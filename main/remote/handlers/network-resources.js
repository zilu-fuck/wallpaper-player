const crypto = require('crypto')
const http = require('http')
const https = require('https')
const { NETWORK_VIDEO_EXTENSIONS } = require('../../constants')
const { loadSettings } = require('../../settings')
const { parseNetworkResourcePage } = require('../../network-resource-parser')
const { sendError } = require('../http-utils')
const { createBoundScopedToken, signScopedToken, verifyBoundScopedToken } = require('../identity')

const NETWORK_DIRECTORY_ID = 'network_resources'
const NETWORK_DIRECTORY_NAME = '网络资源'
const DEFAULT_BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36'
const MAX_REDIRECTS = 4
const MAX_PLAYLIST_BYTES = 5 * 1024 * 1024
const NETWORK_PROXY_TOKEN_TTL_MS = 6 * 60 * 60 * 1000

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

function listRemoteNetworkItems(settings = loadSettings()) {
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

function getRemoteNetworkItemById(id, settings = loadSettings()) {
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

function rewritePlaylistLine(line, baseUrl, networkId, proxyOptions) {
  if (!line || line.startsWith('#EXT-X-KEY') || line.startsWith('#EXT-X-MAP')) {
    return line.replace(/URI="([^"]+)"/g, (_match, uri) => {
      const targetUrl = toAbsolutePlaylistUrl(uri, baseUrl)
      return `URI="${createProxyPath(networkId, targetUrl, proxyOptions)}"`
    })
  }
  if (line.startsWith('#')) return line
  return createProxyPath(networkId, toAbsolutePlaylistUrl(line, baseUrl), proxyOptions)
}

function rewriteM3u8Playlist(text, baseUrl, networkId, proxyOptions) {
  return String(text || '')
    .split(/\r?\n/)
    .map(line => rewritePlaylistLine(line.trim(), baseUrl, networkId, proxyOptions))
    .join('\n')
}

async function resolveNetworkPlayback(item) {
  if (
    item.playbackUrl ||
    item.kind !== 'webpage' ||
    NETWORK_VIDEO_EXTENSIONS.has(getUrlExtension(item.url))
  ) {
    return {
      url: item.playbackUrl || item.url,
      httpHeaders: item.httpHeaders
    }
  }

  const parsed = await parseNetworkResourcePage(item.url)
  const playbackUrl = normalizeUrl(parsed?.playbackUrl)
  if (!playbackUrl) {
    throw Object.assign(new Error('该网页资源需要在电脑端内置网页中观看'), {
      status: 422,
      code: 'network_webview_required'
    })
  }
  return {
    url: playbackUrl,
    httpHeaders: normalizeHttpHeaders(parsed.httpHeaders) || item.httpHeaders
  }
}

function pipeNetworkResponse(req, res, targetUrl, playbackHeaders, options = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    let parsed
    try {
      parsed = new URL(targetUrl)
    } catch {
      reject(Object.assign(new Error('网络资源地址无效'), { status: 400, code: 'invalid_network_url' }))
      return
    }

    const headers = {
      'user-agent': playbackHeaders?.userAgent || DEFAULT_BROWSER_UA,
      accept: req.headers.accept || '*/*'
    }
    if (playbackHeaders?.referer) headers.referer = playbackHeaders.referer
    if (req.headers.range) headers.range = req.headers.range

    const client = parsed.protocol === 'http:' ? http : https
    const upstream = client.request(parsed, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers,
      timeout: 15000
    }, response => {
      const statusCode = Number(response.statusCode || 0)
      const location = response.headers.location
      if ([301, 302, 303, 307, 308].includes(statusCode) && location) {
        response.resume()
        if (redirects >= MAX_REDIRECTS) {
          reject(Object.assign(new Error('网络资源重定向次数过多'), { status: 502, code: 'network_redirect_limit' }))
          return
        }
        pipeNetworkResponse(req, res, toAbsolutePlaylistUrl(location, targetUrl), playbackHeaders, options, redirects + 1).then(resolve, reject)
        return
      }

      if (statusCode < 200 || statusCode >= 300) {
        response.resume()
        reject(Object.assign(new Error(`网络资源请求失败：HTTP ${statusCode || '未知'}`), {
          status: 502,
          code: 'network_upstream_failed'
        }))
        return
      }

      const headersToSend = {
        'Content-Type': response.headers['content-type'] || getNetworkContentType(targetUrl),
        'Accept-Ranges': response.headers['accept-ranges'] || 'bytes',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      }
      if (response.headers['content-range']) headersToSend['Content-Range'] = response.headers['content-range']

      if (isPlaylistResponse(targetUrl, response.headers) && req.method !== 'HEAD') {
        const chunks = []
        let received = 0
        response.on('data', chunk => {
          received += chunk.length
          if (received > MAX_PLAYLIST_BYTES) {
            upstream.destroy(new Error('播放列表过大，已停止代理'))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          const body = Buffer.from(rewriteM3u8Playlist(
            Buffer.concat(chunks).toString('utf8'),
            targetUrl,
            options.networkId,
            options
          ), 'utf8')
          res.writeHead(statusCode, {
            ...headersToSend,
            'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
            'Content-Length': body.length
          })
          res.end(body)
          resolve()
        })
        return
      }

      if (response.headers['content-length']) headersToSend['Content-Length'] = response.headers['content-length']
      res.writeHead(statusCode, headersToSend)
      if (req.method === 'HEAD') {
        response.resume()
        res.end()
        resolve()
        return
      }
      response.pipe(res)
      response.on('end', resolve)
    })

    upstream.on('timeout', () => upstream.destroy(new Error('网络资源请求超时')))
    upstream.on('error', reject)
    req.on('aborted', () => upstream.destroy())
    upstream.end()
  })
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

function createNetworkResourceHandlers({ getRequestToken, allowLegacyToken } = {}) {
  async function handleNetworkThumbnail(req, res) {
    sendError(req, res, 404, 'network_thumbnail_not_found', '网络资源暂无缩略图')
  }

  async function handleNetworkStream(req, res, networkId, requestUrl) {
    const item = getRemoteNetworkItemById(networkId)
    if (!item) {
      sendError(req, res, 404, 'network_resource_not_found', '网络资源不存在')
      return
    }
    const playback = await resolveNetworkPlayback(item)
    const accessToken = typeof getRequestToken === 'function' ? getRequestToken(req, requestUrl, false) : ''
    await pipeNetworkResponse(req, res, playback.url, playback.httpHeaders, {
      networkId,
      accessToken
    })
  }

  async function handleNetworkProxy(req, res, networkId, requestUrl) {
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
    await pipeNetworkResponse(req, res, targetUrl, item.httpHeaders, {
      networkId,
      networkToken,
      networkTokenFactory
    })
  }

  return {
    handleNetworkThumbnail,
    handleNetworkProxy,
    handleNetworkStream
  }
}

module.exports = {
  NETWORK_DIRECTORY_ID,
  NETWORK_DIRECTORY_NAME,
  createNetworkResourceHandlers,
  getNetworkFavoriteKey,
  getLegacyNetworkFavoriteKey,
  getRemoteNetworkItemById,
  listRemoteNetworkItems,
  toRemoteNetworkVideo
}
