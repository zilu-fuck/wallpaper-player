const http = require('http')
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const zlib = require('zlib')
const { shell } = require('electron')
const { URL } = require('url')
const { getPlaybackState, getPublicVideoDirectories, loadSettings, saveSettings, upsertPlaybackState } = require('../settings')
const { assertAllowedVideoPath, scanWithCache } = require('../scanner')
const { resolveThumbnail } = require('../thumbnail')
const {
  claimPairing,
  getPublicIdentity,
  revokePairedDeviceByToken,
  verifyAccessTokenWithType,
  verifyBoundScopedToken
} = require('./identity')
const { isPathInside, pathKey } = require('../paths')
const { getDirectoryId, getDirectoryName, getFavoriteKeyForVideoId, getPathForVideoId, toRemoteVideo } = require('./video-index')
const { getLanAddresses, getPrimaryEndpoint } = require('./network')
const { getMainWindow } = require('../window')
const {
  cancelMobileTranscode,
  getMobileTranscodeStatus,
  getTranscodedPath,
  startMobileTranscode
} = require('./transcode')
const {
  findVideoAnalysis,
  getActiveAnalysisJob,
  getRecentAnalysisEvent,
  startVideoAnalysis
} = require('../video-analysis')

const VIDEO_CONTENT_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.ts': 'video/mp2t',
  '.ogv': 'video/ogg'
}

const IMAGE_CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp'
}

const JSON_GZIP_THRESHOLD = 1024
const STREAM_HIGH_WATER_MARK = 1024 * 1024
const THUMBNAIL_HIGH_WATER_MARK = 256 * 1024
const MAX_SPEED_TEST_BYTES = 4 * 1024 * 1024
const DEFAULT_SPEED_TEST_BYTES = 1024 * 1024
const AUTH_FAILURE_WINDOW_MS = 60 * 1000
const AUTH_FAILURE_LIMIT = 12
const authFailures = new Map()
const speedTestChunk = Buffer.alloc(64 * 1024, 0x61)

function waitForDrainOrClose(res) {
  if (res.destroyed || res.writableEnded) return Promise.resolve(false)
  return new Promise((resolve) => {
    const cleanup = () => {
      res.off('drain', onDrain)
      res.off('close', onClose)
      res.off('error', onClose)
    }
    const onDrain = () => {
      cleanup()
      resolve(true)
    }
    const onClose = () => {
      cleanup()
      resolve(false)
    }
    res.once('drain', onDrain)
    res.once('close', onClose)
    res.once('error', onClose)
  })
}

function acceptsGzip(req) {
  return /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''))
}

function sendJson(req, res, status, data) {
  const body = Buffer.from(JSON.stringify(data))
  if (body.length >= JSON_GZIP_THRESHOLD && acceptsGzip(req)) {
    const compressed = zlib.gzipSync(body)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Encoding': 'gzip',
      'Content-Length': compressed.length,
      'Cache-Control': 'no-store',
      'Vary': 'Accept-Encoding'
    })
    res.end(req.method === 'HEAD' ? undefined : compressed)
    return
  }

  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'Vary': 'Accept-Encoding'
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

function sendError(req, res, status, code, message) {
  sendJson(req, res, status, { error: { code, message } })
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 1024 * 1024) {
        reject(new Error('请求体过大'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (!body) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(body))
      } catch {
        reject(new Error('请求 JSON 无效'))
      }
    })
    req.on('error', reject)
  })
}

function getBearerToken(req) {
  const header = req.headers.authorization
  if (typeof header !== 'string') return ''
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : ''
}

function getRequestToken(req, url, allowQueryToken) {
  return getBearerToken(req) || (allowQueryToken ? url.searchParams.get('token') : '') || ''
}

function getClientAddress(req) {
  return req.socket?.remoteAddress || 'unknown'
}

function getAuthFailureBucket(req) {
  const address = getClientAddress(req)
  const now = Date.now()
  const current = authFailures.get(address)
  if (!current || current.expiresAt <= now) {
    const next = { count: 0, expiresAt: now + AUTH_FAILURE_WINDOW_MS }
    authFailures.set(address, next)
    return { address, bucket: next }
  }
  return { address, bucket: current }
}

function recordAuthFailure(req) {
  const { bucket } = getAuthFailureBucket(req)
  bucket.count += 1
  return bucket.count > AUTH_FAILURE_LIMIT
}

