const assert = require('assert'), fs = require('fs'), fsp = require('fs/promises'), path = require('path')
const { phone } = require('./mobile-module-harness')
const { createHookHarness } = require('./verify-mobile-player-behavior')
const { removeTempRootWithRetry } = require('./verify-helpers')
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const next = async () => { for (let index = 0; index < 60; index++) await Promise.resolve() }
const plain = value => JSON.parse(JSON.stringify(value))
const remote = (revision, patch = {}) => ({ running: true, endpoint: 'http://fixture:38127', settings: { port: 38127, enabled: true, keepRunningInTray: true, allowLegacyToken: false }, ...patch,
  _remoteVersion: { epoch: 'remote-fixture', revision } })
const plugin = (id, revision = 1, config = {}) => ({ id, name: id, enabled: false, canEnable: true, uninstallable: true,
  settingsSchema: { title: { type: 'string' }, count: { type: 'number' }, object: { type: 'object' }, list: { type: 'array' }, enabled: { type: 'boolean' } },
  config: { title: id, count: 5, object: {}, list: ['initial'], enabled: false, ...config }, _settingsVersion: { epoch: 'plugin-fixture', revision } })

async function remoteBehavior() {
  const client = phone(), timers = new Map(), intervals = new Map(); let sequence = 0
  client.control.globals = { setTimeout: (fn, ms) => { const id = ++sequence; timers.set(id, { fn, ms }); return id }, clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => { const id = ++sequence; intervals.set(id, { fn, ms }); return id }, clearInterval: id => intervals.delete(id) }
  const { RemoteSettings } = client.load('src/services/remote-settings.js')
  const reads = [], saves = [], pairs = [], copies = [], views = []
  const api = { remoteGetState: () => { const item = deferred(); reads.push(item); return item.promise },
    remoteSaveSettings: patch => { const item = deferred(); saves.push({ ...item, patch }); return item.promise },
    remoteCreatePairingCode: () => { const item = deferred(); pairs.push(item); return item.promise },
    remoteCopyToken: async () => { throw Error('copy denied') }, remoteCopyPairingCode: async code => { copies.push(code); return { success: true } } }
  const owner = new RemoteSettings(api, value => views.push(value), { remoteAccess: { port: 38127 } })
  try {
    owner.setActive(true); owner.editPort('40001'); owner.refresh(); owner.refresh()
    assert.strictEqual(reads.length, 1, 'refreshes coalesce behind one active status read')
    owner.event(remote(2)); reads[0].resolve(remote(1)); await next()
    assert.strictEqual(owner.view.remotePort, '40001'); assert.strictEqual(owner.view.remoteState._remoteVersion.revision, 2)
    const toggle = owner.save({ allowLegacyToken: true }); await next()
    assert.deepStrictEqual(plain(saves[0].patch), { allowLegacyToken: true }, 'toggles do not submit the unsaved port or stale unrelated preferences')
    saves[0].resolve(remote(3, { settings: { ...remote(1).settings, allowLegacyToken: true } })); await toggle
    assert.strictEqual(owner.view.remotePort, '40001'); assert.strictEqual(owner.view.remoteDirty, true)
    const save = owner.save(); await next(); owner.editPort('40002')
    saves[1].resolve(remote(4, { settings: { ...remote(1).settings, port: 40001 } })); await save
    assert.strictEqual(owner.view.remotePort, '40002'); assert.strictEqual(owner.view.remoteDirty, true)
    const failed = owner.save(); await next(); saves[2].reject(Error('disk failed')); await failed
    assert.strictEqual(owner.view.remoteError, 'disk failed'); assert.strictEqual(owner.view.remotePort, '40002')
    owner.editPort('99999'); assert.strictEqual((await owner.save()).success, false); assert.strictEqual(saves.length, 3)
    owner.editPort('40003'); const retry = owner.save(); await next()
    saves[3].resolve(remote(5, { settings: { ...remote(1).settings, port: 40003 } })); await retry
    assert.strictEqual(owner.view.remoteDirty, false)
    const copy = await owner.action('copy-token', 'remoteCopyToken'); assert.strictEqual(copy.success, false)
    assert.strictEqual(owner.view.remoteError, 'copy denied')

    const pairing = owner.action('pair', 'remoteCreatePairingCode'); await next()
    assert.strictEqual(owner.action('pair', 'remoteCreatePairingCode'), pairing, 'duplicate actions have one owner')
    pairs[0].resolve({ pairingCode: 'fixture-code', qrDataUrl: 'data:image/png,fixture', expiresAt: Date.now() + 30000 }); await pairing
    assert.strictEqual(intervals.size, 1)
    await owner.copyPairing(); assert.strictEqual(copies[0], 'fixture-code')
    const readCount = reads.length
    owner.view.pairingCode.expiresAt = Date.now() - 1
    for (const interval of [...intervals.values()]) interval.fn()
    assert.strictEqual(intervals.size, 0); assert.strictEqual(reads.length, readCount, 'the local QR countdown does not issue native reads')
    assert.strictEqual((await owner.copyPairing()).success, false); assert.strictEqual(copies.length, 1)
    const stalePair = owner.action('pair', 'remoteCreatePairingCode'); await next()
    owner.event(remote(6, { endpoint: 'http://new-address:40003' }))
    pairs[1].resolve({ pairingCode: 'obsolete-address', expiresAt: Date.now() + 30000 }); await stalePair
    assert.strictEqual(owner.view.pairingCode, null); assert.ok(owner.view.remoteError.includes('地址已变化'))
    assert.strictEqual(intervals.size, 0)
    owner.setActive(false); const hidden = views.length
    owner.event(remote(99)); await next(); assert.strictEqual(views.length, hidden)
    assert.strictEqual(timers.size, 0); assert.strictEqual(intervals.size, 0)
    owner.setActive(true); await next()
    const afterResume = reads.length
    reads.at(-1).resolve(remote(7)); await next()
    assert.ok(afterResume >= 2)
    const hiddenPair = owner.action('pair', 'remoteCreatePairingCode'); await next(); owner.setActive(false)
    pairs[2].resolve({ pairingCode: 'hidden-code', expiresAt: Date.now() + 30000 }); await hiddenPair
    assert.strictEqual(owner.view.pairingCode, null); assert.strictEqual(intervals.size, 0)
  } finally { owner.dispose() }
  assert.strictEqual(timers.size + intervals.size, 0)
  // Drain any uncancellable old status reads after disposal; no timer or view can revive.
  const disposed = views.length; reads.forEach(item => item.resolve(remote(100))); await next(); assert.strictEqual(views.length, disposed)
}

