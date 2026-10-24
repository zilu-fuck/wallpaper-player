const assert = require('assert'), fs = require('fs'), path = require('path')
const { pathToFileURL } = require('url')
const { app, BrowserWindow } = require('electron')
app.on('window-all-closed', () => {})
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp', 'refactor-tests')
fs.mkdirSync(parent, { recursive: true })
const fixture = path.resolve(process.env.WALLPAPER_PLAYER_FRAME_FIXTURE || '')
assert.strictEqual(path.dirname(fixture), parent, 'the parent verifier owns and removes the Electron profile after process exit')
app.setPath('userData', fixture)
const windows = []
let phase = 'window setup'
const deadline = setTimeout(() => { console.error('player frame timed out during ' + phase); app.exit(1) }, 20000)
app.whenReady().then(async () => {
  const { registerPlayerIpc } = require('../main/ipc/player'), { setMainWindow } = require('../main/window')
  registerPlayerIpc()
  const make = () => { const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(root, 'preload.js'),
    contextIsolation: true, nodeIntegration: false, sandbox: false } }); windows.push(win); return win }
  const main = make(), foreign = make(); setMainWindow(main)
  const entry = path.join(fixture, 'entry.html'); fs.writeFileSync(entry, '<html><title>player IPC fixture</title></html>')
  require('../main/security/ipc-sender').bindAppWindow(main, pathToFileURL(entry).href)
  await Promise.all(windows.map(win => win.loadFile(entry)))
  const invoke = win => win.webContents.executeJavaScript("window.electronAPI.playerAction({ action: 'state', sessionId: 'not-started' })")
  assert.strictEqual((await invoke(main)).code, 'stale_session', 'real main-frame IPC must pass the sender gate')
  await assert.rejects(invoke(foreign), /ipc_sender_denied/, 'another real renderer cannot control the main player')
  require('../main/ipc/media').registerMediaIpc()
  const { mpvManager } = require('../main/mpv-integration'), installs = []
  const download = mpvManager.download
  mpvManager.download = (progress, { signal }) => new Promise((_resolve, reject) => {
    installs.push({ progress, signal }); signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  const until = async predicate => { const deadline = Date.now() + 5000
    while (!predicate()) { if (Date.now() > deadline) throw new Error('installer IPC condition timed out'); await new Promise(done => setTimeout(done, 5)) } }
  try {
    phase = 'progress listener setup'
    await Promise.all(windows.map(win => win.webContents.executeJavaScript("window.installProgress = []; window.electronAPI.onMpvDownloadProgress(value => window.installProgress.push(value)); 'ready'")))
    const start = (win, id) => win.webContents.executeJavaScript("window.installPromise = window.electronAPI.downloadMpv('" + id + "').then(value => window.installResult = value); 'started'")
    phase = 'installation admission'
    await start(main, 'install-main'); await until(() => installs.length === 1)
    await assert.rejects(foreign.webContents.executeJavaScript("window.electronAPI.downloadMpv('install-foreign')"), /ipc_sender_denied/)
    phase = 'progress and owner cancellation'
    installs[0].progress({ percent: 25 })
    const progress = await main.webContents.executeJavaScript('window.installProgress')
    assert.strictEqual(progress[0].requestId, 'install-main')
    assert.strictEqual((await foreign.webContents.executeJavaScript('window.installProgress')).length, 0, 'progress reaches its requesting WebContents')
    await assert.rejects(foreign.webContents.executeJavaScript("window.electronAPI.cancelMediaWork('install-main')"), /ipc_sender_denied/)
    assert.strictEqual(installs[0].signal.aborted, false, 'a foreign window cannot cancel the first window interest')
    await main.webContents.executeJavaScript("window.electronAPI.cancelMediaWork('install-main')")
    await until(() => installs[0].signal.aborted)
    assert.strictEqual((await main.webContents.executeJavaScript('window.installPromise')).success, false)
    phase = 'cancel before admission'
    await main.webContents.executeJavaScript("window.electronAPI.cancelMediaWork('install-retired')")
    assert.strictEqual((await main.webContents.executeJavaScript("window.electronAPI.downloadMpv('install-retired')")).success, false)
    assert.strictEqual(installs.length, 1, 'cancel before IPC admission prevents a late installation')
    phase = 'main-frame navigation'
    await start(main, 'install-navigation'); await until(() => installs.length === 2)
    await main.loadURL('data:text/html,<html><title>navigated</title></html>'); await until(() => installs[1].signal.aborted)
    await assert.rejects(invoke(main), /ipc_sender_denied/)
    await main.loadFile(entry)
    phase = 'download observation IPC'
    require('../main/ipc/downloads').registerDownloadIpc()
    const downloads = require('../main/download-manager'), originalSnapshot = downloads.getSnapshot, observations = []
    downloads.getSnapshot = options => new Promise((_resolve, reject) => {
      observations.push(options); options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    })
    try {
      await main.webContents.executeJavaScript("window.statePromise = window.electronAPI.downloadGetState({start:false, requestId:'state-main'}); 'started'")
      await until(() => observations.length === 1)
      assert.strictEqual(observations[0].start, false)
      await assert.rejects(foreign.webContents.executeJavaScript("window.electronAPI.cancelMediaWork('state-main')"), /ipc_sender_denied/)
      assert.strictEqual(observations[0].signal.aborted, false)
      await main.webContents.executeJavaScript("window.electronAPI.cancelMediaWork('state-main')")
      assert.strictEqual((await main.webContents.executeJavaScript('window.statePromise')).success, false)
      assert.strictEqual((await main.webContents.executeJavaScript("window.electronAPI.downloadGetState({start:'invalid'})")).success, false)
      assert.strictEqual(observations.length, 1, 'invalid snapshot options cannot reach the manager')
    } finally { downloads.getSnapshot = originalSnapshot }
    phase = 'download admission cancellation'
    await require('../main/settings').saveSettingsAndFlush({ directories: [fixture] })
    const originalAdd = downloads.addUrl, admissions = []
    downloads.addUrl = (payload, context) => new Promise((_resolve, reject) => {
      admissions.push({ payload, context }); context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true })
    })
    try {
      await main.webContents.executeJavaScript("window.admissionPromise = window.electronAPI.downloadAddUrl({url:'https://source.invalid/test.mp4',dir:" + JSON.stringify(fixture) + ",operationId:'op-main',requestId:'prep-main'}); 'started'")
      await until(() => admissions.length === 1)
      assert.strictEqual(admissions[0].payload.operationId, 'op-main')
      await main.webContents.executeJavaScript("window.electronAPI.cancelMediaWork('prep-main')")
      assert.strictEqual((await main.webContents.executeJavaScript('window.admissionPromise')).success, false)
      await main.webContents.executeJavaScript("window.electronAPI.cancelMediaWork('prep-retired')")
      assert.strictEqual((await main.webContents.executeJavaScript("window.electronAPI.downloadAddUrl({url:'https://source.invalid/test.mp4',dir:" + JSON.stringify(fixture) + ",operationId:'op-retired',requestId:'prep-retired'})")).success, false)
      assert.strictEqual(admissions.length, 1)
    } finally { downloads.addUrl = originalAdd }
    phase = 'download control version forwarding'
    const originalPause = downloads.pause, controls = []
    downloads.pause = async (gid, options) => { controls.push({ gid, options }); return { engine: {}, tasks: [], success: true } }
    try {
      assert.strictEqual((await main.webContents.executeJavaScript("window.electronAPI.downloadPause('1111111111111111',{expectedGeneration:'current-generation'})")).success, true)
      assert.strictEqual(controls[0].options.expectedGeneration, 'current-generation')
      assert.strictEqual((await main.webContents.executeJavaScript("window.electronAPI.downloadPause('1111111111111111',{expectedGeneration:123})")).success, false)
      assert.strictEqual(controls.length, 1)
    } finally { downloads.pause = originalPause }
  } finally {
    mpvManager.download = download
    require('../main/application/media-work-service').mediaWorkService.dispose()
  }
  console.log('player frame passed: actual Electron/preload/IPC, player sender gate, scoped installer and download observation ownership, validation, cancel-before-admission and main-frame navigation cleanup')
}).catch(error => { console.error(error); process.exitCode = 1 }).finally(() => {
  clearTimeout(deadline)
  windows.forEach(win => { if (!win.isDestroyed()) win.destroy() })
  app.exit(process.exitCode || 0)
})