function clearAuthFailures(req) {
  authFailures.delete(getClientAddress(req))
}

function allowLegacyToken() {
  return Boolean(loadSettings().remoteAccess?.allowLegacyToken)
}

function requireAuth(req, res, url, options = {}) {
  const authorization = verifyAccessTokenWithType(getRequestToken(req, url, Boolean(options.allowQueryToken)), {
    remoteAddress: req.socket?.remoteAddress || ''
  })
  if (authorization.authorized && (authorization.type !== 'legacy' || options.allowLegacyToken)) {
    clearAuthFailures(req)
    return true
  }
  if (authorization.authorized && authorization.type === 'legacy') {
    sendError(req, res, 403, 'legacy_token_disabled', '临时 Token 兼容入口未开启，请使用扫码绑定')
    return false
  }
  if (recordAuthFailure(req)) {
    sendError(req, res, 429, 'auth_rate_limited', '认证失败次数过多，请稍后再试')
    return false
  }
  sendError(req, res, 401, 'unauthorized', '设备未授权')
  return false
}

function requireThumbnailAuth(req, res, url, videoId) {
  const thumbnailToken = url.searchParams.get('thumbnailToken')
  const legacyAllowed = allowLegacyToken()
  if (verifyBoundScopedToken('thumbnail', videoId, thumbnailToken, { allowLegacyToken: legacyAllowed })) return true
  return requireAuth(req, res, url, { allowLegacyToken: legacyAllowed })
}

function decodeVideoId(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return ''
  }
}

async function resolveVideoPath(videoId) {
  const fullPath = getPathForVideoId(videoId)
  if (!fullPath) {
    throw Object.assign(new Error('视频不存在或索引尚未加载'), { status: 404, code: 'video_not_found' })
  }
  const resolvedPath = await assertAllowedVideoPath(fullPath)
  const publicDirectories = getPublicVideoDirectories()
  if (!publicDirectories.some(directory => isPathInside(directory, resolvedPath))) {
    throw Object.assign(new Error('视频不存在或索引尚未加载'), { status: 404, code: 'video_not_found' })
  }
  return resolvedPath
}

async function handleInfo(req, res, port) {
  sendJson(req, res, 200, {
    ...getPublicIdentity(),
    version: 1,
    endpoint: getPrimaryEndpoint(port),
    endpoints: getLanAddresses(port),
    transport: {
      protocol: 'http',
      range: true,
      tcpNoDelay: true,
      keepAlive: true
    }
  })
}

async function handlePairingClaim(req, res) {
  const body = await readBody(req)
  const result = claimPairing({
    pairingId: body.pairingId,
    oneTimeSecret: body.oneTimeSecret,
    clientId: body.clientId,
    clientName: body.clientName,
    platform: body.platform
  })
  sendJson(req, res, 200, result)
}

async function handleUnpairCurrentDevice(req, res, url) {
  const token = getRequestToken(req, url, false)
  const revoked = revokePairedDeviceByToken(token)
  if (!revoked) {
    sendError(req, res, 400, 'device_not_paired', '当前设备不是扫码绑定设备，已在手机端本地移除')
    return
  }
  sendJson(req, res, 200, { success: true, device: revoked })
}

async function handleSpeedTest(req, res, url) {
  const requestedSize = Number(url.searchParams.get('bytes'))
  const total = Math.max(
    64 * 1024,
    Math.min(Number.isFinite(requestedSize) ? requestedSize : DEFAULT_SPEED_TEST_BYTES, MAX_SPEED_TEST_BYTES)
  )

  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': total,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }

  let remaining = total
  while (remaining > 0) {
    if (res.destroyed || res.writableEnded) return
    const chunk = remaining >= speedTestChunk.length
      ? speedTestChunk
      : speedTestChunk.subarray(0, remaining)
    remaining -= chunk.length
    if (!res.write(chunk)) {
      const canContinue = await waitForDrainOrClose(res)
      if (!canContinue) return
    }
  }
  if (!res.destroyed && !res.writableEnded) res.end()
}

