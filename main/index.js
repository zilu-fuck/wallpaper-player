const { app, dialog, globalShortcut } = require('electron')
const log = require('electron-log')
const { setupCSP, createWindow, getMainWindow, setWindowCloseHandler } = require('./window')
const { setupIPC } = require('./ipc')
const { setupAutoUpdater, disposeUpdater } = require('./updater')
const { initMpv, destroyMpv } = require('./mpv-integration')
const { unwatchAllDirectories } = require('./scanner')
const { loadSettings, saveSettings, sanitizeSettingsForSave, sanitizeSettingsForRenderer, onSettingsChanged } = require('./settings')
const { disposeVlmService } = require('./vlm-service')
const {
  setupRemoteIPC,
  initRemoteAccess,
  disposeRemoteAccess,
  shouldKeepRunningInTray,
  markQuitting
} = require('./remote')

function setupConsoleEncoding() {
  for (const stream of [process.stdout, process.stderr]) {
    if (typeof stream?.setDefaultEncoding === 'function') {
      stream.setDefaultEncoding('utf8')
    }
  }
}

setupConsoleEncoding()

let isAppQuitting = false
let closePromptOpen = false
let removeSettingsChangedListener = null

function getTodayKey() {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function sendPlayerShortcut(action, value) {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return false
  win.webContents.send('player-shortcut', { action, value })
  return true
}

function setupSettingsSync() {
  removeSettingsChangedListener?.()
  removeSettingsChangedListener = onSettingsChanged((settings) => {
    const win = getMainWindow()
    if (!win || win.isDestroyed()) return
    win.webContents.send('settings-changed', sanitizeSettingsForRenderer(settings))
  })
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

function minimizeWindow(win) {
  if (!win || win.isDestroyed()) return
  if (shouldKeepRunningInTray()) {
    win.hide()
  } else {
    win.minimize()
  }
}

function exitApp() {
  isAppQuitting = true
  markQuitting()
  app.quit()
}

function runCloseAction(action, win) {
  if (action === 'exit') {
    exitApp()
  } else {
    minimizeWindow(win)
  }
}

async function handleWindowClose(event, win) {
  if (!win || win.isDestroyed()) return
  if (isAppQuitting) return

  event.preventDefault()
  if (closePromptOpen) return
  closePromptOpen = true

  try {
    const today = getTodayKey()
    const settings = loadSettings()
    const closeMode = settings.windowClose?.mode || 'ask'

    if (closeMode === 'minimize' || closeMode === 'exit') {
      runCloseAction(closeMode, win)
      return
    }

    const rememberedAction = settings.windowClose?.rememberedDate === today
      ? settings.windowClose?.rememberedAction
      : ''

    if (rememberedAction === 'minimize') {
      runCloseAction('minimize', win)
      return
    }

    if (rememberedAction === 'exit') {
      runCloseAction('exit', win)
      return
    }

    const result = await dialog.showMessageBox(win, {
      type: 'question',
      title: '关闭应用',
      message: '要最小化/隐藏到后台，还是退出应用？',
      detail: shouldKeepRunningInTray()
        ? '选择最小化会隐藏到后台，手机访问服务会继续运行。'
        : '选择最小化会保留应用运行，选择退出会关闭应用。',
      buttons: ['最小化/隐藏到后台', '退出应用'],
      defaultId: 0,
      cancelId: 0,
      checkboxLabel: '今日内不再提醒',
      checkboxChecked: false,
      noLink: true
    })

    const action = result.response === 1 ? 'exit' : 'minimize'
    if (result.checkboxChecked) {
      saveSettings(sanitizeSettingsForSave({
        windowClose: {
          rememberedAction: action,
          rememberedDate: today
        }
      }))
    }

    runCloseAction(action, win)
  } finally {
    closePromptOpen = false
  }
}

function start() {
  setupCSP()
  setWindowCloseHandler((event, win) => {
    handleWindowClose(event, win).catch((error) => {
      log.error('[window] close prompt failed:', error)
      minimizeWindow(win)
    })
  })
  setupIPC()
  setupRemoteIPC()
  setupSettingsSync()
  createWindow()
  registerPlayerShortcuts()
  setupAutoUpdater()
  initRemoteAccess().catch((error) => {
    log.error('[remote] 初始化失败:', error)
  })
  initMpv().catch((error) => {
    log.error('[mpv] 初始化失败:', error)
  })

  app.on('activate', () => {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.show()
      win.focus()
    } else {
      createWindow()
    }
  })
}

app.whenReady().then(start).catch((error) => {
  log.error('[app] 启动失败:', error)
  app.quit()
})

app.on('window-all-closed', () => {
  if (shouldKeepRunningInTray()) return
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  isAppQuitting = true
  markQuitting()
  removeSettingsChangedListener?.()
  removeSettingsChangedListener = null
  globalShortcut.unregisterAll()
  disposeUpdater()
  unwatchAllDirectories()
  disposeRemoteAccess().catch((error) => {
    log.error('[remote] dispose failed:', error)
  })
  try {
    disposeVlmService()
  } catch (error) {
    log.error('[vlm] dispose failed:', error)
  }
  destroyMpv()
})

module.exports = { start }
