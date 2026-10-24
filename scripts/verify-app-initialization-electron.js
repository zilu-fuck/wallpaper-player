const assert = require('assert'), fsp = require('fs/promises'), path = require('path'), { pathToFileURL } = require('url')
const { app, BrowserWindow } = require('electron')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests'), fixture = process.env.WALLPAPER_INITIALIZATION_FIXTURE
assert.strictEqual(path.dirname(path.resolve(fixture)), parent); app.setPath('userData', fixture); app.on('window-all-closed', () => {})
const delay = ms => new Promise(done => setTimeout(done, ms))
let release; const held = new Promise(done => { release = done }); let window, phase = 'startup'
const timeout = setTimeout(() => { console.error('initialization UI timeout: ' + phase); app.exit(1) }, 30000)
app.whenReady().then(async () => {
  const { IPC } = require('../main/ipc-channels'), { ipcMain } = require('../main/security/ipc'), settings = require('../main/settings')
  const directory = path.join(fixture, 'library'); await fsp.mkdir(directory)
  await settings.saveSettingsAndFlush({ directories: [directory], defaultDirectory: directory })
  const counts = {}, optional = new Set([IPC.PLUGINS_LIST, IPC.CHECK_FFMPEG, IPC.CHECK_MPV])
  require('../main/ipc/settings').registerSettingsIpc({ handle(channel, action) { ipcMain.handle(channel, async (...args) => {
    if ([IPC.GET_SETTINGS, IPC.GET_SETTINGS_FEED].includes(channel)) { counts[IPC.GET_SETTINGS] = (counts[IPC.GET_SETTINGS] || 0) + 1; if (counts[IPC.GET_SETTINGS] === 1) throw Error('fixture settings read failure'); await held }
    return action(...args)
  }) } })
  for (const key of optional) ipcMain.handle(key, async () => { counts[key] = (counts[key] || 0) + 1; if (counts[key] === 1) throw Error('fixture ' + key + ' read failure'); return key === IPC.PLUGINS_LIST ? [] : { available: false } })
  ipcMain.handle(IPC.SCAN_DIRECTORY, async () => ({ videos: [] })); ipcMain.handle(IPC.UPDATER_GET_STATUS, async () => ({ status: 'disabled' }))
  window = new BrowserWindow({ show: false, width: 1200, height: 820, webPreferences: { preload: path.join(root, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  require('../main/window').setMainWindow(window); const entry = path.join(root, 'dist/index.html')
  require('../main/security/ipc-sender').bindAppWindow(window, pathToFileURL(entry).href)
  const run = source => window.webContents.executeJavaScript(source)
  const until = async test => { const end = Date.now() + 8000; while (!await test()) { if (Date.now() > end) throw Error('UI condition timed out: ' + phase); await delay(5) } }
  await window.loadFile(entry); await window.webContents.insertCSS('*, *::before, *::after { animation: none !important; transition: none !important; }')
  await until(() => run("Boolean(document.querySelector('.initialization-notice [role=alert]'))"))
  assert.ok(await run("document.body.textContent.includes('无法载入应用设置')")); assert.strictEqual(await run("Boolean(document.querySelector('.empty-state'))"), false)
  await run("window.__initializationErrors = []; window.addEventListener('unhandledrejection', e => window.__initializationErrors.push(String(e.reason)))")
  phase = 'coalesced settings retry'
  await run("const button = document.querySelector('.initialization-notice button'); button.click(); button.click()")
  await until(() => counts[IPC.GET_SETTINGS] === 2); await delay(50); assert.strictEqual(counts[IPC.GET_SETTINGS], 2)
  release(); await until(() => run("document.querySelectorAll('.initialization-notice [role=alert]').length === 3"))
  assert.ok(await run("document.body.textContent.includes('未找到视频文件')"), 'a successful empty library and a failed settings read are distinct UI states')
  phase = 'independent optional retries'
  const retry = label => run(`document.querySelectorAll('.initialization-notice button').forEach(button => { if (button.textContent === ${JSON.stringify(label)}) button.click() })`)
  await retry('重试插件列表'); await until(() => counts[IPC.PLUGINS_LIST] === 2 && run("document.querySelectorAll('.initialization-notice [role=alert]').length === 2"))
  assert.strictEqual(counts[IPC.CHECK_FFMPEG], 1); assert.strictEqual(counts[IPC.CHECK_MPV], 1); assert.strictEqual(counts[IPC.GET_SETTINGS], 2)
  await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await delay(150)
  await fsp.writeFile(path.join(parent, 'initialization-retry.png'), (await window.webContents.capturePage()).toPNG())
  await retry('重试FFmpeg 状态'); await retry('重试mpv 状态')
  await until(() => run("!document.querySelector('.initialization-notice')"))
  assert.strictEqual(counts[IPC.GET_SETTINGS], 2); assert.deepStrictEqual(await run('window.__initializationErrors'), [])
  console.log('initialization UI passed: production App/preload/guarded settings IPC, failed settings distinct from empty library, coalesced primary retry and independent plugin/FFmpeg/mpv retries')
}).then(() => finish(0), error => { console.error('initialization UI phase: ' + phase, error); finish(1) })
function finish(code) { release(); clearTimeout(timeout); window?.destroy(); app.exit(code) }
