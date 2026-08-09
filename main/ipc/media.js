const { ipcMain } = require('electron')
const { pathToFileURL } = require('url')
const path = require('path')
const fsp = require('fs/promises')
const { IPC } = require('../ipc-channels')
const { IMAGE_EXTENSIONS } = require('../constants')
const { isPathInside, pathKey } = require('../paths')
const { getAllowedVideoDirectories } = require('../settings')
const { assertAllowedVideoPath, resolveExistingPath, scanWithCache } = require('../scanner')
const {
  execFileAsync,
  findFfmpeg,
  generatePreviewFrame,
  getPreviewFrameDir,
  getThumbnailDir,
  resolveThumbnail,
  setMediaPlaybackActive
} = require('../thumbnail')
const { getVideoMetadata } = require('../video-metadata')

const pendingThumbnailTasks = new Map()

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

function registerMediaIpc() {
  ipcMain.handle(IPC.SCAN_DIRECTORY, async (_event, dirPath, force) => {
    try {
      return await scanWithCache(dirPath, force)
    } catch (err) {
      return { error: err.message }
    }
  })

  ipcMain.handle(IPC.GENERATE_THUMBNAIL, async (_event, videoPath) => {
    try {
      const thumbPath = await queueThumbnailTask(videoPath)
      return { success: true, thumbPath }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.GET_VIDEO_METADATA, async (_event, videoPath, options = {}) => {
    try {
      const resolvedPath = await assertAllowedVideoPath(videoPath)
      return { success: true, media: await getVideoMetadata(resolvedPath, options) }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.GET_THUMBNAIL_URL, async (_event, filePath) => {
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

  ipcMain.handle(IPC.GENERATE_PREVIEW_FRAME, async (_event, videoPath, seconds) => {
    try {
      const framePath = await generatePreviewFrame(videoPath, seconds)
      return { success: true, framePath }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.SET_MEDIA_PLAYBACK_ACTIVE, async (_event, active) => {
    setMediaPlaybackActive(active)
    return { success: true }
  })

  ipcMain.handle(IPC.CHECK_FFMPEG, async () => {
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
}

module.exports = { registerMediaIpc }
