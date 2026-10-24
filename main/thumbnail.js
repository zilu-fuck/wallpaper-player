const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')
const crypto = require('crypto')
const { app } = require('electron')
const { execFileAsync } = require('./exec')
const { getUserDataDir } = require('./user-data')
const { getResourcePath, isPathInside } = require('./paths')
const { getAllowedVideoDirectories } = require('./settings')
const { assertAllowedVideoPath, readWallpaperMetadata } = require('./scanner')
const { createMediaAccessPolicy, createMediaAccessPolicyAsync } = require('./security/media-access')
const { setDesktopPlaybackActive } = require('./media-pressure')
const { mediaScheduler, taskError } = require('./application/resource-scheduler')

let ffmpegPath = null
let ffmpegSearchPromise = null
let ffmpegSearchCompleted = false
const THUMBNAIL_SCALE = '256:-1'
const PREVIEW_FRAME_SCALE = '200:-1'
const THUMBNAIL_QUALITY = '5'
const PREVIEW_FRAME_CACHE_LIMIT = 240
const PREVIEW_FRAME_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const PREVIEW_FRAME_CLEANUP_INTERVAL_MS = 5 * 60 * 1000
let lastPreviewFrameCleanupAt = 0
function enqueueThumbnailJob(task, options = {}) {
  return mediaScheduler.enqueue({ key: options.key, type: 'image', groupLimit: 1,
    priority: options.priority === 'preview' ? 80 : options.priority === 'visible' ? 40 : 0,
    background: options.priority !== 'preview' && options.priority !== 'visible',
    timeoutMs: options.timeoutMs || 45000, signal: options.signal }, task).catch(() => null)
}

function setMediaPlaybackActive(active) {
  setDesktopPlaybackActive(active)
}

