const { app, ipcMain, dialog, shell } = require('electron')
const { pathToFileURL } = require('url')
const path = require('path')
const fsp = require('fs/promises')
const { execFileSync } = require('child_process')
const { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } = require('./constants')
const { pathKey, isPathInside, isMpvExecutablePath, isPortableApp, isVideoFile } = require('./paths')
const {
  sessionAllowedDirectories,
  sessionAllowedMpvPaths,
  addSessionAllowedFile,
  getPlaybackState,
  loadSettings,
  saveSettings,
  sanitizeSettingsForSave,
  upsertPlaybackState,
  getAllowedVideoDirectories
} = require('./settings')
const {
  assertAllowedVideoPath,
  resolveExistingPath,
  scanWithCache
} = require('./scanner')
const {
  execFileAsync,
  findFfmpeg,
  getThumbnailDir,
  resolveThumbnail
} = require('./thumbnail')
const {
  getUpdateState,
  setUpdateState,
  checkForUpdates,
  getUpdaterDisabledState,
  downloadUpdate,
  installUpdate
} = require('./updater')
const { mpvManager, resolveMpvPath } = require('./mpv-integration')
const { getMainWindow } = require('./window')

const MPV_COMMANDS = new Set([
  'seekTo',
  'seekRelative',
  'cyclePause',
  'setPaused',
  'setVolume',
  'setMuted',
  'toggleMute',
  'setSpeed',
  'cycleSpeed',
  'setAudioTrack',
  'cycleAudioTrack',
  'setSubtitleTrack',
  'cycleSubtitleTrack',
  'setSubtitleVisible',
  'toggleSubtitleVisible',
  'setSubtitleScale',
  'setLoopMode',
  'setABLoop',
  'clearABLoop',
  'screenshot'
])