function buildCategoryGroups(items) {
  const customCounts = new Map()
  const systemCounts = new Map()

  for (const item of items) {
    for (const tag of item.customTags || []) {
      customCounts.set(tag, (customCounts.get(tag) || 0) + 1)
    }
    for (const tag of item.systemTags || []) {
      systemCounts.set(tag, (systemCounts.get(tag) || 0) + 1)
    }
  }

  const toCategories = (counts, type) => [...counts.entries()]
    .map(([name, count]) => ({
      key: `${type}:${name}`,
      name,
      count,
      type
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN'))

  return {
    custom: toCategories(customCounts, 'custom'),
    system: toCategories(systemCounts, 'system')
  }
}

function applyDesktopMetadata(video, settings) {
  const favoriteKey = video.favoriteKey
  const systemTags = Array.isArray(video.tags) ? video.tags : []
  const customTags = Array.isArray(settings.customTags?.[favoriteKey])
    ? settings.customTags[favoriteKey]
    : Array.isArray(settings.customTags?.[video.fullPath])
      ? settings.customTags[video.fullPath]
      : []

  return {
    ...video,
    systemTags,
    customTags,
    tags: [...new Set([...systemTags, ...customTags])],
    group: [...systemTags, ...customTags][0] || video.group
  }
}

async function handleLibrary(req, res, url) {
  const directories = getPublicVideoDirectories()
  const items = []
  const directorySummaries = []
  const settings = loadSettings()
  const favoriteKeys = new Set(Array.isArray(settings.favorites) ? settings.favorites : [])
  const accessToken = getRequestToken(req, url, false)

  for (const directory of directories) {
    const directoryId = getDirectoryId(directory)
    const directoryName = getDirectoryName(directory)
    const result = await scanWithCache(directory)
    if (Array.isArray(result?.videos)) {
      const remoteVideos = result.videos.map(video => toRemoteVideo(
        applyDesktopMetadata(video, settings),
        '',
        { directoryId, directoryName, favoriteKeys, accessToken }
      ))
      items.push(...remoteVideos)
      directorySummaries.push({
        id: directoryId,
        name: directoryName,
        count: remoteVideos.length
      })
    }
  }

  sendJson(req, res, 200, {
    items,
    count: items.length,
    directories: directorySummaries,
    categoryGroups: buildCategoryGroups(items),
    favoriteCount: items.filter(item => item.favorite).length,
    scannedAt: Date.now()
  })
}

async function handleThumbnail(req, res, videoId) {
  const videoPath = await resolveVideoPath(videoId)
  const thumbnailPath = await resolveThumbnail(videoPath)
  if (!thumbnailPath) {
    sendError(req, res, 404, 'thumbnail_not_found', '缩略图不存在')
    return
  }

  const resolvedThumb = path.resolve(thumbnailPath)
  const stat = await fsp.stat(resolvedThumb)
  if (!stat.isFile()) {
    sendError(req, res, 404, 'thumbnail_not_found', '缩略图不存在')
    return
  }

  const contentType = IMAGE_CONTENT_TYPES[path.extname(resolvedThumb).toLowerCase()] || 'application/octet-stream'
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, {
      'ETag': etag,
      'Cache-Control': 'private, max-age=3600'
    })
    res.end()
    return
  }

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stat.size,
    'Cache-Control': 'private, max-age=3600',
    'ETag': etag,
    'X-Content-Type-Options': 'nosniff'
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  fs.createReadStream(resolvedThumb, { highWaterMark: THUMBNAIL_HIGH_WATER_MARK }).pipe(res)
}

async function streamFileWithRange(req, res, filePath, contentType, notFoundMessage = '文件不存在', options = {}) {
  const stat = await fsp.stat(filePath)
  if (!stat.isFile()) {
    sendError(req, res, 404, 'file_not_found', notFoundMessage)
    return
  }
  const total = stat.size
  const range = req.headers.range

  if (typeof range === 'string') {
    const requestedRange = range.replace(/^bytes=/, '').split(',')[0]?.trim() || ''
    const match = requestedRange.match(/^(\d*)-(\d*)$/)
    if (!match) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` })
      res.end()
      return
    }

    let start
    let end
    if (!match[1] && match[2]) {
      const suffixLength = Number(match[2])
      start = Math.max(total - suffixLength, 0)
      end = total - 1
    } else {
      start = match[1] ? Number(match[1]) : 0
      end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` })
      res.end()
      return
    }

    res.writeHead(206, {
      'Content-Type': contentType,
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    fs.createReadStream(filePath, { start, end, highWaterMark: STREAM_HIGH_WATER_MARK }).pipe(res)
    return
  }

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': total,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  fs.createReadStream(filePath, { highWaterMark: STREAM_HIGH_WATER_MARK }).pipe(res)
}

