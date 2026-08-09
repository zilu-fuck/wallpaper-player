const path = require('path')
const fsp = require('fs/promises')
const { NETWORK_VIDEO_EXTENSIONS } = require('../constants')
const { isPathInside, pathKey } = require('../paths')
const { assertPublicHttpUrl, assertResolvedTargetPublic } = require('../ip-utils')
const {
  getAllowedDownloadDirectories,
  loadSettings,
  resolvePathForAccess
} = require('../settings')
const { resolveExistingPath } = require('../scanner')
const { getParserForUrl, parseNetworkResourcePage } = require('../network-resource-parser')

const NETWORK_VIDEO_SCHEMES = new Set(['http:', 'https:'])
const STREAM_PLAYLIST_EXTENSIONS = new Set(['.m3u8', '.m3u', '.mpd'])

// SSRF 防线错误消息的统一标识，remote HTTP 层据此把错误映射为 403 响应。
const WEBPAGE_SSRF_GUARD_HINT = '指向本地或内网'

function normalizeNetworkResourceInput(input = {}) {
  const rawUrl = typeof input.url === 'string' ? input.url.trim() : ''
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('网络地址无效')
  }
  if (!NETWORK_VIDEO_SCHEMES.has(parsed.protocol)) {
    throw new Error('仅支持 http/https 视频地址')
  }

  const url = parsed.toString()
  const parser = getParserForUrl(url)
  const extension = path.extname(parsed.pathname || '').toLowerCase()
  if (!parser && extension && !NETWORK_VIDEO_EXTENSIONS.has(extension)) {
    throw new Error('当前链接不是支持的视频格式或可解析网页')
  }

  const fallbackTitle = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '') || parsed.hostname || '网络视频'
  const explicitTitle = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : ''
  return {
    id: typeof input.id === 'string' && input.id.trim()
      ? input.id.trim()
      : Buffer.from(url).toString('base64url'),
    kind: input.kind === 'webpage' || parser ? 'webpage' : 'direct',
    title: (explicitTitle || (parser ? '' : fallbackTitle)).slice(0, 120),
    url,
    playbackUrl: typeof input.playbackUrl === 'string' ? input.playbackUrl.trim() : '',
    httpHeaders: input.httpHeaders && typeof input.httpHeaders === 'object' && !Array.isArray(input.httpHeaders)
      ? input.httpHeaders
      : null,
    parser: typeof input.parser === 'string' && input.parser.trim()
      ? input.parser.trim()
      : (parser?.id || ''),
    page: input.page && typeof input.page === 'object' && !Array.isArray(input.page)
      ? input.page
      : null,
    createdAt: typeof input.createdAt === 'string' && input.createdAt.trim()
      ? input.createdAt.trim()
      : new Date().toISOString()
  }
}

async function enrichNetworkResource(resource) {
  if (resource.kind !== 'webpage') return resource
  const parsed = await parseNetworkResourcePage(resource.url)
  // 解析结果来自不可信远端页面：公网网页解析出内网地址 → SSRF 风险，拒绝持久化。
  // 用户显式添加的局域网网页（resource.url 本身是内网）允许解析内网地址（NAS 场景）。
  assertResolvedTargetPublic(
    resource.url,
    parsed.playbackUrl,
    '网页解析出的播放地址指向本地或内网，请检查网页内容'
  )
  // 剧集展开也会产生独立可播放条目：逐个校验 episodes 的 url/playbackUrl，
  // 防止公网页面把内网媒体地址混入剧集列表绕过顶层校验。
  if (Array.isArray(parsed?.page?.episodes)) {
    for (const episode of parsed.page.episodes) {
      const episodeUrl = typeof episode?.url === 'string' && episode.url.trim() ? episode.url : ''
      const episodePlaybackUrl = typeof episode?.playbackUrl === 'string' && episode.playbackUrl.trim() ? episode.playbackUrl : ''
      assertResolvedTargetPublic(
        resource.url,
        episodeUrl,
        '网页剧集包含指向本地或内网的地址，请检查网页内容'
      )
      assertResolvedTargetPublic(
        resource.url,
        episodePlaybackUrl,
        '网页剧集的播放地址指向本地或内网，请检查网页内容'
      )
    }
  }
  return {
    ...resource,
    title: resource.title || parsed.title,
    playbackUrl: parsed.playbackUrl,
    httpHeaders: parsed.httpHeaders || resource.httpHeaders || null,
    parser: parsed.parser,
    page: parsed.page
  }
}

function isWebpageShellResource(resource) {
  return resource?.kind === 'webpage' &&
    !resource?.playbackUrl &&
    resource?.page?.openMode === 'webview'
}

function normalizeNetworkResourceUrl(value) {
  try {
    return new URL(String(value || '').trim()).toString()
  } catch {
    return ''
  }
}

function normalizeStoredHttpHeaders(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return null
  return {
    referer: typeof headers.referer === 'string' ? headers.referer.trim() : '',
    userAgent: typeof headers.userAgent === 'string' ? headers.userAgent.trim() : ''
  }
}