async function pluginBehavior() {
  const client = phone(), { PluginSettings } = client.load('src/services/plugin-settings.js')
  const saves = [], installs = [], views = []; let catalog = [plugin('a'), plugin('b')], failList = false
  const api = { savePluginConfig: (id, patch) => { const item = deferred(); saves.push({ ...item, id, patch }); return item.promise },
    installPlugin: () => { const item = deferred(); installs.push(item); return item.promise },
    setPluginEnabled: async id => ({ success: true, plugin: plugin(id) }) }
  const owner = new PluginSettings(api, async () => { if (failList) throw Error('list failed'); return catalog }, value => views.push(value), catalog)
  try {
    owner.setActive(true); await next()
    owner.edit('title', 'first a'); owner.editUi({ trustedSiteInput: 'unfinished.site' }); owner.select('b'); owner.edit('title', 'b draft')
    owner.select('a'); assert.strictEqual(owner.view.configDrafts.title, 'first a'); assert.strictEqual(owner.view.pluginUi.trustedSiteInput, 'unfinished.site')
    const saving = owner.save(); await next(); assert.deepStrictEqual(Object.keys(saves[0].patch), ['title'])
    owner.edit('title', 'a while saving'); catalog = [plugin('a', 3, { title: 'first a', count: 8 }), plugin('b')]
    owner.reconcile(catalog); saves[0].resolve({ success: true, plugin: plugin('a', 2, { title: 'first a' }) }); await saving
    assert.strictEqual(owner.view.configDrafts.title, 'a while saving')
    assert.strictEqual(owner.view.configDrafts.count, '8'); assert.strictEqual(owner.view.draftChanged, true)
    owner.select('b'); assert.strictEqual(owner.view.configDrafts.title, 'b draft')
    owner.edit('title', 'late a event', 'a'); assert.strictEqual(owner.view.configDrafts.title, 'b draft', 'callbacks remain scoped to the plugin that rendered them')
    owner.select('a'); assert.strictEqual(owner.view.configDrafts.title, 'late a event')
    const failed = owner.save(); await next(); saves[1].reject(Error('plugin disk failed')); await failed
    assert.strictEqual(owner.view.configDrafts.title, 'late a event'); assert.strictEqual(owner.view.messageError, true)
    owner.edit('count', ''); await owner.save(); assert.ok(owner.view.configErrors.count); assert.strictEqual(saves.length, 2)
    owner.edit('count', '6'); owner.edit('object', '[1]'); await owner.save(); assert.ok(owner.view.configErrors.object)
    owner.edit('object', { header: 'value' }); owner.edit('list', '["new"]')
    const retried = owner.save(); await next(); catalog = [plugin('a', 4, { title: 'late a event', count: 6, object: { header: 'value' }, list: ['new'] }), plugin('b')]
    saves[2].resolve({ success: true, plugin: catalog[0] }); await retried; assert.strictEqual(owner.view.draftChanged, false)
    owner.edit('title', 'text left unsaved'); const toggle = owner.commit('enabled', true); await next()
    assert.deepStrictEqual(Object.keys(saves[3].patch), ['enabled'], 'immediate fields do not submit unrelated text drafts')
    catalog = [plugin('a', 5, { title: 'late a event', count: 6, enabled: true }), plugin('b')]
    saves[3].resolve({ success: true, plugin: catalog[0] }); await toggle
    assert.strictEqual(owner.view.configDrafts.title, 'text left unsaved'); assert.strictEqual(owner.view.draftChanged, true)
    failList = true; await owner.load(true); assert.strictEqual(owner.view.pluginLoadError, 'list failed')
    failList = false; await owner.load(true); assert.strictEqual(owner.view.pluginLoadError, '')
    const install = owner.install(); await next(); owner.select('b')
    catalog = [...catalog, plugin('installed')]; installs[0].resolve({ success: true, plugin: catalog[2] }); await install
    assert.strictEqual(owner.view.activePluginId, 'b', 'a late installation does not steal an explicit later selection')
    owner.reconcile(catalog.filter(item => item.id !== 'a')); assert.strictEqual(owner.models.has('a'), false)
    owner.select('b'); const pending = owner.save(); await next(); const count = views.length; owner.dispose()
    saves.at(-1).resolve({ success: true, plugin: plugin('b', 9) }); await pending
    assert.strictEqual(views.length, count); assert.strictEqual(owner.models.size, 0)
  } finally { owner.dispose() }
}

