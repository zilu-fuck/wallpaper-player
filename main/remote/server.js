const http = require('http')
const { URL } = require('url')
const { getRemoteAccessSettings, getMediaAccessSettings, sessionAllowedDirectories, sessionPrivateDirectories } = require('../settings')
const crypto = require('crypto')
const { jsonResponses } = require('./json-responses')
const { assertAllowedVideoPath } = require('../scanner')
const {
  verifyAccessTokenWithType,
  getAccessTokenHashAuthorization,
  getAuthorizationRevision,
  refreshIdentity,
  refreshIdentitySync,
  verifyBoundScopedToken
} = require('./identity')
const { getPathForVideoId } = require('./video-index')
const { sendError } = require('./http-utils')
const { validateHttpQuery } = require('../../packages/contracts')
const { createDesktopHandlers } = require('./handlers/desktop')
const { createInfoHandlers } = require('./handlers/info')
const { createLibraryHandlers } = require('./handlers/library')
const { createMediaHandlers } = require('./handlers/media')
const { createNetworkResourceHandlers } = require('./handlers/network-resources')
const { createTagsHandlers } = require('./handlers/tags')
const { createTranscodeHandlers } = require('./handlers/transcode')
const { pluginRegistry } = require('../plugins')

const AUTH_FAILURE_WINDOW_MS = 60 * 1000
const AUTH_FAILURE_LIMIT = 12
const authFailures = new Map()

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
  return Boolean(getRemoteAccessSettings().allowLegacyToken)
}

function mediaScopeSignature() {
  return JSON.stringify([getMediaAccessSettings(), [...sessionAllowedDirectories], [...sessionPrivateDirectories]])
}

async function requireAuth(req, res, url, options = {}) {
  await refreshIdentity()
  if (req.aborted || res.destroyed || res.writableEnded) return false
  return requireCurrentAuth(req, res, url, options)
}

