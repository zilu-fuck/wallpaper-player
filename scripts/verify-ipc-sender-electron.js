const assert = require('assert'), fs = require('fs'), path = require('path'), http = require('http')
const { pathToFileURL } = require('url')
const { once } = require('events')
const { app, BrowserWindow, ipcMain: nativeIpcMain } = require('electron')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
const fixture = path.resolve(process.env.WALLPAPER_IPC_SENDER_FIXTURE || '')
assert.strictEqual(path.dirname(fixture), parent)
app.setPath('userData', fixture)
app.on('window-all-closed', () => {})
const windows = [], servers = [], sockets = new Set()
let phase = 'startup'
const delay = ms => new Promise(done => setTimeout(done, ms))
const until = async check => { const end = Date.now() + 5000; while (!await check()) { if (Date.now() >= end) throw Error('timeout: ' + phase); await delay(5) } }
const deadline = setTimeout(() => { console.error('IPC sender timed out: ' + phase); app.exit(1) }, 35000)
app.whenReady().then(async () => {
  const { setMainWindow } = require('../main/window')
  const { bindAppWindow, guardAppNavigation, captureAppSender } = require('../main/security/ipc-sender')
  const { ipcMain } = require('../main/security/ipc')
  const { IPC } = require('../main/ipc-channels')
  require('../main/ipc').setupIPC()
  const officialPlugins = require('../main/plugins')
  await officialPlugins.setupPlugins()
  for (const id of ['video-analysis', 'ai-search']) {
    const enabled = await officialPlugins.pluginRegistry.setPluginEnabled(id, true)
    assert.strictEqual(enabled.success, true, enabled.error)
  }
  const registry = require('../main/plugins/registry').createPluginRegistry()
  let pluginCalls = 0, release, heldSource
  const plugin = { id: 'ipc-source-probe', name: 'IPC Source Probe', enabled: true, setup(ctx) {
    ctx.ipc.handle('probe-ipc-source', (_event, value) => { pluginCalls++; return value })
    ctx.ipc.handle('probe-ipc-held', (event, fail) => {
      heldSource = captureAppSender(event)
      return new Promise((done, reject) => { release = () => fail ? reject(Error('private internal failure')) : done('late-result') })
    })
  } }
  await registry.setup([plugin])
  const registered = ipcMain.registeredChannels()
  for (const channel of Object.values(IPC)) assert.ok(registered.includes(channel), 'core channel is outside the common gate: ' + channel)
  assert.ok(registered.includes('video-analysis-vlm-state') && registered.includes('ai-search-start'))
  const entry = path.join(fixture, 'entry.html'), other = path.join(fixture, 'other.html'), child = path.join(fixture, 'child.html')
  fs.writeFileSync(entry, '<html><title>trusted fixture</title><iframe src="child.html"></iframe></html>')
  fs.writeFileSync(child, '<html><title>child fixture</title></html>')
  fs.writeFileSync(other, '<html><title>other file</title></html>')
  const preload = path.join(fixture, 'preload.js')
  fs.writeFileSync(preload, `require(${JSON.stringify(path.join(root, 'preload.js'))});
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ipcProbe', { invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args) });
ipcRenderer.on('probe-pending', (_event, token) => ipcRenderer.invoke('get-app-version').then(
  () => ipcRenderer.send('probe-pending-result', { token, allowed: true }),
  error => ipcRenderer.send('probe-pending-result', { token, denied: error.message })
));`)
  const make = () => { const win = new BrowserWindow({ show: false, webPreferences: { preload,
    contextIsolation: true, nodeIntegration: false, sandbox: false, nodeIntegrationInSubFrames: true } }); windows.push(win); return win }
  const main = make(), foreign = make(), entryUrl = pathToFileURL(entry).href
  setMainWindow(main); bindAppWindow(main, entryUrl); bindAppWindow(foreign, entryUrl)
  await Promise.all([main.loadFile(entry), foreign.loadFile(entry)])
  const invoke = (target, channel, args = []) => target.executeJavaScript(`window.ipcProbe.invoke(${JSON.stringify(channel)}, ...${JSON.stringify(args)})`)
  const accepts = async () => {
    assert.strictEqual(await invoke(main.webContents, 'get-app-version'), app.getVersion())
    assert.strictEqual(await invoke(main.webContents, 'probe-ipc-source', ['allowed']), 'allowed')
  }
  phase = 'trusted application and all registered channels'
  await accepts()
  assert.strictEqual((await invoke(main.webContents, 'video-analysis-vlm-state')).success, true)
  for (const channel of registered) await assert.rejects(invoke(foreign.webContents, channel), /ipc_sender_denied/, channel)
  const frame = main.webContents.mainFrame.frames.find(frame => frame.url === pathToFileURL(child).href)
  assert.ok(frame, 'real subframe loaded')
  assert.strictEqual(await frame.executeJavaScript('typeof window.ipcProbe?.invoke'), 'function')
  for (const channel of registered) await assert.rejects(invoke(frame, channel), /ipc_sender_denied/, channel)
  assert.strictEqual(pluginCalls, 1, 'rejected plugin calls have no effects')

  phase = 'exact file, query and same-document navigation'
  for (const url of [pathToFileURL(other).href, entryUrl + '?unexpected=1', 'about:blank', 'data:text/html,<title>remote document</title>']) {
    await main.loadURL(url)
    await assert.rejects(invoke(main.webContents, 'get-app-version'), /ipc_sender_denied/)
  }
  await main.loadFile(entry); await accepts()
  await main.loadURL(entryUrl + '#library'); await accepts()
  phase = 'navigation generation and retired results'
  await main.webContents.executeJavaScript("window.held = window.ipcProbe.invoke('probe-ipc-held').catch(() => null); 'started'")
  await until(() => release)
  const reloaded = once(main.webContents, 'did-finish-load'); main.reload(); await reloaded
  assert.throws(() => heldSource.assertCurrent(), error => error.code === 'ipc_sender_denied')
  release(); await accepts()

  phase = 'exact development origin and pending navigation'
  let heldResponse, redirectTarget = '', otherHits = 0
  const listen = async handler => {
    const server = http.createServer(handler); servers.push(server)
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
    await new Promise(done => server.listen(0, '127.0.0.1', done)); return 'http://127.0.0.1:' + server.address().port + '/'
  }
  const wrongOrigin = await listen((_req, res) => { otherHits++; res.end('<title>other port</title>') })
  const origin = await listen((req, res) => {
    if (req.url === '/hold') { heldResponse = res; return }
    if (redirectTarget) { const target = redirectTarget; redirectTarget = ''; res.writeHead(302, { Location: target }); res.end(); return }
    res.end('<title>development fixture</title>')
  })
  bindAppWindow(main, origin)
  await main.loadURL(origin); await accepts()
  await main.loadURL(wrongOrigin)
  await assert.rejects(invoke(main.webContents, 'get-app-version'), /ipc_sender_denied/)
  await main.loadURL(origin)
  let pendingReport
  const report = (event, value) => { if (event.sender === main.webContents && value.token === 'navigation-pending') pendingReport = value }
  nativeIpcMain.on('probe-pending-result', report)
  const pending = main.loadURL(origin + 'hold').catch(() => {})
  await until(() => heldResponse)
  // executeJavaScript waits for navigation to finish; ask the still-running old preload to issue the actual IPC instead.
  main.webContents.send('probe-pending', 'navigation-pending')
  await until(() => pendingReport)
  assert.match(pendingReport.denied || '', /ipc_sender_denied/)
  nativeIpcMain.removeListener('probe-pending-result', report)
  await main.loadURL(origin); await pending; heldResponse.destroy(); await accepts()

  phase = 'actual navigation and redirect guard'
  const external = [], unguard = guardAppNavigation(main.webContents, origin, url => external.push(url))
  const hitsBefore = otherHits
  await main.webContents.executeJavaScript(`const link = document.createElement('a'); link.href = ${JSON.stringify(wrongOrigin)}; document.body.append(link); link.click(); 'clicked'`)
  await until(() => external.length === 1)
  assert.strictEqual(main.webContents.getURL(), origin); assert.strictEqual(otherHits, hitsBefore)
  redirectTarget = wrongOrigin
  await main.loadURL(origin).catch(() => {})
  assert.strictEqual(otherHits, hitsBefore, 'redirect is stopped before the other origin is requested')
  await main.loadURL(origin); await accepts(); unguard()

  phase = 'plugin unload/reload and active-window replacement'
  await registry.setPluginEnabled(plugin.id, false)
  assert.ok(!ipcMain.registeredChannels().includes('probe-ipc-source'))
  await registry.setPluginEnabled(plugin.id, true)
  await accepts()
  release = null
  const retiredReply = assert.rejects(invoke(main.webContents, 'probe-ipc-held'), /ipc_sender_denied/)
  await until(() => release)
  setMainWindow(foreign)
  release(); await retiredReply
  setMainWindow(main); release = null
  const retiredError = assert.rejects(invoke(main.webContents, 'probe-ipc-held', [true]), error =>
    /ipc_sender_denied/.test(error.message) && !error.message.includes('private internal failure'))
  await until(() => release)
  setMainWindow(foreign); release(); await retiredError
  await assert.rejects(invoke(main.webContents, 'get-app-version'), /ipc_sender_denied/)
  assert.strictEqual(await invoke(foreign.webContents, 'get-app-version'), app.getVersion())
  await registry.dispose()
  assert.ok(!ipcMain.registeredChannels().includes('probe-ipc-source'))
  await officialPlugins.disposePlugins()
  require('../main/application/media-work-service').mediaWorkService.dispose()
  await require('../main/application/resource-scheduler').mediaScheduler.dispose()
  console.log('IPC sender passed: ' + registered.length + ' real core/plugin channels, exact file/development entry, foreign windows, real subframes, query/origin rejection, pending/reloaded generations, actual navigation/redirect guards, plugin unload/reload and active-window replacement')
}).catch(error => { console.error('IPC phase: ' + phase, error); process.exitCode = 1 }).finally(async () => {
  clearTimeout(deadline)
  sockets.forEach(socket => socket.destroy())
  await Promise.all(servers.map(server => new Promise(done => server.close(done))))
  windows.forEach(win => { if (!win.isDestroyed()) win.destroy() })
  app.exit(process.exitCode || 0)
})
