const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const { phone } = require('./mobile-module-harness')
const { settingsEventSchema, settingsFeedSchema, diffSettingsMap, applySettingsMap } = require('../packages/contracts')
const { createSettingsBroadcast } = require('../main/application/settings-broadcast')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
fs.mkdirSync(parent, { recursive: true }); const fixture = fs.mkdtempSync(path.join(parent, 'settings-feed-'))
const passed = [], plain = value => JSON.parse(JSON.stringify(value)), deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const next = async () => { for (let i = 0; i < 50; i++) await Promise.resolve() }
const version = revision => ({ epoch: 'feed-fixture', revision })
const snapshot = (revision, patch = {}) => ({ theme: 'dark', directories: [], privateDirectories: [], favorites: [],
  customTags: { one: ['old'], stable: ['same'] }, customTagRevisions: {}, playbackStates: {}, privacy: { passwordSet: false }, ...patch, _settingsVersion: version(revision) })
const event = (base, revision, set = {}, maps = {}, feedId = 'feed-a') => ({ kind: 'settings-patch-v1', feedId,
  baseVersion: version(base), version: version(revision), set, maps, removed: [] })
const feed = (revision, patch = {}, feedId = 'feed-a') => ({ kind: 'settings-feed-v1', feedId, snapshot: snapshot(revision, patch) })
const timeout = setTimeout(() => { console.error('settings feed verification timed out'); process.exit(1) }, 35000)

async function clientBehavior() {
  const { SettingsClient } = phone().load('src/services/settings-client.js'), reads = [], writes = [], errors = [], views = []
  const api = { onSettingsPatched() {}, getSettingsFeed() { const item = deferred(); reads.push(item); return item.promise },
    saveSettings(patch) { const item = deferred(); writes.push({ ...item, patch }); return item.promise } }
  const client = new SettingsClient(api, value => views.push(value), error => errors.push(error))
  const first = client.read(), joined = client.read(); await next(); assert.equal(reads.length, 1)
  client.receivePatch(event(1, 2, { theme: 'light' }))
  reads[0].resolve(feed(1)); await Promise.all([first, joined]); await next(); assert.equal(reads.length, 2)
  reads[1].resolve(feed(2, { theme: 'light' })); await next(); assert.equal(client.confirmed.theme, 'light')
  passed.push('initial feed reads coalesce and a pre-reply event triggers one fresh baseline')

  const stableTags = client.confirmed.customTags, stableArray = stableTags.stable
  assert(client.receivePatch(event(2, 3, { favorites: ['phone'] })))
  assert.equal(client.confirmed.customTags, stableTags)
  assert.equal(client.receivePatch(event(2, 3, { favorites: ['duplicate'] })), false)
  assert.equal(client.receivePatch(event(3, 999, { theme: 'old-feed' }, {}, 'retired-feed')), false)
  assert.equal(reads.length, 2)
  const saving = client.save({ theme: 'dark' }); await next()
  client.receivePatch(event(3, 4, { theme: 'dark' }))
  client.receivePatch(event(4, 5, {}, { customTags: { set: { one: ['new'] }, removed: [], order: ['stable', 'one'] } }))
  assert.equal(client.confirmed.customTags.stable, stableArray); assert.deepEqual(Object.keys(client.confirmed.customTags), ['stable', 'one'])
  writes[0].resolve({ success: true, settings: snapshot(4, { theme: 'dark', favorites: ['phone'] }) }); await saving
  assert.deepEqual(plain(client.view.customTags.one), ['new'])
  passed.push('entity changes preserve unchanged references and optimistic intent rejects stale full acknowledgments')

  for (let i = 0; i < 30; i++) client.receivePatch(event(6, 7, { theme: 'gap' }))
  await next(); assert.equal(reads.length, 3)
  client.receivePatch(event(7, 8, { theme: 'newest' }))
  reads[2].resolve(feed(7)); await next(); assert.equal(reads.length, 4)
  reads[3].resolve(feed(8, { theme: 'newest' })); await next(); assert.equal(client.confirmed.theme, 'newest'); assert.equal(reads.length, 4)
  client.receivePatch(event(99, 100, { theme: 'impossible-clock' })); await next(); assert.equal(reads.length, 5)
  reads[4].resolve(feed(8, { theme: 'newest' })); await next(); assert.equal(reads.length, 5, 'a fresh baseline must end an impossible-clock resync loop')
  passed.push('lost/out-of-order messages coalesce recovery and fresh baselines bound invalid-clock retries')

  const privateMessage = event(8, 9, { privacy: { passwordSet: true, passwordHash: 'must-not-apply' } })
  assert.equal(client.receivePatch(privateMessage), false); await next(); assert.equal(reads.length, 6)
  assert.deepEqual(plain(client.confirmed.privacy), { passwordSet: false })
  reads[5].resolve(feed(9)); await next()
  const before = client.confirmed
  client.receivePatch(event(9, 10, { theme: 'must-not-partially-apply' }, { customTags: { set: {}, removed: [], order: ['one', 'one'] } }))
  await next(); assert.equal(client.confirmed, before); assert.equal(reads.length, 7)
  reads[6].resolve(feed(10)); await next()
  passed.push('private fields and malformed map order cannot partially mutate confirmed settings')

  client.receivePatch(event(11, 12)); await next(); assert.equal(reads.length, 8)
  const published = views.length; client.dispose(); reads[7].resolve(feed(99)); await next(); assert.equal(views.length, published)
  client.resume(); const resumed = client.read(); await next(); assert.equal(reads.length, 9)
  reads[8].resolve(feed(12)); await resumed
  client.receivePatch(event(12, 13, {}, { customTags: { set: {}, removed: [], order: ['stable', 'one'] } }))
  assert.deepEqual(Object.keys(client.confirmed.customTags), ['stable', 'one'])
  client.receivePatch(event(14, 15)); await next(); assert.equal(reads.length, 10)
  reads[9].reject(Error('current recovery failure')); await next(); assert.equal(errors.at(-1), 'current recovery failure')
  client.dispose()
  passed.push('retired reads do not publish after disposal and current recovery failures stay visible')
}

