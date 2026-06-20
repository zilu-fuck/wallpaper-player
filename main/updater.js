const { app } = require('electron')
const { autoUpdater } = require('electron-updater')
const log = require('electron-log')
const { isPortableApp } = require('./paths')
const { getMainWindow } = require('./window')

let updateCheckTimer = null
let updateState = {
  status: 'idle',
  currentVersion: app.getVersion()
}
let updateCheckPromise = null
let updateDownloadPromise = null

function normalizeReleaseNotes(releaseNotes) {
  if (Array.isArray(releaseNotes)) {
    return releaseNotes
      .map(note => typeof note === 'string' ? note : note?.note)
      .filter(Boolean)
      .join('\n\n')
  }

  return typeof releaseNotes === 'string' ? releaseNotes : ''
}

function getUpdateInfo(info = {}) {
  const version = info.version || ''
  return {
    version,
    currentVersion: app.getVersion(),
    releaseName: info.releaseName || (version ? `Wallpaper Player ${version}` : ''),
    releaseNotes: normalizeReleaseNotes(info.releaseNotes),
    releaseDate: info.releaseDate || '',
    releaseUrl: version ? `https://github.com/zilu-fuck/wallpaper-player/releases/tag/v${version}` : ''
  }
}

function setUpdateState(status, payload = {}) {
  const nextPayload = { ...payload }
  if (
    nextPayload.updateInfo &&
    !nextPayload.updateInfo.releaseNotes &&
    updateState.updateInfo?.version === nextPayload.updateInfo.version
  ) {
    nextPayload.updateInfo = {
      ...updateState.updateInfo,
      ...nextPayload.updateInfo,
      releaseNotes: updateState.updateInfo.releaseNotes
    }
  }

  updateState = {
    ...updateState,
    ...nextPayload,
    status,
    currentVersion: app.getVersion(),
    error: Object.hasOwn(nextPayload, 'error') ? nextPayload.error : updateState.error || ''
  }

  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('updater-status', updateState)
  }

  return updateState
}

function getUpdateState() {
  return updateState
}

function checkForUpdates() {
  if (updateCheckPromise) return updateCheckPromise

  updateCheckPromise = autoUpdater.checkForUpdates()
    .finally(() => {
      updateCheckPromise = null
    })

  return updateCheckPromise
}

function getUpdaterDisabledState() {
  return {
    status: 'disabled',
    currentVersion: app.getVersion(),
    message: isPortableApp() ? '便携版不支持自动更新' : '开发模式不检查更新'
  }
}

function setupAutoUpdater() {
  if (!app.isPackaged || isPortableApp()) {
    console.log('[updater] 跳过自动更新检查')
    setUpdateState('disabled', getUpdaterDisabledState())
    return
  }

  autoUpdater.logger = log
  log.transports.file.level = 'info'
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    log.info('[updater] 正在检查更新')
    setUpdateState('checking', { error: '' })
  })

  autoUpdater.on('update-available', (info) => {
    log.info('[updater] 发现新版本:', info.version)
    setUpdateState('available', {
      updateInfo: getUpdateInfo(info),
      progress: null,
      error: ''
    })
  })

  autoUpdater.on('update-not-available', (info) => {
    log.info('[updater] 当前已是最新版本:', info.version)
    setUpdateState('not-available', {
      updateInfo: getUpdateInfo(info),
      progress: null,
      error: ''
    })
  })

  autoUpdater.on('download-progress', (progress) => {
    log.info(
      `[updater] 下载进度 ${progress.percent.toFixed(1)}%，` +
      `${Math.round(progress.bytesPerSecond / 1024)} KB/s`
    )
    setUpdateState('downloading', {
      progress: {
        percent: progress.percent,
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total
      },
      error: ''
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    log.info('[updater] 更新下载完成:', info.version)
    setUpdateState('downloaded', {
      updateInfo: getUpdateInfo(info),
      progress: {
        percent: 100,
        bytesPerSecond: 0,
        transferred: 0,
        total: 0
      },
      error: ''
    })
  })

  autoUpdater.on('error', (error) => {
    log.error('[updater] 自动更新失败:', error)
    setUpdateState('error', {
      error: error.message || String(error)
    })
  })

  setTimeout(() => {
    checkForUpdates().catch((error) => {
      log.error('[updater] 检查更新失败:', error)
    })
  }, 5000)

  updateCheckTimer = setInterval(() => {
    checkForUpdates().catch((error) => {
      log.error('[updater] 定时检查更新失败:', error)
    })
  }, 6 * 60 * 60 * 1000)
}

function disposeUpdater() {
  if (updateCheckTimer) {
    clearInterval(updateCheckTimer)
    updateCheckTimer = null
  }
}

function downloadUpdate() {
  if (updateState.status === 'downloading' && updateDownloadPromise) {
    return updateDownloadPromise
  }

  if (updateState.status !== 'available') {
    return Promise.resolve(updateState)
  }

  setUpdateState('downloading', {
    progress: { percent: 0, bytesPerSecond: 0, transferred: 0, total: 0 },
    error: ''
  })

  updateDownloadPromise = autoUpdater.downloadUpdate()
    .finally(() => {
      updateDownloadPromise = null
    })
  return updateDownloadPromise
}

function installUpdate() {
  if (updateState.status !== 'downloaded') {
    return { success: false, error: '更新尚未下载完成' }
  }

  autoUpdater.quitAndInstall(false, true)
  return { success: true }
}

module.exports = {
  normalizeReleaseNotes,
  getUpdateInfo,
  setUpdateState,
  getUpdateState,
  checkForUpdates,
  getUpdaterDisabledState,
  setupAutoUpdater,
  disposeUpdater,
  downloadUpdate,
  installUpdate
}
