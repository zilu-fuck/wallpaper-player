const assert = require('assert'), fs = require('fs'), fsp = require('fs/promises'), path = require('path')
const { phone } = require('./mobile-module-harness')
const { createHookHarness } = require('./verify-mobile-player-behavior')
const { removeTempRootWithRetry } = require('./verify-helpers')
const next = async () => { for (let count = 0; count < 40; count++) await Promise.resolve() }
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const version = (revision, patch = {}) => ({ theme: 'dark', favorites: [], playbackMode: 'order', ...patch, _settingsVersion: { epoch: 'fixture-main', revision } })
const plain = value => JSON.parse(JSON.stringify(value))

async function clientBehavior() {
  const { SettingsClient } = phone().load('src/services/settings-client.js')
  const calls = [], errors = [], views = [], reads = []
  const api = { saveSettings: patch => { const item = deferred(); calls.push({ ...item, patch }); return item.promise },
    getSettings: () => { const item = deferred(); reads.push(item); return item.promise } }
  const client = new SettingsClient(api, value => views.push(value), error => errors.push(error))
  client.receive(version(1, { videoAnalysis: { enabled: true, modelDir: 'preserved' } }))
  const first = client.save({ theme: 'light' }), second = client.save({ playbackMode: 'shuffle' })
  await next(); assert.strictEqual(calls.length, 1, 'native writes serialize while all accepted intents remain optimistic')
  assert.strictEqual(client.view.theme, 'light'); assert.strictEqual(client.view.playbackMode, 'shuffle')
  client.receive(version(3, { theme: 'light', favorites: ['from phone'] }))
  calls[0].resolve({ success: true, settings: version(2, { theme: 'light' }) }); await first; await next()
  assert.strictEqual(calls.length, 2)
  assert.strictEqual(client.view.favorites[0], 'from phone', 'an old settings reply cannot erase newer media data')
  assert.strictEqual(client.view.playbackMode, 'shuffle')
  calls[1].resolve({ success: true, settings: version(4, { theme: 'light', favorites: ['from phone'], playbackMode: 'shuffle' }) }); await second
  assert.strictEqual(client.view.playbackMode, 'shuffle')
  assert.strictEqual(client.receive(version(3)), false)
  assert.strictEqual(client.receive({ ...version(999), _settingsVersion: { epoch: 'previous-main', revision: 999 } }), false)
  assert.strictEqual(client.receive({ theme: 'stale unversioned response' }), false)

  const failed = client.save({ theme: 'dark' }).catch(error => error.message), later = client.save({ playbackMode: 'single' })
  await next()
  client.receive(version(5, { theme: 'light', favorites: ['from phone', 'newest'], customTags: { video: ['new'] }, playbackMode: 'shuffle' }))
  calls[2].reject(Error('old disk failure')); await failed; await next()
  assert.strictEqual(client.view.theme, 'light', 'rollback removes only the failed optimistic intent')
  assert.strictEqual(client.view.playbackMode, 'single')
  assert.strictEqual(client.view.customTags.video[0], 'new')
  assert.notStrictEqual(errors.at(-1), 'old disk failure', 'an old failure cannot replace feedback for a newer save')
  calls[3].resolve({ success: true, settings: version(6, { theme: 'light', favorites: ['from phone', 'newest'], customTags: { video: ['new'] }, playbackMode: 'single' }) }); await later
  const read = client.read(); client.receive(version(8, { theme: 'dark', favorites: ['newest'] }))
  reads[0].resolve(version(7, { theme: 'light' })); assert.strictEqual((await read).theme, 'dark')
  const latestFailure = client.save({ videoAnalysis: { enabled: false } }).catch(error => error.message)
  await next(); calls[4].reject(Error('current disk failure')); await latestFailure
  assert.strictEqual(errors.at(-1), 'current disk failure')
  assert.strictEqual(client.view.theme, 'dark'); assert.strictEqual(client.view.favorites[0], 'newest')
  const invalid = client.save({ theme: 'light' }).catch(error => error.message)
  await next(); calls[5].resolve({ success: false, error: 'rejected by main' }); await invalid
  assert.strictEqual(client.view.theme, 'dark')

  const legacyCalls = [], legacyRead = deferred()
  const legacy = new SettingsClient({ saveSettings: patch => { const item = deferred(); legacyCalls.push({ ...item, patch }); return item.promise }, getSettings: () => legacyRead.promise }, () => {}, () => {})
  legacy.receive({ theme: 'dark', favorites: [] })
  const legacySave = legacy.save({ theme: 'light' }); await next()
  legacy.receive({ theme: 'light', favorites: ['new media'] })
  legacyCalls[0].resolve({ settings: { theme: 'light', favorites: [] } }); await next()
  legacyRead.resolve({ theme: 'light', favorites: ['new media'] }); await legacySave
  assert.strictEqual(legacy.view.favorites[0], 'new media', 'an overtaken legacy reply is reconciled with a fresh read')
  const legacyBootRead = deferred(), legacyBoot = new SettingsClient({ getSettings: () => legacyBootRead.promise }, () => {}, () => {})
  const boot = legacyBoot.read(); legacyBoot.receive({ theme: 'light', favorites: ['new boot media'] })
  legacyBootRead.resolve({ theme: 'dark', favorites: [] })
  assert.strictEqual((await boot).favorites[0], 'new boot media', 'an overtaken legacy initialization read keeps the newer observation')
  legacyBoot.dispose()

  const held = deferred(), ownedViews = [], ownerErrors = [], owner = new SettingsClient({ saveSettings: () => held.promise }, value => ownedViews.push(value), error => ownerErrors.push(error), { maxPending: 2 })
  owner.receive(version(1))
  const accepted = owner.save({ theme: 'light' }).catch(error => error.code)
  const abandoned = owner.save({ playbackMode: 'shuffle' }).catch(error => error.code)
  await next(); owner.dispose(); owner.resume()
  await assert.rejects(owner.save({ theme: 'dark' }), /请求过多/, 'queue limits still include work from the retired generation')
  assert.ok(ownerErrors.at(-1).includes('请求过多'), 'admission failures remain visible to event handlers that rely on shared feedback')
  const before = ownedViews.length
  held.resolve({ settings: version(9, { theme: 'light' }) })
  assert.strictEqual(await accepted, 'settings_owner_closed'); assert.strictEqual(await abandoned, 'settings_owner_closed')
  assert.strictEqual(ownedViews.length, before)
  assert.strictEqual(owner.view.theme, 'dark'); assert.strictEqual(owner.outstanding, 0)
  const oldRead = deferred(), newRead = deferred(), restarts = []
  const reader = new SettingsClient({ getSettings: () => { const item = restarts.length ? newRead : oldRead; restarts.push(item); return item.promise } }, () => {}, () => {})
  const retired = reader.read().catch(error => error.code); reader.dispose(); reader.resume()
  const resumed = reader.read(); newRead.resolve(version(2)); await resumed
  oldRead.resolve(version(1, { theme: 'light' })); assert.strictEqual(await retired, 'settings_owner_closed')
  assert.strictEqual(reader.view.theme, 'dark')
  client.dispose(); legacy.dispose(); owner.dispose(); reader.dispose()
}

