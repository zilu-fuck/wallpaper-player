const assert = require('assert'), fs = require('fs'), fsp = require('fs/promises'), path = require('path')
const { pathToFileURL } = require('url')
const { app, BrowserWindow } = require('electron')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
const fixture = process.env.WALLPAPER_SETTINGS_SNAPSHOT_FIXTURE
assert.strictEqual(path.dirname(path.resolve(fixture)), parent)
app.setPath('userData', fixture)
app.on('window-all-closed', () => {})
const delay = ms => new Promise(done => setTimeout(done, ms))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
let window, remove, releaseFailure, phase = 'startup'
const rename = fsp.rename
const deadline = setTimeout(() => { console.error('settings snapshot UI timeout: ' + phase); app.exit(1) }, 30000)
app.whenReady().then(async () => {
  const settings = require('../main/settings'), { ipcMain } = require('../main/security/ipc'), { IPC, EVENT } = require('../main/ipc-channels')
  const { setMainWindow } = require('../main/window'), { bindAppWindow } = require('../main/security/ipc-sender')
  const directory = path.join(fixture, 'library'); await fsp.mkdir(directory)
  const videos = [0, 1].map(index => ({ name: 'fixture video ' + index, fullPath: path.join(directory, index + '.mp4'), fileName: index + '.mp4',
    favoriteKey: path.join(directory, index + '.mp4'), extension: '.mp4', size: 24, tags: [], media: { available: true, durationSeconds: 120 } }))
  await Promise.all(videos.map(video => fsp.writeFile(video.fullPath, 'fixture, never decoded')))
  await settings.saveSettingsAndFlush({ directories: [directory], defaultDirectory: directory, theme: 'dark' })
  const held = deferred(), initialRead = deferred(); let saveCalls = 0, heldResult, readResult, feedReads = 0
  const mediaReplies = []
  require('../main/ipc/settings').registerSettingsIpc({ handle(channel, action) {
    ipcMain.handle(channel, async (...args) => {
      if (channel === IPC.SAVE_SETTINGS) saveCalls++
      if (channel === IPC.GET_SETTINGS_FEED) feedReads++
      const result = await action(...args)
      if ([IPC.GET_SETTINGS, IPC.GET_SETTINGS_FEED].includes(channel) && !readResult) { readResult = result; await initialRead.promise }
      if (channel === IPC.SAVE_SETTINGS && saveCalls === 1) { heldResult = result; await held.promise }
      return result
    })
  } })
  require('../main/ipc/media-data').registerMediaDataIpc({ handle(channel, action) {
    ipcMain.handle(channel, async (...args) => { const result = await action(...args); mediaReplies.push({channel, result}); return result })
  } })
  for (const [channel, response] of [['plugins-list', []], [IPC.SCAN_DIRECTORY, { videos }], [IPC.CHECK_FFMPEG, { available: false }],
    [IPC.CHECK_MPV, { available: false }], [IPC.GENERATE_THUMBNAIL, { thumbPath: null }], [IPC.UPDATER_GET_STATUS, { status: 'disabled' }]]) {
    ipcMain.handle(channel, async () => response)
  }
  window = new BrowserWindow({ show: false, width: 1200, height: 820,
    webPreferences: { preload: path.join(root, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  setMainWindow(window)
  const entry = path.join(root, 'dist/index.html'); bindAppWindow(window, pathToFileURL(entry).href)
  remove = settings.onSettingsChanged(snapshot => { if (!window.isDestroyed()) window.webContents.send(EVENT.SETTINGS_CHANGED, settings.sanitizeSettingsForRenderer(snapshot)) })
  const run = source => window.webContents.executeJavaScript(source)
  const until = async test => { const end = Date.now() + 8000; while (!await test()) { if (Date.now() >= end) throw Error('settings UI condition timed out: ' + phase); await delay(5) } }
  await window.loadFile(entry)
  await window.webContents.insertCSS('*, *::before, *::after { animation: none !important; transition: none !important; }')
  phase = 'late initial read after broadcast'
  await until(() => Boolean(readResult))
  assert.strictEqual(readResult.kind, 'settings-feed-v1', 'current production UI must exercise the incremental feed read')
  await run('window.__bootSnapshots = []; window.__removeBootProbe = window.electronAPI.onSettingsChanged(snapshot => window.__bootSnapshots.push(snapshot._settingsVersion.revision)); true')
  await settings.saveSettingsAndFlush({ favorites: [videos[1].favoriteKey] })
  const bootRevision = settings.sanitizeSettingsForRenderer(settings.loadSettings())._settingsVersion.revision
  await until(() => run('window.__bootSnapshots.includes(' + bootRevision + ')'))
  initialRead.resolve()
  await until(() => run("document.querySelectorAll('.video-card').length === 2"))
  assert.strictEqual(await run("document.querySelector('.card-favorite-btn.active')?.getAttribute('aria-label')"), '取消喜欢 fixture video 1')
  await run('window.__removeBootProbe(); true')
  await run("window.__snapshotErrors = []; window.addEventListener('unhandledrejection', event => window.__snapshotErrors.push(String(event.reason))); document.querySelector('.sidebar-settings-btn').click()")
  await until(() => run("Boolean(document.querySelector('.theme-option'))"))
  const click = selector => run('document.querySelector(' + JSON.stringify(selector) + ').click()')
  phase = 'held old reply and queued intent'
  await click('.theme-option:nth-child(2)')
  await until(() => Boolean(heldResult))
  assert.strictEqual(Object.hasOwn(heldResult, 'settings'), false, 'current App must request a narrow version acknowledgment')
  const firstVersion = heldResult.settingsVersion
  await click('.theme-option:nth-child(1)')
  await until(() => run("document.querySelector('.app').classList.contains('theme-dark')"))
  assert.strictEqual(saveCalls, 1, 'a second optimistic theme change waits for the first native request')
  await settings.saveSettingsAndFlush({ favorites: [videos[0].favoriteKey] })
  await until(() => run("document.querySelectorAll('.card-favorite-btn.active').length === 1"))
  assert.ok(settings.sanitizeSettingsForRenderer(settings.loadSettings())._settingsVersion.revision > firstVersion.revision)
  held.resolve()
  await until(() => saveCalls === 2 && settings.loadSettings().theme === 'dark')
  await delay(75)
  assert.strictEqual(await run("document.querySelectorAll('.card-favorite-btn.active').length"), 1, 'old theme acknowledgments preserve the newer media update')
  assert.strictEqual(await run("document.querySelector('.theme-option.active').innerText.trim()"), '深色')

  phase = 'real disk failure and retry'
  const failedWrite = deferred(), failEntered = deferred(); releaseFailure = failedWrite.resolve
  let failNext = true
  fsp.rename = async function (from, to) {
    if (to === path.join(fixture, 'settings.json') && failNext) {
      failNext = false; failEntered.resolve(); await failedWrite.promise
      throw Object.assign(new Error('fixture settings disk failure'), { code: 'EACCES' })
    }
    return rename.call(this, from, to)
  }
  await click('.theme-option:nth-child(2)'); await failEntered.promise
  // A newer complete snapshot from another entry must also survive a failing settings intent.
  window.webContents.send(EVENT.SETTINGS_CHANGED, settings.sanitizeSettingsForRenderer(settings.loadSettings()))
  failedWrite.resolve()
  await until(() => run("Boolean(document.querySelector('.settings-panel [role=alert]'))"))
  assert.strictEqual(settings.loadSettings().theme, 'dark')
  assert.strictEqual(await run("document.querySelector('.theme-option.active').innerText.trim()"), '深色')
  assert.strictEqual(await run("document.querySelectorAll('.card-favorite-btn.active').length"), 1)
  await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  await delay(350)
  const layout = await run(`(() => { const panel = document.querySelector('.settings-panel'), alert = panel.querySelector('[role=alert]');
    return { panel: { width: panel.getBoundingClientRect().width, height: panel.getBoundingClientRect().height, opacity: getComputedStyle(panel).opacity },
      alert: { text: alert.innerText, width: alert.getBoundingClientRect().width, height: alert.getBoundingClientRect().height, color: getComputedStyle(alert).color } }; })()`)
  assert.ok(layout.panel.width > 300 && layout.panel.height > 300 && Number(layout.panel.opacity) > 0.9)
  assert.ok(layout.alert.width > 100 && layout.alert.height > 0)
  await fsp.writeFile(path.join(parent, 'settings-snapshot-save-error.png'), (await window.webContents.capturePage()).toPNG())
  fsp.rename = rename
  await click('.theme-option:nth-child(2)')
  await until(() => settings.loadSettings().theme === 'light' && run("document.querySelector('.app').classList.contains('theme-light') && !document.querySelector('.settings-panel [role=alert]')"))
  assert.deepStrictEqual(await run('window.__snapshotErrors'), [])
  const disk = JSON.parse(await fsp.readFile(path.join(fixture, 'settings.json'), 'utf8'))
  assert.strictEqual(disk.theme, 'light'); assert.deepStrictEqual(disk.favorites, [videos[0].favoriteKey])
  assert.ok(!Object.hasOwn(disk, '_settingsVersion'))
  phase = 'actual favorite hook repairs its lost final event'
  await click('.settings-overlay')
  await until(() => run("!document.querySelector('.settings-overlay')"))
  let dropNext = true
  const nativeSend = window.webContents.send.bind(window.webContents)
  window.webContents.send = (channel, ...args) => {
    if (channel === 'settings-patched' && dropNext) { dropNext = false; return }
    return nativeSend(channel, ...args)
  }
  const readsBeforeFavorite = feedReads
  await click('.card-favorite-btn[aria-label="喜欢 fixture video 1"]')
  await until(() => run("document.querySelectorAll('.card-favorite-btn.active').length === 2"))
  assert.strictEqual(feedReads, readsBeforeFavorite + 1)
  assert.ok(mediaReplies.at(-1).result.settingsVersion)
  assert.strictEqual(Object.hasOwn(mediaReplies.at(-1).result, 'settings'), false)
  phase = 'actual tag editor repairs its lost final event'
  await click('.card-menu-btn[aria-label="更多操作 fixture video 0"]')
  await run("Array.from(document.querySelectorAll('.card-menu [role=menuitem]')).find(node => node.textContent === '自定义标签').click()")
  await until(() => run("Boolean(document.querySelector('#custom-tags-input:not(:disabled)'))"))
  await run("Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(document.querySelector('#custom-tags-input'), 'native-hook-tag'); document.querySelector('#custom-tags-input').dispatchEvent(new Event('input', {bubbles:true}))")
  const readsBeforeTags = feedReads; dropNext = true
  await click('.tag-editor-footer .btn-primary')
  await until(() => run("!document.querySelector('#custom-tags-input')"))
  assert.strictEqual(feedReads, readsBeforeTags + 1)
  assert.deepStrictEqual(settings.loadSettings().customTags[videos[0].favoriteKey], ['native-hook-tag'])
  assert.ok(mediaReplies.every(reply => reply.result.success && reply.result.settingsVersion && !Object.hasOwn(reply.result, 'settings')))
  assert.deepStrictEqual(await run('window.__snapshotErrors'), [])
  await settings.flushSettingsWrites()
  const crypto = require('node:crypto')
  const files = ['main/settings.js', 'main/ipc/settings.js', 'main/ipc/media-data.js', 'preload.js', 'src/services/settings-client.js',
    'src/hooks/useAppState.js', 'src/hooks/useAppController.js', 'src/hooks/useFavorites.js', 'src/hooks/useTagEditor.js', 'src/api/media.ts']
  await fsp.writeFile(path.join(parent, 'settings-replies-app-ui.json'), JSON.stringify({date:new Date().toISOString(),
    passed:['rebuilt production App uses version acknowledgments with queued intent and old reply isolation',
      'actual settings disk failure shows a visible error and retry succeeds',
      'actual favorite hook recovers a lost last event with one feed read',
      'actual tag editor recovers a lost last event with one feed read and closes after reconciliation'],
    mediaReplies:mediaReplies.map(({channel,result}) => ({channel,version:result.settingsVersion,bytes:Buffer.byteLength(JSON.stringify(result)),hasSettings:Object.hasOwn(result,'settings')})),
    sourceDigests:Object.fromEntries(files.map(file => [file,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')])),
    conditions:'Actual rebuilt production App, guarded IPC and preload in hidden Electron with synthetic video headers. UI clicks via executeJavaScript, no decode or physical device.'},null,2))
  console.log('settings snapshot UI passed: actual production App/settings/preload/guarded IPC, stale initial read, held version ack, queued intent, newer media snapshot, real disk failure/retry, actual favorite/tag hooks repair lost final events and no unhandled rejection')
}).then(() => finish(0), error => { console.error('settings UI phase: ' + phase, error); finish(1) })
function finish(code) {
  releaseFailure?.(); fsp.rename = rename; remove?.(); clearTimeout(deadline)
  if (window && !window.isDestroyed()) window.destroy()
  app.exit(code)
}