async function mainBehavior() {
  process.chdir(fixture)
  assert.equal(require('../main/user-data').getUserDataDir(), path.join(fixture, '.tmp-wallpaper-player'))
  const settings = require('../main/settings'), directory = path.join(fixture, 'library'); fs.mkdirSync(directory)
  const tags = Object.fromEntries(Array.from({ length: 10000 }, (_, i) => ['file-' + i, ['tag-' + i]]))
  await settings.saveSettingsAndFlush({ directories: [directory], customTags: tags })
  const messages = []; let generation = 0, ready = true
  const contents = { mainFrame: {}, send(channel, data) { messages.push({ channel, data: structuredClone(data) }) } }
  const win = { webContents: contents, isDestroyed: () => false }, sender = { sender: contents, senderFrame: contents.mainFrame }
  const publisher = createSettingsBroadcast({ settings, getMainWindow: () => win, captureSender: input => {
    assert(ready && input.sender === contents && input.senderFrame === contents.mainFrame)
    const captured = generation
    return { assertCurrent() { assert(ready && generation === captured) } }
  } })
  const stop = publisher.start()
  try {
    await settings.saveSettingsAndFlush({ theme: 'light' }); assert.equal(messages.at(-1).channel, 'settings-changed')
    const opened = settingsFeedSchema.parse(publisher.openFeed(sender)), secondRead = publisher.openFeed(sender)
    assert.equal(opened.feedId, secondRead.feedId, 'another reader cannot retire the live per-frame feed')
    messages.length = 0
    await settings.updateSettingsAndFlush(current => ({ patch: { customTags: { ...current.customTags, 'file-1': ['changed'] } } }), { returnSettings: false })
    assert.equal(messages.length, 1); const tagEvent = settingsEventSchema.parse(messages[0].data)
    assert.equal(tagEvent.kind, 'settings-patch-v1'); assert.deepEqual(Object.keys(tagEvent.maps.customTags.set), ['file-1'])
    assert.equal(Buffer.byteLength(JSON.stringify(tagEvent)) < 4096, true)
    passed.push('negotiated broadcasts carry one entity and keep a stable feed for multiple readers')

    let parses = 0; const parse = JSON.parse
    JSON.parse = (...args) => { const value = parse(...args); if (value?.customTags && value?.directories && value?.privacy) parses++; return value }
    try {
      const fields = settings.loadSettingsFields(['privacy', 'networkResources']); fields.privacy.passwordSet = true
      assert.equal(settings.loadSettingsFields(['privacy']).privacy.passwordSet, false)
      assert.equal(settings.readPlaybackState(path.join(directory, 'none.mp4')), null)
      assert.equal(parses, 0)
    } finally { JSON.parse = parse }
    passed.push('field and playback reads avoid full snapshots while keeping detached values')

    publisher.setLegacy(sender, { enabled: true, sequence: 2 }); publisher.setLegacy(sender, { enabled: false, sequence: 1 })
    messages.length = 0; await settings.saveSettingsAndFlush({ theme: 'dark' })
    assert.deepEqual(messages.map(x => x.channel).sort(), ['settings-changed', 'settings-patched'])
    publisher.setLegacy(sender, { enabled: false, sequence: 3 })
    messages.length = 0; await settings.saveSettingsAndFlush({ theme: 'light' }); assert.deepEqual(messages.map(x => x.channel), ['settings-patched'])
    passed.push('legacy listeners coexist and stale unsubscribe messages cannot disable newer listeners')

    const unregister = settings.registerSettingsSection('feedSection', { defaults: { enabled: true } })
    messages.length = 0; await settings.saveSettingsAndFlush({ theme: 'dark' })
    assert.equal(messages[0].data.kind, 'settings-snapshot-v1')
    unregister(); await settings.saveSettingsAndFlush({ theme: 'light' })
    const privacy = await settings.createPrivacyPassword('settings-feed-fixture')
    messages.length = 0; await settings.saveSettingsAndFlush({ privacy })
    const privateEvent = settingsEventSchema.parse(messages[0].data)
    assert.deepEqual(privateEvent.set.privacy, { passwordSet: true })
    passed.push('unannounced version changes recover with a full snapshot and privacy changes stay redacted')

    const rename = fs.promises.rename; fs.promises.rename = async () => { throw Object.assign(Error('fixture disk failure'), { code: 'EACCES' }) }
    messages.length = 0
    try { await assert.rejects(settings.saveSettingsAndFlush({ theme: 'failed' }), { code: 'EACCES' }); assert.equal(messages.length, 0) }
    finally { fs.promises.rename = rename }
    generation++; ready = false
    await settings.saveSettingsAndFlush({ theme: 'off-page' }); assert.equal(messages.length, 0)
    ready = true; const newFeed = publisher.openFeed(sender); assert.notEqual(newFeed.feedId, opened.feedId)
    await settings.saveSettingsAndFlush({ theme: 'back' }); assert.equal(messages.at(-1).data.feedId, newFeed.feedId)
    passed.push('failed commits and retired frame scopes cannot emit state')
  } finally { stop(); await settings.flushSettingsWrites(); await settings.disposeSettingsSerialization(); process.chdir(root) }
}

