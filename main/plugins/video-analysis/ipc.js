const path = require('path')
const fsp = require('fs/promises')
const { dialog, shell } = require('electron')
const { core } = require('./core')
const { pathKey } = core('paths')
const {
  loadSettings,
  saveSettings
} = core('settings')
const { assertAllowedVideoPath } = core('scanner')
const { getMainWindow } = core('window')
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
} = require('./service')
const {
  sessionAllowedAnalysisResultDirectories,
  sessionAllowedAnalysisModelDirectories,
  getDefaultAnalysisModelDirectory,
  getDefaultAnalysisResultDirectory
} = require('./settings')
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

function registerVideoAnalysisIpc(ctx) {
  ctx.ipc.handle('video-analysis-get', async (_event, filePath) => {
    try {
      const resolvedPath = await assertAllowedVideoPath(filePath)
      return await findVideoAnalysis(resolvedPath)
    } catch (err) {
      return { available: false, reason: 'error', error: err.message }
    }
  })

  ctx.ipc.handle('video-analysis-list-saved', async (_event, videos = []) => {
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

  ctx.ipc.handle('video-analysis-delete-saved', async (_event, resultPath) => {
    try {
      return await deleteSavedAnalysisResult(resultPath)
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ctx.ipc.handle('video-analysis-start', async (event, filePath) => {
    try {
      const resolvedPath = await assertAllowedVideoPath(filePath)
      return await startVideoAnalysis(resolvedPath, event.sender)
    } catch (err) {
      return { accepted: false, reason: 'error', error: err.message }
    }
  })

  ctx.ipc.handle('video-analysis-cancel', async (_event, jobId) => {
    return cancelVideoAnalysis(jobId)
  })

  ctx.ipc.handle('video-analysis-job', async () => {
    return getActiveAnalysisJob()
  })

  ctx.ipc.handle('video-analysis-get-output-dir', async () => {
    return getAnalysisResultDirectory()
  })

  ctx.ipc.handle('video-analysis-select-output-dir', async () => {
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

  ctx.ipc.handle('video-analysis-open-output-dir', async () => {
    const dir = getAnalysisResultDirectory() || getDefaultAnalysisResultDirectory()
    try {
      await fsp.mkdir(dir, { recursive: true })
      const error = await shell.openPath(dir)
      return { success: !error, error, dir }
    } catch (err) {
      return { success: false, error: err.message, dir }
    }
  })

  ctx.ipc.handle('video-analysis-get-model-dir', async () => {
    return getAnalysisModelDirectory()
  })

  ctx.ipc.handle('video-analysis-get-default-model-dir', async () => {
    return getDefaultAnalysisModelDirectory()
  })

  ctx.ipc.handle('video-analysis-select-model-dir', async () => {
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

  ctx.ipc.handle('video-analysis-open-model-dir', async () => {
    const dir = getAnalysisModelDirectory() || getDefaultAnalysisModelDirectory()
    try {
      await fsp.mkdir(dir, { recursive: true })
      const error = await shell.openPath(dir)
      return { success: !error, error, dir }
    } catch (err) {
      return { success: false, error: err.message, dir }
    }
  })

  ctx.ipc.handle('video-analysis-get-runtime-config', async () => {
    try {
      return { success: true, config: await getVideoAnalysisRuntimeConfig() }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ctx.ipc.handle('video-analysis-save-runtime-config', async (_event, config) => {
    try {
      return { success: true, config: await saveVideoAnalysisRuntimeConfig(config) }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ctx.ipc.handle('video-analysis-reset-runtime-config', async () => {
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

  ctx.ipc.handle('video-analysis-vlm-state', async () => {
    try {
      return { success: true, state: await getVlmServiceState() }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ctx.ipc.handle('video-analysis-vlm-model-options', async () => {
    try {
      return { success: true, options: getVlmModelOptions() }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ctx.ipc.handle('video-analysis-vlm-save-config', async (_event, patch) => {
    try {
      return await saveVlmServiceConfig(patch)
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ctx.ipc.handle('video-analysis-vlm-select-model-file', async () => {
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

  ctx.ipc.handle('video-analysis-vlm-select-server-executable', async () => {
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

  ctx.ipc.handle('video-analysis-vlm-hf-list-files', async (_event, patch) => {
    try {
      return await listHuggingFaceModelFiles(patch)
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ctx.ipc.handle('video-analysis-vlm-hf-select-file', async (_event, file) => {
    try {
      return await selectHuggingFaceModelFile(file)
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ctx.ipc.handle('video-analysis-vlm-local-list-files', async () => {
    try {
      return await listLocalVlmModelFiles()
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ctx.ipc.handle('video-analysis-vlm-local-select-file', async (_event, filePath) => {
    try {
      return await selectLocalVlmModelFile(filePath)
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ctx.ipc.handle('video-analysis-vlm-download', async (_event, selection) => {
    try {
      return await downloadVlmModel(selection)
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ctx.ipc.handle('video-analysis-vlm-start', async () => {
    try {
      return await startVlmService()
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ctx.ipc.handle('video-analysis-vlm-stop', async () => {
    try {
      return await stopVlmService()
    } catch (err) {
      return { success: false, error: err.message }
    }
  })
}

module.exports = {
  registerVideoAnalysisIpc
}
