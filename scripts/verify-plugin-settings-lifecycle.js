const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto')
const { createRequire } = require('node:module')
const { spawnSync } = require('node:child_process')
const { createSettingsJson } = require('../main/application/settings-json')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
fs.mkdirSync(parent, { recursive: true })
const fixture = fs.mkdtempSync(path.join(parent, 'plugin-settings-')), cases = [], apis = [], gates = []
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async check => { const end = Date.now() + 5000; while (!check()) { if (Date.now() > end) throw Error('Plugin settings condition timed out'); await delay(3) } }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); const value = { promise, resolve }; gates.push(value); return value }
const timeout = setTimeout(() => { console.error('Plugin settings verification timed out'); process.exit(1) }, 45000)
let sequence = 0
function load(file, overrides = {}, sourceRoot = root) {
  const filename = path.join(root, file), normal = createRequire(filename), module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(sourceRoot, file), 'utf8'), {
    module, exports: module.exports, require: name => Object.hasOwn(overrides, name) ? overrides[name] : normal(name),
    JSON, Buffer, console, process, setTimeout, clearTimeout, setImmediate, clearImmediate, structuredClone, URL
  }, { filename })
  return module.exports
}
function owner({ sourceRoot = root } = {}) {
  let directory = path.join(fixture, 'case-' + (++sequence)), prepareCount = 0, pause = null, fault = null
  fs.mkdirSync(directory)
  const filename = path.join(directory, 'settings.json'), library = path.join(directory, 'library')
  fs.mkdirSync(library)
  const input = { schemaVersion: 1, theme: 'dark', directories: [library], privateDirectories: [],
    customTags: Object.fromEntries(Array.from({ length: 10000 }, (_, i) => ['file-' + i, ['tag-' + i]])),
    privacy: { salt: 'a'.repeat(32), passwordHash: 'b'.repeat(64) },
    plugins: { fixture: { enabled: true, config: { count: 0, name: 'stored' }, installedAt: 'fixture-installed' } },
    fixtureSection: { value: 7 }, untouched: { nested: ['keep'] }, remoteAccess: { enabled: false } }
  fs.writeFileSync(filename, JSON.stringify(input))
  const codec = createSettingsJson()
  const controlled = { ...codec, async prepare(...args) {
    prepareCount++
    if (pause) { const current = pause; pause = null; current.entered = true; await current.promise }
    if (fault) { const error = fault; fault = null; throw error }
    return codec.prepare(...args)
  } }
  const api = load('main/settings.js', { electron: {}, './user-data': { getUserDataDir: () => directory },
    './application/settings-json': { createSettingsJson: () => controlled } }, sourceRoot)
  const value = { api, codec, filename, library, input, prepareCount: () => prepareCount,
    pauseNext() { return pause = deferred() }, failNext(error) { fault = error }, move(next) { directory = next } }
  apis.push(value)
  return value
}
function registryFor(api, sourceRoot = root) {
  const warnings = [], handlers = new Map(), ipcMain = { handle: (key, handler) => handlers.set(key, handler), removeHandler: key => handlers.delete(key) }
  const core = load('main/plugins/core-api.js', { '../settings': api }, sourceRoot)
  const registry = load('main/plugins/registry.js', { '../settings': api, '../security/ipc': { ipcMain }, './core-api': core,
    'electron-log': { warn: (...args) => warnings.push(args.map(String).join(' ')) } }, sourceRoot).createPluginRegistry({ ipcMain })
  return { registry, warnings, core }
}
async function counted(operation) {
  const parse = JSON.parse, stringify = JSON.stringify, realpath = fs.realpathSync.native
  const counts = { fullParses: 0, fullStringifies: 0, syncRealpaths: 0 }
  const full = value => value && typeof value === 'object' && ['customTags', 'directories', 'privacy'].every(key => Object.hasOwn(value, key))
  JSON.parse = function (...args) { const result = parse.apply(this, args); if (full(result)) counts.fullParses++; return result }
  JSON.stringify = function (value, ...args) { if (full(value)) counts.fullStringifies++; return stringify.call(this, value, ...args) }
  fs.realpathSync.native = function (...args) { counts.syncRealpaths++; return realpath.apply(this, args) }
  try { await operation() } finally { JSON.parse = parse; JSON.stringify = stringify; fs.realpathSync.native = realpath }
  return counts
}
const plain = value => JSON.parse(JSON.stringify(value))
function definition(log = []) {
  return { defaults: { value: 1 }, normalize(value) {
    log.push(value?.value ?? 'missing')
    return { toJSON(key) { log.push('json:' + key); return { value: value?.value ?? 1, key } } }
  } }
}
async function registryComparison(sourceRoot) {
  const state = owner({ sourceRoot }), { api } = state
  await api.initializeSettings()
  const { registry, warnings } = registryFor(api, sourceRoot), callbacks = []
  let context
  const plugin = { id: 'fixture', name: 'Fixture', enabled: true, executable: true,
    settingsSections: { fixtureSection: definition(callbacks) },
    settingsDefaults: { count: 1, name: 'default' }, settingsSchema: { count: { type: 'number' }, name: { type: 'string' } },
    setup(ctx) { context = ctx; assert.equal(ctx.plugins.getConfig().count, 0) } }
  const setup = await counted(async () => { await registry.setup([plugin]); await api.flushSettingsWrites() })
  assert.equal(registry.getPlugin('fixture').status, 'active')
  const snapshot = api.loadSettings()
  assert.equal(snapshot.fixtureSection.value, 7); assert.equal(snapshot.fixtureSection.key, 'fixtureSection')
  assert.equal(snapshot.plugins.fixture.config.count, 0); assert.equal(snapshot.plugins.fixture.installedAt, 'fixture-installed')
  assert.deepEqual(plain(snapshot.untouched), { nested: ['keep'] })
  const selectedReads = await counted(async () => {
    const config = context.plugins.getConfig(); config.name = 'outside'
    assert.equal(context.plugins.getConfig().name, 'stored')
    const list = registry.listPlugins(); list[0].config.count = 999
    assert.equal(registry.listPlugins()[0].config.count, 0)
  })
  const disable = await counted(async () => { assert.equal((await registry.setPluginEnabled('fixture', false)).success, true) })
  const unregister = await counted(async () => { assert.equal(await registry.unregister('fixture'), true); await api.flushSettingsWrites() })
  assert.equal(warnings.length, 0)
  const disk = JSON.parse(fs.readFileSync(state.filename, 'utf8'))
  assert.equal(disk.plugins.fixture.enabled, false); assert.equal(disk.customTags['file-9999'][0], 'tag-9999')
  await registry.dispose()
  return { setup, selectedReads, disable, unregister, callbacks }
}
async function comparisons() {
  const after = await registryComparison(root), baseline = path.join(parent, 'r7-plugin-settings/baseline')
  let before = null
  if (fs.existsSync(path.join(baseline, 'main/settings.js'))) {
    before = await registryComparison(baseline)
    assert.ok(before.setup.fullParses > 0 && before.unregister.fullParses > 0 && before.selectedReads.fullParses > 0)
    assert.deepEqual(after.callbacks, before.callbacks)
  }
  for (const [name, counts] of Object.entries(after)) if (name !== 'callbacks') assert.deepEqual(counts, { fullParses: 0, fullStringifies: 0, syncRealpaths: 0 }, name)
  cases.push('real registry setup, selected reads, disable and unregister avoid full main JSON/realpath work with 10000 tags; captured previous modules provide the same positive control and callback results')
  return { tags: 10000, before, after }
}
async function sectionSemantics() {
  const state = owner(), { api } = state, original = fs.readFileSync(state.filename)
  await api.initializeSettings()
  const callbacks = [], remove = await api.registerSettingsSectionAsync('fixtureSection', definition(callbacks))
  assert.deepEqual(callbacks, [1, 7, 'json:fixtureSection'])
  const section = api.loadSettingsFields(['fixtureSection']).fixtureSection
  section.value = 900; assert.equal(api.loadSettingsFields(['fixtureSection']).fixtureSection.value, 7)
  assert.deepEqual(fs.readFileSync(state.filename), original, 'registration preparation is read-only')
  const override = await api.registerSettingsSectionAsync('playbackMode', { normalize: () => 'plugin-mode' })
  assert.equal(api.loadSettingsFields(['playbackMode']).playbackMode, 'plugin-mode')
  await override(); assert.equal(api.loadSettingsFields(['playbackMode']).playbackMode, 'order')
  const special = await api.registerSettingsSectionAsync('__proto__', { normalize: () => ({ safe: 'own' }) })
  const fields = api.loadSettingsFields(['__proto__'])
  assert.equal(Object.hasOwn(fields, '__proto__'), true); assert.equal(fields.__proto__.safe, 'own'); assert.equal(Object.prototype.safe, undefined)
  await special(); const first = remove(), second = remove(); assert.equal(first, second); await first
  const replacement = await api.registerSettingsSectionAsync('fixtureSection', { normalize: () => ({ replacement: true }) })
  await remove(); assert.equal(api.loadSettingsFields(['fixtureSection']).fixtureSection.replacement, true)
  await replacement()
  const facade = registryFor(api).core.requireCoreModule('settings')
  assert.equal(facade.registerSettingsSectionAsync, undefined); assert.equal(typeof facade.registerSettingsSection, 'function')
  cases.push('registered defaults, callback order, keyed JSON, detached ownership, builtin overrides and special own keys are preserved; preparation stays read-only and an old disposer cannot remove a new owner')
}
async function concurrentWrites() {
  const state = owner(), { api } = state
  await api.initializeSettings()
  const gate = state.pauseNext(), count = state.prepareCount(), pending = api.registerSettingsSectionAsync('queued', { normalize: value => ({ number: value?.number ?? 1 }) })
  await until(() => gate.entered)
  let committed = false
  const commit = api.commitSettingsPatch({ theme: 'light' }, { returnSettings: false }).then(() => { committed = true })
  api.saveSettings({ favorites: ['newer-sync-intent'] })
  await delay(100); assert.equal(committed, false)
  gate.resolve(); const remove = await pending; await commit; await api.flushSettingsWrites()
  const value = api.loadSettings(); assert.equal(value.theme, 'light'); assert.equal(value.favorites[0], 'newer-sync-intent'); assert.equal(value.queued.number, 1)
  assert.ok(state.prepareCount() >= count + 2, 'new synchronous cache forces a fresh owned preparation')
  const disk = JSON.parse(fs.readFileSync(state.filename, 'utf8')); assert.equal(disk.theme, 'light'); assert.equal(disk.favorites[0], 'newer-sync-intent')
  await remove()
  cases.push('section preparation shares the real durable queue, retries a superseding synchronous cache and lets queued/debounced writes commit without busy-worker failures or lost intent')
}
async function failuresAndRetirement() {
  const state = owner(), { api } = state
  await api.initializeSettings()
  const baseline = api.loadSettings(), original = fs.readFileSync(state.filename)
  await assert.rejects(api.registerSettingsSectionAsync('broken', { normalize() { throw Error('expected section callback failure') } }), /expected section/)
  assert.deepEqual(plain(api.loadSettings()), plain(baseline)); assert.deepEqual(fs.readFileSync(state.filename), original)
  const retry = await api.registerSettingsSectionAsync('broken', { normalize: () => ({ good: true }) }); await retry()
  state.failNext(Object.assign(Error('expected worker failure'), { code: 'settings_serializer_stopped' }))
  await assert.rejects(api.registerSettingsSectionAsync('fault', {}), { code: 'settings_serializer_stopped' })
  const healthy = await api.registerSettingsSectionAsync('fault', {}); await healthy()
  const duplicate = await api.registerSettingsSectionAsync('duplicate', {})
  await assert.rejects(api.registerSettingsSectionAsync('duplicate', {}), /already registered/); await duplicate()
  await assert.rejects(api.registerSettingsSectionAsync('schemaVersion', {}), /reserved/)
  cases.push('callback and worker failure leave the cache/files unchanged, roll back the registered definition and allow a real retry; duplicates and storage metadata remain rejected')

  const closing = owner(); await closing.api.initializeSettings()
  const gate = closing.pauseNext(), pending = closing.api.registerSettingsSectionAsync('late', {})
  const rejected = assert.rejects(pending, { code: 'app_quitting' })
  await until(() => gate.entered); await closing.api.disposeSettingsSerialization({ cancel: true }); gate.resolve(); await rejected
  assert.deepEqual(closing.codec.diagnostics(), { worker: false, active: false, closed: true })
  const retired = owner(); await retired.api.initializeSettings()
  const other = owner(), scopeGate = retired.pauseNext(), old = retired.api.registerSettingsSectionAsync('retired', {})
  const noPublish = assert.rejects(old, { code: 'settings_sections_retired' })
  await until(() => scopeGate.entered); retired.move(path.dirname(other.filename)); scopeGate.resolve(); await noPublish
  await retired.api.initializeSettings(); assert.equal(retired.api.loadSettingsFields(['retired']).retired, undefined)
  const cleanup = await retired.api.registerSettingsSectionAsync('after-close', {})
  await retired.api.disposeSettingsSerialization({ cancel: true }); await cleanup()
  assert.deepEqual(retired.codec.diagnostics(), { worker: false, active: false, closed: true })
  cases.push('shutdown and changed profile scopes retire pending registration without late publication; disposal after serializer shutdown removes its owner without reviving a worker')
}
async function bridgeReads() {
  const state = owner(), { api } = state; await api.initializeSettings()
  await api.commitSettingsPatch({ playbackMode: 'shuffle', videoAnalysis: { enabled: false }, remoteAccess: { allowLegacyToken: true } }, { returnSettings: false })
  let auth = { authorized: true, type: 'legacy' }, played
  const core = load('main/plugins/core-api.js', { '../settings': api, '../remote/identity': { getAccessTokenHashAuthorization: () => auth } })
  const capabilities = load('main/plugins/capabilities.js', { '../settings': api,
    '../scanner': { assertAllowedVideoPath: async value => value },
    '../mpv-integration': { mpvManager: { play: async (file, options) => { played = { file, options } } } },
    '../remote/video-index': { getPathForVideoId: id => id === 'fixture-id' ? state.library : null } })
  const query = capabilities.createCoreCapabilities({ getCapability: () => ({}) })
  const counters = await counted(async () => {
    assert.equal(core.requireCoreModule('remote/authorization').isAuthorized('hash'), true)
    await capabilities.playVideo('fixture-id'); assert.equal(played.options.mode, 'shuffle')
    assert.equal((await query['video-analysis.summary'].start('fixture-id')).reason, 'disabled')
  })
  assert.deepEqual(counters, { fullParses: 0, fullStringifies: 0, syncRealpaths: 0 })
  await api.commitSettingsPatch({ remoteAccess: { allowLegacyToken: false } }, { returnSettings: false })
  assert.equal(core.requireCoreModule('remote/authorization').isAuthorized('hash'), false)
  auth = { authorized: true, type: 'paired' }; assert.equal(core.requireCoreModule('remote/authorization').isAuthorized('hash'), true)
  auth = { authorized: false, type: 'paired' }; assert.equal(core.requireCoreModule('remote/authorization').isAuthorized('hash'), false)
  cases.push('actual plugin authorization/player/analysis bridges read only selected fields, retain fresh legacy-token revocation and preserve paired authorization/default playback behavior')
  return counters
}
async function registryShutdown() {
  const state = owner(); await state.api.initializeSettings()
  const { registry } = registryFor(state.api), gate = state.pauseNext()
  let activated = 0, disposed = false
  const pending = registry.setup([{ id: 'closing', enabled: true, settingsSections: { closing: {} }, setup() { activated++ } }])
  const rejected = assert.rejects(pending, { code: 'plugin_service_stopping' })
  await until(() => gate.entered)
  const shutdown = registry.dispose().then(() => { disposed = true })
  await delay(20); assert.equal(disposed, false)
  gate.resolve(); await rejected; await shutdown
  assert.equal(activated, 0); assert.equal(registry.listPlugins().length, 0)
  await registry.setup([{ id: 'restarted', enabled: true, setup() { activated++ } }])
  assert.equal(activated, 1); await registry.dispose()
  cases.push('registry disposal drains an in-progress declared-section setup, prevents late plugin activation/error placeholders and permits an explicit later setup')
}
async function latestBootstrap() {
  const state = owner(), { api } = state; await api.initializeSettings()
  const update = api.updateSettingsAndFlush
  let preceding
  api.updateSettingsAndFlush = (...args) => {
    preceding = api.commitSettingsPatch({ plugins: { fixture: { config: { count: 0, name: 'fresh-before-bootstrap' } } } }, { returnSettings: false })
    return update(...args)
  }
  const { registry } = registryFor(api)
  let observed
  await registry.setup([{ id: 'fixture', enabled: true, settingsSchema: { count: { type: 'number' }, name: { type: 'string' } },
    settingsDefaults: { count: 9, name: 'default' }, setup(ctx) { observed = ctx.plugins.getConfig() } }])
  await preceding
  assert.equal(observed.name, 'fresh-before-bootstrap'); assert.equal(observed.count, 0)
  const disk = JSON.parse(fs.readFileSync(state.filename, 'utf8'))
  assert.equal(disk.plugins.fixture.config.name, 'fresh-before-bootstrap')
  assert.equal(disk.plugins.fixture.installedAt, 'fixture-installed')
  await registry.dispose()
  cases.push('config bootstrap selects the latest plugin state inside the durable queue, preserves zero values/install metadata and cannot overwrite a preceding committed config with its earlier snapshot')
}
async function manifestRetirement() {
  const state = owner(); await state.api.initializeSettings()
  const { registry } = registryFor(state.api), gate = deferred()
  let calls = 0, activated = 0, capabilities = 0
  const plugin = { id: 'manifest-fixture', enabled: true, setup() { activated++ } }
  const service = load('main/plugins/index.js', { '../settings': state.api,
    './registry': { createPluginRegistry: () => registry }, './builtin': { loadOfficialPluginImplementation: value => value },
    './loader': { listExternalPluginManifests: async () => { if (++calls === 1) await gate.promise; return [plugin] } },
    './capabilities': { createCoreCapabilities: () => { capabilities++; return {} } } })
  const pending = service.setupPlugins(), rejected = assert.rejects(pending, { code: 'plugin_service_stopping' })
  await until(() => calls === 1)
  const closing = service.disposePlugins(); assert.equal(closing, service.disposePlugins()); await closing
  gate.resolve(); await rejected
  assert.equal(activated, 0); assert.equal(capabilities, 0); assert.equal(registry.listPlugins().length, 0)
  await service.setupPlugins(); assert.equal(activated, 1); assert.equal(capabilities, 1); await service.disposePlugins()
  cases.push('a manifest scan retired by plugin-service shutdown cannot register core capabilities or activate plugins; disposal coalesces and an explicit later service setup can restart')
}
function nativeShutdown() {
  const results = []
  for (const mode of ['guard-control', 'current']) {
    const directory = path.join(fixture, 'native-' + mode); fs.mkdirSync(directory)
    const env = { ...process.env, WALLPAPER_PLUGIN_SETTINGS_FIXTURE: directory, WALLPAPER_PLUGIN_SETTINGS_MODE: mode }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawnSync(require('electron'), [path.join(__dirname, 'verify-plugin-settings-electron.js')], {
      cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024
    })
    fs.writeFileSync(path.join(directory, 'process-output.json'), JSON.stringify({ status: child.status, signal: child.signal,
      error: child.error?.message || null, stdout: child.stdout, stderr: child.stderr }, null, 2))
    assert.ifError(child.error); assert.equal(child.status, 0, child.stderr)
    const result = JSON.parse(fs.readFileSync(path.join(directory, 'result.json'), 'utf8'))
    assert.equal(result.passed, true, JSON.stringify(result)); assert.equal(result.closedSettingsDrain, true)
    assert.equal(result.windows.length, 0); results.push(result)
  }
  cases.push('actual Electron main startup/quit drains official plugin setup and cannot restart services; removing only the new quit guard reaches the controlled boundary as a positive control, with zero windows in both modes')
  return results
}
async function main() {
  const comparison = await comparisons(); await sectionSemantics(); await concurrentWrites(); await failuresAndRetirement(); const bridge = await bridgeReads(); await registryShutdown(); await latestBootstrap(); await manifestRetirement()
  const native = nativeShutdown()
  const files = ['main/settings.js', 'main/index.js', 'main/plugins/registry.js', 'main/plugins/index.js', 'main/plugins/core-api.js', 'main/plugins/capabilities.js', 'scripts/verify-plugin-settings-lifecycle.js', 'scripts/verify-plugin-settings-electron.js']
  const result = { date: new Date().toISOString(), passed: true, fixture, cases, comparison, bridge, native,
    sourceDigests: Object.fromEntries(files.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])),
    scope: 'Real Node workers/storage/settings and actual registry/core bridge modules in isolated VM owners, with 10000 generated tag keys. Actual Electron main and official plugin startup/quit, with the first post-quit IPC boundary controlled. Controlled plugin callbacks, worker delays/failure, manager/path/authorization dependencies in Node cases. No native window, decoder, external plugin installation or interactive latency/memory budget acceptance.' }
  fs.writeFileSync(path.join(fixture, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result))
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  for (const gate of gates) gate.resolve()
  for (const state of apis) { await state.api.flushSettingsWrites().catch(() => {}); await state.api.disposeSettingsSerialization({ cancel: true }) }
  clearTimeout(timeout)
})
