const assert = require('assert'), fs = require('fs'), path = require('path'), Module = require('module')
const { EventEmitter } = require('events')
const { removeTempRootWithRetry } = require('./verify-helpers')
const { execFileTreeAsync } = require('../main/exec')
const { ResourceScheduler } = require('../main/application/resource-scheduler')
const { createPlayerService } = require('../main/application/player-service')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
fs.mkdirSync(parent, { recursive: true })
const fixture = fs.mkdtempSync(path.join(parent, 'preparation-processes-'))
const delay = ms => new Promise(done => setTimeout(done, ms))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const until = async predicate => { const deadline = Date.now() + 6000
  while (!predicate()) { if (Date.now() > deadline) throw new Error('preparation process condition timed out'); await delay(4) } }
const alive = pid => { try { process.kill(pid, 0)
  if (process.platform !== 'win32' && fs.existsSync('/proc/' + pid + '/stat')) return !/\) Z /.test(fs.readFileSync('/proc/' + pid + '/stat', 'utf8'))
  return true } catch { return false } }
async function processes() {
  const script = path.join(fixture, 'worker.js')
  fs.writeFileSync(script, `const fs=require('fs'),{spawn}=require('child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});fs.writeFileSync(process.argv[2],JSON.stringify({parent:process.pid,child:child.pid}));if(process.argv[3]==='output')setTimeout(()=>process.stdout.write('x'.repeat(65536)),100);setInterval(()=>{},1000)`)
  for (const mode of ['abort', 'timeout', 'output']) {
    const pidsFile = path.join(fixture, mode + '.json'), controller = new AbortController()
    let ticks = 0
    const ticker = setInterval(() => ticks++, 10)
    const pending = execFileTreeAsync(process.execPath, [script, pidsFile, mode], { signal: controller.signal, timeout: mode === 'timeout' ? 300 : 5000, maxBuffer: 1024 }).catch(error => error)
    await until(() => fs.existsSync(pidsFile))
    const pids = JSON.parse(fs.readFileSync(pidsFile, 'utf8'))
    assert.ok(alive(pids.parent) && alive(pids.child))
    if (mode === 'abort') controller.abort(new Error('preparation-cancelled'))
    const error = await pending; clearInterval(ticker)
    assert.ok(error instanceof Error)
    if (mode === 'timeout') { assert.strictEqual(error.code, 'ETIMEDOUT'); assert.ok(ticks >= 5, 'a blocked native worker does not block the Node event loop') }
    if (mode === 'output') assert.strictEqual(error.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
    await until(() => !alive(pids.parent) && !alive(pids.child))
  }
}
async function player() {
  const scheduler = new ResourceScheduler({ limits: { prepare: 1 }, subscribe: () => () => {} }), pending = deferred()
  const sender = new EventEmitter(); sender.id = 99; sender.mainFrame = {}; sender.isDestroyed = () => false
  const event = { sender, senderFrame: sender.mainFrame }, state = { value: { sessionId: '' } }
  let sourceSignal, tools = 0, plays = 0, pressure = false
  const manager = { getState: () => state.value, stop: async () => { state.value = { sessionId: '' } }, play: async (target, options) => { plays++
    state.value = { sessionId: options.sessionId, engineSessionId: plays, resourceTarget: target, filePath: target,
      timePos: 0, duration: 1, paused: false, ready: true, volume: 100, muted: false, speed: 1, eofReached: false, trackList: [] } } }
  const service = createPlayerService({ manager, scheduler, preparationMs: 80, getMainWindow: () => ({ webContents: sender }),
    resolveLocal: async (target, _sender, context) => { if (target === 'slow') { sourceSignal = context.signal; await pending.promise } return target },
    resolveNetwork: async () => null, resolveMpvPath: async () => { tools++; return 'mpv' },
    readPlaybackState: () => null, setMediaPlaybackActive: active => { pressure = active } })
  try {
    const first = service.action(event, { action: 'load', sessionId: 'slow', target: 'slow', source: 'local' })
    await assert.rejects(first, error => error.code === 'task_timeout')
    assert.strictEqual(sourceSignal.aborted, true); assert.strictEqual(pressure, false)
    assert.strictEqual(scheduler.diagnostics().used.prepare, 1, 'ignored filesystem cancellation retains the resource until the real operation returns')
    const next = service.action(event, { action: 'load', sessionId: 'next', target: 'next', source: 'local' })
    await delay(10); assert.strictEqual(tools, 0); assert.strictEqual(plays, 0)
    pending.resolve(); await next; await scheduler.waitForIdle()
    assert.strictEqual(tools, 1); assert.strictEqual(plays, 1)
    await service.legacyStop(event)
  } finally { pending.resolve(); await scheduler.dispose() }
}
async function finder() {
  const original = Module._load, gate = deferred()
  let capturedSignal
  Module._load = function (name, owner, ...rest) {
    if (owner?.filename.replace(/\\/g, '/').endsWith('/main/mpv.js')) {
      if (name === 'electron') return { app: { getPath: () => fixture } }
      if (name === './paths') return { getResourcePath: () => path.join(fixture, 'absent.exe') }
      if (name === './exec') return { execFileTreeAsync: async (_file, _args, options) => { capturedSignal = options.signal; await gate.promise; return { stdout: '' } } }
    }
    return original.call(this, name, owner, ...rest)
  }
  let MpvManager
  try { MpvManager = require('../main/mpv') } finally { Module._load = original }
  const manager = new MpvManager(), pending = manager.findMpv(null).catch(error => error)
  await until(() => capturedSignal)
  let finished = false
  const disposal = manager.destroy().then(() => { finished = true })
  await delay(10); assert.strictEqual(capturedSignal.aborted, true); assert.strictEqual(finished, false)
  gate.resolve(); assert.ok(await pending instanceof Error); await disposal
  assert.strictEqual(manager.getMpvPath(), null)
}
async function shutdownBudget() {
  const scheduler = new ResourceScheduler({ limits: { prepare: 1, transfer: 1 }, subscribe: () => () => {} }), held = deferred()
  const daemon = await scheduler.acquire({ key: 'daemon', type: 'download-daemon', resources: { transfer: 1 } })
  let signal
  const job = scheduler.enqueue({ key: 'prepare', type: 'prepare', resources: { prepare: 1 } }, async context => { signal = context.signal; await held.promise }).catch(error => error)
  await until(() => signal)
  scheduler.beginShutdown({ preserveTypes: ['download-daemon'] })
  assert.strictEqual(signal.aborted, true); assert.strictEqual(daemon.signal.aborted, false)
  await assert.rejects(scheduler.enqueue({ type: 'new', resources: { prepare: 1 } }, async () => {}), error => error.code === 'task_stopping')
  held.resolve(); daemon.release(); await job; await scheduler.dispose()
  assert.strictEqual(scheduler.diagnostics().running, 0)
}
const deadline = setTimeout(() => { console.error('preparation process verification timed out'); process.exit(1) }, 25000)
processes().then(player).then(finder).then(shutdownBudget).then(() => console.log('preparation processes passed: actual owned process trees, signal/timeout/output cleanup, responsive event loop, full player preparation deadline, retained late-IO budget/no late play, mpv finder disposal and graceful downloader budget preservation')).catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  clearTimeout(deadline); assert.strictEqual(path.dirname(path.resolve(fixture)), parent); await removeTempRootWithRetry(fixture)
})
