const assert = require('assert'), fs = require('fs'), fsp = require('fs/promises'), path = require('path')
const { spawn } = require('child_process')
const { EventEmitter } = require('events')
const { createXunleiManager } = require('../main/download-xunlei')
const { stopProcessTree } = require('../main/process-lifecycle')
const { removeTempRootWithRetry } = require('./verify-helpers')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
fs.mkdirSync(parent, { recursive: true }); const fixture = fs.mkdtempSync(path.join(parent, 'xunlei-lifecycle-'))
const delay = ms => new Promise(done => setTimeout(done, ms))
const until = async predicate => { const deadline = Date.now() + 5000
  while (!predicate()) { if (Date.now() > deadline) throw new Error('xunlei condition timed out'); await delay(4) } }
async function main() {
  const children = [], managers = [], originalEnv = process.env.WALLPAPER_PLAYER_XUNLEI
  delete process.env.WALLPAPER_PLAYER_XUNLEI
  const directory = path.join(fixture, 'state'), targetDir = path.join(fixture, 'downloads'); await fsp.mkdir(targetDir)
  const execute = async (file, args, options) => {
    assert.ok(path.isAbsolute(file)); assert.ok(options.signal); assert.ok(options.timeout <= 1500)
    return { stdout: ' REG_SZ "' + process.execPath + '" "%1"' }
  }
  const launch = (_file, args, options) => {
    assert.strictEqual(options.detached, true); assert.strictEqual(options.windowsHide, false); assert.ok(args[0].startsWith('http'))
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' }); children.push(child); return child
  }
  const create = options => { const manager = createXunleiManager({ getDownloadStateDir: () => directory, execute, launch, ...options }); managers.push(manager); return manager }
  const payload = n => ({ url: 'https://download.example.invalid/video-' + n + '.mp4', dir: targetDir, assertDownloadDirectory: async dir => dir })
  try {
    const manager = create(), results = await Promise.all([1, 2, 3, 4].map(n => manager.addTask(payload(n))))
    assert.ok(results.every(result => result.success)); assert.strictEqual((await manager.loadTasks()).length, 4)
    const normalized = manager.normalizeTask(results[0].task)
    assert.strictEqual(normalized.ownership, 'external'); assert.strictEqual(normalized.handoffState, 'requested')
    assert.strictEqual(normalized.controls.stopExternal, false); assert.ok(normalized.message.includes('无法确认'))
    const first = results[0].task.gid, second = results[1].task.gid
    await Promise.all([manager.removeTask(first), manager.addTask(payload(5)), manager.removeTask(second)])
    const tasks = await manager.loadTasks(); assert.strictEqual(tasks.length, 3); assert.ok(!tasks.some(task => [first, second].includes(task.gid)))
    assert.strictEqual((await create().loadTasks()).length, 3)
    const pid = children[0].pid; await manager.dispose(); process.kill(pid, 0)
    await assert.rejects(manager.addTask(payload(6)), /关闭/)

    const failed = create({ launch: () => spawn(path.join(fixture, 'missing-client.exe'), [], { windowsHide: true }) })
    const failure = await failed.addTask(payload(6)); assert.strictEqual(failure.success, false)
    assert.strictEqual(failed.normalizeTask(failure.task).status, 'error'); assert.strictEqual(failed.normalizeTask(failure.task).controls.stopExternal, false)

    const originalTimeout = global.setTimeout
    let killAttempts = 0
    try {
      global.setTimeout = (callback, ms, ...args) => originalTimeout(callback, ms === 5000 ? 50 : ms, ...args)
      const unknown = create({ launch: () => Object.assign(new EventEmitter(), { unref() {}, kill() { killAttempts++ } }) })
      const uncertain = await unknown.addTask(payload('uncertain'))
      assert.strictEqual(uncertain.success, false); assert.strictEqual(uncertain.task.handoffState, 'unknown')
      assert.strictEqual(unknown.normalizeTask(uncertain.task).status, 'external'); assert.strictEqual(killAttempts, 0)
    } finally { global.setTimeout = originalTimeout }

    let signal
    const detecting = create({ execute: async (_file, _args, options) => { signal = options.signal; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) } })
    const cancellation = new AbortController(), detection = detecting.detect(true, { signal: cancellation.signal }).catch(error => error)
    await until(() => signal); cancellation.abort(new Error('cancel-detection')); assert.match((await detection).message, /cancel-detection/)

    let release, entered = false
    const barrier = new Promise(done => { release = done }), preparing = create(), before = children.length
    const late = preparing.addTask({ ...payload(7), assertDownloadDirectory: async () => { entered = true; await barrier; return targetDir } }).catch(error => error)
    await until(() => entered); let closed = false
    const closing = preparing.dispose().then(() => { closed = true }); await delay(15); assert.strictEqual(closed, false)
    release(); assert.match((await late).message, /关闭/); await closing; assert.strictEqual(children.length, before)

    const corruptDir = path.join(fixture, 'corrupt'); await fsp.mkdir(corruptDir); const corrupt = path.join(corruptDir, 'xunlei-tasks.json')
    await fsp.writeFile(corrupt, '{broken')
    await assert.rejects(create({ getDownloadStateDir: () => corruptDir }).addTask(payload(8)))
    assert.strictEqual(await fsp.readFile(corrupt, 'utf8'), '{broken'); assert.strictEqual(children.length, before)
    const cappedDir = path.join(fixture, 'capped'); await fsp.mkdir(cappedDir)
    const cappedPath = path.join(cappedDir, 'xunlei-tasks.json')
    await fsp.writeFile(cappedPath, JSON.stringify({ version: 1, tasks: Array.from({ length: 80 }, (_, i) => ({ gid: 'xunlei-legacy-' + i })) }))
    await assert.rejects(create({ getDownloadStateDir: () => cappedDir }).addTask(payload('over-cap')), /80/)
    assert.strictEqual(JSON.parse(await fsp.readFile(cappedPath, 'utf8')).tasks.length, 80)
    assert.strictEqual(children.length, before, 'record admission fails before any external handoff')
    console.log('xunlei lifecycle passed: async cancellable registry detection, serial atomic durable intents, concurrent add/remove, actual owned test client survives record removal/disposal, spawn failure, no late handoff after shutdown and corrupt-record preservation; no real external client or network contacted')
  } finally {
    await Promise.allSettled(managers.map(manager => manager.dispose()))
    for (const child of children) { const closed = child.exitCode != null || child.signalCode != null ? Promise.resolve() : new Promise(done => child.once('close', done)); await stopProcessTree(child); await closed }
    if (originalEnv === undefined) delete process.env.WALLPAPER_PLAYER_XUNLEI; else process.env.WALLPAPER_PLAYER_XUNLEI = originalEnv
  }
}
const deadline = setTimeout(() => { console.error('xunlei lifecycle verification timed out'); process.exit(1) }, 25000)
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  clearTimeout(deadline); assert.strictEqual(path.dirname(path.resolve(fixture)), parent); await removeTempRootWithRetry(fixture)
})
