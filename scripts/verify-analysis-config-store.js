const assert = require('assert')
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const Module = require('module')
const http = require('http')
const { RuntimeConfigStore } = require('../main/plugins/video-analysis/runtime-config-store')
const { removeTempRootWithRetry } = require('./verify-helpers')

const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
fs.mkdirSync(parent, { recursive: true })
const fixture = fs.mkdtempSync(path.join(parent, 'analysis-config-'))
const stores = []
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const injected = () => Object.assign(new Error('injected filesystem failure'), { code: 'EACCES' })
const make = (name, options = {}) => {
  const filename = path.join(fixture, name, '.env')
  const store = new RuntimeConfigStore({ filename: () => filename, ...options })
  stores.push(store)
  return { store, filename }
}
const update = (store, patch, metadata) => store.update(text => {
  const value = { ...JSON.parse(text || '{}'), ...patch }
  return { text: JSON.stringify(value), value }
}, metadata)

async function storeBehavior() {
  const { store, filename } = make('atomic')
  assert.strictEqual(await store.read(text => text), null)
  assert.ok(!fs.existsSync(path.dirname(filename)), 'reading defaults does not create a directory')
  await update(store, { first: 0 })
  const entered = deferred(), release = deferred()
  const first = update(store, { first: 1 }, async () => { entered.resolve(); await release.promise })
  await entered.promise
  const second = update(store, { second: 2 }), latest = store.read(JSON.parse)
  release.resolve()
  await Promise.all([first, second])
  assert.deepStrictEqual(await latest, { first: 1, second: 2 }, 'queued patches and reads use the latest committed text')

  // Independent readers see either full generation, including while a large candidate is staged.
  const generations = [JSON.stringify({ data: '甲'.repeat(200000) }), JSON.stringify({ data: '乙'.repeat(200000) })]
  await store.update(() => ({ text: generations[0] }))
  let reading = true, readCount = 0
  const reader = (async () => { while (reading) {
    const text = await fsp.readFile(filename, 'utf8')
    assert.ok(generations.includes(text), 'an external reader cannot observe a partially written env file')
    readCount++
    await new Promise(done => setTimeout(done, 4))
  } })()
  try { for (let index = 0; index < 6; index++) await store.update(() => ({ text: generations[(index + 1) % 2] })) }
  finally { reading = false; await reader }
  assert.ok(readCount > 0)
  await update(store, { data: 'baseline' })
  const original = await fsp.readFile(filename, 'utf8')

  for (const method of ['writeFile', 'sync']) {
    const open = fsp.open
    fsp.open = async function (file, flags, ...rest) {
      const handle = await open.call(this, file, flags, ...rest)
      if (flags === 'wx' && path.dirname(file) === path.dirname(filename)) handle[method] = async () => { throw injected() }
      return handle
    }
    try { await assert.rejects(update(store, { data: 'failed' }), /injected/) }
    finally { fsp.open = open }
    assert.strictEqual(await fsp.readFile(filename, 'utf8'), original)
  }
  const rename = fsp.rename
  let denied = 0
  fsp.rename = async function (from, to) {
    if (to === filename && denied++ < 2) throw Object.assign(injected(), { code: 'EPERM' })
    return rename.call(this, from, to)
  }
  try { await update(store, { data: 'transient retry' }) } finally { fsp.rename = rename }
  assert.ok(denied >= 3, 'transient Windows rename denials are retried without removing the destination')
  await update(store, { data: 'baseline' })
  fsp.rename = async function (from, to) {
    if (to === filename && path.basename(from).startsWith('.runtime-env-write-')) throw injected()
    return rename.call(this, from, to)
  }
  try { await assert.rejects(update(store, { data: 'failed' }), /injected/) }
  finally { fsp.rename = rename }
  assert.strictEqual(await fsp.readFile(filename, 'utf8'), original)
  await assert.rejects(update(store, { data: 'metadata failed' }, () => { throw injected() }), /injected/)
  assert.strictEqual(await fsp.readFile(filename, 'utf8'), original, 'metadata failure restores the previous complete file')
  assert.deepStrictEqual(await fsp.readdir(path.dirname(filename)), ['.env'])

  const stage = store.stage.bind(store)
  store.stage = async (...args) => {
    const staged = await stage(...args)
    if (args[1] === 'rollback') await fsp.writeFile(filename, '{"external":true}')
    return staged
  }
  try { await assert.rejects(update(store, { data: 'conflicting' }), error => error.code === 'runtime_config_conflict') }
  finally { store.stage = stage }
  assert.strictEqual(await fsp.readFile(filename, 'utf8'), '{"external":true}')

  const broken = make('rollback-failure')
  await update(broken.store, { old: true })
  fsp.rename = async function (from, to) {
    if (to === broken.filename && path.basename(from).startsWith('.runtime-env-rollback-')) throw injected()
    return rename.call(this, from, to)
  }
  let recovery
  try { await assert.rejects(update(broken.store, { old: false }, () => { throw injected() }), error => {
    recovery = error.recoveryPath; return error.code === 'runtime_config_rollback_failed'
  }) } finally { fsp.rename = rename }
  assert.strictEqual(await fsp.readFile(recovery, 'utf8'), '{"old":true}', 'failed rollback retains a complete recovery copy')
  await assert.rejects(broken.store.read(JSON.parse), error => error.code === 'runtime_config_recovery_required')
  await assert.rejects(update(broken.store, { newer: true }), error => error.code === 'runtime_config_recovery_required')

  const legacy = path.join(fixture, 'legacy.env')
  await fsp.writeFile(legacy, 'legacy=first\n')
  const migration = make('migration', { legacyFilename: () => legacy })
  assert.strictEqual(await migration.store.read(text => text), 'legacy=first\n')
  await fsp.writeFile(legacy, 'legacy=changed\n')
  assert.strictEqual(await migration.store.read(text => text), 'legacy=first\n')
  const materialized = make('defaults')
  await materialized.store.materialize(() => 'first')
  await materialized.store.materialize(() => 'second')
  assert.strictEqual(await materialized.store.read(text => text), 'first')

  const small = make('limits', { maxBytes: 16, maxPending: 2 })
  await assert.rejects(small.store.update(() => ({ text: 'x'.repeat(17) })), error => error.code === 'runtime_config_too_large')
  await fsp.mkdir(path.dirname(small.filename), { recursive: true })
  await fsp.writeFile(small.filename, Buffer.from([0xc3, 0x28]))
  await assert.rejects(small.store.read(text => text), /encoded data|encoding/i)
  await fsp.writeFile(small.filename, 'x'.repeat(17))
  await assert.rejects(small.store.read(text => text), error => error.code === 'runtime_config_too_large')
  await fsp.writeFile(small.filename, '{}')
  const accepted = deferred(), finish = deferred()
  const held = update(small.store, { a: 1 }, async () => { accepted.resolve(); await finish.promise })
  await accepted.promise
  const queued = small.store.read(JSON.parse)
  await assert.rejects(small.store.read(JSON.parse), error => error.code === 'runtime_config_busy')
  let closed = false
  const closing = small.store.close().then(() => { closed = true })
  await assert.rejects(update(small.store, { b: 2 }), error => error.code === 'runtime_config_stopping')
  assert.strictEqual(closed, false)
  finish.resolve(); await Promise.all([held, queued, closing])
  small.store.resume(); assert.deepStrictEqual(await small.store.read(JSON.parse), { a: 1 })
}