async function hookBehavior() {
  const client = phone(), harness = createHookHarness(client), visibility = new Set(), events = new Set(), reads = []
  const document = { visibilityState: 'visible', addEventListener: (_name, fn) => visibility.add(fn), removeEventListener: (_name, fn) => visibility.delete(fn) }
  client.control.globals = { ...client.control.globals, document, window: { electronAPI: {
    remoteGetState: () => { const item = deferred(); reads.push(item); return item.promise }, onRemoteAccessState: fn => { events.add(fn); return () => events.delete(fn) }
  } } }
  const { useRemoteSettings } = client.load('src/hooks/useRemoteSettings.js')
  harness.mount(() => useRemoteSettings({ remoteAccess: { port: 38127 } })); await harness.settle()
  assert.strictEqual(reads.length, 1)
  harness.tree().setRemotePort('44444'); events.forEach(fn => fn(remote(2))); reads[0].resolve(remote(1)); await harness.settle()
  assert.strictEqual(harness.tree().remotePort, '44444')
  document.visibilityState = 'hidden'; visibility.forEach(fn => fn()); const before = reads.length
  events.forEach(fn => fn(remote(3))); await harness.settle(); assert.strictEqual(reads.length, before)
  harness.unmount(); assert.strictEqual(events.size + visibility.size, 0)
  assert.deepStrictEqual(harness.diagnostics(), { intervals: 0, timers: 0, frames: 0, listeners: 0 })
}

