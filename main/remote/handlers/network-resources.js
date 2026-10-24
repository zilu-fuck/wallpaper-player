const crypto = require('crypto')
const http = require('http')
const https = require('https')
const { pipeline } = require('stream/promises')
const { acquireRemoteStream } = require('../../media-pressure')
const { trackNetworkStream } = require('../streaming')
const { NETWORK_VIDEO_EXTENSIONS } = require('../../constants')
const { loadSettingsFields } = require('../../settings')
const { getTagsRevision } = require('../../repositories/tag-state')
const {
  assertResolvedTargetPublic,
  isLocalHostname,
  isPrivateIpAddress,
  normalizeHostname
} = require('../../ip-utils')
const { parseNetworkResourcePage } = require('../../network-resource-parser')
const { enrichNetworkResource, WEBPAGE_SSRF_GUARD_HINT } = require('../../ipc/network-resource-service')
const { sendError } = require('../http-utils')
const { createBoundScopedToken, signScopedToken, verifyBoundScopedToken, refreshIdentity } = require('../identity')

const NETWORK_DIRECTORY_ID = 'network_resources'
const NETWORK_DIRECTORY_NAME = '网络资源'
const DEFAULT_BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36'
const MAX_REDIRECTS = 4
const MAX_PLAYLIST_BYTES = 5 * 1024 * 1024
const MAX_NETWORK_PROXY_CONCURRENCY = 16
const MAX_NETWORK_PROXY_PER_RESOURCE = 6
const NETWORK_PROXY_TOKEN_TTL_MS = 6 * 60 * 60 * 1000
const networkError = (code, message, status = 502) => Object.assign(new Error(message), { code, status })

const activeNetworkProxyRequests = {
  total: 0,
  byNetworkId: new Map()
}

function normalizeUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim())
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
    return parsed.toString()
  } catch {
    return ''
  }
}

function getUrlExtension(value) {
  try {
    return new URL(value).pathname.toLowerCase().match(/\.[^.\\/]+$/)?.[0] || ''
  } catch {
    return ''
  }
}

function getHostName(value) {
  try {
    return new URL(value).hostname.replace(/^www\./i, '')
  } catch {
    return ''
  }
}

function isSameSiteUrl(targetUrl, baseUrl) {
  try {
    const target = new URL(targetUrl)
    const base = new URL(baseUrl)
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return false
    const targetHost = normalizeHostname(target.hostname)
    const baseHost = normalizeHostname(base.hostname)
    if (!targetHost || !baseHost) return false
    return targetHost === baseHost
  } catch {
    return false
  }
}

function isAllowedPlaylistTarget(targetUrl, baseUrl, options = {}) {
  if (isSameSiteUrl(targetUrl, baseUrl)) return true
  const allowedHosts = Array.isArray(options.allowedHosts) ? options.allowedHosts : []
  const targetHost = normalizeHostname(getHostName(targetUrl))
  if (!targetHost) return false
  if (allowedHosts.some(host => targetHost === normalizeHostname(host))) return true
  if (isLocalHostname(targetHost) || isPrivateIpAddress(targetHost)) return false
  return true
}

function withNetworkProxySlot(networkId, fn) {
  const key = String(networkId || 'unknown')
  const currentForResource = activeNetworkProxyRequests.byNetworkId.get(key) || 0
  if (
    activeNetworkProxyRequests.total >= MAX_NETWORK_PROXY_CONCURRENCY ||
    currentForResource >= MAX_NETWORK_PROXY_PER_RESOURCE
  ) {
    throw Object.assign(new Error('网络资源代理请求过多，请稍后再试'), {
      status: 429,
      code: 'network_proxy_busy'
    })
  }

  activeNetworkProxyRequests.total += 1
  activeNetworkProxyRequests.byNetworkId.set(key, currentForResource + 1)

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      activeNetworkProxyRequests.total = Math.max(0, activeNetworkProxyRequests.total - 1)
      const nextForResource = (activeNetworkProxyRequests.byNetworkId.get(key) || 1) - 1
      if (nextForResource > 0) {
        activeNetworkProxyRequests.byNetworkId.set(key, nextForResource)
      } else {
        activeNetworkProxyRequests.byNetworkId.delete(key)
      }
    })
}

