const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const { pathToFileURL } = require('node:url'), { app, BrowserWindow } = require('electron')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests'), fixture = process.env.WALLPAPER_SETTINGS_FEED_FIXTURE
assert.equal(path.dirname(path.resolve(fixture)), parent)
app.setPath('userData', fixture); app.on('window-all-closed', () => {})
app.disableHardwareAcceleration()
const delay = ms => new Promise(resolve => setTimeout(resolve, ms)), passed = [], messages = []
let win, stop, settings, phase = 'initialization', feedReads = 0
const replies = []
const fullBroadcastParses = {}
const until = async check => { const end = Date.now() + 8000; while (!await check()) { if (Date.now() > end) throw Error('Feed condition timed out: ' + phase); await delay(5) } }
const timeout = setTimeout(() => { console.error('Feed Electron timeout: ' + phase); app.exit(1) }, 35000)
app.whenReady().then(async () => {
  assert.equal(require('../main/user-data').getUserDataDir(), fixture)
  settings = require('../main/settings')
  const library = path.join(fixture, 'library'); fs.mkdirSync(library)
  const target = { fullPath: path.join(library, 'target.mp4') }; fs.writeFileSync(target.fullPath, 'fixture; never decoded')
  await settings.saveSettingsAndFlush({ customTags: Object.fromEntries(Array.from({ length: 10000 }, (_, i) =>
    [i === 7 || i === 8 ? 'file-' + i : 'https://fixture.invalid/video/' + i, ['tag-' + i]])), directories: [library] })
  const { IPC } = require('../main/ipc-channels'), { ipcMain } = require('../main/security/ipc')
  const registration = { handle(channel, action) { ipcMain.handle(channel, async (...args) => {
    if (channel === IPC.GET_SETTINGS_FEED) feedReads++
    const result = await action(...args)
    if (result?.settingsVersion) replies.push({ channel, bytes: Buffer.byteLength(JSON.stringify(result)),
      hasSettings: Object.hasOwn(result, 'settings'), version: result.settingsVersion })
    return result
  }) } }
  require('../main/ipc/settings').registerSettingsIpc(registration)
  require('../main/ipc/media-data').registerMediaDataIpc(registration)
  win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: {
    preload: path.join(root, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false
  } })
  const shown = []; win.on('show', () => shown.push(Date.now()))
  require('../main/window').setMainWindow(win)
  const entry = path.join(fixture, 'web/index.html')
  require('../main/security/ipc-sender').bindAppWindow(win, pathToFileURL(entry).href)
  stop = require('../main/application/settings-broadcast').settingsBroadcast.start()
  let dropping = false
  const send = win.webContents.send.bind(win.webContents)
  win.webContents.send = (channel, payload, ...args) => {
    if (['settings-patched', 'settings-changed'].includes(channel)) {
      if (dropping && channel === 'settings-patched') { dropping = false; return }
      messages.push({ channel, kind: payload.kind || 'legacy-full', bytes: Buffer.byteLength(JSON.stringify(payload)),
        feedId: payload.feedId, mapKeys: Object.fromEntries(Object.entries(payload.maps || {}).map(([key, delta]) => [key, Object.keys(delta.set)])) })
    }
    return send(channel, payload, ...args)
  }
  const run = source => win.webContents.executeJavaScript(source)
  const measureFullParses = async action => {
    const original = JSON.parse; let count = 0
    JSON.parse = (text, ...args) => {
      if (typeof text === 'string' && text.includes('"customTags":') && text.includes('"directories":') && text.includes('"privacy":')) count++
      return original(text, ...args)
    }
    try { await action() } finally { JSON.parse = original }
    return count
  }
  const parse = JSON.parse; let fullReadParses = 0
  JSON.parse = (text, ...args) => {
    if (typeof text === 'string' && text.includes('"customTags":') && text.includes('"directories":') && text.includes('"privacy":')) fullReadParses++
    return parse(text, ...args)
  }
  try { await win.loadFile(entry); await until(() => run('window.feedReady === true')) }
  finally { JSON.parse = parse }
  assert.equal(fullReadParses, 0, 'current preload feed must not parse the full settings on the main thread')
  assert.equal(win.isVisible(),false);assert.equal(win.isAlwaysOnTop(),false)
  passed.push('initial encoded 10000-tag feed crosses real sandbox IPC with zero full main-thread JSON.parse')
  assert.equal(feedReads, 1)
  phase = 'ordinary and entity messages'
  await settings.saveSettingsAndFlush({ theme: 'light' }); await until(() => run("window.feedView.theme === 'light'"))
  await settings.updateSettingsAndFlush(current => ({ patch: { playbackStates: { ...current.playbackStates,
    'fixture-video': { position: 15, updatedAt: 1, revision: 1 } } } }), { returnSettings: false })
  await until(() => run("window.feedView.playbackStates['fixture-video']?.position === 15"))
  await settings.updateSettingsAndFlush(current => ({ patch: { customTags: { ...current.customTags, 'file-7': ['changed'] } } }), { returnSettings: false })
  await until(() => run("window.feedView.customTags['file-7'][0] === 'changed'"))
  assert.equal(await run("window.stableTag === window.feedClient.confirmed.customTags['file-8']"), true)
  assert.equal(messages.length, 3); assert(messages.every(message => message.channel === 'settings-patched' && message.bytes < 4096))
  assert.deepEqual(messages.at(-1).mapKeys.customTags, ['file-7'])
  const ordinary = [...messages], firstFeedId = messages[0].feedId
  passed.push('production sandbox preload and SettingsClient receive only narrow actual Electron events')

  phase = 'legacy coexistence'
  await run("window.stopLegacy = window.electronAPI.onSettingsChanged(snapshot => window.feedLegacy.push({theme:snapshot.theme})); window.electronAPI.getSettings()")
  messages.length = 0
  fullBroadcastParses.legacy = await measureFullParses(async () => {
    await settings.commitSettingsPatch({ theme: 'dark' }, { returnSettings: false })
    await until(() => run("window.feedLegacy.length === 1 && window.feedView.theme === 'dark'"))
  })
  assert.equal(fullBroadcastParses.legacy, 0)
  assert.deepEqual(messages.map(message => message.channel).sort(), ['settings-changed', 'settings-patched'])
  await run('window.stopLegacy(); window.electronAPI.getSettings()')
  messages.length = 0; await settings.saveSettingsAndFlush({ theme: 'light' }); await until(() => run("window.feedView.theme === 'light'"))
  assert.deepEqual(messages.map(message => message.channel), ['settings-patched'])
  passed.push('encoded legacy notifications cross the real sandbox with zero full main JSON.parse, ordinary public values and safe unsubscribe')

  phase = 'encoded full fallback'
  const beforeFallbackReads = feedReads
  const unregister = settings.registerSettingsSection('nativeFeedFixture', { defaults: { enabled: true }, normalize: value => ({ enabled: value?.enabled !== false }) })
  try {
    messages.length = 0
    fullBroadcastParses.fallback = await measureFullParses(async () => {
      await settings.commitSettingsPatch({ theme: 'forced-full-fallback' }, { returnSettings: false })
      await until(() => run("window.feedView.theme === 'forced-full-fallback'"))
    })
    assert.equal(fullBroadcastParses.fallback, 0); assert.equal(feedReads, beforeFallbackReads)
    assert.deepEqual(messages.map(message => message.kind), ['settings-snapshot-v1'])
    assert.equal(await run("window.feedFrames.at(-1).snapshot.kind === undefined && window.feedFrames.at(-1).snapshot.nativeFeedFixture.enabled === true"), true)
    assert.deepEqual(await run('window.feedFrames.at(-1).snapshot.privacy'), { passwordSet: false })
  } finally { unregister() }
  // Unregister also changes the version without a notification; the next commit
  // must restore the ordinary baseline before exercising deliberate event loss.
  await settings.commitSettingsPatch({ theme: 'after-full-fallback' }, { returnSettings: false })
  await until(() => run("window.feedView.theme === 'after-full-fallback'"))
  passed.push('a version-gap full snapshot decodes in actual preload, stays public and redacted, and needs no extra feed read or full main JSON.parse')

  phase = 'lost message recovery'
  const priorReads = feedReads
  dropping = true; await settings.saveSettingsAndFlush({ favorites: ['lost-before-next'] })
  await settings.saveSettingsAndFlush({ theme: 'dark' })
  await until(() => run("window.feedView.theme === 'dark' && window.feedView.favorites[0] === 'lost-before-next'"))
  assert.equal(feedReads, priorReads + 1)
  assert.deepEqual(await run('window.feedErrors.filter(Boolean)'), [])
  passed.push('a lost native event produces one authoritative full resync')

  phase = 'retired navigation scope'
  const foreign = path.join(fixture, 'foreign.html')
  fs.writeFileSync(foreign, '<!doctype html><body><script>window.foreignEvents=[];window.electronAPI.onSettingsPatched(e=>window.foreignEvents.push(e));window.electronAPI.getSettingsFeed().then(()=>window.denied=false,()=>window.denied=true)</script>')
  await win.loadFile(foreign); await until(() => run('window.denied === true'))
  messages.length = 0; await settings.saveSettingsAndFlush({ theme: 'retired-scope' }); await delay(20)
  assert.equal(messages.length, 0); assert.equal(await run('window.foreignEvents.length'), 0)
  await win.loadFile(entry); await until(() => run('window.feedReady === true'))
  await settings.saveSettingsAndFlush({ theme: 'back' }); await until(() => run("window.feedView.theme === 'back'"))
  assert.notEqual(messages.at(-1).feedId, firstFeedId)
  passed.push('foreign navigation cannot read or receive settings and an authorized reload gets a fresh feed')

  phase = 'version acknowledgments without extra full reads'
  const beforeSaveReads = feedReads
  await run("window.feedClient.save({theme:'client-saved'}).then(() => true)")
  assert.equal(feedReads, beforeSaveReads); assert.equal(await run("window.feedView.theme"), 'client-saved')
  assert.equal(replies.at(-1).channel, IPC.SAVE_SETTINGS); assert.equal(replies.at(-1).hasSettings, false)
  passed.push('production SettingsClient requests version-only durable save replies without an extra full read')

  phase = 'last event lost before save reply'
  dropping = true
  await run("window.feedClient.save({theme:'last-event-lost'}).then(() => true)")
  assert.equal(feedReads, beforeSaveReads + 1)
  assert.equal(await run('window.feedView.theme'), 'last-event-lost')
  passed.push('a version acknowledgment repairs a lost final save event with one authoritative full read')

  phase = 'production media adapter replies'
  const targetText = JSON.stringify(target), mediaReadStart = feedReads
  await run(`(async () => { const result = await window.feedMedia.setVideoFavorite(${targetText}, true); await window.feedClient.reconcileMutation(result); return true })()`)
  assert.equal(feedReads, mediaReadStart)
  dropping = true
  await run(`(async () => { const result = await window.feedMedia.setVideoFavorite(${targetText}, false); await window.feedClient.reconcileMutation(result); return true })()`)
  assert.equal(feedReads, mediaReadStart + 1)
  await run(`(async () => {
    const before = await window.feedMedia.getVideoCustomTags(${targetText}); await window.feedClient.reconcileMutation(before);
    const condition = {expectedRevision: before.customTagsRevision, operationId: 'native_receipt_test'};
    const saved = await window.feedMedia.setVideoCustomTags(${targetText}, ['native-tag'], condition); await window.feedClient.reconcileMutation(saved);
    const replay = await window.feedMedia.setVideoCustomTags(${targetText}, ['native-tag'], condition); await window.feedClient.reconcileMutation(replay);
    if (!replay.replayed) throw Error('expected native idempotent replay');
    const bulk = await window.feedMedia.appendVideoCustomTags([${targetText}], ['bulk']); await window.feedClient.reconcileMutation(bulk);
    window.nativeTagReply = bulk; return true;
  })()`)
  assert.equal(await run('window.nativeTagReply.updatedCount'), 1)
  assert.ok(replies.length >= 8 && replies.every(reply => !reply.hasSettings && reply.bytes < 4096))
  assert.ok((await run(`window.electronAPI.getVideoCustomTags(${targetText}).then(result => Boolean(result.settings))`)))
  assert.deepEqual(await run('window.feedErrors.filter(Boolean)'), [])
  passed.push('production media adapters use small version replies, recover a lost last event and preserve tag replay, bulk and legacy reads')

  await settings.flushSettingsWrites(); await settings.disposeSettingsSerialization()
  assert.deepEqual(shown,[]);assert.equal(win.isVisible(),false);assert.equal(win.isAlwaysOnTop(),false)
  const files = ['main/settings.js', 'main/application/settings-broadcast.js', 'main/ipc/settings.js', 'main/ipc/media-data.js', 'main/application/media-mutations.js', 'main/security/ipc-sender.js',
    'main/application/settings-reader.js','main/application/settings-read-worker.js','main/repositories/settings-renderer.js',
    'preload.js', 'src/api/media.ts', 'src/services/settings-client.js', 'src/utils/share-json.js', 'packages/contracts/dist/settings-feed.js']
  const evidence = { date: new Date().toISOString(), fixture: path.relative(root, fixture), passed, ordinary, replies, fullReadParses, fullBroadcastParses, shownWindows:shown.length,
    sourceDigests: Object.fromEntries(files.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])),
    conditions: 'Actual hidden Electron, production sandbox preload, guarded IPC and freshly bundled SettingsClient. 10000 generated tags, no decoder. JSON payload size is not IPC wire size or native latency/P95.' }
  fs.writeFileSync(path.join(parent, 'settings-feed-electron.json'), JSON.stringify(evidence, null, 2))
  console.log('settings feed Electron passed: guarded feed, narrow theme/progress/entity events, legacy compatibility, loss recovery, navigation isolation and reload')
}).then(() => finish(0), error => { console.error('settings feed phase: ' + phase, error); finish(1) })
function finish(code) { stop?.(); clearTimeout(timeout); if (win && !win.isDestroyed()) win.destroy(); app.exit(code) }