async function ownerQueues() {
  for (const kind of ['remote', 'plugin']) {
    const client = phone(), gate = deferred(), calls = [], owners = []
    client.control.globals = { setInterval, clearInterval }
    const api = kind === 'remote' ? { remoteGetState: async () => remote(1), remoteSaveSettings: async patch => {
      calls.push(patch.port); if (calls.length === 1) await gate.promise
      return remote(calls.length + 1, { settings: { ...remote(1).settings, port: patch.port } })
    } } : { savePluginConfig: async (id, patch) => {
      calls.push(patch.title); if (calls.length === 1) await gate.promise
      return { success: true, plugin: plugin(id, calls.length + 1, patch) }
    } }
    const Controller = kind === 'remote' ? client.load('src/services/remote-settings.js').RemoteSettings : client.load('src/services/plugin-settings.js').PluginSettings
    const create = value => {
      const owner = kind === 'remote' ? new Controller(api, () => {}, {}) : new Controller(api, async () => [plugin('a')], () => {}, [plugin('a')])
      owners.push(owner); owner.setActive(true)
      if (kind === 'remote') owner.editPort(String(value)); else owner.edit('title', value)
      return owner
    }
    try {
      const old = create(43001), first = old.save(); await next(); old.dispose()
      const skipped = create(43002), second = skipped.save(); skipped.dispose()
      const current = create(43003), third = current.save(); await next()
      assert.deepStrictEqual(calls, [kind === 'remote' ? 43001 : '43001'], kind + ' native work remains serialized across panel owners')
      gate.resolve(); await Promise.all([first, second, third])
      assert.deepStrictEqual(calls, kind === 'remote' ? [43001, 43003] : ['43001', '43003'], kind + ' disposed queued work never reaches native code')
    } finally { gate.resolve(); owners.forEach(owner => owner.dispose()) }
  }
  const { createSettingsQueue } = phone().load('src/services/settings-operations.js'), gate = deferred(), queue = createSettingsQueue(2)
  const first = queue(() => gate.promise), second = queue(async () => 2)
  await assert.rejects(queue(async () => 3), /操作过多/); gate.resolve(); await Promise.all([first, second])
  assert.strictEqual(await queue(async () => 4), 4, 'queue capacity is restored only after admitted work settles')
}