function getThumbnailDir() {
  const dir = path.join(getUserDataDir(), 'thumbnails')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function getPreviewFrameDir() {
  const dir = path.join(getThumbnailDir(), 'preview-frames')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

async function cleanupPreviewFrameCache(force = false) {
  const now = Date.now()
  if (!force && now - lastPreviewFrameCleanupAt < PREVIEW_FRAME_CLEANUP_INTERVAL_MS) return
  lastPreviewFrameCleanupAt = now

  try {
    const dir = getPreviewFrameDir()
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    const files = []

    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.jpg') continue
      const filePath = path.join(dir, entry.name)
      try {
        const stats = await fsp.stat(filePath)
        files.push({ filePath, mtimeMs: stats.mtimeMs })
      } catch {}
    }

    files.sort((a, b) => b.mtimeMs - a.mtimeMs)
    const expiredBefore = now - PREVIEW_FRAME_MAX_AGE_MS
    const removals = files
      .filter((file, index) => index >= PREVIEW_FRAME_CACHE_LIMIT || file.mtimeMs < expiredBefore)
      .map(file => fsp.unlink(file.filePath).catch(() => {}))

    await Promise.all(removals)
  } catch {}
}

async function findFfmpeg(options = {}) {
  if (options.signal?.aborted) throw options.signal.reason || taskError('task_cancelled', '媒体任务已取消', 499)
  if (process.env.WALLPAPER_PLAYER_FFMPEG_PATH) return process.env.WALLPAPER_PLAYER_FFMPEG_PATH
  if (ffmpegPath) return ffmpegPath
  if (ffmpegSearchCompleted) return null
  if (!options.signal && ffmpegSearchPromise) return ffmpegSearchPromise
  const search = async () => {
    const candidates = [getResourcePath('vendor', 'ffmpeg', 'bin', 'ffmpeg.exe'),
      getResourcePath('vendor', 'ffmpeg', 'ffmpeg.exe'), 'ffmpeg', 'ffmpeg.exe',
      app?.getAppPath ? path.join(app.getAppPath(), 'ffmpeg.exe') : '',
      app?.getAppPath ? path.join(app.getAppPath(), 'ffmpeg') : '',
      'C:\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe']
    for (const candidate of candidates.filter(Boolean)) {
      if (options.signal?.aborted) throw options.signal.reason
      try {
        await execFileAsync(candidate, ['-version'], { timeout: 5000, signal: options.signal })
        ffmpegPath = candidate; return candidate
      } catch (error) { if (options.signal?.aborted) throw options.signal.reason || error }
    }
    ffmpegSearchCompleted = true
    return null
  }
  if (options.signal) return search()
  ffmpegSearchPromise = search()
  try { return await ffmpegSearchPromise } finally { ffmpegSearchPromise = null }
}

async function createImage(videoPath, outputPath, seconds, scale, access, priority, signature) {
  const publicPolicy = await createMediaAccessPolicyAsync({ audience: 'remote', signal: access.signal })
  const publicSource = publicPolicy.canReadResolvedPath(videoPath, false)
  const scope = publicSource ? 'public' : 'desktop:' + (access.senderId ?? 'default')
  const result = await enqueueThumbnailJob(async context => {
    const workerAccess = { ...(publicSource ? { audience: 'remote' } : access), ...context }
    context.throwIfAborted()
    await assertAllowedVideoPath(videoPath, workerAccess)
    if (fs.existsSync(outputPath)) return outputPath
    const ffmpeg = await findFfmpeg({ signal: context.signal })
    if (!ffmpeg) return null
    const temporary = outputPath + '.' + crypto.randomUUID() + '.tmp.jpg'
    const execute = async offset => {
      await assertAllowedVideoPath(videoPath, workerAccess)
      context.throwIfAborted()
      return execFileAsync(ffmpeg, [
      ...(offset === null ? [] : ['-ss', String(offset)]), '-threads', '1', '-i', videoPath, '-threads', '1',
      '-vframes', '1', '-vf', 'scale=' + scale, '-q:v', THUMBNAIL_QUALITY, '-y', temporary
      ], { timeout: Math.max(1, Math.min(30000, context.deadlineAt - Date.now())), signal: context.signal, maxBuffer: 1024 * 1024 })
    }
    try {
      try { await execute(seconds) } catch (error) {
        context.throwIfAborted()
        if (priority === 'preview') throw error
        await execute(null)
      }
      context.throwIfAborted()
      await assertAllowedVideoPath(videoPath, workerAccess)
      const current = await fsp.stat(videoPath)
      if (current.size !== signature.size || Math.round(current.mtimeMs) !== signature.mtimeMs) throw new Error('媒体文件已改变')
      context.throwIfAborted()
      await fsp.rename(temporary, outputPath)
      if (priority === 'preview') cleanupPreviewFrameCache().catch(() => {})
      return outputPath
    } finally { await fsp.unlink(temporary).catch(() => {}) }
  }, { key: 'image:' + outputPath + ':' + scope, priority, signal: access.signal })
  if (result) await assertAllowedVideoPath(videoPath, access)
  return result
}

async function generateThumbnail(videoPath, access = {}) {
  videoPath = await assertAllowedVideoPath(videoPath, access)
  const thumbName = Buffer.from(videoPath).toString('base64url') + '.jpg'
  const thumbPath = path.join(getThumbnailDir(), thumbName)
  if (fs.existsSync(thumbPath)) return thumbPath
  const stats = await fsp.stat(videoPath)
  return createImage(videoPath, thumbPath, 1, THUMBNAIL_SCALE, access, access.priority || 'thumbnail',
    { size: stats.size, mtimeMs: Math.round(stats.mtimeMs) })
}

async function generatePreviewFrame(videoPath, seconds, access = {}) {
  const resolvedPath = await assertAllowedVideoPath(videoPath, access)
  const time = Math.max(0, Math.round(Number(seconds) || 0)), stats = await fsp.stat(resolvedPath)
  const signature = Math.round(stats.mtimeMs) + '-' + stats.size
  const cacheKey = crypto.createHash('sha256').update(resolvedPath + '|' + signature + '|' + time).digest('hex')
  const framePath = path.join(getPreviewFrameDir(), cacheKey + '.jpg')
  if (fs.existsSync(framePath)) { await assertAllowedVideoPath(resolvedPath, access); return framePath }
  return createImage(resolvedPath, framePath, time, PREVIEW_FRAME_SCALE, access, 'preview',
    { size: stats.size, mtimeMs: Math.round(stats.mtimeMs) })
}

async function getExistingPreviewPath(videoPath, access = {}) {
  let dirPath = path.dirname(videoPath)
  const allowedDirs = getAllowedVideoDirectories()

  while (allowedDirs.some(dir => isPathInside(dir, dirPath))) {
    const metadata = await readWallpaperMetadata(dirPath)
    if (metadata?.previewPath && createMediaAccessPolicy(access).canReadPath(metadata.previewPath)) {
      return metadata.previewPath
    }

    const parentPath = path.dirname(dirPath)
    if (parentPath === dirPath) break
    dirPath = parentPath
  }

  return null
}

async function resolveThumbnail(videoPath, access = {}) {
  const resolvedPath = await assertAllowedVideoPath(videoPath, access)
  const result = await getExistingPreviewPath(resolvedPath, access) || await generateThumbnail(resolvedPath, access)
  if (result) await assertAllowedVideoPath(resolvedPath, access)
  return result
}

module.exports = {
  execFileAsync,
  findFfmpeg,
  getThumbnailDir,
  getPreviewFrameDir,
  enqueueThumbnailJob,
  generateThumbnail,
  generatePreviewFrame,
  setMediaPlaybackActive,
  getExistingPreviewPath,
  resolveThumbnail
}
