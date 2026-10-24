const { app, dialog, globalShortcut } = require('electron')
const log = require('electron-log')
const { IPC, EVENT } = require('./ipc-channels')
const { setupCSP, createWindow, getMainWindow, setWindowCloseHandler } = require('./window')
const { setupIPC } = require('./ipc')
const { settingsBroadcast } = require('./application/settings-broadcast')
const { setupAutoUpdater, disposeUpdater } = require('./updater')
const { initMpv, destroyMpv } = require('./mpv-integration')
const { disposeDownloadManager } = require('./download-manager')
const { unwatchAllDirectories } = require('./scanner')
const { loadSettings, saveSettings, sanitizeSettingsForSave, flushSettingsWrites, disposeSettingsSerialization } = require('./settings')
const { setupPlugins, disposePlugins } = require('./plugins')
const { getPortableDataFallback } = require('./portable-user-data')
const {
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
let pendingSecondInstance = false
let shutdownStarted = false
let shutdownComplete = false

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
  win.webContents.send(EVENT.PLAYER_SHORTCUT, { action, value })
  return true
}

function setupSettingsSync() {
  removeSettingsChangedListener?.()
  removeSettingsChangedListener = settingsBroadcast.start()
}

function registerGlobalMediaShortcuts() {
  const shortcuts = [
    ['MediaPlayPause', () => sendPlayerShortcut('play-pause')],
    ['MediaNextTrack', () => sendPlayerShortcut('next')],
    ['MediaPreviousTrack', () => sendPlayerShortcut('prev')],
    ['MediaStop', () => sendPlayerShortcut('stop')]
  ]

  for (const [accelerator, callback] of shortcuts) {
    try {
      globalShortcut.register(accelerator, callback)
    } catch (err) {
      log.warn('[shortcut] register failed:', accelerator, err.message)
    }
  }
}

function focusMainWindow() {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return false
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  return true
}

function showPortableDataFallbackNotice(win) {
  const fallback = getPortableDataFallback()
  if (!fallback) return
  log.warn('[portable] Data 目录不可写，已回退系统 userData:', fallback)
  // 启动早期窗口可能还没装载好，notify 内部会自动回退到系统对话框。
  require('./application/confirm').notify(win, {
    tone: 'warning',
    title: '便携数据目录不可写',
    message: '已改用系统数据目录保存本次数据',
    detail: `便携目录：${fallback.requestedPath}\n系统目录：${fallback.fallbackPath}\n\n便携目录恢复可写后，数据不会自动迁回。`
  }).catch(error => {
    log.warn('[portable] fallback notice failed:', error?.message || error)
  })
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

    // 优先用应用内自绘的询问框（与设计系统一致）；
    // 渲染层不可用（正在重载、崩溃、超时）时回退到系统对话框。
    const { askRendererToClose, canAskRenderer } = require('./ipc/window-shell')
    const inApp = canAskRenderer(win) ? await askRendererToClose(win) : null
    const result = inApp || await dialog.showMessageBox(win, {
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

    // 应用内询问框可以回答 cancel（保持窗口打开）——此时什么都不做。
    if (inApp && inApp.action === 'cancel') return

    const action = (inApp ? inApp.action : (result.response === 1 ? 'exit' : 'minimize')) === 'exit' ? 'exit' : 'minimize'
    const rememberAction = inApp ? Boolean(inApp.remember) : Boolean(result.checkboxChecked)
    if (rememberAction) {
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

async function start() {
  const settingsReady = await require('./application/settings-startup').prepareSettingsForStartup({ dialog })
  if (isAppQuitting) return
  if (!settingsReady) { app.exit(1); return }
  setupCSP()
  await require('./remote/identity').refreshIdentity().catch(error => {
    log.error('[identity] 初始化失败:', error)
  })
  if (isAppQuitting) return
  setWindowCloseHandler((event, win) => {
    handleWindowClose(event, win).catch((error) => {
      log.error('[window] close prompt failed:', error)
      minimizeWindow(win)
    })
  })
  await setupPlugins()
  if (isAppQuitting) return
  setupIPC()
  setupSettingsSync()
  const win = createWindow()
  showPortableDataFallbackNotice(win)
  registerGlobalMediaShortcuts()
  if (pendingSecondInstance) {
    pendingSecondInstance = false
    focusMainWindow()
  }
  setupAutoUpdater()
  initRemoteAccess().catch((error) => {
    log.error('[remote] 初始化失败:', error)
  })
  initMpv().catch((error) => {
    log.error('[mpv] 初始化失败:', error)
  })

  app.on('activate', () => {
    if (!focusMainWindow()) {
      createWindow()
    }
  })
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!focusMainWindow()) pendingSecondInstance = true
  })

  app.whenReady().then(start).catch((error) => {
    log.error('[app] 启动失败:', error)
    app.quit()
  })

  app.on('window-all-closed', () => {
    if (shouldKeepRunningInTray()) return
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', (event) => {
    if (shutdownComplete) return
    event.preventDefault()
    if (shutdownStarted) return
    shutdownStarted = true
    isAppQuitting = true
    markQuitting()
    removeSettingsChangedListener?.()
    removeSettingsChangedListener = null
    globalShortcut.unregisterAll()
    disposeUpdater()
    unwatchAllDirectories()
    require('./application/media-work-service').mediaWorkService.dispose()
    require('./application/resource-scheduler').mediaScheduler.beginShutdown?.({ preserveTypes: ['download-daemon'] })
    let resourceCleanup
    const disposeResourceScheduler = () => resourceCleanup ||= require('./application/resource-scheduler').mediaScheduler.dispose()
    const teardown = (async () => {
      const results = await Promise.allSettled([
        disposeRemoteAccess(), require('./remote/transcode').disposeTranscodes(), disposePlugins(), destroyMpv(), disposeDownloadManager(),
        require('./video-metadata').disposeVideoMetadata()
      ])
      for (const result of results) {
        if (result.status === 'rejected') log.error('[shutdown] cleanup failed:', result.reason)
      }
      await disposeResourceScheduler()
      await flushSettingsWrites()
      await disposeSettingsSerialization()
    })()
    let deadline
    const bounded = new Promise(resolve => {
      deadline = setTimeout(() => {
        log.warn('[shutdown] cleanup exceeded 5 seconds')
        void disposeSettingsSerialization({ cancel: true }).catch(error => log.error('[shutdown] forced settings cleanup failed:', error))
        void disposeResourceScheduler().catch(error => log.error('[shutdown] forced resource cleanup failed:', error))
        const forced = require('./mpv-integration').mpvManager.destroy()
        forced?.catch?.(error => log.error('[shutdown] forced player cleanup failed:', error))
        resolve()
      }, 5000)
    })
    Promise.race([teardown, bounded]).catch(error => {
      log.error('[shutdown] persistence failed:', error)
    }).finally(() => {
      clearTimeout(deadline)
      shutdownComplete = true
      app.quit()
    })
  })
}

module.exports = { start }
