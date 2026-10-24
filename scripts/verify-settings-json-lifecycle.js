const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFile } = require('node:child_process')
const { Worker } = require('node:worker_threads')
const { createSettingsJson } = require('../main/application/settings-json')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
fs.mkdirSync(parent, { recursive: true })
const fixture = fs.mkdtempSync(path.join(parent, 'settings-json-lifecycle-'))
const passed = [], clients = [], deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const deadline = setTimeout(() => { console.error('settings JSON lifecycle timed out'); process.exit(1) }, 45000)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check) { const end = Date.now() + 5000; while (!check()) { if (Date.now() > end) throw Error('Worker condition timed out'); await delay(2) } }
const client = options => { const value = createSettingsJson(options); clients.push(value); return value }
const controlledWorker = path.join(fixture, 'controlled-worker.cjs')
fs.writeFileSync(controlledWorker, `const { parentPort } = require('node:worker_threads')
const nativeOn = parentPort.on.bind(parentPort)
parentPort.on = (event, listener) => nativeOn(event, message => {
  if (message.changes.some(([key]) => key === '__crash')) process.exit(17)
  if (message.changes.some(([key]) => key === '__bad')) { parentPort.postMessage({id:message.id,text:'{}',fields:[],bytes:'invalid'}); return }
  const gate = message.seed?.__gate
  if (gate) { const view = new Int32Array(gate); Atomics.store(view,0,1); Atomics.notify(view,0); Atomics.wait(view,1,0) }
  listener(message)
})
require(${JSON.stringify(path.join(root, 'main/application/settings-json-worker.js'))})
`)
async function workers() {
  const codec = client(), base = { tags: { one: ['original'] }, unchanged: { keep: true } }
  const first = await codec.encode({ base, changes: [['favorites', ['a']]] })
  assert.deepEqual(JSON.parse(first.bytes.toString('utf8')), JSON.parse(first.text))
  base.tags.one.push('outside'); first.fields[0].value.push('outside')
  const second = await codec.encode({ base, baseId: first.id, changes: [['theme', 'light']] })
  assert.deepEqual(JSON.parse(second.text).tags.one, ['original']); assert.deepEqual(JSON.parse(second.text).favorites, ['a'])
  passed.push('worker snapshot and returned fields have separate ownership')

  const rebased = await codec.encode({ base: { fresh: true }, baseId: first.id, changes: [['theme', 'dark']] })
  assert.deepEqual(JSON.parse(rebased.text), { fresh: true, theme: 'dark' })
  const canonical = await codec.encode({ base: {}, changes: [['undefined', undefined], ['nan', NaN], ['array', [undefined, -0, Infinity]], ['date', new Date('2026-01-02T00:00:00Z')]] })
  assert.deepEqual(JSON.parse(canonical.text), { nan: null, array: [null, 0, null], date: '2026-01-02T00:00:00.000Z' })
  await assert.rejects(codec.encode({ base: {}, changes: [['big', 1n]] }), { code: 'settings_serialization_failed' })
  const cycle = {}; cycle.self = cycle
  await assert.rejects(codec.encode({ base: {}, changes: [['cycle', cycle]] }), { code: 'settings_serialization_failed' })
  await assert.rejects(codec.encode({ base: {}, changes: [['function', () => {}]] }), /clone/i)
  const recovered = await codec.encode({ base: {}, changes: [['ok', true]] }); assert.equal(JSON.parse(recovered.text).ok, true)
  passed.push('seed mismatch, JSON canonical semantics and serialization error recovery')

  const budget = client({ maxBytes: 128 })
  await assert.rejects(budget.encode({ base: {}, changes: [['large', 'x'.repeat(1024)]] }), { code: 'settings_too_large' })
  assert.equal(JSON.parse((await budget.encode({ base: {}, changes: [['ok', true]] })).text).ok, true)
  passed.push('configured byte budget rejects before publication and recovers')

  const controlled = client({ workerFile: controlledWorker }), gate = new SharedArrayBuffer(8), view = new Int32Array(gate)
  const held = controlled.encode({ base: { __gate: gate }, changes: [['ok', true]] })
  await until(() => Atomics.load(view, 0) === 1)
  await assert.rejects(controlled.encode({ base: {}, changes: [] }), { code: 'settings_serializer_busy' })
  let closed = false; const closing = controlled.close().then(() => { closed = true })
  await delay(5); assert(!closed); assert(controlled.diagnostics().active)
  Atomics.store(view, 1, 1); Atomics.notify(view, 1)
  await Promise.all([held, closing]); assert.deepEqual(controlled.diagnostics(), { worker: false, active: false, closed: true })
  await assert.rejects(controlled.encode({ base: {}, changes: [] }), { code: 'settings_serializer_closed' })
  passed.push('single active job and graceful close wait for actual worker completion')

  const cancelled = client({ workerFile: controlledWorker }), cancelGate = new SharedArrayBuffer(8), cancelView = new Int32Array(cancelGate)
  const cancelledTask = assert.rejects(cancelled.encode({ base: { __gate: cancelGate }, changes: [] }), { code: 'settings_serializer_stopped' })
  await until(() => Atomics.load(cancelView, 0) === 1)
  await cancelled.close({ cancel: true }); await cancelledTask
  assert.equal(cancelled.diagnostics().worker, false)
  passed.push('forced close terminates only the owned thread before releasing the job')

  const crashing = client({ workerFile: controlledWorker })
  await assert.rejects(crashing.encode({ base: {}, changes: [['__crash', true]] }), { code: 'settings_serializer_stopped' })
  assert.equal(crashing.diagnostics().worker, false)
  assert.equal(JSON.parse((await crashing.encode({ base: {}, changes: [['ok', true]] })).text).ok, true)
  await assert.rejects(crashing.encode({ base: {}, changes: [['__bad', true]] }), /invalid snapshot/)
  assert.equal(crashing.diagnostics().worker, false)
  assert.equal(JSON.parse((await crashing.encode({ base: {}, changes: [['ok', true]] })).text).ok, true)
  passed.push('unexpected thread exit and malformed response recover after thread exit')

  const expiring = client({ workerFile: controlledWorker, timeoutMs: 1000 }), timeoutGate = new SharedArrayBuffer(8), timeoutView = new Int32Array(timeoutGate)
  const expired = assert.rejects(expiring.encode({ base: { __gate: timeoutGate }, changes: [] }), { code: 'settings_serialization_timeout' })
  await until(() => Atomics.load(timeoutView, 0) === 1); await expired
  assert.equal(expiring.diagnostics().worker, false)
  assert.equal(JSON.parse((await expiring.encode({ base: {}, changes: [['ok', true]] })).text).ok, true)
  passed.push('deadline terminates a live blocked worker and later requests recover')

  const childSource = `const {createSettingsJson}=require(${JSON.stringify(path.join(root, 'main/application/settings-json.js'))});createSettingsJson().encode({base:{},changes:[['ok',true]]}).then(()=>console.log('idle-worker-did-not-keep-process-alive')).catch(error=>{console.error(error);process.exitCode=1})`
  const output = await new Promise((resolve, reject) => execFile(process.execPath, ['-e', childSource], { cwd: fixture, windowsHide: true, timeout: 5000 }, (error, stdout) => error ? reject(error) : resolve(stdout)))
  assert(output.includes('idle-worker-did-not-keep-process-alive'))
  passed.push('idle worker does not keep an otherwise completed Node process alive')

  const idle = client({ idleTimeoutMs: 20 }), idleFirst = await idle.encode({ base: { keep: true }, changes: [['theme', 'light']] })
  await until(() => !idle.diagnostics().worker)
  const idleNext = await idle.encode({ base: JSON.parse(idleFirst.text), baseId: idleFirst.id, changes: [['theme', 'dark']] })
  assert.deepEqual(JSON.parse(idleNext.text), { keep: true, theme: 'dark' })
  passed.push('idle retirement releases the owned thread and later reseeds from current state')
}

