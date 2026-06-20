const { app, BrowserWindow, globalShortcut } = require('electron')
const log = require('electron-log')
const { setupCSP, createWindow, getMainWindow } = require('./window')
const { setupIPC } = require('./ipc')
const { setupAutoUpdater, disposeUpdater } = require('./updater')
const { initMpv, destroyMpv } = require('./mpv-integration')
const { unwatchAllDirectories } = require('./scanner')

function sendPlayerShortcut(action, value) {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return false
  win.webContents.send('player-shortcut', { action, value })
  return true
}

function registerPlayerShortcuts() {
  const shortcuts = [
    ['MediaPlayPause', () => sendPlayerShortcut('play-pause')],
    ['MediaNextTrack', () => sendPlayerShortcut('next')],
    ['MediaPreviousTrack', () => sendPlayerShortcut('prev')],
    ['MediaStop', () => sendPlayerShortcut('stop')],
    ['Ctrl+O', () => sendPlayerShortcut('open-file')],
    ['Ctrl+Right', () => sendPlayerShortcut('seek-forward', 5)],
    ['Ctrl+Left', () => sendPlayerShortcut('seek-backward', 5)],
    ['Ctrl+Up', () => sendPlayerShortcut('volume-up', 5)],
    ['Ctrl+Down', () => sendPlayerShortcut('volume-down', 5)]
  ]

  for (const [accelerator, callback] of shortcuts) {
    try {
      globalShortcut.register(accelerator, callback)
    } catch (err) {
      log.warn('[shortcut] register failed:', accelerator, err.message)
    }
  }
}

function start() {
  setupCSP()
  setupIPC()
  createWindow()
  registerPlayerShortcuts()
  setupAutoUpdater()
  initMpv().catch((error) => {
    log.error('[mpv] 初始化失败:', error)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

app.whenReady().then(start).catch((error) => {
  log.error('[app] 启动失败:', error)
  app.quit()
})

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll()
  destroyMpv()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  globalShortcut.unregisterAll()
  disposeUpdater()
  unwatchAllDirectories()
  destroyMpv()
})

module.exports = { start }