function getRemoteNetworkId(value) {
  return `network_${crypto.createHash('sha256').update(String(value || '')).digest('base64url').slice(0, 32)}`
}

function getNetworkFavoriteKey(item) {
  return normalizeUrl(item?.url || item?.playbackUrl)
}

function getLegacyNetworkFavoriteKey(item) {
  const key = getNetworkFavoriteKey(item)
  return key ? `network:${key}` : ''
}

function normalizeHttpHeaders(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return null
  return {
    referer: typeof headers.referer === 'string' ? headers.referer.trim() : '',
    userAgent: typeof headers.userAgent === 'string' ? headers.userAgent.trim() : ''
  }
}

function isPlayableCandidate(item) {
  if (item.playbackUrl) return true
  if (item.kind !== 'webpage') return true
  return item.openMode !== 'webview'
}

function getNetworkTitle(resource, episode = null) {
  const title = String(episode?.title || resource?.title || '').trim()
  if (title) return title
  const url = normalizeUrl(episode?.url || resource?.url)
  if (!url) return '网络资源'
  try {
    const parsed = new URL(url)
    const fileName = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '')
    return fileName || parsed.hostname || '网络资源'
  } catch {
    return '网络资源'
  }
}

function createNetworkItem(resource, episode = null) {
  const url = normalizeUrl(episode?.url || resource?.url)
  const playbackUrl = normalizeUrl(episode ? episode?.playbackUrl : resource?.playbackUrl)
  if (!url) return null

  const page = resource?.page && typeof resource.page === 'object' ? resource.page : null
  const episodeIndex = Number(episode?.index || page?.currentEpisodeIndex || 0) || null
  const episodeTitle = String(episode?.title || page?.currentEpisodeTitle || '').trim()
  const site = String(page?.site || getHostName(resource?.url || url) || NETWORK_DIRECTORY_NAME).trim()
  const kind = resource?.kind === 'webpage' ? 'webpage' : 'direct'
  const openMode = String(episode?.openMode || page?.openMode || '').trim()
  const sourceKey = [
    resource?.id || resource?.url || '',
    url,
    playbackUrl,
    episodeIndex || '',
    episodeTitle
  ].join('|')

  const item = {
    id: getRemoteNetworkId(sourceKey),
    sourceResourceId: resource?.id || '',
    kind,
    title: getNetworkTitle(resource, episode),
    url,
    playbackUrl,
    httpHeaders: normalizeHttpHeaders(episode?.httpHeaders) || normalizeHttpHeaders(resource?.httpHeaders),
    parser: String(resource?.parser || '').trim(),
    createdAt: resource?.createdAt || '',
    openMode,
    site,
    episodeIndex,
    episodeTitle,
    favoriteKey: '',
    desktopResource: {
      id: resource?.id || '',
      kind,
      title: getNetworkTitle(resource, episode),
      url,
      playbackUrl,
      httpHeaders: normalizeHttpHeaders(episode?.httpHeaders) || normalizeHttpHeaders(resource?.httpHeaders),
      parser: String(resource?.parser || '').trim(),
      page: page
        ? {
          ...page,
          openMode,
          currentEpisodeIndex: episodeIndex,
          currentEpisodeTitle: episodeTitle
        }
        : null
    }
  }
  item.favoriteKey = getNetworkFavoriteKey(item)
  return isPlayableCandidate(item) ? item : null
}

function listRemoteNetworkItems(settings = loadSettingsFields(['networkResources'])) {
  const resources = Array.isArray(settings.networkResources) ? settings.networkResources : []
  const items = []
  const seen = new Set()

  for (const resource of resources) {
    const episodes = Array.isArray(resource?.page?.episodes) ? resource.page.episodes : []
    if (episodes.length > 0) {
      for (const episode of episodes) {
        const item = createNetworkItem(resource, episode)
        if (!item || seen.has(item.id)) continue
        seen.add(item.id)
        items.push(item)
      }
      continue
    }

    const item = createNetworkItem(resource)
    if (!item || seen.has(item.id)) continue
    seen.add(item.id)
    items.push(item)
  }

  return items
}