function requireCurrentAuth(req, res, url, options = {}) {
  const authorization = verifyAccessTokenWithType(getRequestToken(req, url, Boolean(options.allowQueryToken)), {
    remoteAddress: req.socket?.remoteAddress || ''
  })
  if (authorization.authorized && (authorization.type !== 'legacy' || options.allowLegacyToken)) {
    req.remoteAuthorization = authorization
    if (!req.assertJsonResponseCurrent) {
      req.refreshJsonResponseAuthorization = refreshIdentity
      const tokenHash = crypto.createHash('sha256').update(getRequestToken(req, url, Boolean(options.allowQueryToken)).trim()).digest('hex')
      let signature, revision = getAuthorizationRevision(), currentType = authorization.type
      req.assertJsonResponseCurrent = ({ beforeHeaders = false } = {}) => {
        if (beforeHeaders || revision !== getAuthorizationRevision()) {
          const current = getAccessTokenHashAuthorization(tokenHash)
          if (!current.authorized) throw Object.assign(new Error('设备未授权'), { status: 401, code: 'unauthorized' })
          revision = getAuthorizationRevision(); currentType = current.type
        }
        if (currentType === 'legacy' && !allowLegacyToken()) throw Object.assign(new Error('设备未授权'), { status: 401, code: 'unauthorized' })
        const currentScope = mediaScopeSignature()
        if (signature === undefined) signature = currentScope
        else if (signature !== currentScope) throw Object.assign(new Error('目录权限已变化，请重新读取'), { status: 409, code: 'media_policy_changed' })
      }
    }
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

async function requireThumbnailAuth(req, res, url, videoId) {
  await refreshIdentity()
  if (req.aborted || res.destroyed || res.writableEnded) return false
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
  try {
    return await assertAllowedVideoPath(fullPath, { audience: 'remote' })
  } catch {
    throw Object.assign(new Error('视频不存在或索引尚未加载'), { status: 404, code: 'video_not_found' })
  }
}

function createRemoteServer({ port, onPairingRequest, networkTimeouts = {} } = {}) {
  const {
    handleInfo,
    handleAuthorization,
    handlePairingClaim,
    handleUnpairCurrentDevice,
    handleSpeedTest
  } = createInfoHandlers({ getRequestToken })
  const { handleLibrary, handleLibraryQuery, handleLibraryRevision, handleLibraryCategories } = createLibraryHandlers({ getRequestToken })
  const {
    handleThumbnail,
    handleStream,
    handleGetVideoMetadata
  } = createMediaHandlers({ resolveVideoPath,
    authorizeThumbnail: (req, res, videoId) => requireThumbnailAuth(req, res, new URL(req.url, 'http://localhost'), videoId),
    authorizeMedia: (req, res) => requireAuth(req, res, new URL(req.url, 'http://localhost'), { allowLegacyToken: allowLegacyToken() }) })
  const {
    handleNetworkThumbnail,
    handleNetworkProxy,
    handleNetworkStream
  } = createNetworkResourceHandlers({ getRequestToken, allowLegacyToken,
    authorizeNetwork: (req, res, url) => requireAuth(req, res, url, { allowLegacyToken: allowLegacyToken() }),
    headerTimeoutMs: networkTimeouts.headers, playlistTimeoutMs: networkTimeouts.playlist })
  const {
    handleStartTranscode,
    handleGetTranscode,
    handleCancelTranscode,
    handleListTranscodes,
    handleClearTranscodeCache,
    handleTranscodedStream
  } = createTranscodeHandlers({ resolveVideoPath,
    authorizeMedia: (req, res) => requireAuth(req, res, new URL(req.url, 'http://localhost'), { allowLegacyToken: allowLegacyToken() }) })
  const {
    handleGetPlayback,
    handlePutPlayback,
    handleToggleFavorite,
    handlePutTags,
    handleGetTags,
    handlePutBulkTags,
    handleRestoreHiddenTags
  } = createTagsHandlers({ resolveVideoPath })
  const {
    handlePlayOnDesktop,
    handleRevealOnDesktop
  } = createDesktopHandlers({ resolveVideoPath })

  const server = http.createServer(async (req, res) => {
    req.remoteServer = server
    if (server.resourceClosing) { sendError(req, res, 503, 'server_stopping', '服务正在关闭'); return }
    try {
      if (!req.url || !req.method) {
        sendError(req, res, 400, 'bad_request', '请求无效')
        return
      }

      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)
      const pathname = url.pathname

      if (req.method === 'GET' && pathname === '/v1/info') {
        await refreshIdentity()
        await handleInfo(req, res, port)
        return
      }

      if (req.method === 'POST' && pathname === '/v1/pairing/claim') {
        await refreshIdentity()
        await handlePairingClaim(req, res)
        onPairingRequest?.()
        return
      }

      const thumbnailMatch = pathname.match(/^\/v1\/videos\/([^/]+)\/thumbnail$/)
      if (thumbnailMatch && (req.method === 'GET' || req.method === 'HEAD')) {
        const videoId = decodeVideoId(thumbnailMatch[1])
        if (!await requireThumbnailAuth(req, res, url, videoId)) return
        await handleThumbnail(req, res, videoId)
        return
      }

      const networkProxyMatch = pathname.match(/^\/v1\/network-resources\/([^/]+)\/proxy$/)
      if (networkProxyMatch && (req.method === 'GET' || req.method === 'HEAD')) {
        await handleNetworkProxy(req, res, decodeVideoId(networkProxyMatch[1]), url)
        return
      }

      if (!await requireAuth(req, res, url, { allowLegacyToken: allowLegacyToken() })) return
      validateHttpQuery(req.method, url)
      if (req.method === 'GET' && pathname === '/v1/auth') { await handleAuthorization(req, res); return }

      if (req.method === 'GET' && pathname === '/v1/library') {
        await handleLibrary(req, res, url)
        return
      }
      if (req.method === 'POST' && pathname === '/v1/library/query') { await handleLibraryQuery(req, res); return }
      if (req.method === 'GET' && pathname === '/v1/library/revision') { await handleLibraryRevision(req, res); return }
      if (req.method === 'GET' && pathname === '/v1/library/categories') { await handleLibraryCategories(req, res, url); return }

      if (req.method === 'DELETE' && pathname === '/v1/devices/current') {
        await handleUnpairCurrentDevice(req, res, url)
        return
      }

      if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/v1/speed-test') {
        await handleSpeedTest(req, res, url)
        return
      }

      if (req.method === 'GET' && pathname === '/v1/transcodes') {
        await handleListTranscodes(req, res)
        return
      }

      if (req.method === 'DELETE' && pathname === '/v1/transcodes/cache') {
        await handleClearTranscodeCache(req, res)
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

      const networkMatch = pathname.match(/^\/v1\/network-resources\/([^/]+)\/(thumbnail|stream)$/)
      if (networkMatch && (req.method === 'GET' || req.method === 'HEAD')) {
        const networkId = decodeVideoId(networkMatch[1])
        if (networkMatch[2] === 'thumbnail') {
          await handleNetworkThumbnail(req, res, networkId)
        } else {
          await handleNetworkStream(req, res, networkId, url)
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

      const metadataMatch = pathname.match(/^\/v1\/videos\/([^/]+)\/metadata$/)
      if (metadataMatch && req.method === 'GET') {
        await handleGetVideoMetadata(req, res, decodeVideoId(metadataMatch[1]))
        return
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
      if (tagsMatch) {
        if (req.method === 'PUT') { await handlePutTags(req, res, decodeVideoId(tagsMatch[1])); return }
        if (req.method === 'GET') { await handleGetTags(req, res, decodeVideoId(tagsMatch[1])); return }
      }

      // 还原所有隐藏标签（需隐私密码验证）
      if (req.method === 'POST' && pathname === '/v1/tags/restore-hidden') {
        await handleRestoreHiddenTags(req, res)
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

      const pluginRoute = pluginRegistry.matchRemoteRoute(req.method, pathname)
      if (pluginRoute) {
        await pluginRoute.route.handler(req, res, {
          params: pluginRoute.params,
          url,
          port,
          getRequestToken,
          resolveVideoPath,
          // Existing installed plugins expect a synchronous boolean helper.
          // Current plugins use the async helper; the legacy bridge fails busy
          // rather than racing an in-flight identity write.
          authorizeMedia: (request, response) => {
            refreshIdentitySync()
            return requireCurrentAuth(request, response, new URL(request.url, 'http://localhost'), { allowLegacyToken: allowLegacyToken() })
          },
          authorizeMediaAsync: (request, response) => requireAuth(request, response, new URL(request.url, 'http://localhost'), {
            allowLegacyToken: allowLegacyToken()
          })
        })
        return
      }

      sendError(req, res, 404, 'not_found', '接口不存在')
    } catch (err) {
      const status = Number(err.status) || 500
      const code = err.code || 'internal_error'
      const message = status >= 500 ? '远程服务错误' : err.message
      sendError(req, res, status, code, message, { currentRevision: err.currentRevision, currentLibraryRevision: err.currentLibraryRevision })
    }
  })

  server.on('close', () => jsonResponses.close(server))
  server.on('listening', () => { if (!server.resourceClosing) jsonResponses.open(server) })

  server.keepAliveTimeout = 15000
  server.headersTimeout = 30000
  // Incoming headers/body are bounded; long response streams retain their own cancellation lifecycle.
  server.requestTimeout = 15000
  server.maxRequestsPerSocket = 1000
  server.on('connection', (socket) => {
    socket.setNoDelay(true)
    socket.setKeepAlive(true, 30000)
  })

  return server
}

module.exports = {
  createRemoteServer
}
