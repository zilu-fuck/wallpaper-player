const crypto = require('crypto')
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const { app } = require('electron')
const { execFileAsync } = require('./exec')
const { getUserDataDir } = require('./user-data')
const { getResourcePath, normalizedPathKey, pathKey, resolvePathForAccessAsync, resolvePathsForAccess } = require('./paths')
const { mediaScheduler, taskError } = require('./application/resource-scheduler')
const { createMediaAccessPolicyAsync } = require('./security/media-access')

const CACHE_VERSION = 1
const PROBE_TIMEOUT_MS = 12000
const warmQueue = new Map()
const WARM_QUEUE_LIMIT = 512
let cacheWriteQueue = Promise.resolve()
let closing = false
const warmPendingKeys = new Set()
let warmPromise = null
let warmController = null
const warmPreparationQueue = new Map(), warmPreparingKeys = new Set()
let warmPreparationPromise = null

let metadataCache = null

function setVideoMetadataWarmPaused(paused) { mediaScheduler.setBackgroundPaused('metadata', Boolean(paused)) }

function getMetadataCachePath() {
  return path.join(getUserDataDir(), 'video-metadata-cache.json')
}

// 缓存键按 realpath 归一化：扫描器返回的 fullPath 是 realpath 后的，
// 而探测入口可能收到用户字面量路径，subst 映射盘/junction/大小写差异下
// 两者不一致会导致缓存永远未命中。归一化后统一。
function getCacheKey(filePath, canonicalPathKey) {
  return crypto.createHash('sha256').update(canonicalPathKey || normalizedPathKey(filePath)).digest('hex')
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

function saveMetadataEntry(key, entry, context, validate) {
  const operation = cacheWriteQueue.catch(() => {}).then(async () => {
    context.throwIfAborted()
    await validate?.()
    const candidate = { ...loadMetadataCache(), entries: { ...loadMetadataCache().entries, [key]: entry } }
    const cachePath = getMetadataCachePath(), temporary = cachePath + '.' + crypto.randomUUID() + '.tmp'
    await fsp.mkdir(path.dirname(cachePath), { recursive: true })
    try {
      await fsp.writeFile(temporary, JSON.stringify(candidate), 'utf8')
      context.throwIfAborted()
      await validate?.()
      await fsp.rename(temporary, cachePath)
      metadataCache = candidate
    } finally { await fsp.unlink(temporary).catch(() => {}) }
  })
  cacheWriteQueue = operation
  return operation
}

function getCachedVideoMetadata(filePath, signature = null, canonicalPathKey) {
  const cache = loadMetadataCache()
  const entry = cache.entries[getCacheKey(filePath, canonicalPathKey)]
  if (!entry?.metadata) return null

  if (signature) {
    if (entry.size !== signature.size || entry.mtimeMs !== signature.mtimeMs) return null
  }

  return sanitizeMetadata(entry.metadata)
}

async function findFfprobe(options = {}) {
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
    if (options.signal?.aborted) throw options.signal.reason
    try {
      await execFileAsync(candidate, ['-version'], { timeout: 5000, signal: options.signal })
      return candidate
    } catch (error) { if (options.signal?.aborted) throw options.signal.reason || error }
  }
  return null
}