async function hookBehavior() {
  const client = phone(), harness = createHookHarness(client), calls = [], pluginReads = []
  let listener, removed = false
  client.control.globals = { ...client.control.globals, window: { electronAPI: {
    onSettingsChanged: fn => { listener = fn; return () => { removed = true } },
    saveSettings: patch => { const item = deferred(); calls.push({ ...item, patch }); return item.promise },
    getSettings: async () => version(1),
    listPlugins: () => { const item = deferred(); pluginReads.push(item); return item.promise }
  } } }
  const { useAppState } = client.load('src/hooks/useAppState.js')
  harness.mount(() => useAppState()); listener(version(1, { videoAnalysis: { enabled: true, modelDir: 'models' } })); await harness.settle()
  assert.strictEqual((await harness.tree().readSettings()).videoAnalysis.modelDir, 'models', 'initialization reads use the same public owner and snapshot gate')
  const write = harness.tree().saveSettings({ videoAnalysis: { enabled: false } }); await harness.settle()
  assert.strictEqual(harness.tree().settings.videoAnalysis.modelDir, 'models')
  listener(version(3, { videoAnalysis: { enabled: false, modelDir: 'models' }, favorites: ['phone edit'] })); await harness.settle()
  calls[0].resolve({ settings: version(2, { videoAnalysis: { enabled: false, modelDir: 'models' } }) }); await write; await harness.settle()
  assert.strictEqual(harness.tree().settings.favorites[0], 'phone edit')
  harness.tree().setSettings(version(2)); await harness.settle()
  assert.strictEqual(harness.tree().settings.favorites[0], 'phone edit', 'direct full-snapshot consumers share the same stale gate')
  const oldList = harness.tree().refreshPlugins(), newList = harness.tree().refreshPlugins()
  pluginReads[1].resolve([{ id: 'new plugin' }]); await newList; await harness.settle()
  pluginReads[0].resolve([{ id: 'old plugin' }]); await oldList; await harness.settle()
  assert.strictEqual(harness.tree().plugins[0].id, 'new plugin', 'late plugin reads do not replace the newer list')
  const retiredList = harness.tree().refreshPlugins()
  harness.unmount(); pluginReads[2].resolve([{ id: 'after unmount' }]); assert.deepStrictEqual(plain(await retiredList), [])
  assert.strictEqual(removed, true); listener(version(99)); await harness.settle()
}

