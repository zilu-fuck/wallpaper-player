const { app, ipcMain, dialog, shell } = require('electron')
const { pathToFileURL } = require('url')
const path = require('path')
const fsp = require('fs/promises')
const { execFileSync } = require('child_process')
const { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } = require('./constants')
const { pathKey, isPathInside, isMpvExecutablePath, isPortableApp, isVideoFile } = require('./paths')
const {
  sessionAllowedDirectories,
  sessionPrivateDirectories,
  sessionAllowedMpvPaths,
  addSessionAllowedFile,
  getPlaybackState,
  loadSettings,
  saveSettings,
  sanitizeSettingsForSave,
  sanitizeSettingsForRenderer,
  createPrivacyPassword,
  verifyPrivacyPassword,
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
  getPreviewFrameDir,
  generatePreviewFrame,
  setMediaPlaybackActive,
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
const { getVideoMetadata } = require('./video-metadata')
const { pluginRegistry, installPlugin, uninstallPlugin, getExternalPluginsDir } = require('./plugins')

const SECRET_PLACEHOLDER = '***'

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
const PRIVACY_UNLOCK_FAILURE_LIMIT = 5
const PRIVACY_UNLOCK_LOCK_MS = 30 * 1000
const privacyUnlockFailures = new Map()
const pendingThumbnailTasks = new Map()

function preserveMaskedPluginSecrets(plugin, nextConfig, currentConfig) {
  if (!nextConfig || typeof nextConfig !== 'object' || Array.isArray(nextConfig)) return nextConfig
  const secretKeys = Array.isArray(plugin?.secretKeys) ? plugin.secretKeys : []
  if (!secretKeys.length) return nextConfig
  const secretKeySet = new Set(secretKeys)
  function mergeValue(nextValue, currentValue, key) {
    if (secretKeySet.has(key) && nextValue === SECRET_PLACEHOLDER) {
      return currentValue
    }
    if (
      nextValue &&
      typeof nextValue === 'object' &&
      !Array.isArray(nextValue) &&
      currentValue &&
      typeof currentValue === 'object' &&
      !Array.isArray(currentValue)
    ) {
      return Object.fromEntries(
        Object.entries(nextValue).map(([childKey, childValue]) => [
          childKey,
          mergeValue(childValue, currentValue[childKey], childKey)
        ])
      )
    }
    return nextValue
  }
  return mergeValue(nextConfig, currentConfig || {}, '')
}

function queueThumbnailTask(videoPath) {
  const key = pathKey(videoPath)
  const pending = pendingThumbnailTasks.get(key)
  if (pending) return pending

  const task = resolveThumbnail(videoPath)
    .finally(() => {
      pendingThumbnailTasks.delete(key)
    })
  pendingThumbnailTasks.set(key, task)
  return task
}

async function runThumbnailWorkers(videoPaths, concurrency, onProgress) {
  const results = {}
  const uniquePaths = []
  const seen = new Set()
  for (const videoPath of videoPaths) {
    if (typeof videoPath !== 'string' || !videoPath.trim()) continue
    const key = pathKey(videoPath)
    if (seen.has(key)) continue
    seen.add(key)
    uniquePaths.push(videoPath)
  }

  let index = 0
  let completed = 0
  async function worker() {
    while (index < uniquePaths.length) {
      const videoPath = uniquePaths[index++]
      try {
        results[videoPath] = await queueThumbnailTask(videoPath)
      } catch {
        results[videoPath] = null
      }
      completed += 1
      onProgress?.(completed, uniquePaths.length)
    }
  }

  onProgress?.(0, uniquePaths.length, true)
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()))
  onProgress?.(completed, uniquePaths.length, true)
  return results
}

function getPrivacyUnlockKey(event) {
  return String(event?.sender?.id || 'main')
}

function getPrivacyUnlockWaitMs(key) {
  const current = privacyUnlockFailures.get(key)
  if (!current || !current.lockUntil) return 0
  const waitMs = current.lockUntil - Date.now()
  if (waitMs <= 0) {
    privacyUnlockFailures.delete(key)
    return 0
  }
  return waitMs
}