async function probeVideoMetadataRaw(filePath, options) {
  const ffprobe = await findFfprobe(options)
  if (!ffprobe) return { available: false, error: 'ffprobe_not_found', probedAt: Date.now() }
  await options.validate?.()
  options.throwIfAborted?.()

  const { stdout } = await execFileAsync(ffprobe, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath
  ], {
    timeout: Math.max(1, Math.min(PROBE_TIMEOUT_MS, options.deadlineAt - Date.now())),
    signal: options.signal,
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
  if (closing) throw taskError('task_stopping', '元数据服务正在关闭')
  const validateConsumer = async () => {
    if (options.signal?.aborted) throw options.signal.reason
    await options.validate?.({ signal: options.signal })
    if (options.signal?.aborted) throw options.signal.reason
  }
  const resolvedPath = path.resolve(filePath), signature = await getFileSignature(resolvedPath)
  const canonicalPathKey = pathKey(await resolvePathForAccessAsync(resolvedPath))
  if (options.signal?.aborted) throw options.signal.reason
  if (!options.force) {
    const cached = getCachedVideoMetadata(resolvedPath, signature, canonicalPathKey)
    if (cached && (cached.available || Date.now() - cached.probedAt < 30000)) { await validateConsumer(); return cached }
  }
  const key = getCacheKey(resolvedPath, canonicalPathKey)
  const result = await mediaScheduler.enqueue({ key: 'metadata:' + key + ':' + signature.size + ':' + signature.mtimeMs + ':' + (options.scope || 'public'),
    type: 'metadata', priority: options.background ? 0 : 60, background: Boolean(options.background),
    timeoutMs: 45000, signal: options.signal }, async context => {
    const validateWork = options.validateWorker || options.validate
    const validate = validateWork ? () => validateWork(context) : undefined
    context.throwIfAborted(); await validate?.()
    let metadata
    try { metadata = await probeVideoMetadataRaw(resolvedPath, { ...context, validate }) } catch (error) {
      context.throwIfAborted()
      metadata = { available: false, probedAt: Date.now() }
    }
    context.throwIfAborted(); await validate?.()
    const current = await getFileSignature(resolvedPath)
    if (current.size !== signature.size || current.mtimeMs !== signature.mtimeMs) throw new Error('媒体文件已改变')
    const safe = sanitizeMetadata(metadata)
    if (safe.available) await saveMetadataEntry(key, { path: resolvedPath, ...signature, metadata: safe }, context, validate)
    return safe
  })
  await validateConsumer()
  return result
}

function probeVideoMetadata(filePath, options = {}) { return getVideoMetadata(filePath, { ...options, force: true }) }

async function getCachedVideoMetadataForPath(filePath) {
  try {
    const resolved = await resolvePathForAccessAsync(filePath)
    return getCachedVideoMetadata(resolved, await getFileSignature(resolved), pathKey(resolved))
  } catch {
    return null
  }
}

function warmVideoMetadataCache(videoPaths, options = {}) {
  if (closing) return Promise.resolve()
  const limit = Math.min(WARM_QUEUE_LIMIT, Math.max(1, Number(options.limit) || WARM_QUEUE_LIMIT))
  const files = (Array.isArray(videoPaths) ? videoPaths : []).slice(0, limit).filter(file => typeof file === 'string' && file.trim())
  for (const file of files) {
    const resolved = path.resolve(file), key = pathKey(resolved)
    if (warmPreparationQueue.has(key) || warmPreparingKeys.has(key)) continue
    if (warmPreparationQueue.size + warmPreparingKeys.size + warmQueue.size + warmPendingKeys.size >= WARM_QUEUE_LIMIT) break
    warmPreparationQueue.set(key, resolved)
  }
  const preparing = warmPreparationPromise || (warmPreparationQueue.size ? startMetadataWarmPreparation(options) : Promise.resolve())
  return preparing.then(() => warmPromise)
}

function startMetadataWarmPreparation(options) {
  const work = (async () => {
    while (!closing && warmPreparationQueue.size) {
      const batch = [...warmPreparationQueue.entries()].slice(0, 8)
      for (const [key] of batch) { warmPreparationQueue.delete(key); warmPreparingKeys.add(key) }
      try {
        const paths = await resolvePathsForAccess(batch.map(([, file]) => file))
        if (closing) return
        for (const resolved of paths.values()) {
          const key = getCacheKey(resolved, pathKey(resolved))
          if (!warmPendingKeys.has(key) && !warmQueue.has(key)) warmQueue.set(key, resolved)
        }
      } finally { for (const [key] of batch) warmPreparingKeys.delete(key) }
      if (!warmPromise && warmQueue.size) startMetadataWarmQueue(options)
    }
  })()
  warmPreparationPromise = work.finally(() => {
    warmPreparationPromise = null
    if (!closing && warmPreparationQueue.size) return startMetadataWarmPreparation(options)
  })
  return warmPreparationPromise
}

function startMetadataWarmQueue(options) {
  const controller = new AbortController()
  warmController = controller
  const timeout = setTimeout(() => controller.abort(new Error('元数据预热超过最长等待时间')), 2 * 60 * 1000)
  timeout.unref?.()
  const concurrency = Math.max(1, Math.min(2, Number(options.concurrency) || 1))
  const worker = async () => {
    while (warmQueue.size && !controller.signal.aborted) {
      const [key, current] = warmQueue.entries().next().value
      warmQueue.delete(key); warmPendingKeys.add(key)
      try { await getVideoMetadata(current, { background: true, signal: controller.signal,
        validate: async () => {
          const canonical = await resolvePathForAccessAsync(current)
          const policy = await createMediaAccessPolicyAsync({ signal: controller.signal })
          return policy.assertReadResolvedPath(canonical)
        } }) } catch {} finally { warmPendingKeys.delete(key) }
    }
  }
  warmPromise = Promise.all(Array.from({ length: concurrency }, worker)).finally(() => {
    clearTimeout(timeout)
    if (controller.signal.aborted) warmQueue.clear()
    warmPromise = null
    warmController = null
    if (!closing && warmQueue.size) return startMetadataWarmQueue(options)
  })
  return warmPromise
}

async function disposeVideoMetadata() {
  closing = true
  warmPreparationQueue.clear(); warmQueue.clear(); warmController?.abort(new Error('元数据服务正在关闭'))
  await warmPreparationPromise?.catch(() => {})
  await warmPromise?.catch(() => {})
  await cacheWriteQueue.catch(() => {})
}

module.exports = {
  getVideoMetadataDiagnostics: () => ({ warmQueued: warmPreparationQueue.size, warmPreparing: warmPreparingKeys.size,
    warmCanonicalQueued: warmQueue.size, warmActive: warmPendingKeys.size, closing }),
  getMetadataCachePath,
  loadMetadataCache,
  getCachedVideoMetadata,
  getCachedVideoMetadataForPath,
  getVideoMetadata,
  warmVideoMetadataCache,
  probeVideoMetadata,
  findFfprobe,
  setVideoMetadataWarmPaused,
  disposeVideoMetadata
}