function setupIPC() {
  ipcMain.handle('scan-directory', async (_event, dirPath, force) => {
    try {
      return await scanWithCache(dirPath, force)
    } catch (err) {
      return { error: err.message }
    }
  })

  ipcMain.handle('generate-thumbnail', async (_event, videoPath) => {
    try {
      const thumbPath = await resolveThumbnail(videoPath)
      return { thumbPath }
    } catch (err) {
      return { error: err.message }
    }
  })

  ipcMain.handle('generate-thumbnails', async (_event, payload) => {
    const videoPaths = Array.isArray(payload) ? payload : payload?.paths
    const requestId = Array.isArray(payload) ? null : payload?.requestId
    if (!Array.isArray(videoPaths)) {
      return {}
    }

    const results = {}
    const concurrency = 4
    let index = 0
    let completed = 0
    let lastProgressAt = 0

    function sendThumbnailProgress(force = false) {
      const win = getMainWindow()
      if (!win || win.isDestroyed()) return
      const now = Date.now()
      if (!force && now - lastProgressAt < 120) return
      lastProgressAt = now
      win.webContents.send('thumbnail-progress', {
        completed,
        total: videoPaths.length,
        requestId
      })
    }

    async function worker() {
      while (index < videoPaths.length) {
        const i = index++
        const vp = videoPaths[i]
        try {
          results[vp] = await resolveThumbnail(vp)
        } catch {
          results[vp] = null
        }
        completed++
        sendThumbnailProgress(completed === videoPaths.length)
      }
    }

    sendThumbnailProgress(true)
    const workers = Array.from({ length: concurrency }, () => worker())
    await Promise.all(workers)
    sendThumbnailProgress(true)

    return results
  })

  ipcMain.handle('get-settings', async () => {
    return loadSettings()
  })

  ipcMain.handle('get-app-version', async () => {
    return app.getVersion()
  })

  ipcMain.handle('save-settings', async (_event, settings) => {
    saveSettings(sanitizeSettingsForSave(settings))
    return { success: true }
  })

  ipcMain.handle('select-directory', async () => {
    const win = getMainWindow()
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: '选择视频目录'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const selectedDir = path.resolve(result.filePaths[0])
    sessionAllowedDirectories.add(selectedDir)
    return selectedDir
  })

  ipcMain.handle('open-video-file', async () => {
    const win = getMainWindow()
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      title: '打开视频文件',
      filters: [
        { name: '视频文件', extensions: Array.from(VIDEO_EXTENSIONS).map(ext => ext.slice(1)) },
        { name: '所有文件', extensions: ['*'] }
      ]
    })

    if (result.canceled || result.filePaths.length === 0) return null
    const selectedPath = path.resolve(result.filePaths[0])
    if (!isVideoFile(selectedPath)) return null

    addSessionAllowedFile(selectedPath)
    return selectedPath
  })

  ipcMain.handle('allow-video-file', async (_event, filePath) => {
    try {
      const resolvedPath = await resolveExistingPath(filePath)
      const stats = await fsp.stat(resolvedPath)
      if (!stats.isFile() || !isVideoFile(resolvedPath)) {
        return { success: false, error: '文件不是受支持的视频' }
      }

      addSessionAllowedFile(resolvedPath)
      return { success: true, path: resolvedPath }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('show-in-folder', async (_event, filePath) => {
    try {
      const resolvedPath = await assertAllowedVideoPath(filePath)
      shell.showItemInFolder(resolvedPath)
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('get-file-url', async (_event, filePath) => {
    const resolvedPath = await assertAllowedVideoPath(filePath)
    return pathToFileURL(resolvedPath).href
  })

  ipcMain.handle('get-playback-state', async (_event, filePath) => {
    try {
      const resolvedPath = await assertAllowedVideoPath(filePath)
      const settings = loadSettings()
      return getPlaybackState(settings.playbackStates, resolvedPath)
    } catch {
      return null
    }
  })

  ipcMain.handle('save-playback-state', async (_event, filePath, statePatch) => {
    try {
      if (typeof filePath !== 'string' || !filePath.trim()) {
        return { success: false, error: '文件路径无效' }
      }

      const resolvedPath = await assertAllowedVideoPath(filePath)
      const settings = loadSettings()
      const playbackStates = upsertPlaybackState(settings.playbackStates, resolvedPath, statePatch)
      saveSettings({ playbackStates })
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('get-thumbnail-url', async (_event, filePath) => {
    const resolvedPath = await resolveExistingPath(filePath)
    const stats = await fsp.stat(resolvedPath)
    const thumbDir = getThumbnailDir()
    const allowedDirs = getAllowedVideoDirectories()
    const canExpose = (
      isPathInside(thumbDir, resolvedPath) ||
      allowedDirs.some(dir => isPathInside(dir, resolvedPath))
    )

    if (!stats.isFile() || !canExpose || !IMAGE_EXTENSIONS.has(path.extname(resolvedPath).toLowerCase())) {
      throw new Error('缩略图路径无效')
    }

    return pathToFileURL(resolvedPath).href
  })

  ipcMain.handle('check-ffmpeg', async () => {
    const ffmpeg = await findFfmpeg()
    if (!ffmpeg) return { available: false }

    try {
      const { stdout } = await execFileAsync(ffmpeg, ['-version'], { timeout: 5000 })
      const versionLine = stdout.split(/\r?\n/).find(line => line.trim()) || 'unknown'
      return { available: true, path: ffmpeg, version: versionLine }
    } catch {
      return { available: false }
    }
  })

  ipcMain.handle('updater-get-status', async () => getUpdateState())

  ipcMain.handle('updater-check', async () => {
    if (!app.isPackaged || isPortableApp()) {
      return setUpdateState('disabled', getUpdaterDisabledState())
    }

    await checkForUpdates()
    return getUpdateState()
  })

  ipcMain.handle('updater-download', async () => {
    if (!app.isPackaged || isPortableApp()) {
      return setUpdateState('disabled', getUpdaterDisabledState())
    }

    await downloadUpdate()
    return getUpdateState()
  })

  ipcMain.handle('updater-install', async () => {
    return installUpdate()
  })

  ipcMain.handle('check-mpv', async () => {
    const mpvPath = await resolveMpvPath()
    if (mpvPath) {
      try {
        const stdout = execFileSync(mpvPath, ['--version'], { timeout: 5000, encoding: 'utf-8', stdio: 'pipe' })
        const versionLine = stdout.split(/\r?\n/).find(line => line.trim()) || 'unknown'
        return { available: true, path: mpvPath, version: versionLine }
      } catch {
        return { available: false, path: mpvPath, version: 'unknown' }
      }
    }
    return { available: false, path: null }
  })

  ipcMain.handle('download-mpv', async () => {
    try {
      const mpvPath = await mpvManager.download((progress) => {
        const win = getMainWindow()
        if (win && !win.isDestroyed()) {
          win.webContents.send('mpv-download-progress', progress)
        }
      })
      return { success: true, path: mpvPath }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('mpv-play', async (_event, filePath, options = {}) => {
    try {
      const resolvedPath = await assertAllowedVideoPath(filePath)
      addSessionAllowedFile(resolvedPath)
      const mpvPath = await resolveMpvPath()
      if (!mpvPath) {
        return { success: false, error: 'mpv 未安装' }
      }

      const settings = loadSettings()
      const playOptions = options && typeof options === 'object' ? options : {}
      const playlist = []
      if (Array.isArray(playOptions.playlist)) {
        for (const item of playOptions.playlist) {
          try {
            playlist.push(await assertAllowedVideoPath(item))
          } catch {}
        }
      }
      const playlistIndex = Number.isInteger(Number(playOptions.playlistIndex))
        ? Number(playOptions.playlistIndex)
        : undefined
      const resume = playOptions.resume === false
        ? false
        : getPlaybackState(settings.playbackStates, resolvedPath)
      await mpvManager.play(resolvedPath, { ...playOptions, playlist, playlistIndex, resume })
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('mpv-set-host-bounds', async (_event, bounds) => {
    try {
      return mpvManager.setHostBounds(bounds)
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('mpv-stop', async () => {
    mpvManager.stop()
    return { success: true }
  })

  ipcMain.handle('mpv-is-playing', async () => {
    return mpvManager.isPlaying()
  })

  ipcMain.handle('mpv-get-state', async () => {
    return mpvManager.getState()
  })

  ipcMain.handle('mpv-command', async (_event, method, ...args) => {
    if (!MPV_COMMANDS.has(method)) {
      throw new Error(`Unsupported mpv command: ${method}`)
    }
    const fn = mpvManager[method]
    if (typeof fn !== 'function') {
      throw new Error(`Unsupported mpv command: ${method}`)
    }
    return fn.apply(mpvManager, args)
  })

  ipcMain.handle('select-mpv-path', async () => {
    const win = getMainWindow()
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      title: '选择 mpv.exe',
      filters: [{ name: '可执行文件', extensions: ['exe'] }, { name: '所有文件', extensions: ['*'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const selectedPath = path.resolve(result.filePaths[0])
    if (!isMpvExecutablePath(selectedPath)) return null
    sessionAllowedMpvPaths.add(pathKey(selectedPath))
    return selectedPath
  })
}

module.exports = { setupIPC }