function getRemoteNetworkItemById(id, settings = loadSettingsFields(['networkResources'])) {
  const target = String(id || '').trim()
  if (!target.startsWith('network_')) return null
  return listRemoteNetworkItems(settings).find(item => item.id === target) || null
}

function toRemoteNetworkVideo(item, context = {}) {
  const legacyFavoriteKey = getLegacyNetworkFavoriteKey(item)
  const customTags = [
    ...(Array.isArray(context.customTags?.[item.favoriteKey]) ? context.customTags[item.favoriteKey] : []),
    ...(Array.isArray(context.customTags?.[legacyFavoriteKey]) ? context.customTags[legacyFavoriteKey] : [])
  ].filter((tag, index, tags) => tag && tags.indexOf(tag) === index)
  const systemTags = [NETWORK_DIRECTORY_NAME, item.site].filter(Boolean)
  const tags = [...new Set([...systemTags, ...customTags])]
  const extension = getUrlExtension(item.playbackUrl || item.url) ||
    (item.kind === 'webpage' ? '.web' : '.url')
  const modified = Date.parse(item.createdAt)

  return {
    id: item.id,
    sourceType: 'network',
    resourceKind: item.kind,
    name: item.title,
    fileName: item.title,
    extension,
    size: 0,
    modified: Number.isFinite(modified) ? modified : 0,
    group: item.site || NETWORK_DIRECTORY_NAME,
    tags,
    systemTags,
    customTags,
    customTagsRevision: getTagsRevision({ customTagRevisions: context.customTagRevisions }, { favoriteKey: item.favoriteKey, path: item.url }),
    favorite: Boolean(context.favoriteKeys?.has(item.favoriteKey) || context.favoriteKeys?.has(legacyFavoriteKey)),
    directoryId: NETWORK_DIRECTORY_ID,
    directoryName: NETWORK_DIRECTORY_NAME,
    thumbnailUrl: `/v1/network-resources/${encodeURIComponent(item.id)}/thumbnail`,
    thumbnailToken: '',
    streamUrl: `/v1/network-resources/${encodeURIComponent(item.id)}/stream`,
    media: null,
    network: {
      site: item.site,
      episodeIndex: item.episodeIndex,
      episodeTitle: item.episodeTitle,
      parser: item.parser,
      kind: item.kind
    }
  }
}

function isPlaylistResponse(targetUrl, headers = {}) {
  const contentType = String(headers['content-type'] || '').toLowerCase()
  const extension = getUrlExtension(targetUrl)
  return contentType.includes('mpegurl') || extension === '.m3u8' || extension === '.m3u'
}

function toAbsolutePlaylistUrl(value, baseUrl) {
  try {
    return new URL(String(value || '').trim(), baseUrl).toString()
  } catch {
    return value
  }
}

function encodeProxyTarget(targetUrl) {
  return Buffer.from(String(targetUrl || ''), 'utf8').toString('base64url')
}

function decodeProxyTarget(value) {
  try {
    return Buffer.from(String(value || ''), 'base64url').toString('utf8')
  } catch {
    return ''
  }
}

function getNetworkProxyToken(networkId, targetUrl, accessToken) {
  return createBoundScopedToken('network-proxy', `${networkId}\n${targetUrl}`, accessToken, NETWORK_PROXY_TOKEN_TTL_MS)
}

function createNetworkProxyTokenFactory(networkId, networkToken) {
  const [tokenHash, expiresAtText] = String(networkToken || '').split('.')
  const expiresAt = Number(expiresAtText)
  if (!tokenHash || !Number.isFinite(expiresAt) || expiresAt < Date.now()) return null
  return (targetUrl) => {
    const signature = signScopedToken('network-proxy', `${networkId}\n${targetUrl}\n${tokenHash}`, expiresAt)
    return `${tokenHash}.${expiresAt}.${signature}`
  }
}