async function handleStream(req, res, videoId) {
  const videoPath = await resolveVideoPath(videoId)
  const contentType = VIDEO_CONTENT_TYPES[path.extname(videoPath).toLowerCase()] || 'application/octet-stream'
  await streamFileWithRange(req, res, videoPath, contentType, '视频不存在')
}

async function handleStartTranscode(req, res, videoId) {
  const videoPath = await resolveVideoPath(videoId)
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)
  const quality = url.searchParams.get('quality') || 'compatible'
  await startMobileTranscode(videoId, videoPath, quality)
  sendJson(req, res, 202, getMobileTranscodeStatus(videoId, quality))
}

async function handleGetTranscode(req, res, videoId) {
  await resolveVideoPath(videoId)
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)
  const quality = url.searchParams.get('quality') || 'compatible'
  const status = getMobileTranscodeStatus(videoId, quality)
  if (!status) {
    sendError(req, res, 404, 'transcode_not_started', '尚未开始准备兼容格式')
    return
  }
  sendJson(req, res, 200, status)
}

async function handleCancelTranscode(req, res, videoId) {
  await resolveVideoPath(videoId)
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)
  const quality = url.searchParams.get('quality') || 'compatible'
  sendJson(req, res, 200, { success: cancelMobileTranscode(videoId, quality) })
}

async function handleTranscodedStream(req, res, videoId) {
  await resolveVideoPath(videoId)
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)
  const quality = url.searchParams.get('quality') || 'compatible'
  const outputPath = getTranscodedPath(videoId, quality)
  if (!outputPath) {
    sendError(req, res, 409, 'transcode_not_ready', '兼容格式尚未准备完成')
    return
  }
  await streamFileWithRange(req, res, outputPath, 'video/mp4', '兼容格式不存在')
}

function sanitizeRemoteAnalysis(analysis) {
  if (!analysis || typeof analysis !== 'object') return null
  const timeline = Array.isArray(analysis.timeline)
    ? analysis.timeline.map(item => ({
        start_time: Number(item?.start_time) || 0,
        end_time: Number(item?.end_time) || 0,
        title: typeof item?.title === 'string' ? item.title : '',
        description: typeof item?.description === 'string' ? item.description : '',
        confidence: Number(item?.confidence) || 0,
        vlm_status: typeof item?.vlm_status === 'string' ? item.vlm_status : ''
      }))
    : []
  const characters = Array.isArray(analysis.characters)
    ? analysis.characters.map(item => ({
        name: typeof item?.name === 'string' ? item.name : '',
        identity_status: typeof item?.identity_status === 'string' ? item.identity_status : '',
        description: typeof item?.description === 'string' ? item.description : '',
        confidence: Number(item?.confidence) || 0
      })).filter(item => item.name || item.description)
    : []
  const sourceVideo = analysis.sourceVideo && typeof analysis.sourceVideo === 'object'
    ? {
        original_filename: typeof analysis.sourceVideo.original_filename === 'string'
          ? analysis.sourceVideo.original_filename
          : '',
        duration: Number(analysis.sourceVideo.duration) || 0,
        file_size_bytes: Number(analysis.sourceVideo.file_size_bytes) || 0
      }
    : {}

  return {
    available: analysis.available !== false,
    reason: typeof analysis.reason === 'string' ? analysis.reason : '',
    error: typeof analysis.error === 'string' ? analysis.error : '',
    savedAt: typeof analysis.savedAt === 'string' ? analysis.savedAt : '',
    matchType: typeof analysis.matchType === 'string' ? analysis.matchType : '',
    sourceVideo,
    summary: typeof analysis.summary === 'string' ? analysis.summary : '',
    tags: Array.isArray(analysis.tags) ? analysis.tags.filter(item => typeof item === 'string') : [],
    keywords: Array.isArray(analysis.keywords) ? analysis.keywords.filter(item => typeof item === 'string') : [],
    timeline,
    characters,
    quality: analysis.quality && typeof analysis.quality === 'object' ? analysis.quality : {},
    naming: analysis.naming && typeof analysis.naming === 'object' ? analysis.naming : {}
  }
}

function sanitizeRemoteAnalysisEvent(event) {
  if (!event || typeof event !== 'object') return null
  return {
    type: typeof event.type === 'string' ? event.type : '',
    stage: typeof event.stage === 'string' ? event.stage : '',
    status: typeof event.status === 'string' ? event.status : '',
    message: typeof event.message === 'string' ? event.message : '',
    createdAt: typeof event.createdAt === 'string' ? event.createdAt : ''
  }
}

