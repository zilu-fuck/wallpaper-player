const crypto = require('crypto')
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const { execFile } = require('child_process')
const { app } = require('electron')
const { getResourcePath } = require('./paths')

const fallbackUserDataDir = path.join(process.cwd(), '.tmp-wallpaper-player')
const CACHE_VERSION = 1
const PROBE_TIMEOUT_MS = 12000
const probePromises = new Map()
const warmPendingKeys = new Set()
let warmPromise = null
let warmPaused = false

let metadataCache = null

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function setVideoMetadataWarmPaused(paused) {
  warmPaused = Boolean(paused)
}

function getUserDataDir() {
  return app?.getPath ? app.getPath('userData') : fallbackUserDataDir
}

function getMetadataCachePath() {
  return path.join(getUserDataDir(), 'video-metadata-cache.json')
}

function getCacheKey(filePath) {
  return crypto.createHash('sha256').update(path.resolve(filePath)).digest('hex')
}

async function getFileSignature(filePath) {
  const stats = await fsp.stat(filePath)
  return {
    size: stats.size,
    mtimeMs: Math.round(stats.mtimeMs)
  }
}

function normalizeNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function parseFps(value) {
  if (typeof value !== 'string') return 0
  const [left, right] = value.split('/').map(Number)
  if (Number.isFinite(left) && Number.isFinite(right) && right > 0) return left / right
  return normalizeNumber(value)
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (err, stdout, stderr) => {
      if (err) reject(err)
      else resolve({ stdout, stderr })
    })
  })
}

function sanitizeStream(stream) {
  return {
    codecType: typeof stream?.codec_type === 'string' ? stream.codec_type : '',
    codecName: typeof stream?.codec_name === 'string' ? stream.codec_name : '',
    width: normalizeNumber(stream?.width),
    height: normalizeNumber(stream?.height),
    fps: parseFps(stream?.avg_frame_rate || stream?.r_frame_rate),
    bitRate: normalizeNumber(stream?.bit_rate)
  }
}

function sanitizeMetadata(value) {
  const metadata = value && typeof value === 'object' ? value : {}
  const videoStream = sanitizeStream(metadata.videoStream)
  const audioStream = sanitizeStream(metadata.audioStream)
  return {
    available: Boolean(metadata.available),
    durationSeconds: Math.max(0, normalizeNumber(metadata.durationSeconds)),
    width: Math.max(0, normalizeNumber(metadata.width || videoStream.width)),
    height: Math.max(0, normalizeNumber(metadata.height || videoStream.height)),
    fps: Math.max(0, normalizeNumber(metadata.fps || videoStream.fps)),
    videoCodec: typeof metadata.videoCodec === 'string' ? metadata.videoCodec : videoStream.codecName,
    audioCodec: typeof metadata.audioCodec === 'string' ? metadata.audioCodec : audioStream.codecName,
    bitRate: Math.max(0, normalizeNumber(metadata.bitRate)),
    container: typeof metadata.container === 'string' ? metadata.container : '',
    probedAt: normalizeNumber(metadata.probedAt, Date.now())
  }
}

function emptyCache() {
  return {
    version: CACHE_VERSION,
    entries: {}
  }
}

function loadMetadataCache() {
  if (metadataCache) return metadataCache

  try {
    const raw = fs.readFileSync(getMetadataCachePath(), 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed?.version !== CACHE_VERSION || !parsed.entries || typeof parsed.entries !== 'object') {
      metadataCache = emptyCache()
    } else {
      metadataCache = {
        version: CACHE_VERSION,
        entries: parsed.entries
      }
    }
  } catch {
    metadataCache = emptyCache()
  }

  return metadataCache
}

async function saveMetadataCache() {
  const cache = loadMetadataCache()
  const cachePath = getMetadataCachePath()
  await fsp.mkdir(path.dirname(cachePath), { recursive: true })
  await fsp.writeFile(cachePath, JSON.stringify(cache, null, 2), 'utf-8')
}

function getCachedVideoMetadata(filePath, signature = null) {
  const cache = loadMetadataCache()
  const entry = cache.entries[getCacheKey(filePath)]
  if (!entry?.metadata) return null

  if (signature) {
    if (entry.size !== signature.size || entry.mtimeMs !== signature.mtimeMs) return null
  }

  return sanitizeMetadata(entry.metadata)
}