async function productionBehavior() {
  process.chdir(fixture)
  const settings = require('../main/settings')
  const definition = require('../main/plugins/video-analysis/settings')
  const unregister = settings.registerSettingsSection('videoAnalysis', definition.videoAnalysisSettingsSection)
  const core = require('../main/plugins/video-analysis/core')
  const paths = require('../main/paths')
  core.setCoreResolver(name => name === 'paths' ? { ...paths, getResourcePath: (...segments) => segments[0] === 'video comprehension'
    ? path.join(fixture, 'legacy-project', ...segments.slice(1)) : paths.getResourcePath(...segments) } : require('../main/plugins/core-api').requireCoreModule(name))
  const load = Module._load, handlers = new Map()
  let selection
  Module._load = function (name, owner, ...rest) {
    if (name === 'electron' && /\/main\/plugins\/video-analysis\/(service|vlm-service|ipc)\.js$/.test(owner?.filename.replace(/\\/g, '/') || '')) {
      return { BrowserWindow: { getAllWindows: () => [] }, dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [selection] }) } }
    }
    return load.call(this, name, owner, ...rest)
  }
  let service, vlm
  try {
    service = require('../main/plugins/video-analysis/service')
    vlm = require('../main/plugins/video-analysis/vlm-service')
    require('../main/plugins/video-analysis/ipc').registerVideoAnalysisIpc({ ipc: { handle: (name, action) => handlers.set(name, action) } })
  } finally { Module._load = load }
  const origin = http.createServer((_req, res) => res.end('{"data":[]}'))
  await new Promise(done => origin.listen(0, '127.0.0.1', done))
  const removeListener = settings.onSettingsChanged(() => { changes++ })
  let changes = 0
  try {
    assert.strictEqual((await service.getVideoAnalysisRuntimeConfig()).usingDefaults, true, 'the service fixture has no developer legacy configuration')
    const baseline = await service.saveVideoAnalysisRuntimeConfig({ llmName: 'baseline', vlmBaseUrl: 'http://127.0.0.1:' + origin.address().port })
    assert.strictEqual(settings.loadSettings().videoAnalysis.llmProfiles.local.llmName, 'baseline', 'first save persists the active profile')
    const envPath = baseline.envPath, settingsPath = path.join(path.dirname(path.dirname(envPath)), 'settings.json')
    const originalEnv = await fsp.readFile(envPath, 'utf8'), originalSettings = await fsp.readFile(settingsPath, 'utf8')
    const oldStat = await fsp.stat(envPath, { bigint: true }), before = changes
    for (let count = 0; count < 6; count++) await service.getVideoAnalysisRuntimeConfig()
    await service.saveVideoAnalysisRuntimeConfig({})
    assert.strictEqual(changes, before, 'reads and an unchanged save do not broadcast settings')
    assert.strictEqual((await fsp.stat(envPath, { bigint: true })).mtimeNs, oldStat.mtimeNs)
    assert.strictEqual(await fsp.readFile(settingsPath, 'utf8'), originalSettings)

    const chosenModel = path.join(fixture, 'chosen.gguf')
    await fsp.writeFile(chosenModel, 'controlled model fixture')
    await Promise.all([service.saveVideoAnalysisRuntimeConfig({ llmName: 'edited LLM' }), vlm.selectLocalVlmModelFile(chosenModel)])
    const merged = await service.getVideoAnalysisRuntimeConfig()
    assert.strictEqual(merged.llmName, 'edited LLM'); assert.strictEqual(merged.vlmModelPath, chosenModel)
    assert.strictEqual(settings.loadSettings().videoAnalysis.llmProfiles.local.llmName, 'edited LLM', 'the VLM patch retains the active text profile')
    const savedEnv = await fsp.readFile(envPath, 'utf8'), savedSettings = settings.loadSettings(), eventCount = changes
    await assert.rejects(service.saveVideoAnalysisRuntimeConfig({ llmName: 'injected\nMODE=fast' }), /换行/)
    assert.strictEqual(await fsp.readFile(envPath, 'utf8'), savedEnv)
    const rename = fsp.rename
    fsp.rename = async function (from, to) { if (to === settingsPath) throw injected(); return rename.call(this, from, to) }
    selection = path.join(fixture, 'new model directory')
    await fsp.mkdir(selection)
    try {
      await assert.rejects(handlers.get('video-analysis-select-model-dir')(), /injected/)
      const reset = await handlers.get('video-analysis-reset-runtime-config')()
      assert.strictEqual(reset.success, false)
    } finally { fsp.rename = rename }
    assert.strictEqual(await fsp.readFile(envPath, 'utf8'), savedEnv)
    assert.deepStrictEqual(settings.loadSettings(), savedSettings, 'failed metadata commits leave the in-memory settings unchanged')
    assert.strictEqual(changes, eventCount)
    assert.ok(!fs.readdirSync(path.dirname(envPath)).some(name => name.endsWith('.tmp')))
    assert.strictEqual(await handlers.get('video-analysis-select-model-dir')(), selection)
    assert.strictEqual(settings.loadSettings().videoAnalysis.modelDir, selection)
    assert.strictEqual((await service.getVideoAnalysisRuntimeConfig()).modelStorageDir, selection)
    assert.strictEqual(settings.loadSettings().videoAnalysis.llmProfiles.local.llmName, 'edited LLM', 'directory selection retains the active text profile')
    const refreshed = await service.saveVideoAnalysisRuntimeConfig({ llmProvider: 'api', llmName: 'api fixture' })
    assert.strictEqual(settings.loadSettings().videoAnalysis.llmProfiles.local.llmName, 'edited LLM')
    assert.strictEqual(settings.loadSettings().videoAnalysis.llmProfiles.api.llmName, 'api fixture')
    await service.saveVideoAnalysisRuntimeConfig(refreshed) // Older full-object clients remain supported.
    await assert.rejects(service.saveVideoAnalysisRuntimeConfig([]), /无效/)
    assert.notStrictEqual(await fsp.readFile(envPath, 'utf8'), originalEnv)
    await Promise.all([service.disposeVideoAnalysis(), vlm.disposeVlmService()])
    await service.disposeRuntimeConfiguration()
    await assert.rejects(service.getVideoAnalysisRuntimeConfig(), error => error.code === 'runtime_config_stopping')
    service.resumeVideoAnalysis(); assert.strictEqual((await service.getVideoAnalysisRuntimeConfig()).llmName, 'api fixture')
  } finally {
    removeListener()
    await Promise.all([service.disposeVideoAnalysis(), vlm.disposeVlmService()])
    await service.disposeRuntimeConfiguration()
    await settings.flushSettingsWrites()
    await new Promise(done => origin.close(done))
    unregister(); core.setCoreResolver(null)
  }
}

async function main() {
  try {
    await storeBehavior(); await productionBehavior()
    console.log('analysis config store passed: serialized patches/reads, atomic publication, filesystem/metadata rollback, recovery copy, bounded input/queue, migration, no-op reads/saves, actual service/VLM/directory/reset IPC and shutdown')
  } finally {
    await Promise.all(stores.map(store => store.close()))
    process.chdir(root)
    assert.strictEqual(path.dirname(path.resolve(fixture)), parent)
    await removeTempRootWithRetry(fixture)
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
