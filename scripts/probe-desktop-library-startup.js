// Runs the actual main process, preload, production React bundle and native Chromium window.
// The sole window override keeps this automated probe hidden.
const path = require('path'), Module = require('module')
const electron = require('electron')
const root = path.resolve(__dirname, '..'), fixture = process.env.WALLPAPER_DESKTOP_LIBRARY_FIXTURE || process.argv[2]
const { app } = electron
if (!fixture || !path.isAbsolute(fixture) || path.dirname(path.resolve(fixture)) !== path.join(root, '.tmp/refactor-tests') || !path.basename(fixture).startsWith('library-performance-')) {
  process.stderr.write('desktop probe requires an owned absolute library performance fixture\n'); app.exit(1)
}
const { performance } = require('perf_hooks')
const started = performance.now(), phases = {}
const elapsed = () => performance.now() - started
app.whenReady().then(() => { phases.nativeReadyMs = elapsed() })
const nativeHandle = electron.ipcMain.handle
electron.ipcMain.handle = function (channel, handler) {
  return nativeHandle.call(this, channel, async (...args) => {
    if (channel === 'scan-directory' && !phases.scanStartMs) {
      phases.scanStartMs = elapsed()
      const result = await handler(...args)
      phases.scanEndMs = elapsed(); phases.scanCount = result.videos?.length
      return result
    }
    return handler(...args)
  })
}
app.setPath('userData', path.join(fixture, '.tmp-wallpaper-player'))
app.setAppLogsPath(path.join(fixture, 'electron-logs'))
app.setName('Wallpaper Player Library Verification')
const HiddenWindow = class extends electron.BrowserWindow {
  constructor(options) { super({ ...options, show: false }) }
}
const proxy = new Proxy(electron, { get(target, key) { return key === 'BrowserWindow' ? HiddenWindow : target[key] } })
const original = Module._load
Module._load = function (request, ...args) { return request === 'electron' ? proxy : original.call(this, request, ...args) }
const timeout = setTimeout(() => { process.stderr.write('desktop startup timed out\n'); app.exit(1) }, 30000)
app.once('browser-window-created', (_event, window) => {
  phases.windowCreatedMs = elapsed()
  window.webContents.on('did-finish-load', async () => {
    phases.documentLoadedMs = elapsed()
    try {
      const inspect = () => window.webContents.executeJavaScript(`({
        cards: document.querySelectorAll('.video-card').length,
        search: Boolean(document.querySelector('.search-input')),
        clear: Boolean(document.querySelector('.search-clear')),
        updating: Boolean(document.querySelector('.progress-bar.scanning'))
      })`)
      let snapshot
      const deadline = Date.now() + 20000
      do {
        snapshot = await inspect()
        if (snapshot.cards && snapshot.search) break
        if (Date.now() > deadline) throw new Error('desktop first page did not render: ' + JSON.stringify(snapshot))
        await new Promise(resolve => setTimeout(resolve, 25))
      } while (true)
      const firstPage = snapshot.cards
      phases.firstCardsMs = elapsed()
      await window.webContents.executeJavaScript(`{
        const input = document.querySelector('.search-input');
        input.focus();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '视频-0');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }`)
      do {
        snapshot = await inspect()
        if (snapshot.clear && snapshot.cards < firstPage) break
        if (Date.now() > deadline) throw new Error('desktop input did not update the actual React gallery')
        await new Promise(resolve => setTimeout(resolve, 25))
      } while (true)
      process.stdout.write('DESKTOP_EVIDENCE:' + JSON.stringify({ firstPageCards: firstPage,
        filteredCards: snapshot.cards, searchHandled: true, progressiveScan: snapshot.updating, phases }) + '\n')
      clearTimeout(timeout)
      await require('../main/scanner').waitForBackgroundScanRefreshes()
      app.quit()
    } catch (error) { process.stderr.write(String(error.stack)); app.exit(1) }
  })
})
require('../main/index')
phases.mainRequiredMs = elapsed()