async function mainBehavior() {
  const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
  await fsp.mkdir(parent, { recursive: true }); const fixture = await fsp.mkdtemp(path.join(parent, 'settings-panels-')); process.chdir(fixture)
  const settings = require('../main/settings'), remoteService = require('../main/remote')
  try {
    await settings.saveSettingsAndFlush({ remoteAccess: { enabled: false, port: 42001, keepRunningInTray: false, allowLegacyToken: true } })
    const initial = remoteService.getRemoteState(), same = remoteService.getRemoteState()
    assert.deepStrictEqual(initial._remoteVersion, same._remoteVersion)
    const changed = await remoteService.applyRemoteSettings({ port: 42002 })
    assert.strictEqual(changed.settings.allowLegacyToken, true); assert.strictEqual(changed.settings.keepRunningInTray, false)
    assert.ok(changed._remoteVersion.revision > initial._remoteVersion.revision)
    await assert.rejects(remoteService.applyRemoteSettings({ port: 99999 }), /端口/)
    assert.strictEqual(remoteService.getRemoteState().settings.port, 42002)
    await Promise.all([
      settings.saveSettingsAndFlush({ remoteAccess: { allowLegacyToken: false, keepRunningInTray: true } }),
      remoteService.applyRemoteSettings({ port: 42003 })
    ])
    const concurrent = remoteService.getRemoteState().settings
    assert.strictEqual(concurrent.port, 42003); assert.strictEqual(concurrent.allowLegacyToken, false); assert.strictEqual(concurrent.keepRunningInTray, true)
    const registry = require('../main/plugins').pluginRegistry
    await registry.register({ id: 'panel-fixture', name: 'Panel fixture', enabled: false, setup() {}, secretKeys: ['secret'], settingsDefaults: { title: 'before', secret: 'fixture-secret', count: 1 },
      settingsSchema: { title: { type: 'string' }, secret: { type: 'string' }, count: { type: 'number' } } })
    await settings.flushSettingsWrites()
    const handlers = new Map(); require('../main/ipc/plugins').registerPluginIpc({ handle: (name, fn) => handlers.set(name, fn) })
    const save = input => handlers.get('plugins-save-config')(null, 'panel-fixture', input)
    const [one, two] = await Promise.all([save({ title: 'after' }), save({ count: 9, secret: '***' })])
    assert.strictEqual(one.success && two.success, true)
    const config = settings.loadSettings().plugins['panel-fixture'].config
    assert.strictEqual(config.title, 'after'); assert.strictEqual(config.count, 9); assert.strictEqual(config.secret, 'fixture-secret')
    assert.strictEqual(two.plugin.config.secret, '***'); assert.ok(two.plugin._settingsVersion)
    const rename = fsp.rename, filename = path.join(fixture, '.tmp-wallpaper-player/settings.json'), before = settings.loadSettings()
    fsp.rename = async function (from, to) { if (to === filename) throw Error('panel disk failure'); return rename.call(this, from, to) }
    try {
      const failed = await save({ title: 'must not publish' }); assert.strictEqual(failed.success, false)
      assert.deepStrictEqual(settings.loadSettings(), before)
      const lifecycle = await registry.setPluginEnabled('panel-fixture', true)
      assert.strictEqual(lifecycle.success, false); assert.strictEqual(lifecycle.plugin.enabled, true, 'a failed preference write still reports the actual runtime state')
    } finally { fsp.rename = rename }
    await registry.setPluginEnabled('panel-fixture', false); await registry.dispose()
    const isolated = require('../main/plugins/registry').createPluginRegistry({ ipcMain: { handle() {}, removeHandler() {} } })
    const setup = deferred(), calls = []
    await isolated.register({ id: 'serialized-panel', enabled: false, async setup(ctx) { calls.push('setup'); await setup.promise; calls.push('ready'); ctx.lifecycle.onDispose(() => calls.push('disposed')) } })
    const enable = isolated.setPluginEnabled('serialized-panel', true), disable = isolated.setPluginEnabled('serialized-panel', false)
    await next(); assert.deepStrictEqual(calls, ['setup'])
    setup.resolve(); await Promise.all([enable, disable]); assert.deepStrictEqual(calls, ['setup', 'ready', 'disposed'])
    const restart = isolated.setPluginEnabled('serialized-panel', true), shuttingDown = isolated.dispose()
    await assert.rejects(isolated.setPluginEnabled('serialized-panel', false), error => error.code === 'plugin_service_stopping')
    await Promise.all([restart, shuttingDown]); assert.strictEqual(calls.at(-1), 'disposed'); assert.strictEqual(isolated.listPlugins().length, 0)
  } finally {
    await remoteService.disposeRemoteAccess(); await settings.flushSettingsWrites(); process.chdir(root)
    assert.strictEqual(path.dirname(path.resolve(fixture)), parent); await removeTempRootWithRetry(fixture)
  }
}
async function main() { await remoteBehavior(); await pluginBehavior(); await hookBehavior(); await ownerQueues(); await mainBehavior(); console.log('settings panels passed: production remote/plugin controllers, dirty fields, stale snapshots, pairing/actions/visibility cleanup, cross-owner bounded queues, scoped plugin drafts, native partial saves/secrets, disk failure and serialized lifecycle') }
main().catch(error => { console.error(error); process.exitCode = 1 })