;(async () => {
  const before = Object.fromEntries([['__proto__', ['old']], ['a', ['one']], ['b', ['two']]])
  const after = Object.fromEntries([['b', ['two']], ['a', ['updated']], ['__proto__', ['new']]])
  assert.deepEqual(Object.keys(applySettingsMap(before, diffSettingsMap(before, after))), Object.keys(after))
  assert.deepEqual(applySettingsMap(before, diffSettingsMap(before, after)), after)
  assert.equal(Object.prototype.polluted, undefined)
  assert.throws(() => settingsEventSchema.parse(event(1, 2, { tagMutationReceipts: [] })))
  assert.throws(() => settingsEventSchema.parse(event(1, 2, { _settingsVersion: version(999) })))
  passed.push('shared schema protects metadata, special keys and map ordering')
  await clientBehavior(); await mainBehavior()
  const files = ['main/settings.js', 'main/application/settings-broadcast.js', 'main/application/settings-json.js', 'main/application/settings-json-worker.js',
    'src/services/settings-client.js', 'src/hooks/useAppState.js', 'src/utils/share-json.js', 'preload.js', 'packages/contracts/src/settings-feed.ts']
  const evidence = { date: new Date().toISOString(), fixture: path.relative(root, fixture), passed,
    sourceDigests: Object.fromEntries(files.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])),
    conditions: 'Actual production settings, worker, publisher and renderer SettingsClient. Renderer hooks loaded through controlled harness and main-frame scope injected here; actual Electron frame/preload verification is separate.' }
  fs.writeFileSync(path.join(parent, 'settings-feed-lifecycle.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence))
})().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => clearTimeout(timeout))