function sanitizeRemoteAnalysisJob(job, videoPath) {
  if (!job?.running) return null
  const sameVideo = job.videoPath && pathKey(job.videoPath) === pathKey(videoPath)
  if (!sameVideo) {
    return {
      running: true,
      currentVideo: false,
      startedAt: job.startedAt || 0
    }
  }

  return {
    running: true,
    currentVideo: true,
    jobId: job.jobId || '',
    startedAt: job.startedAt || 0,
    lastEvent: sanitizeRemoteAnalysisEvent(job.lastEvent)
  }
}

function sanitizeRemoteRecentAnalysisEvent(recent, videoPath) {
  if (!recent || (recent.videoPath && pathKey(recent.videoPath) !== pathKey(videoPath))) return null
  return {
    jobId: recent.jobId || '',
    status: typeof recent.status === 'string' ? recent.status : '',
    message: typeof recent.message === 'string' ? recent.message : '',
    error: typeof recent.error === 'string' ? recent.error : '',
    updatedAt: recent.updatedAt || 0,
    event: sanitizeRemoteAnalysisEvent(recent.event),
    analysis: sanitizeRemoteAnalysis(recent.analysis)
  }
}

async function getRemoteVideoAnalysisPayload(videoId) {
  const videoPath = await resolveVideoPath(videoId)
  const settings = loadSettings()
  const enabled = Boolean(settings.videoAnalysis?.enabled)
  const job = getActiveAnalysisJob()
  const sanitizedJob = sanitizeRemoteAnalysisJob(job, videoPath)
  const analysis = enabled && !sanitizedJob?.currentVideo
    ? await findVideoAnalysis(videoPath)
    : { available: false, reason: enabled ? 'running' : 'disabled' }
  const recent = sanitizeRemoteRecentAnalysisEvent(getRecentAnalysisEvent(videoPath), videoPath)
  return {
    enabled,
    analysis: sanitizeRemoteAnalysis(analysis),
    job: sanitizedJob,
    recent,
    checkedAt: Date.now()
  }
}

async function handleGetVideoAnalysis(req, res, videoId) {
  sendJson(req, res, 200, await getRemoteVideoAnalysisPayload(videoId))
}

async function handleStartVideoAnalysis(req, res, videoId) {
  const videoPath = await resolveVideoPath(videoId)
  const settings = loadSettings()
  if (!settings.videoAnalysis?.enabled) {
    sendJson(req, res, 200, {
      accepted: false,
      reason: 'disabled',
      error: '请先在电脑端设置里开启视频理解',
      ...(await getRemoteVideoAnalysisPayload(videoId))
    })
    return
  }

  const result = await startVideoAnalysis(videoPath)
  sendJson(req, res, result.accepted ? 202 : 200, {
    ...result,
    job: sanitizeRemoteAnalysisJob(result.job, videoPath),
    ...(await getRemoteVideoAnalysisPayload(videoId))
  })
}

async function handleGetPlayback(req, res, videoId) {
  const videoPath = await resolveVideoPath(videoId)
  const settings = loadSettings()
  sendJson(req, res, 200, getPlaybackState(settings.playbackStates, videoPath) || null)
}

async function handlePutPlayback(req, res, videoId) {
  const videoPath = await resolveVideoPath(videoId)
  const body = await readBody(req)
  const settings = loadSettings()
  const playbackStates = upsertPlaybackState(settings.playbackStates, videoPath, {
    position: Number(body.position) || 0,
    updatedAt: Date.now()
  })
  saveSettings({ playbackStates })
  sendJson(req, res, 200, { success: true })
}

async function handleToggleFavorite(req, res, videoId) {
  const videoPath = await resolveVideoPath(videoId)
  const favoriteKey = getFavoriteKeyForVideoId(videoId)
  if (!favoriteKey) {
    sendError(req, res, 404, 'video_not_found', '视频不存在或索引尚未加载')
    return
  }

  await assertAllowedVideoPath(videoPath)
  const settings = loadSettings()
  const favorites = Array.isArray(settings.favorites) ? settings.favorites : []
  const favorite = !favorites.includes(favoriteKey) && !favorites.includes(videoPath)
  const nextFavorites = favorite
    ? [...favorites, favoriteKey]
    : favorites.filter(item => item !== favoriteKey && item !== videoPath)
  saveSettings({ favorites: nextFavorites })
  sendJson(req, res, 200, { success: true, favorite })
}

