const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')
const crypto = require('crypto')
const { execFile } = require('child_process')
const { app } = require('electron')
const { getResourcePath, isPathInside } = require('./paths')
const { getAllowedVideoDirectories } = require('./settings')
const { assertAllowedVideoPath, readWallpaperMetadata } = require('./scanner')

let ffmpegPath = null
let ffmpegSearchPromise = null
let ffmpegSearchCompleted = false
const fallbackUserDataDir = path.join(process.cwd(), '.tmp-wallpaper-player')
const THUMBNAIL_FFMPEG_CONCURRENCY = 1
const THUMBNAIL_SCALE = '320:-1'
const PREVIEW_FRAME_SCALE = '240:-1'
const THUMBNAIL_QUALITY = '5'
const PREVIEW_FRAME_CACHE_LIMIT = 500
const PREVIEW_FRAME_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const PREVIEW_FRAME_CLEANUP_INTERVAL_MS = 5 * 60 * 1000
const thumbnailJobQueue = []
let activeThumbnailJobs = 0
let lastPreviewFrameCleanupAt = 0

function drainThumbnailJobs() {
  while (activeThumbnailJobs < THUMBNAIL_FFMPEG_CONCURRENCY && thumbnailJobQueue.length > 0) {
    const { task, resolve } = thumbnailJobQueue.shift()
    activeThumbnailJobs += 1
    Promise.resolve()
      .then(task)
      .then(resolve, () => resolve(null))
      .finally(() => {
        activeThumbnailJobs -= 1
        drainThumbnailJobs()
      })
  }
}

function enqueueThumbnailJob(task) {
  return new Promise((resolve) => {
    thumbnailJobQueue.push({ task, resolve })
    drainThumbnailJobs()
  })
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (err, stdout, stderr) => {
      if (err) {
        reject(err)
      } else {
        resolve({ stdout, stderr })
      }
    })
  })
}

function getThumbnailDir() {
  const baseDir = app?.getPath
    ? app.getPath('userData')
    : fallbackUserDataDir
  const dir = path.join(baseDir, 'thumbnails')
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

async function findFfmpeg() {
  if (ffmpegPath) return ffmpegPath
  if (ffmpegSearchCompleted) return null
  if (ffmpegSearchPromise) return ffmpegSearchPromise

  ffmpegSearchPromise = (async () => {
    const candidates = [
      getResourcePath('vendor', 'ffmpeg', 'bin', 'ffmpeg.exe'),
      getResourcePath('vendor', 'ffmpeg', 'ffmpeg.exe'),
      'ffmpeg',
      'ffmpeg.exe',
      app?.getAppPath ? path.join(app.getAppPath(), 'ffmpeg.exe') : '',
      app?.getAppPath ? path.join(app.getAppPath(), 'ffmpeg') : '',
      'C:\\ffmpeg\\bin\\ffmpeg.exe',
      'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe'
    ]

    for (const candidate of candidates) {
      try {
        await execFileAsync(candidate, ['-version'], { timeout: 5000 })
        ffmpegPath = candidate
        return candidate
      } catch {
        continue
      }
    }

    return null
  })()

  try {
    return await ffmpegSearchPromise
  } finally {
    ffmpegSearchCompleted = true
    ffmpegSearchPromise = null
  }
}

async function generateThumbnail(videoPath) {
  const thumbDir = getThumbnailDir()
  const thumbName = Buffer.from(videoPath).toString('base64url') + '.jpg'
  const thumbPath = path.join(thumbDir, thumbName)

  if (fs.existsSync(thumbPath)) {
    return thumbPath
  }

  const ffmpeg = await findFfmpeg()
  if (!ffmpeg) {
    return null
  }

  return enqueueThumbnailJob(() => new Promise((resolve) => {
    if (fs.existsSync(thumbPath)) {
      resolve(thumbPath)
      return
    }

    // 取视频第 1 秒的帧作为缩略图（跳过可能的黑色片头）
    execFile(ffmpeg, [
      '-ss', '00:00:01',
      '-i', videoPath,
      '-threads', '1',
      '-vframes', '1',
      '-vf', `scale=${THUMBNAIL_SCALE}`,
      '-q:v', THUMBNAIL_QUALITY,
      '-y',
      thumbPath
    ], { timeout: 30000 }, (err) => {
      if (err) {
        // 如果 -ss 1 秒失败，尝试第 0 秒
        execFile(ffmpeg, [
          '-i', videoPath,
          '-threads', '1',
          '-vframes', '1',
          '-vf', `scale=${THUMBNAIL_SCALE}`,
          '-q:v', THUMBNAIL_QUALITY,
          '-y',
          thumbPath
        ], { timeout: 30000 }, (err2) => {
          resolve(err2 ? null : thumbPath)
        })
      } else {
        resolve(thumbPath)
      }
    })
  }))
}

async function generatePreviewFrame(videoPath, seconds) {
  const resolvedPath = await assertAllowedVideoPath(videoPath)
  const time = Math.max(0, Math.round(Number(seconds) || 0))
  const stats = await fsp.stat(resolvedPath)
  const previewDir = getPreviewFrameDir()
  const signature = `${Math.round(stats.mtimeMs)}-${stats.size}`
  const cacheKey = crypto.createHash('sha256').update(`${resolvedPath}|${signature}|${time}`).digest('hex')
  const framePath = path.join(previewDir, `${cacheKey}.jpg`)

  if (fs.existsSync(framePath)) {
    return framePath
  }

  const ffmpeg = await findFfmpeg()
  if (!ffmpeg) {
    return null
  }

  return enqueueThumbnailJob(() => new Promise((resolve) => {
    if (fs.existsSync(framePath)) {
      resolve(framePath)
      return
    }

    execFile(ffmpeg, [
      '-ss', String(time),
      '-i', resolvedPath,
      '-threads', '1',
      '-vframes', '1',
      '-vf', `scale=${PREVIEW_FRAME_SCALE}`,
      '-q:v', THUMBNAIL_QUALITY,
      '-y',
      framePath
    ], { timeout: 30000 }, (err) => {
      if (err) {
        fsp.unlink(framePath).catch(() => {})
      } else {
        cleanupPreviewFrameCache().catch(() => {})
      }
      resolve(err ? null : framePath)
    })
  }))
}

async function getExistingPreviewPath(videoPath) {
  let dirPath = path.dirname(videoPath)
  const allowedDirs = getAllowedVideoDirectories()

  while (allowedDirs.some(dir => isPathInside(dir, dirPath))) {
    const metadata = await readWallpaperMetadata(dirPath)
    if (metadata?.previewPath) return metadata.previewPath

    const parentPath = path.dirname(dirPath)
    if (parentPath === dirPath) break
    dirPath = parentPath
  }

  return null
}

async function resolveThumbnail(videoPath) {
  const resolvedPath = await assertAllowedVideoPath(videoPath)
  return await getExistingPreviewPath(resolvedPath) || await generateThumbnail(resolvedPath)
}

module.exports = {
  execFileAsync,
  findFfmpeg,
  getThumbnailDir,
  getPreviewFrameDir,
  generateThumbnail,
  generatePreviewFrame,
  getExistingPreviewPath,
  resolveThumbnail
}