function getKnownNetworkResource(url, settings = loadSettings()) {
  const target = normalizeNetworkResourceUrl(url).toLowerCase()
  if (!target) return null
  const resource = Array.isArray(settings.networkResources)
    ? settings.networkResources.find(item => String(item?.url || '').trim().toLowerCase() === target)
    : null

  if (resource) {
    return {
      ...resource,
      playbackUrl: '',
      httpHeaders: normalizeStoredHttpHeaders(resource.httpHeaders)
    }
  }

  const resources = Array.isArray(settings.networkResources) ? settings.networkResources : []
  for (const parent of resources) {
    const episodes = Array.isArray(parent?.page?.episodes) ? parent.page.episodes : []
    const episode = episodes.find(item => normalizeNetworkResourceUrl(item?.url).toLowerCase() === target)
    if (!episode) continue
    return {
      ...parent,
      id: `${parent.id || parent.url}:${episode.index || episode.url}`,
      title: episode.title || parent.title || '',
      url: normalizeNetworkResourceUrl(episode.url),
      playbackUrl: '',
      httpHeaders: normalizeStoredHttpHeaders(episode.httpHeaders) || normalizeStoredHttpHeaders(parent.httpHeaders),
      page: {
        ...(parent.page || {}),
        openMode: episode.openMode || parent.page?.openMode || '',
        currentEpisodeIndex: episode.index || null,
        currentEpisodeTitle: episode.title || parent.page?.currentEpisodeTitle || ''
      }
    }
  }

  return null
}

async function resolveNetworkResourcePlayback(resourceOrUrl, options = {}) {
  const resource = typeof resourceOrUrl === 'string'
    ? normalizeNetworkResourceInput({ url: resourceOrUrl, title: options?.title })
    : normalizeNetworkResourceInput(resourceOrUrl)
  const parser = getParserForUrl(resource.url)
  if (resource.kind !== 'webpage' && !parser) {
    return { ...resource, playbackUrl: resource.url }
  }
  return enrichNetworkResource({
    ...resource,
    kind: 'webpage',
    playbackUrl: '',
    parser: resource.parser || parser?.id || ''
  })
}

async function resolveKnownNetworkResourcePlayback(resourceOrUrl, options = {}) {
  const requested = typeof resourceOrUrl === 'string'
    ? normalizeNetworkResourceInput({ url: resourceOrUrl, title: options?.title })
    : normalizeNetworkResourceInput(resourceOrUrl)
  const settings = options.settings || loadSettings()
  const knownResource = getKnownNetworkResource(requested.url, settings)
  if (!knownResource) {
    throw new Error('网络资源未添加到库中')
  }
  return resolveNetworkResourcePlayback(knownResource, { refresh: true })
}

function assertNetworkResourceDownloadable(url) {
  let parsed
  try {
    parsed = new URL(String(url || '').trim())
  } catch {
    throw new Error('网络地址无效')
  }
  const extension = path.extname(parsed.pathname || '').toLowerCase()
  if (STREAM_PLAYLIST_EXTENSIONS.has(extension)) {
    throw new Error('当前下载中心先支持直链视频文件；m3u8/mpd 可以播放，完整离线下载需要后续接入 HLS/DASH 下载流程。')
  }
  assertPublicHttpUrl(parsed.toString(), '为安全起见，下载中心不支持下载本地或内网地址')
}

function isKnownNetworkResource(url, settings = loadSettings()) {
  return Boolean(getKnownNetworkResource(url, settings))
}

async function assertAllowedDownloadDirectory(dirPath) {
  if (typeof dirPath !== 'string' || !dirPath.trim()) {
    throw new Error('请选择保存目录')
  }
  const resolvedPath = await resolveExistingPath(dirPath)
  const stats = await fsp.stat(resolvedPath)
  if (!stats.isDirectory()) {
    throw new Error('保存路径不是目录')
  }

  const allowedDirs = getAllowedDownloadDirectories()
  if (!allowedDirs.some(dir => isPathInside(dir, resolvedPath))) {
    throw new Error('保存目录不在已选择或已添加的视频目录中')
  }
  return resolvedPath
}

function isPersistentLibraryDirectory(dirPath, settings = loadSettings()) {
  const resolvedPath = resolvePathForAccess(dirPath)
  return (settings.directories || []).some(dir => isPathInside(resolvePathForAccess(dir), resolvedPath))
}

module.exports = {
  WEBPAGE_SSRF_GUARD_HINT,
  assertAllowedDownloadDirectory,
  assertNetworkResourceDownloadable,
  enrichNetworkResource,
  isKnownNetworkResource,
  isPersistentLibraryDirectory,
  isWebpageShellResource,
  normalizeNetworkResourceInput,
  resolveKnownNetworkResourcePlayback,
  resolveNetworkResourcePlayback
}