function recordPrivacyUnlockFailure(key) {
  const current = privacyUnlockFailures.get(key) || { count: 0, lockUntil: 0 }
  const nextCount = current.count + 1
  const next = {
    count: nextCount,
    lockUntil: nextCount >= PRIVACY_UNLOCK_FAILURE_LIMIT ? Date.now() + PRIVACY_UNLOCK_LOCK_MS : 0
  }
  privacyUnlockFailures.set(key, next)
  return next.lockUntil ? PRIVACY_UNLOCK_LOCK_MS : 0
}

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
      const thumbPath = await queueThumbnailTask(videoPath)
      return { thumbPath }
    } catch (err) {
      return { error: err.message }
    }
  })

  ipcMain.handle('get-video-metadata', async (_event, videoPath, options = {}) => {
    try {
      const resolvedPath = await assertAllowedVideoPath(videoPath)
      return { success: true, media: await getVideoMetadata(resolvedPath, options) }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('generate-thumbnails', async (_event, payload) => {
    const videoPaths = Array.isArray(payload) ? payload : payload?.paths
    const requestId = Array.isArray(payload) ? null : payload?.requestId
    if (!Array.isArray(videoPaths)) {
      return {}
    }

    const concurrency = 3
    let lastProgressAt = 0

    function sendThumbnailProgress(completed, total, force = false) {
      const win = getMainWindow()
      if (!win || win.isDestroyed()) return
      const now = Date.now()
      if (!force && now - lastProgressAt < 120) return
      lastProgressAt = now
      win.webContents.send('thumbnail-progress', {
        completed,
        total,
        requestId
      })
    }

    return runThumbnailWorkers(videoPaths, concurrency, sendThumbnailProgress)
  })

  ipcMain.handle('get-settings', async () => {
    return sanitizeSettingsForRenderer(loadSettings())
  })

  ipcMain.handle('get-app-version', async () => {
    return app.getVersion()
  })

  ipcMain.handle('plugins-list', async () => {
    return pluginRegistry.listPlugins()
  })

  ipcMain.handle('plugins-set-enabled', async (_event, pluginId, enabled) => {
    try {
      return await pluginRegistry.setPluginEnabled(pluginId, enabled)
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('plugins-install', async (_event, sourceType = 'file') => {
    try {
      const win = getMainWindow()
      const installDirectory = sourceType === 'directory'
      const result = await dialog.showOpenDialog(win, {
        title: installDirectory ? '选择插件文件夹' : '选择插件包或 plugin.json',
        properties: installDirectory ? ['openDirectory'] : ['openFile'],
        filters: installDirectory
          ? undefined
          : [
              { name: '插件包或清单', extensions: ['zip', 'json'] },
              { name: '所有文件', extensions: ['*'] }
            ]
      })
      if (result.canceled || !result.filePaths.length) {
        return { success: false, canceled: true }
      }
      return await installPlugin(result.filePaths[0])
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('plugins-uninstall', async (_event, pluginId) => {
    try {
      return await uninstallPlugin(pluginId)
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('plugins-open-directory', async () => {
    try {
      const dir = getExternalPluginsDir()
      await fsp.mkdir(dir, { recursive: true })
      const error = await shell.openPath(dir)
      return { success: !error, error, dir }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('plugins-save-config', async (_event, pluginId, config) => {
    try {
      const plugin = pluginRegistry.getPlugin(pluginId)
      if (!plugin) return { success: false, error: '插件不存在' }
      const settings = loadSettings()
      const currentConfig = settings.plugins?.[plugin.id]?.config || {}
      const nextConfig = pluginRegistry.normalizePluginConfig(
        plugin,
        preserveMaskedPluginSecrets(plugin, config, currentConfig)
      )
      if (plugin.id === 'ai-search' && config && !Object.prototype.hasOwnProperty.call(config, 'feedbackMemory') && Array.isArray(currentConfig.feedbackMemory)) {
        nextConfig.feedbackMemory = currentConfig.feedbackMemory
      }
      const saved = saveSettings(sanitizeSettingsForSave({
        plugins: {
          [plugin.id]: {
            ...(settings.plugins?.[plugin.id] || {}),
            config: nextConfig,
            updatedAt: new Date().toISOString()
          }
        }
      }))
      return {
        success: true,
        plugin: pluginRegistry.listPlugins().find(item => item.id === plugin.id)
      }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('save-settings', async (_event, settings) => {
    const saved = saveSettings(sanitizeSettingsForSave(settings))
    return { success: true, settings: sanitizeSettingsForRenderer(saved) }
  })

  ipcMain.handle('privacy-set-password', async (_event, password) => {
    try {
      const settings = loadSettings()
      if (settings.privacy?.passwordSet) {
        return { success: false, error: '隐私密码已设置' }
      }
      const privacy = createPrivacyPassword(password)
      saveSettings({ privacy })
      return { success: true, privacy: { passwordSet: true } }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('privacy-unlock', async (event, password) => {
    try {
      const unlockKey = getPrivacyUnlockKey(event)
      const waitMs = getPrivacyUnlockWaitMs(unlockKey)
      if (waitMs > 0) {
        return { success: false, error: `密码错误次数过多，请 ${Math.ceil(waitMs / 1000)} 秒后再试` }
      }
      const settings = loadSettings()
      if (!settings.privacy?.passwordSet) {
        return { success: false, error: '请先设置隐私密码' }
      }
      if (!verifyPrivacyPassword(password, settings.privacy)) {
        const lockedMs = recordPrivacyUnlockFailure(unlockKey)
        if (lockedMs > 0) {
          return { success: false, error: `密码错误次数过多，请 ${Math.ceil(lockedMs / 1000)} 秒后再试` }
        }
        return { success: false, error: '隐私密码不正确' }
      }
      privacyUnlockFailures.delete(unlockKey)
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
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

  ipcMain.handle('select-video-directory', async () => {
    const win = getMainWindow()
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: '选择视频目录'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const selectedDir = path.resolve(result.filePaths[0])
    const response = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['添加', '取消'],
      defaultId: 0,
      cancelId: 1,
      title: '添加目录',
      message: '是否将这个目录设为隐私目录？',
      detail: '隐私目录默认不会出现在侧栏和手机远程库中。你可以在侧栏临时显示后进入或移除。',
      checkboxLabel: '设为隐私目录',
      checkboxChecked: false,
      noLink: true
    })
    if (response.response === 1) return null
    sessionAllowedDirectories.add(selectedDir)
    if (response.checkboxChecked) {
      sessionPrivateDirectories.add(pathKey(selectedDir))
    } else {
      sessionPrivateDirectories.delete(pathKey(selectedDir))
    }
    return {
      path: selectedDir,
      privateDirectory: Boolean(response.checkboxChecked)
    }
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
    const previewFrameDir = getPreviewFrameDir()
    const allowedDirs = getAllowedVideoDirectories()
    const canExpose = (
      isPathInside(thumbDir, resolvedPath) ||
      isPathInside(previewFrameDir, resolvedPath) ||
      allowedDirs.some(dir => isPathInside(dir, resolvedPath))
    )

    if (!stats.isFile() || !canExpose || !IMAGE_EXTENSIONS.has(path.extname(resolvedPath).toLowerCase())) {
      throw new Error('缩略图路径无效')
    }

    return pathToFileURL(resolvedPath).href
  })

  ipcMain.handle('generate-preview-frame', async (_event, videoPath, seconds) => {
    try {
      const framePath = await generatePreviewFrame(videoPath, seconds)
      return { framePath }
    } catch (err) {
      return { error: err.message }
    }
  })

  ipcMain.handle('set-media-playback-active', async (_event, active) => {
    setMediaPlaybackActive(active)
    return { success: true }
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
      setMediaPlaybackActive(true)
      await mpvManager.play(resolvedPath, {
        hostBounds: playOptions.hostBounds,
        playlist,
        playlistIndex,
        resume
      })
      return { success: true }
    } catch (err) {
      setMediaPlaybackActive(false)
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
    setMediaPlaybackActive(false)
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