function createProxyPath(networkId, targetUrl, options = {}) {
  const token = options.accessToken
    ? getNetworkProxyToken(networkId, targetUrl, options.accessToken)
    : typeof options.networkTokenFactory === 'function'
      ? options.networkTokenFactory(targetUrl)
    : options.networkToken || ''
  return `/v1/network-resources/${encodeURIComponent(networkId)}/proxy?target=${encodeURIComponent(encodeProxyTarget(targetUrl))}&networkToken=${encodeURIComponent(token)}`
}

function createCheckedProxyPath(networkId, targetUrl, baseUrl, options = {}) {
  if (!isAllowedPlaylistTarget(targetUrl, baseUrl, options)) {
    throw Object.assign(new Error('播放列表包含不受信任的跨站资源，已停止代理'), {
      status: 403,
      code: 'network_proxy_cross_site_blocked'
    })
  }
  return createProxyPath(networkId, targetUrl, options)
}

function rewritePlaylistLine(line, baseUrl, networkId, proxyOptions) {
  if (!line || line.startsWith('#EXT-X-KEY') || line.startsWith('#EXT-X-MAP') || line.startsWith('#EXT-X-MEDIA')) {
    return line.replace(/URI="([^"]+)"/g, (_match, uri) => {
      const targetUrl = toAbsolutePlaylistUrl(uri, baseUrl)
      return `URI="${createCheckedProxyPath(networkId, targetUrl, baseUrl, proxyOptions)}"`
    })
  }
  if (line.startsWith('#')) return line
  const targetUrl = toAbsolutePlaylistUrl(line, baseUrl)
  return createCheckedProxyPath(networkId, targetUrl, baseUrl, proxyOptions)
}

async function rewriteM3u8Playlist(text, baseUrl, networkId, proxyOptions, signal) {
  const input = String(text || '')
  let lineCount = 1
  for (const _match of input.matchAll(/\n/g)) {
    if (++lineCount > 10000) throw Object.assign(new Error('播放列表条目过多'), { status: 502, code: 'network_playlist_too_large' })
  }
  const result = [], lines = input.split(/\r?\n/)
  let bytes = 0
  for (let index = 0; index < lines.length; index++) {
    if (signal.aborted) throw signal.reason
    const line = rewritePlaylistLine(lines[index].trim(), baseUrl, networkId, proxyOptions)
    bytes += Buffer.byteLength(line, 'utf8') + 1
    if (bytes > 10 * 1024 * 1024) throw Object.assign(new Error('改写后的播放列表过大'), { status: 502, code: 'network_playlist_too_large' })
    result.push(line)
    if (index % 128 === 127) await new Promise(resolve => setImmediate(resolve))
  }
  return result.join('\n')
}

async function resolveNetworkPlayback(item, options = {}) {
  if (
    item.playbackUrl ||
    item.kind !== 'webpage' ||
    NETWORK_VIDEO_EXTENSIONS.has(getUrlExtension(item.url))
  ) {
    const url = item.playbackUrl || item.url
    // 网页类资源（含升级前已持久化的存量数据）的播放地址可能来自解析器，禁止公网网页指向内网。
    // 用户显式添加的局域网网页（item.url 本身是内网）与 direct 直链（NAS）放行。
    if (item.kind === 'webpage') {
      assertResolvedTargetPublic(item.url, url, '网页资源的播放地址指向本地或内网，已停止代理')
    }
    return {
      url,
      httpHeaders: item.httpHeaders
    }
  }

  // 解析路径与桌面端 IPC 收敛到同一实现（enrichNetworkResource）：
  // 包含网页解析、播放地址/剧集逐条 SSRF 校验与 httpHeaders 规整。
  let resolved
  try {
    resolved = await enrichNetworkResource(item, options)
  } catch (err) {
    if (typeof err?.message === 'string' && err.message.includes(WEBPAGE_SSRF_GUARD_HINT)) {
      throw Object.assign(err, { status: 403, code: 'network_webpage_ssrf_blocked' })
    }
    throw err
  }
  const playbackUrl = normalizeUrl(resolved?.playbackUrl)
  if (!playbackUrl) {
    throw Object.assign(new Error('该网页资源需要在电脑端内置网页中观看'), {
      status: 422,
      code: 'network_webview_required'
    })
  }
  return {
    url: playbackUrl,
    httpHeaders: normalizeHttpHeaders(resolved.httpHeaders) || item.httpHeaders
  }
}

