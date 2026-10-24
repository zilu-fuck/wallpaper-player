const assert = require('assert'), fs = require('fs'), fsp = require('fs/promises'), path = require('path'), Module = require('module')
const { execFileTreeAsync } = require('../main/exec')
const { removeTempRootWithRetry } = require('./verify-helpers')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
fs.mkdirSync(parent, { recursive: true }); const fixture = fs.mkdtempSync(path.join(parent, 'download-preparation-'))
const delay = ms => new Promise(done => setTimeout(done, ms))
const until = async predicate => { const deadline = Date.now() + 6000
  while (!predicate()) { if (Date.now() > deadline) throw new Error('download preparation condition timed out'); await delay(4) } }
async function main() {
  process.chdir(fixture)
  const priorAria = process.env.WALLPAPER_PLAYER_ARIA2C, originalLoad = Module._load, originalTimeout = global.setTimeout
  process.env.WALLPAPER_PLAYER_ARIA2C = process.execPath
  let mode = 'hold', probes = 0, nativeStarted = 0, nativeClosed = 0, daemons = 0
  const records = []
  const probe = async options => {
    probes++; assert.ok(options.signal); assert.ok(options.deadlineAt > Date.now())
    if (mode === 'fast') return null
    const target = path.join(fixture, 'probe-' + (++nativeStarted) + '.pid'), record = { target, signal: options.signal }
    records.push(record)
    try {
      await execFileTreeAsync(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)', target], { signal: options.signal, timeout: 10000, maxBuffer: 128 * 1024 })
    } finally { nativeClosed++ }
  }
  Module._load = function (name, owner, ...rest) {
    if (owner?.filename.replace(/\\/g, '/').endsWith('/main/download-manager.js')) {
      if (name === './ytdlp-service') return { detectYtDlp: (_refresh, options) => probe(options), getYtDlpStatus: () => ({ available: false }), getSystemProxyAsync: async () => ({ enabled: false }) }
      if (name === './download-xunlei') return { createXunleiManager: () => ({ detect: (_refresh, options) => probe(options), getStatus: () => ({}), loadTasks: async () => [], normalizeTask: value => value }) }
      if (name === 'child_process') return { spawn() { daemons++; throw new Error('observation started a daemon') } }
    }
    return originalLoad.call(this, name, owner, ...rest)
  }
  let manager
  try { manager = require('../main/download-manager') } finally { Module._load = originalLoad }
  const scheduler = require('../main/application/resource-scheduler').mediaScheduler
  try {
    const a = new AbortController(), b = new AbortController()
    const first = manager.getSnapshot({ start: false, signal: a.signal }).catch(error => error)
    const second = manager.getSnapshot({ start: false, signal: b.signal }).catch(error => error)
    await until(() => records.length === 2 && records.every(record => fs.existsSync(record.target)))
    assert.ok(records.every(record => record.signal !== a.signal && record.signal !== b.signal), 'shared work uses its own lifetime signal')
    a.abort(); assert.strictEqual((await first).code, 'task_cancelled'); assert.strictEqual(nativeClosed, 0)
    b.abort(); assert.strictEqual((await second).code, 'task_cancelled')
    assert.strictEqual(nativeClosed, 2, 'last observer waits for every actual preparation process to close')
    for (const record of records) assert.throws(() => process.kill(Number(fs.readFileSync(record.target, 'utf8')), 0))
    assert.strictEqual(scheduler.diagnostics().used.prepare, 0); assert.strictEqual(scheduler.diagnostics().used.control, 0)
    mode = 'fast'
    await manager.getSnapshot({ start: false }); const count = probes
    await Promise.all(Array.from({ length: 5 }, () => manager.getSnapshot({ start: false })))
    assert.strictEqual(probes, count, 'ordinary polling retains the successful preflight for thirty seconds')
    await manager.getSnapshot({ start: false, refresh: true }); assert.strictEqual(probes, count + 2)
    mode = 'hold'
    global.setTimeout = (callback, ms, ...args) => originalTimeout(callback, ms === 30000 ? 100 : ms, ...args)
    const timed = await manager.getSnapshot({ start: false, refresh: true }).catch(error => error)
    assert.strictEqual(timed.code, 'task_timeout'); assert.strictEqual(nativeClosed, nativeStarted)
    assert.strictEqual(daemons, 0)
    console.log('download preparation passed: production snapshot/preflight, shared signals, actual owned CLI cleanup, cancel-before-next-stage, thirty-second preflight cache/explicit refresh, whole preparation deadline and no daemon from observation; detector CLIs are controlled fixtures')
  } finally {
    global.setTimeout = originalTimeout; await manager.disposeDownloadManager(); await scheduler.dispose()
    if (priorAria === undefined) delete process.env.WALLPAPER_PLAYER_ARIA2C; else process.env.WALLPAPER_PLAYER_ARIA2C = priorAria
  }
}
const deadline = setTimeout(() => { console.error('download preparation verification timed out'); process.exit(1) }, 20000)
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  clearTimeout(deadline); process.chdir(root); assert.strictEqual(path.dirname(path.resolve(fixture)), parent); await removeTempRootWithRetry(fixture)
})