function normalizeRequestTags(tags) {
  return Array.isArray(tags)
    ? [...new Set(tags.filter(tag => typeof tag === 'string' && tag.trim()).map(tag => tag.trim()))]
    : []
}

async function handlePutTags(req, res, videoId) {
  const videoPath = await resolveVideoPath(videoId)
  const favoriteKey = getFavoriteKeyForVideoId(videoId)
  if (!favoriteKey) {
    sendError(req, res, 404, 'video_not_found', '视频不存在或索引尚未加载')
    return
  }

  await assertAllowedVideoPath(videoPath)
  const body = await readBody(req)
  const tags = normalizeRequestTags(body.tags)
  const settings = loadSettings()
  const customTags = { ...(settings.customTags || {}) }
  delete customTags[videoPath]
  if (tags.length > 0) {
    customTags[favoriteKey] = tags
  } else {
    delete customTags[favoriteKey]
  }
  saveSettings({ customTags })
  sendJson(req, res, 200, { success: true, customTags: tags })
}

async function handlePutBulkTags(req, res) {
  const body = await readBody(req)
  const videoIds = Array.isArray(body.videoIds)
    ? [...new Set(body.videoIds.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))]
    : []
  const tags = normalizeRequestTags(body.tags)

  if (!videoIds.length) {
    sendError(req, res, 400, 'missing_video_ids', '请选择要添加标签的视频')
    return
  }
  if (!tags.length) {
    sendError(req, res, 400, 'missing_tags', '请输入要添加的标签')
    return
  }

  const settings = loadSettings()
  const customTags = { ...(settings.customTags || {}) }
  let updatedCount = 0

  for (const videoId of videoIds) {
    const videoPath = await resolveVideoPath(videoId)
    const favoriteKey = getFavoriteKeyForVideoId(videoId)
    if (!favoriteKey) continue
    await assertAllowedVideoPath(videoPath)
    const currentTags = [
      ...(Array.isArray(customTags[favoriteKey]) ? customTags[favoriteKey] : []),
      ...(Array.isArray(customTags[videoPath]) ? customTags[videoPath] : [])
    ]
    customTags[favoriteKey] = [...new Set([...currentTags, ...tags])]
    delete customTags[videoPath]
    updatedCount += 1
  }

  saveSettings({ customTags })
  sendJson(req, res, 200, { success: true, updatedCount, tags })
}

async function handlePlayOnDesktop(req, res, videoId) {
  const videoPath = await resolveVideoPath(videoId)
  const body = await readBody(req)
  const position = Math.max(0, Number(body.position) || 0)
  const settings = loadSettings()
  const playbackStates = upsertPlaybackState(settings.playbackStates, videoPath, {
    position,
    updatedAt: Date.now()
  })
  saveSettings({ playbackStates })

  const win = getMainWindow()
  if (!win || win.isDestroyed()) {
    sendError(req, res, 503, 'desktop_window_unavailable', '电脑端窗口不可用')
    return
  }

  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
  win.webContents.send('remote-play-on-desktop', {
    filePath: videoPath,
    position
  })
  sendJson(req, res, 200, { success: true })
}

async function handleRevealOnDesktop(req, res, videoId) {
  const videoPath = await resolveVideoPath(videoId)
  shell.showItemInFolder(videoPath)
  sendJson(req, res, 200, { success: true })
}