async function pipeNetworkResponse(req, res, targetUrl, playbackHeaders, options = {}) {
  const controller = new AbortController(), signal = controller.signal
  const untrack = trackNetworkStream(req.remoteServer, controller)
  const releasePressure = req.method === 'HEAD' ? () => {} : acquireRemoteStream()
  const startedAt = Date.now()
  let upstream, response, deadline
  const networkError = (code, message, status = 502) => Object.assign(new Error(message), { code, status })
  const disconnect = () => controller.abort(networkError('network_request_cancelled', '网络播放请求已断开', 499))
  const responseClosed = () => { if (!res.writableFinished) disconnect() }
  const abortIO = () => {
    upstream?.destroy(signal.reason); response?.destroy(signal.reason)
    if (res.headersSent && !res.writableFinished) res.destroy()
  }
  const waitClosed = stream => !stream || stream.closed ? Promise.resolve() : new Promise(resolve => stream.once('close', resolve))
  const closeUpstream = async () => {
    const pending = [waitClosed(upstream), waitClosed(response)]
    if (response && !response.closed) response.destroy()
    if (upstream && !upstream.closed) upstream.destroy()
    await Promise.all(pending)
    upstream = null; response = null
  }
  const armDeadline = milliseconds => {
    clearTimeout(deadline)
    deadline = setTimeout(() => controller.abort(networkError('network_request_timeout', '网络资源请求超过等待时限', 504)), Math.max(1, milliseconds))
    deadline.unref?.()
  }
  req.once('aborted', disconnect); res.once('close', responseClosed)
  signal.addEventListener('abort', abortIO, { once: true })
  armDeadline(options.headerTimeoutMs || 15000)
  try {
    if (req.aborted || res.destroyed) disconnect()
    let redirects = 0, ignoreRange = false
    while (true) {
      if (signal.aborted) throw signal.reason
      let parsed
      try { parsed = new URL(targetUrl) } catch { throw networkError('invalid_network_url', '网络资源地址无效', 400) }
      const headers = { 'user-agent': playbackHeaders?.userAgent || DEFAULT_BROWSER_UA, accept: req.headers.accept || '*/*' }
      if (playbackHeaders?.referer) headers.referer = playbackHeaders.referer
      if (req.headers.range && !ignoreRange && !['.m3u8', '.m3u'].includes(getUrlExtension(targetUrl))) headers.range = req.headers.range
      response = await new Promise((resolve, reject) => {
        const client = parsed.protocol === 'http:' ? http : https
        const request = client.request(parsed, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers,
          signal, timeout: 15000, highWaterMark: 256 * 1024 }, incoming => {
          incoming.on('error', () => {})
          resolve(incoming)
        })
        upstream = request
        request.once('timeout', () => { if (upstream === request) controller.abort(networkError('network_idle_timeout', '网络资源读取超时', 504)) })
        request.on('error', reject)
        request.end()
      })
      const status = Number(response.statusCode || 0), location = response.headers.location
      if ([301, 302, 303, 307, 308].includes(status) && location) {
        if (++redirects > MAX_REDIRECTS) throw networkError('network_redirect_limit', '网络资源重定向次数过多')
        const nextUrl = toAbsolutePlaylistUrl(location, targetUrl)
        if (!isAllowedPlaylistTarget(nextUrl, targetUrl, options)) throw networkError('network_redirect_blocked', '网络资源重定向到不受信任的地址', 403)
        await closeUpstream(); targetUrl = nextUrl
        continue
      }
      if (status < 200 || status >= 300) throw networkError('network_upstream_failed', '网络资源请求失败：HTTP ' + (status || '未知'))
      const playlist = isPlaylistResponse(targetUrl, response.headers) && req.method !== 'HEAD'
      if (playlist && status === 206) {
        if (ignoreRange || !headers.range) throw networkError('network_playlist_partial', '上游返回了不完整的播放列表')
        await closeUpstream(); ignoreRange = true; continue
      }
      clearTimeout(deadline)
      if (playlist) armDeadline((options.playlistTimeoutMs || 30000) - (Date.now() - startedAt))
      const beforeHeaders = async () => {
        if (signal.aborted) throw signal.reason
        if (options.beforeHeaders && !await options.beforeHeaders()) return false
        return !res.destroyed && !res.writableEnded
      }
      const outputHeaders = { 'Content-Type': response.headers['content-type'] || getNetworkContentType(targetUrl),
        'Accept-Ranges': playlist ? 'none' : response.headers['accept-ranges'] || 'bytes',
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
      if (response.headers['content-range'] && !playlist) outputHeaders['Content-Range'] = response.headers['content-range']
      if (req.method === 'HEAD') {
        if (response.headers['content-length']) outputHeaders['Content-Length'] = response.headers['content-length']
        if (await beforeHeaders()) { res.writeHead(status, outputHeaders); res.end() }
        return
      }
      if (playlist) {
        if (Number(response.headers['content-length']) > MAX_PLAYLIST_BYTES) throw networkError('network_playlist_too_large', '播放列表过大')
        const chunks = []; let received = 0
        for await (const chunk of response) {
          received += chunk.length
          if (received > MAX_PLAYLIST_BYTES) throw networkError('network_playlist_too_large', '播放列表过大')
          chunks.push(chunk)
        }
        const text = await rewriteM3u8Playlist(Buffer.concat(chunks).toString('utf8'), targetUrl, options.networkId, options, signal)
        const body = Buffer.from(text, 'utf8')
        if (await beforeHeaders()) {
          res.writeHead(status, { ...outputHeaders, 'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8', 'Content-Length': body.length })
          res.end(body)
        }
      } else {
        if (response.headers['content-length']) outputHeaders['Content-Length'] = response.headers['content-length']
        if (!await beforeHeaders()) return
        res.writeHead(status, outputHeaders)
        await pipeline(response, res, { signal })
      }
      return
    }
  } catch (error) {
    if (req.aborted || res.destroyed || res.writableEnded) return
    if (res.headersSent) { res.destroy(); return }
    throw signal.aborted ? signal.reason : error
  } finally {
    clearTimeout(deadline)
    await closeUpstream()
    req.off('aborted', disconnect); res.off('close', responseClosed); signal.removeEventListener('abort', abortIO)
    releasePressure(); untrack()
  }
}