async function findFfprobe() {
  if (process.env.WALLPAPER_PLAYER_FFPROBE_PATH) return process.env.WALLPAPER_PLAYER_FFPROBE_PATH
  const candidates = [
    getResourcePath('vendor', 'ffmpeg', 'bin', 'ffprobe.exe'),
    getResourcePath('vendor', 'ffmpeg', 'ffprobe.exe'),
    'ffprobe',
    'ffprobe.exe',
    app?.getAppPath ? path.join(app.getAppPath(), 'ffprobe.exe') : '',
    'C:\\ffmpeg\\bin\\ffprobe.exe',
    'C:\\Program Files\\ffmpeg\\bin\\ffprobe.exe'
  ]

  for (const candidate of candidates.filter(Boolean)) {
    try {
      await execFileAsync(candidate, ['-version'], { timeout: 5000 })
      return candidate
    } catch {}
  }
  return null
}

async function probeVideoMetadata(filePath) {
  const ffprobe = await findFfprobe()
  if (!ffprobe) return { available: false, error: 'ffprobe_not_found', probedAt: Date.now() }

  const { stdout } = await execFileAsync(ffprobe, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath
  ], {
    timeout: PROBE_TIMEOUT_MS,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024
  })

  const payload = JSON.parse(stdout)
  const streams = Array.isArray(payload.streams) ? payload.streams : []
  const videoStream = streams.find(stream => stream?.codec_type === 'video')
  const audioStream = streams.find(stream => stream?.codec_type === 'audio')
  const safeVideoStream = sanitizeStream(videoStream)
  const safeAudioStream = sanitizeStream(audioStream)
  const format = payload.format && typeof payload.format === 'object' ? payload.format : {}

  return sanitizeMetadata({
    available: Boolean(videoStream),
    durationSeconds: normalizeNumber(format.duration || videoStream?.duration),
    width: safeVideoStream.width,
    height: safeVideoStream.height,
    fps: safeVideoStream.fps,
    videoCodec: safeVideoStream.codecName,
    audioCodec: safeAudioStream.codecName,
    bitRate: normalizeNumber(format.bit_rate),
    container: typeof format.format_name === 'string' ? format.format_name : '',
    probedAt: Date.now()
  })
}

async function getVideoMetadata(filePath, options = {}) {
  const resolvedPath = path.resolve(filePath)
  const signature = await getFileSignature(resolvedPath)
  if (!options.force) {
    const cached = getCachedVideoMetadata(resolvedPath, signature)
    if (cached) return cached
  }

  const key = getCacheKey(resolvedPath)
  if (probePromises.has(key)) return probePromises.get(key)

  const promise = (async () => {
    let metadata
    try {
      metadata = await probeVideoMetadata(resolvedPath)
    } catch (error) {
      metadata = {
        available: false,
        error: error?.message || 'metadata_probe_failed',
        probedAt: Date.now()
      }
    }

    const cache = loadMetadataCache()
    cache.entries[key] = {
      path: resolvedPath,
      size: signature.size,
      mtimeMs: signature.mtimeMs,
      metadata: sanitizeMetadata(metadata)
    }
    await saveMetadataCache()
    return cache.entries[key].metadata
  })()

  probePromises.set(key, promise)
  try {
    return await promise
  } finally {
    probePromises.delete(key)
  }
}

async function getCachedVideoMetadataForPath(filePath) {
  try {
    return getCachedVideoMetadata(path.resolve(filePath), await getFileSignature(filePath))
  } catch {
    return null
  }
}

async function warmVideoMetadataCache(videoPaths, options = {}) {
  const limit = Number(options.limit)
  const rawPaths = Array.isArray(videoPaths)
    ? [...new Set(videoPaths.filter(item => typeof item === 'string' && item.trim()).map(item => path.resolve(item)))]
    : []
  const paths = Number.isInteger(limit) && limit > 0 ? rawPaths.slice(0, limit) : rawPaths
  if (!paths.length) return

  const concurrency = Math.max(1, Math.min(2, Number(options.concurrency) || 1))
  let index = 0

  async function worker() {
    while (index < paths.length) {
      while (warmPaused) {
        await delay(500)
      }
      const current = paths[index++]
      const key = getCacheKey(current)
      if (warmPendingKeys.has(key)) continue
      warmPendingKeys.add(key)
      try {
        const signature = await getFileSignature(current)
        if (getCachedVideoMetadata(current, signature)) continue
        await getVideoMetadata(current)
      } catch {}
      finally {
        warmPendingKeys.delete(key)
      }
    }
  }

  warmPromise = Promise.all(Array.from({ length: concurrency }, () => worker()))
    .catch(() => {})
    .finally(() => {
      warmPromise = null
    })

  return warmPromise
}

module.exports = {
  getMetadataCachePath,
  loadMetadataCache,
  getCachedVideoMetadata,
  getCachedVideoMetadataForPath,
  getVideoMetadata,
  warmVideoMetadataCache,
  probeVideoMetadata,
  findFfprobe,
  setVideoMetadataWarmPaused
}