async function settings() {
  process.chdir(fixture)
  const settings = require('../main/settings'), settingsFile = path.join(fixture, '.tmp-wallpaper-player/settings.json')
  const library = path.join(fixture, 'library'); fs.mkdirSync(library)
  const tags = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => ['file-' + i, ['tag-' + i]]))
  await settings.saveSettingsAndFlush({ directories: [library], customTags: tags })
  await settings.saveSettingsAndFlush({ theme: 'dark' })
  const messages = [], nativePost = Worker.prototype.postMessage, nativeTerminate = Worker.prototype.terminate
  let gate = null, crash = false
  Worker.prototype.postMessage = function (message, ...args) {
    messages.push({ seed: Object.hasOwn(message, 'seed'), keys: message.changes.map(([key]) => key) })
    if (crash) { crash = false; void nativeTerminate.call(this); return }
    if (gate && message.changes.some(([key, value]) => key === 'theme' && value === 'held')) {
      gate.entered.resolve(); gate.release = () => nativePost.call(this, message, ...args); return
    }
    return nativePost.call(this, message, ...args)
  }
  try {
    const originalInput = { favorites: ['captured'] }, result = await settings.saveSettingsAndFlush(originalInput)
    originalInput.favorites.push('outside'); result.customTags['file-0'].push('outside')
    assert.equal(messages[0].seed, false); assert.deepEqual(messages[0].keys, ['favorites'])
    assert.deepEqual(settings.loadSettings().favorites, ['captured']); assert.deepEqual(settings.loadSettings().customTags['file-0'], ['tag-0'])
    passed.push('ordinary production patch sends changed fields and preserves input/result/cache ownership')

    const noSnapshot = await settings.updateSettingsAndFlush(() => ({ patch: { theme: 'light' }, value: { ok: true } }), { returnSettings: false })
    assert.deepEqual(noSnapshot, { value: { ok: true } })
    const readOnly = await settings.updateSettingsAndFlush(() => ({ patch: {}, value: 7 }), { returnSettings: false, readOnly: true })
    assert.deepEqual(readOnly, { value: 7 })
    const oldCache = settings.loadSettings(), oldDisk = fs.readFileSync(settingsFile, 'utf8'), notices = []
    const unsubscribe = settings.onSettingsChanged(snapshot => notices.push(snapshot))
    await assert.rejects(settings.saveSettingsAndFlush({ unsupportedBig: 1n, favorites: ['failed'] }), { code: 'settings_serialization_failed' })
    assert.deepEqual(settings.loadSettings(), oldCache); assert.equal(fs.readFileSync(settingsFile, 'utf8'), oldDisk); assert.equal(notices.length, 0)
    crash = true
    await assert.rejects(settings.saveSettingsAndFlush({ favorites: ['thread-failed'] }), { code: 'settings_serializer_stopped' })
    assert.deepEqual(settings.loadSettings(), oldCache); assert.equal(fs.readFileSync(settingsFile, 'utf8'), oldDisk); assert.equal(notices.length, 0)
    await settings.saveSettingsAndFlush({ favorites: ['recovered'] }); assert.deepEqual(settings.loadSettings().favorites, ['recovered'])
    unsubscribe()
    passed.push('value-only result and worker failure never publish or replace the durable file')

    gate = { entered: deferred(), release: null }
    const pending = settings.saveSettingsAndFlush({ theme: 'held' }); await gate.entered.promise
    settings.saveSettings({ windowClose: { mode: 'minimize' } })
    gate.release(); gate = null; await pending; await settings.flushSettingsWrites()
    const durable = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
    assert.equal(durable.theme, 'held'); assert.equal(durable.windowClose.mode, 'minimize')
    passed.push('synchronous changes during worker preparation rebase and flush together')

    class Custom { toJSON(key) { return { key, owned: true } } }
    const special = Object.fromEntries([['customShape', new Custom()], ['__proto__', { private: true }], ['constructor', 'own'], ['negativeZero', -0]])
    const saved = await settings.saveSettingsAndFlush(special)
    assert.deepEqual(saved.customShape, { key: 'customShape', owned: true })
    assert(Object.hasOwn(saved, '__proto__')); assert.equal(Object.getPrototypeOf(saved), Object.prototype)
    assert.equal(Object.prototype.private, undefined); assert.equal(saved.constructor, 'own'); assert.equal(Object.is(saved.negativeZero, -0), false)
    assert.deepEqual(settings.loadSettings(), JSON.parse(fs.readFileSync(settingsFile, 'utf8')))
    settings.setDirectoryChangeHandler(directories => directories.push('mutated-listener'))
    await settings.saveSettingsAndFlush({ directories: [library] })
    assert.deepEqual(settings.getMediaAccessSettings().directories, [library])
    settings.setDirectoryChangeHandler(null)
    passed.push('custom property-key JSON, special keys and directory callback ownership stay compatible')

    const providerValue = { stamp: 1 }, removeProvider = settings.registerSettingsSection('providerPathFixture', {
      defaults: providerValue, normalize() { return providerValue }
    })
    const nativeRename = fs.promises.rename, renameEntered = deferred(), releaseRename = deferred()
    let paused = false
    fs.promises.rename = async function (...args) {
      if (!paused && args[1] === settingsFile) { paused = true; renameEntered.resolve(); await releaseRename.promise }
      return nativeRename.apply(this, args)
    }
    try {
      const providerCommit = settings.saveSettingsAndFlush({ directories: [library], providerPathFixture: { stamp: 1 } })
      await renameEntered.promise; providerValue.stamp = 2; releaseRename.resolve()
      await providerCommit; await settings.flushSettingsWrites()
      assert.equal(settings.loadSettings().providerPathFixture.stamp, 2)
      assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).providerPathFixture.stamp, 2)
    } finally { releaseRename.resolve(); fs.promises.rename = nativeRename; removeProvider() }
    passed.push('path rebase compares the encoded durable snapshot before scheduling a follow-up write')
  } finally {
    gate?.release?.(); Worker.prototype.postMessage = nativePost
    await settings.flushSettingsWrites(); await settings.disposeSettingsSerialization()
    process.chdir(root)
  }
}

;(async () => {
  await workers(); await settings()
  const sourceFiles = ['main/settings.js', 'main/application/settings-json.js', 'main/application/settings-json-worker.js', 'main/application/media-mutations.js', 'main/remote/media-mutations.js', 'main/index.js']
  const evidence = { date: new Date().toISOString(), fixture: path.relative(root, fixture), passed,
    sourceDigests: Object.fromEntries(sourceFiles.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])),
    conditions: 'Actual Node worker threads, actual production settings and atomic filesystem. Controlled shared-memory gate, thread exit/timeout, configurable test byte limit, process exit and message fault injection. No native-device, cold-start or power-loss acceptance.' }
  fs.writeFileSync(path.join(parent, 'settings-json-lifecycle.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence))
})().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  for (const codec of clients) await codec.close({ cancel: true })
  clearTimeout(deadline)
})