function getNetworkContentType(targetUrl) {
  const extension = getUrlExtension(targetUrl)
  if (extension === '.m3u8' || extension === '.m3u') return 'application/vnd.apple.mpegurl'
  if (extension === '.mpd') return 'application/dash+xml'
  if (NETWORK_VIDEO_EXTENSIONS.has(extension)) {
    if (extension === '.mp4' || extension === '.m4v') return 'video/mp4'
    if (extension === '.webm') return 'video/webm'
    if (extension === '.ts') return 'video/mp2t'
  }
  return 'application/octet-stream'
}

function createNetworkResourceHandlers({ getRequestToken, allowLegacyToken, authorizeNetwork, headerTimeoutMs, playlistTimeoutMs } = {}) {
  async function handleNetworkThumbnail(req, res) {
    sendError(req, res, 404, 'network_thumbnail_not_found', '网络资源暂无缩略图')
  }

  async function handleNetworkStream(req, res, networkId, requestUrl) {
    const item = getRemoteNetworkItemById(networkId)
    if (!item) {
      sendError(req, res, 404, 'network_resource_not_found', '网络资源不存在')
      return
    }
    await withNetworkProxySlot(networkId, async () => {
      const controller = new AbortController(), untrack = trackNetworkStream(req.remoteServer, controller)
      const abort = () => controller.abort(networkError('network_request_cancelled', '网络播放准备已取消', 499))
      const closed = () => { if (!res.writableFinished) abort() }
      req.once('aborted', abort); res.once('close', closed)
      let playback
      try {
        if (req.aborted || res.destroyed) abort()
        playback = await resolveNetworkPlayback(item, { signal: controller.signal })
        if (controller.signal.aborted) throw controller.signal.reason
      } catch (error) {
        if (controller.signal.aborted) { if (!res.destroyed) res.destroy(); return }
        throw error
      } finally { untrack(); req.off('aborted', abort); res.off('close', closed) }
      if (req.aborted || res.destroyed) return
      if (authorizeNetwork && !await authorizeNetwork(req, res, requestUrl)) return
      const current = getRemoteNetworkItemById(networkId)
      if (!current || current.url !== item.url) throw networkError('network_resource_not_found', '网络资源已移除或改变', 404)
      const accessToken = typeof getRequestToken === 'function' ? getRequestToken(req, requestUrl, false) : ''
      await pipeNetworkResponse(req, res, playback.url, playback.httpHeaders, {
      networkId, accessToken, headerTimeoutMs, playlistTimeoutMs,
      beforeHeaders: () => {
        if (getRemoteNetworkItemById(networkId)?.url !== item.url) throw Object.assign(new Error('网络资源已移除或改变'), { status: 404, code: 'network_resource_not_found' })
        return !authorizeNetwork || authorizeNetwork(req, res, requestUrl)
      }
      })
    })
  }

  async function handleNetworkProxy(req, res, networkId, requestUrl) {
    await refreshIdentity()
    if (req.aborted || res.destroyed || res.writableEnded) return
    const item = getRemoteNetworkItemById(networkId)
    if (!item) {
      sendError(req, res, 404, 'network_resource_not_found', '网络资源不存在')
      return
    }

    const targetUrl = normalizeUrl(decodeProxyTarget(requestUrl.searchParams.get('target')))
    const networkToken = requestUrl.searchParams.get('networkToken') || ''
    if (!targetUrl || !verifyBoundScopedToken('network-proxy', `${networkId}\n${targetUrl}`, networkToken, {
      allowLegacyToken: typeof allowLegacyToken === 'function' ? allowLegacyToken() : false
    })) {
      sendError(req, res, 401, 'unauthorized', '网络资源代理未授权')
      return
    }

    const networkTokenFactory = createNetworkProxyTokenFactory(networkId, networkToken)
    await withNetworkProxySlot(networkId, () => pipeNetworkResponse(req, res, targetUrl, item.httpHeaders, {
      networkId,
      networkToken,
      networkTokenFactory, headerTimeoutMs, playlistTimeoutMs,
      beforeHeaders: async () => {
        await refreshIdentity()
        if (!getRemoteNetworkItemById(networkId)) throw Object.assign(new Error('网络资源已移除'), { status: 404, code: 'network_resource_not_found' })
        if (!verifyBoundScopedToken('network-proxy', networkId + '\n' + targetUrl, networkToken,
          { allowLegacyToken: typeof allowLegacyToken === 'function' ? allowLegacyToken() : false })) {
          throw Object.assign(new Error('网络播放授权已失效'), { status: 401, code: 'unauthorized' })
        }
        return true
      }
    }))
  }

  return {
    handleNetworkThumbnail,
    handleNetworkProxy,
    handleNetworkStream
  }
}

module.exports = {
  getNetworkProxyDiagnostics: () => ({ active: activeNetworkProxyRequests.total, resources: activeNetworkProxyRequests.byNetworkId.size }),
  isAllowedPlaylistTarget,
  NETWORK_DIRECTORY_ID,
  NETWORK_DIRECTORY_NAME,
  createNetworkResourceHandlers,
  getNetworkFavoriteKey,
  getLegacyNetworkFavoriteKey,
  getRemoteNetworkItemById,
  listRemoteNetworkItems,
  toRemoteNetworkVideo
}
