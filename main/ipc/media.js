const { ipcMain: appIpcMain } = require('../security/ipc')
const { pathToFileURL } = require('url')
const path = require('path')
const fsp = require('fs/promises')
const { IPC } = require('../ipc-channels')
const { IMAGE_EXTENSIONS } = require('../constants')
const { isPathInside } = require('../paths')
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
const { createMediaAccessPolicy, createMediaAccessPolicyAsync } = require('../security/media-access')
const { s, ipcScanSchema, metadataOptionsSchema } = require('../../packages/contracts')
const { mediaWorkService } = require('../application/media-work-service')
const { mediaScheduler } = require('../application/resource-scheduler')

function registerMediaIpc(ipcMain = appIpcMain) {
  ipcMain.handle(IPC.SCAN_DIRECTORY, async (_event, dirPath, force) => {
    try {
      return ipcScanSchema.parse(await scanWithCache(s.string(32768, 1).parse(dirPath), s.optional(s.boolean).parse(force), { initialLimit: 100 }))
    } catch (err) {
      return { error: err.message }
    }
  })

  ipcMain.handle(IPC.GENERATE_THUMBNAIL, async (event, videoPath, requestId) => {
    try {
      const target = s.string(32768, 1).parse(videoPath)
      const thumbPath = await mediaWorkService.run(event, requestId, signal => resolveThumbnail(target,
        { signal, senderId: event.sender?.id, priority: 'visible' }))
      return { success: true, thumbPath }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.GET_VIDEO_METADATA, async (event, videoPath, options = {}) => {
    try {
      const target = s.string(32768, 1).parse(videoPath), parsed = metadataOptionsSchema.parse(options)
      const access = { senderId: event.sender?.id }
      const media = await mediaWorkService.run(event, parsed.requestId, async signal => {
        const resolvedPath = await assertAllowedVideoPath(target, { ...access, signal })
        const publicPolicy = await createMediaAccessPolicyAsync({ audience: 'remote', signal })
        const scope = publicPolicy.canReadResolvedPath(resolvedPath, false) ? 'public' : 'desktop:' + event.sender.id
        return getVideoMetadata(resolvedPath, { force: parsed.force, signal, scope,
          validate: context => assertAllowedVideoPath(target, { ...access, ...context }),
          validateWorker: context => assertAllowedVideoPath(target,
            { ...(scope === 'public' ? { audience: 'remote' } : access), ...context }) })
      })
      return { success: true, media }
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
      (allowedDirs.some(dir => isPathInside(dir, resolvedPath)) &&
        createMediaAccessPolicy().canReadPath(resolvedPath))
    )

    if (!stats.isFile() || !canExpose || !IMAGE_EXTENSIONS.has(path.extname(resolvedPath).toLowerCase())) {
      throw new Error('缩略图路径无效')
    }

    return pathToFileURL(resolvedPath).href
  })

  ipcMain.handle(IPC.GENERATE_PREVIEW_FRAME, async (event, videoPath, seconds, requestId) => {
    try {
      const target = s.string(32768, 1).parse(videoPath), position = s.number(0).parse(seconds)
      const framePath = await mediaWorkService.run(event, requestId, signal => generatePreviewFrame(target, position,
        { signal, senderId: event.sender?.id }))
      return { success: true, framePath }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.CANCEL_MEDIA_WORK, (event, requestId) => mediaWorkService.cancel(event, requestId))

  ipcMain.handle(IPC.SET_MEDIA_PLAYBACK_ACTIVE, async (_event, active) => {
    setMediaPlaybackActive(active)
    return { success: true }
  })

  ipcMain.handle(IPC.CHECK_FFMPEG, async event => mediaWorkService.run(event, undefined, signal => mediaScheduler.enqueue({
    key: 'check-ffmpeg', type: 'tool', priority: 70, timeoutMs: 45000, signal }, async context => {
    const ffmpeg = await findFfmpeg({ signal: context.signal })
    if (!ffmpeg) return { available: false }

    try {
      const { stdout } = await execFileAsync(ffmpeg, ['-version'], { timeout: 5000, signal: context.signal })
      const versionLine = stdout.split(/\r?\n/).find(line => line.trim()) || 'unknown'
      return { available: true, path: ffmpeg, version: versionLine }
    } catch {
      return { available: false }
    }
  })))
}

module.exports = { registerMediaIpc }