function createRemoteServer({ port, onPairingRequest } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url || !req.method) {
        sendError(req, res, 400, 'bad_request', '请求无效')
        return
      }

      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)
      const pathname = url.pathname

      if (req.method === 'GET' && pathname === '/v1/info') {
        await handleInfo(req, res, port)
        return
      }

      if (req.method === 'POST' && pathname === '/v1/pairing/claim') {
        await handlePairingClaim(req, res)
        onPairingRequest?.()
        return
      }

      const thumbnailMatch = pathname.match(/^\/v1\/videos\/([^/]+)\/thumbnail$/)
      if (thumbnailMatch && (req.method === 'GET' || req.method === 'HEAD')) {
        const videoId = decodeVideoId(thumbnailMatch[1])
        if (!requireThumbnailAuth(req, res, url, videoId)) return
        await handleThumbnail(req, res, videoId)
        return
      }

      if (!requireAuth(req, res, url, { allowLegacyToken: allowLegacyToken() })) return

      if (req.method === 'GET' && pathname === '/v1/library') {
        await handleLibrary(req, res, url)
        return
      }

      if (req.method === 'DELETE' && pathname === '/v1/devices/current') {
        await handleUnpairCurrentDevice(req, res, url)
        return
      }

      if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/v1/speed-test') {
        await handleSpeedTest(req, res, url)
        return
      }

      const videoMatch = pathname.match(/^\/v1\/videos\/([^/]+)\/(thumbnail|stream)$/)
      if (videoMatch && (req.method === 'GET' || req.method === 'HEAD')) {
        const videoId = decodeVideoId(videoMatch[1])
        if (videoMatch[2] === 'stream') {
          await handleStream(req, res, videoId)
        }
        return
      }

      const transcodeMatch = pathname.match(/^\/v1\/videos\/([^/]+)\/transcode$/)
      if (transcodeMatch) {
        const videoId = decodeVideoId(transcodeMatch[1])
        if (req.method === 'POST') {
          await handleStartTranscode(req, res, videoId)
          return
        }
        if (req.method === 'GET') {
          await handleGetTranscode(req, res, videoId)
          return
        }
        if (req.method === 'DELETE') {
          await handleCancelTranscode(req, res, videoId)
          return
        }
      }

      const analysisMatch = pathname.match(/^\/v1\/videos\/([^/]+)\/analysis$/)
      if (analysisMatch) {
        const videoId = decodeVideoId(analysisMatch[1])
        if (req.method === 'GET') {
          await handleGetVideoAnalysis(req, res, videoId)
          return
        }
        if (req.method === 'POST') {
          await handleStartVideoAnalysis(req, res, videoId)
          return
        }
      }

      const transcodedStreamMatch = pathname.match(/^\/v1\/videos\/([^/]+)\/transcoded-stream$/)
      if (transcodedStreamMatch && (req.method === 'GET' || req.method === 'HEAD')) {
        await handleTranscodedStream(req, res, decodeVideoId(transcodedStreamMatch[1]))
        return
      }

      const playbackMatch = pathname.match(/^\/v1\/playback\/([^/]+)$/)
      if (playbackMatch) {
        const videoId = decodeVideoId(playbackMatch[1])
        if (req.method === 'GET') {
          await handleGetPlayback(req, res, videoId)
          return
        }
        if (req.method === 'PUT') {
          await handlePutPlayback(req, res, videoId)
          return
        }
      }

      const favoriteMatch = pathname.match(/^\/v1\/videos\/([^/]+)\/favorite$/)
      if (favoriteMatch && req.method === 'PUT') {
        await handleToggleFavorite(req, res, decodeVideoId(favoriteMatch[1]))
        return
      }

      if (req.method === 'PUT' && pathname === '/v1/videos/tags/bulk') {
        await handlePutBulkTags(req, res)
        return
      }

      const tagsMatch = pathname.match(/^\/v1\/videos\/([^/]+)\/tags$/)
      if (tagsMatch && req.method === 'PUT') {
        await handlePutTags(req, res, decodeVideoId(tagsMatch[1]))
        return
      }

      const desktopPlayMatch = pathname.match(/^\/v1\/videos\/([^/]+)\/play-on-desktop$/)
      if (desktopPlayMatch && req.method === 'POST') {
        await handlePlayOnDesktop(req, res, decodeVideoId(desktopPlayMatch[1]))
        return
      }

      const desktopRevealMatch = pathname.match(/^\/v1\/videos\/([^/]+)\/reveal-on-desktop$/)
      if (desktopRevealMatch && req.method === 'POST') {
        await handleRevealOnDesktop(req, res, decodeVideoId(desktopRevealMatch[1]))
        return
      }

      sendError(req, res, 404, 'not_found', '接口不存在')
    } catch (err) {
      const status = Number(err.status) || 500
      const code = err.code || 'internal_error'
      const message = status >= 500 ? '远程服务错误' : err.message
      sendError(req, res, status, code, message)
    }
  })

  server.keepAliveTimeout = 65000
  server.headersTimeout = 66000
  server.requestTimeout = 0
  server.on('connection', (socket) => {
    socket.setNoDelay(true)
    socket.setKeepAlive(true, 30000)
  })

  return server
}

module.exports = {
  createRemoteServer
}