async function mainBehavior() {
  const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
  await fsp.mkdir(parent, { recursive: true }); const fixture = await fsp.mkdtemp(path.join(parent, 'settings-snapshots-'))
  process.chdir(fixture)
  const settings = require('../main/settings')
  let remove
  try {
    const events = []
    assert.throws(() => settings.registerSettingsSection('_settingsVersion', {}), /reserved/)
    remove = settings.onSettingsChanged(snapshot => events.push(settings.sanitizeSettingsForRenderer(snapshot)))
    const original = settings.loadSettings(), old = settings.sanitizeSettingsForRenderer(original)
    assert.ok(old._settingsVersion.epoch); assert.ok(old._settingsVersion.revision > 0)
    assert.deepStrictEqual(settings.sanitizeSettingsForRenderer(settings.loadSettings())._settingsVersion, old._settingsVersion, 'normal reads do not advance the snapshot clock')
    const first = await settings.saveSettingsAndFlush({ theme: 'light' }), firstPublic = settings.sanitizeSettingsForRenderer(first)
    const second = await settings.saveSettingsAndFlush({ favorites: ['phone write'] }), secondPublic = settings.sanitizeSettingsForRenderer(second)
    assert.strictEqual(settings.sanitizeSettingsForRenderer(first)._settingsVersion.revision, firstPublic._settingsVersion.revision, 'old snapshots keep their own version after newer commits')
    assert.strictEqual(settings.sanitizeSettingsForRenderer(original)._settingsVersion.revision, old._settingsVersion.revision)
    assert.ok(secondPublic._settingsVersion.revision > firstPublic._settingsVersion.revision)
    assert.deepStrictEqual(events.at(-1)._settingsVersion, secondPublic._settingsVersion)
    const filename = path.join(fixture, '.tmp-wallpaper-player/settings.json'), rename = fsp.rename
    fsp.rename = async function (from, to) { if (to === filename) throw Error('injected write failure'); return rename.call(this, from, to) }
    try { await assert.rejects(settings.saveSettingsAndFlush({ theme: 'dark' }), /injected/) }
    finally { fsp.rename = rename }
    assert.deepStrictEqual(settings.sanitizeSettingsForRenderer(settings.loadSettings())._settingsVersion, secondPublic._settingsVersion)
    assert.strictEqual(events.length, 2, 'a disk failure neither advances the version nor broadcasts')
    const unregister = settings.registerSettingsSection('snapshotFixture', { defaults: { enabled: false } })
    assert.ok(settings.sanitizeSettingsForRenderer(settings.loadSettings())._settingsVersion.revision > secondPublic._settingsVersion.revision)
    unregister()
    settings.saveSettings({ ...settings.sanitizeSettingsForSave({ _settingsVersion: { epoch: 'forged', revision: 999 }, theme: 'dark' }) })
    await settings.flushSettingsWrites()
    const disk = JSON.parse(await fsp.readFile(filename, 'utf8'))
    assert.strictEqual(Object.hasOwn(disk, '_settingsVersion'), false)
    assert.strictEqual(Object.hasOwn(settings.loadSettings(), '_settingsVersion'), false)
    assert.notStrictEqual(settings.sanitizeSettingsForRenderer(settings.loadSettings())._settingsVersion.epoch, 'forged')
    assert.strictEqual(Object.hasOwn(settings.sanitizeSettingsForRenderer(settings.loadSettings()).privacy, 'passwordHash'), false)
  } finally {
    remove?.(); await settings.flushSettingsWrites(); process.chdir(root)
    assert.strictEqual(path.dirname(path.resolve(fixture)), parent); await removeTempRootWithRetry(fixture)
  }
}
async function main() { await clientBehavior(); await hookBehavior(); await mainBehavior(); console.log('settings snapshots passed: actual main snapshot stamps, old copies, disk failure/no persistence, production client/hook, queued intent rebasing, stale read/reply/broadcast gates, legacy refresh, owner disposal/resume and bounded retired work') }
main().catch(error => { console.error(error); process.exitCode = 1 })
