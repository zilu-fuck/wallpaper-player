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
  sessionAllowedAnalysisResultDirectories,
  sessionAllowedAnalysisModelDirectories,
  addSessionAllowedFile,
  getDefaultAnalysisModelDirectory,
  getDefaultAnalysisResultDirectory,
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
const {
  findVideoAnalysis,
  listSavedAnalysisResultsForVideos,
  deleteSavedAnalysisResult,
  startVideoAnalysis,
  cancelVideoAnalysis,
  getActiveAnalysisJob,
  getAnalysisModelDirectory,
  getAnalysisResultDirectory,
  getVideoAnalysisRuntimeConfig,
  saveVideoAnalysisRuntimeConfig,
  resetVideoAnalysisRuntimeConfig
} = require('./video-analysis')
const {
  getVlmModelOptions,
  getVlmServiceState,
  saveVlmServiceConfig,
  startVlmService,
  stopVlmService,
  downloadVlmModel,
  listLocalVlmModelFiles,
  selectLocalVlmModelFile,
  listHuggingFaceModelFiles,
  selectHuggingFaceModelFile
} = require('./vlm-service')
const { getVideoMetadata } = require('./video-metadata')

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

async function ensureDialogDefaultDirectory(candidatePath, fallbackDir) {
  const fallback = path.resolve(fallbackDir)
  const candidate = typeof candidatePath === 'string' && candidatePath.trim()
    ? path.resolve(candidatePath)
    : ''
  let defaultDir = fallback
  if (candidate) {
    try {
      const stat = await fsp.stat(candidate)
      defaultDir = stat.isDirectory() ? candidate : path.dirname(candidate)
    } catch {
      defaultDir = path.extname(candidate) ? path.dirname(candidate) : candidate
    }
  }
  await fsp.mkdir(defaultDir, { recursive: true })
  return defaultDir
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
      const thumbPath = await resolveThumbnail(videoPath)
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

    const results = {}
    const concurrency = 1
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
    return sanitizeSettingsForRenderer(loadSettings())
  })

  ipcMain.handle('get-app-version', async () => {
    return app.getVersion()
  })

  ipcMain.handle('save-settings', async (_event, settings) => {
    saveSettings(sanitizeSettingsForSave(settings))
    return { success: true }
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

  ipcMain.handle('video-analysis-get', async (_event, filePath) => {
    try {
      const resolvedPath = await assertAllowedVideoPath(filePath)
      return await findVideoAnalysis(resolvedPath)
    } catch (err) {
      return { available: false, reason: 'error', error: err.message }
    }
  })

  ipcMain.handle('video-analysis-list-saved', async (_event, videos = []) => {
    try {
      const requestedVideos = Array.isArray(videos) ? videos : []
      const allowedVideos = []
      for (const video of requestedVideos.slice(0, 2000)) {
        try {
          const resolvedPath = await assertAllowedVideoPath(video?.videoPath)
          allowedVideos.push({
            videoPath: resolvedPath,
            videoName: typeof video?.videoName === 'string' ? video.videoName : '',
            fileSizeBytes: Number(video?.fileSizeBytes) || 0
          })
        } catch {}
      }
      return await listSavedAnalysisResultsForVideos(allowedVideos)
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('video-analysis-delete-saved', async (_event, resultPath) => {
    try {
      return await deleteSavedAnalysisResult(resultPath)
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('video-analysis-start', async (event, filePath) => {
    try {
      const resolvedPath = await assertAllowedVideoPath(filePath)
      return await startVideoAnalysis(resolvedPath, event.sender)
    } catch (err) {
      return { accepted: false, reason: 'error', error: err.message }
    }
  })

  ipcMain.handle('video-analysis-cancel', async (_event, jobId) => {
    return cancelVideoAnalysis(jobId)
  })

  ipcMain.handle('video-analysis-job', async () => {
    return getActiveAnalysisJob()
  })

  ipcMain.handle('video-analysis-get-output-dir', async () => {
    return getAnalysisResultDirectory()
  })

  ipcMain.handle('video-analysis-select-output-dir', async () => {
    const win = getMainWindow()
    const currentDir = getAnalysisResultDirectory()
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      title: '选择分析结果保存目录',
      defaultPath: currentDir
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const selectedDir = path.resolve(result.filePaths[0])
    sessionAllowedAnalysisResultDirectories.add(pathKey(selectedDir))
    const settings = loadSettings()
    saveSettings({
      videoAnalysis: {
        ...(settings.videoAnalysis || {}),
        outputDir: selectedDir
      }
    })
    return selectedDir
  })

  ipcMain.handle('video-analysis-open-output-dir', async () => {
    const dir = getAnalysisResultDirectory() || getDefaultAnalysisResultDirectory()
    try {
      await fsp.mkdir(dir, { recursive: true })
      const error = await shell.openPath(dir)
      return { success: !error, error, dir }
    } catch (err) {
      return { success: false, error: err.message, dir }
    }
  })

  ipcMain.handle('video-analysis-get-model-dir', async () => {
    return getAnalysisModelDirectory()
  })

  ipcMain.handle('video-analysis-get-default-model-dir', async () => {
    return getDefaultAnalysisModelDirectory()
  })

  ipcMain.handle('video-analysis-select-model-dir', async () => {
    const win = getMainWindow()
    const currentDir = getAnalysisModelDirectory()
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      title: '选择视频理解模型存放目录',
      defaultPath: currentDir
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const selectedDir = path.resolve(result.filePaths[0])
    sessionAllowedAnalysisModelDirectories.add(pathKey(selectedDir))
    const settings = loadSettings()
    saveSettings({
      videoAnalysis: {
        ...(settings.videoAnalysis || {}),
        modelDir: selectedDir
      }
    })
    await saveVideoAnalysisRuntimeConfig({
      ...(await getVideoAnalysisRuntimeConfig()),
      modelStorageDir: selectedDir
    })
    return selectedDir
  })

  ipcMain.handle('video-analysis-open-model-dir', async () => {
    const dir = getAnalysisModelDirectory() || getDefaultAnalysisModelDirectory()
    try {
      await fsp.mkdir(dir, { recursive: true })
      const error = await shell.openPath(dir)
      return { success: !error, error, dir }
    } catch (err) {
      return { success: false, error: err.message, dir }
    }
  })

  ipcMain.handle('video-analysis-get-runtime-config', async () => {
    try {
      return { success: true, config: await getVideoAnalysisRuntimeConfig() }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('video-analysis-save-runtime-config', async (_event, config) => {
    try {
      return { success: true, config: await saveVideoAnalysisRuntimeConfig(config) }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('video-analysis-reset-runtime-config', async () => {
    try {
      const settings = loadSettings()
      saveSettings({
        videoAnalysis: {
          ...(settings.videoAnalysis || {}),
          modelDir: getDefaultAnalysisModelDirectory()
        }
      })
      return { success: true, config: await resetVideoAnalysisRuntimeConfig() }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('video-analysis-vlm-state', async () => {
    try {
      return { success: true, state: await getVlmServiceState() }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('video-analysis-vlm-model-options', async () => {
    try {
      return { success: true, options: getVlmModelOptions() }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('video-analysis-vlm-save-config', async (_event, patch) => {
    try {
      return await saveVlmServiceConfig(patch)
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('video-analysis-vlm-select-model-file', async () => {
    try {
      const config = await getVideoAnalysisRuntimeConfig()
      const win = getMainWindow()
      const defaultPath = await ensureDialogDefaultDirectory(
        config.vlmModelPath,
        path.join(config.modelStorageDir || getAnalysisModelDirectory(), 'vlm')
      )
      const result = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        title: '选择 VLM 模型文件',
        defaultPath,
        filters: [
          { name: '模型文件', extensions: ['gguf', 'bin', 'safetensors', 'onnx'] },
          { name: '所有文件', extensions: ['*'] }
        ]
      })
      if (result.canceled || result.filePaths.length === 0) return null
      const selectedPath = path.resolve(result.filePaths[0])
      return await saveVlmServiceConfig({ vlmModelPath: selectedPath })
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('video-analysis-vlm-select-server-executable', async () => {
    try {
      const config = await getVideoAnalysisRuntimeConfig()
      const win = getMainWindow()
      const defaultPath = await ensureDialogDefaultDirectory(
        config.vlmServerExecutable,
        config.modelStorageDir || getAnalysisModelDirectory()
      )
      const result = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        title: '选择 VLM 服务程序',
        defaultPath,
        filters: [
          { name: '可执行文件', extensions: ['exe', 'bat', 'cmd'] },
          { name: '所有文件', extensions: ['*'] }
        ]
      })
      if (result.canceled || result.filePaths.length === 0) return null
      const selectedPath = path.resolve(result.filePaths[0])
      return await saveVlmServiceConfig({ vlmServerExecutable: selectedPath })
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('video-analysis-vlm-hf-list-files', async (_event, patch) => {
    try {
      return await listHuggingFaceModelFiles(patch)
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('video-analysis-vlm-hf-select-file', async (_event, file) => {
    try {
      return await selectHuggingFaceModelFile(file)
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('video-analysis-vlm-local-list-files', async () => {
    try {
      return await listLocalVlmModelFiles()
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('video-analysis-vlm-local-select-file', async (_event, filePath) => {
    try {
      return await selectLocalVlmModelFile(filePath)
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('video-analysis-vlm-download', async (_event, selection) => {
    try {
      return await downloadVlmModel(selection)
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('video-analysis-vlm-start', async () => {
    try {
      return await startVlmService()
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('video-analysis-vlm-stop', async () => {
    try {
      return await stopVlmService()
    } catch (err) {
      return { success: false, error: err.message }
    }
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
