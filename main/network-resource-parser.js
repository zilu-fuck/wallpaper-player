const http = require('http')
const https = require('https')
const { parseWithYtDlp } = require('./ytdlp-service')

const DEFAULT_TIMEOUT_MS = 12000
const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024
const MAX_REDIRECTS = 4
const MAX_EPISODES_TO_STORE = 2000
const DEFAULT_BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36'
const DIRECT_MEDIA_EXTENSIONS = new Set([
  '.mp4', '.webm', '.mkv', '.avi', '.mov', '.wmv', '.flv',
  '.m4v', '.mpg', '.mpeg', '.3gp', '.ogv', '.ts', '.vob',
  '.rmvb', '.rm', '.asf', '.divx', '.f4v', '.m3u8', '.m3u', '.mpd'
])

function toAbsoluteUrl(value, baseUrl) {
  if (!value) return ''
  try {
    return new URL(String(value), baseUrl).toString()
  } catch {
    return ''
  }
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim()
}

function stripQueryNoise(url) {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return url
  }
}

function getHostName(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '')
  } catch {
    return ''
  }
}

function getWebpageFallbackTitle(url, html = '') {
  return extractHtmlTitle(html) || getHostName(url) || '网页资源'
}

function createWebpageShellResult(url, options = {}) {
  const parserId = options.parser || 'generic'
  const parserName = options.parserName || '通用网页'
  const title = String(options.title || getWebpageFallbackTitle(url, options.html)).trim() || '网页资源'
  const error = String(options.error || '').trim()
  return {
    parser: parserId,
    parserName,
    title: title.slice(0, 120),
    playbackUrl: '',
    page: {
      site: options.site || getHostName(url) || parserName,
      openMode: 'webview',
      playbackType: 'webpage',
      currentEpisodeTitle: title.slice(0, 120),
      episodeCount: 1,
      episodes: [{
        index: 1,
        title: title.slice(0, 120),
        url
      }],
      lastParseError: error.slice(0, 500)
    }
  }
}

function getUrlExtension(url) {
  try {
    return new URL(url).pathname.toLowerCase().match(/\.[^.\\/]+$/)?.[0] || ''
  } catch {
    return ''
  }
}

function fetchText(url, redirects = 0, options = {}) {
  return new Promise((resolve, reject) => {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      reject(new Error('网页地址无效'))
      return
    }

    const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS)
    const headers = {
      'user-agent': DEFAULT_BROWSER_UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      ...(options.headers && typeof options.headers === 'object' ? options.headers : {})
    }
    const client = parsed.protocol === 'http:' ? http : https
    const request = client.get(parsed, {
      timeout: timeoutMs,
      headers
    }, response => {
      const statusCode = Number(response.statusCode || 0)
      const location = response.headers.location
      if ([301, 302, 303, 307, 308].includes(statusCode) && location) {
        response.resume()
        if (redirects >= MAX_REDIRECTS) {
          reject(new Error('网页重定向次数过多'))
          return
        }
        fetchText(toAbsoluteUrl(location, url), redirects + 1, options).then(resolve, reject)
        return
      }

      if (statusCode < 200 || statusCode >= 300) {
        response.resume()
        reject(new Error(`网页请求失败：HTTP ${statusCode || '未知'}`))
        return
      }

      const contentLength = Number(response.headers['content-length'] || 0)
      const maxBodyBytes = Number(options.maxBodyBytes || DEFAULT_MAX_BODY_BYTES)
      if (contentLength > maxBodyBytes) {
        response.resume()
        reject(new Error('网页内容过大，已停止解析'))
        return
      }

      const chunks = []
      let received = 0
      response.on('data', chunk => {
        received += chunk.length
        if (received > maxBodyBytes) {
          request.destroy(new Error('网页内容过大，已停止解析'))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    })

    request.on('timeout', () => {
      request.destroy(new Error('网页解析超时'))
    })
    request.on('error', reject)
  })
}

async function fetchJson(url, options) {
  const text = await fetchText(url, 0, options)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('接口返回不是有效 JSON')
  }
}

function extractHtmlTitle(html) {
  const ogTitle = String(html || '').match(/<meta\b[^>]*(?:property|name)=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/i)?.[1]
  const title = ogTitle || String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
  return decodeHtmlEntities(String(title || '').replace(/\s+/g, ' '))
}

function collectJsonValues(value, keys, results = []) {
  if (!value || typeof value !== 'object') return results
  if (Array.isArray(value)) {
    value.forEach(item => collectJsonValues(item, keys, results))
    return results
  }
  for (const [key, item] of Object.entries(value)) {
    if (keys.has(key) && typeof item === 'string') {
      results.push(item)
    } else {
      collectJsonValues(item, keys, results)
    }
  }
  return results
}

function addCandidate(candidates, seen, value, pageUrl) {
  const decoded = decodeHtmlEntities(String(value || '')
    .replace(/\\\//g, '/')
    .replace(/\\u002F/gi, '/')
    .replace(/\\u0026/gi, '&')
    .trim())
  if (!decoded || decoded.startsWith('blob:') || decoded.startsWith('data:')) return
  const absolute = stripQueryNoise(toAbsoluteUrl(decoded, pageUrl))
  if (!absolute || seen.has(absolute)) return
  try {
    const parsed = new URL(absolute)
    const path = parsed.pathname.toLowerCase()
    const looksPlayable = (
      /\.(m3u8|mp4|webm|mkv|mov|avi|flv|m4v|mpd)(?:$|[?#])/i.test(`${parsed.pathname}${parsed.search}`) ||
      path.endsWith('.m3u8') ||
      path.endsWith('.mpd')
    )
    if (!looksPlayable) return
  } catch {
    return
  }
  seen.add(absolute)
  candidates.push(absolute)
}

function extractGenericMediaUrls(html, pageUrl) {
  const candidates = []
  const seen = new Set()
  const text = String(html || '')

  const tagPattern = /<(?:video|source)\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi
  let tagMatch
  while ((tagMatch = tagPattern.exec(text))) {
    addCandidate(candidates, seen, tagMatch[1], pageUrl)
  }

  const jsonPattern = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let jsonMatch
  while ((jsonMatch = jsonPattern.exec(text))) {
    try {
      const payload = JSON.parse(decodeHtmlEntities(jsonMatch[1]))
      const values = collectJsonValues(payload, new Set(['contentUrl', 'embedUrl', 'url']))
      values.forEach(value => addCandidate(candidates, seen, value, pageUrl))
    } catch {}
  }

  const urlPattern = /(?:https?:)?\/\/[^"' <>()\\]+?\.(?:m3u8|mp4|webm|mkv|mov|avi|flv|m4v|mpd)(?:\?[^"' <>()\\]*)?/gi
  let urlMatch
  while ((urlMatch = urlPattern.exec(text))) {
    const value = urlMatch[0].startsWith('//') ? `https:${urlMatch[0]}` : urlMatch[0]
    addCandidate(candidates, seen, value, pageUrl)
  }

  const quotedPathPattern = /["']([^"']+\.(?:m3u8|mp4|webm|mkv|mov|avi|flv|m4v|mpd)(?:\?[^"']*)?)["']/gi
  let pathMatch
  while ((pathMatch = quotedPathPattern.exec(text))) {
    addCandidate(candidates, seen, pathMatch[1], pageUrl)
  }

  return candidates
}

function extractPlayerObject(html) {
  const match = String(html || '').match(/var\s+player_aaaa\s*=\s*(\{[\s\S]*?\})\s*<\/script>/)
  if (!match) return null
  try {
    return JSON.parse(match[1])
  } catch {
    return null
  }
}

function getBilibiliBvid(url) {
  try {
    const parsed = new URL(url)
    const match = parsed.pathname.match(/\/video\/(BV[a-zA-Z0-9]+)/)
    return match?.[1] || ''
  } catch {
    return ''
  }
}

function getBilibiliPageIndex(url) {
  try {
    const parsed = new URL(url)
    const value = Number(parsed.searchParams.get('p') || 1)
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 1
  } catch {
    return 1
  }
}

function getTwitterStatusId(url) {
  try {
    const parsed = new URL(url)
    if (!/(^|\.)x\.com$/i.test(parsed.hostname) && !/(^|\.)twitter\.com$/i.test(parsed.hostname)) {
      return ''
    }
    return parsed.pathname.match(/\/status(?:es)?\/(\d+)/i)?.[1] || ''
  } catch {
    return ''
  }
}

function collectTwitterVideoVariants(value, results = []) {
  if (!value || typeof value !== 'object') return results
  if (Array.isArray(value)) {
    value.forEach(item => collectTwitterVideoVariants(item, results))
    return results
  }

  const url = typeof value.url === 'string' ? value.url : ''
  if (url && /\.(?:mp4|m3u8)(?:$|[?#])/i.test(url)) {
    results.push({
      url,
      bitrate: Number(value.bitrate || 0),
      contentType: value.content_type || value.contentType || ''
    })
  }

  Object.values(value).forEach(item => collectTwitterVideoVariants(item, results))
  return results
}

function parseYh5dmEpisodes(html, pageUrl, vodId, sourceId) {
  const episodes = []
  const episodeMap = new Map()
  const linkPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/g
  let match
  while ((match = linkPattern.exec(html))) {
    const [, href, rawTitle] = match
    const url = toAbsoluteUrl(href, pageUrl)
    if (!url) continue
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      continue
    }
    if (parsed.search || parsed.hash) continue
    const episodeMatch = parsed.pathname.match(/^\/p\/(\d+)-(\d+)-(\d+)\.html$/i)
    if (!episodeMatch) continue
    const [, matchedVodId, matchedSourceId, episodeIndex] = episodeMatch
    if (String(matchedVodId) !== String(vodId) || String(matchedSourceId) !== String(sourceId)) continue
    const cleanTitle = decodeHtmlEntities(rawTitle.replace(/<[^>]+>/g, '')) || `第${episodeIndex}集`
    const previous = episodeMap.get(url)
    if (!previous || (/^第.+集$/.test(cleanTitle) && !/^第.+集$/.test(previous.title))) {
      episodeMap.set(url, {
        index: Number(episodeIndex),
        title: cleanTitle,
        url
      })
    }
  }
  episodes.push(...episodeMap.values())
  episodes.sort((a, b) => a.index - b.index)
  return episodes
}

const yh5dmParser = {
  id: 'yh5dm',
  name: '樱花动漫',
  supports(url) {
    try {
      const parsed = new URL(url)
      return /(^|\.)yh5dm\.cc$/i.test(parsed.hostname) && /^\/p\/\d+-\d+-\d+\.html$/i.test(parsed.pathname)
    } catch {
      return false
    }
  },
  async parse(url) {
    const html = await fetchText(url)
    const player = extractPlayerObject(html)
    if (!player?.url) {
      throw new Error('未找到网页中的播放地址')
    }

    const vodId = player.id || player.vod_data?.vod_id || ''
    const sourceId = player.sid || ''
    const episodeIndex = Number(player.nid || 0)
    const episodes = vodId && sourceId
      ? parseYh5dmEpisodes(html, url, vodId, sourceId)
      : []
    const currentEpisode = episodes.find(item => item.index === episodeIndex) || null
    const vodName = decodeHtmlEntities(player.vod_data?.vod_name || '')
    const episodeTitle = currentEpisode?.title || (episodeIndex ? `第${String(episodeIndex).padStart(4, '0')}集` : '')
    const title = [vodName, episodeTitle].filter(Boolean).join(' ')
    const nextPageUrl = toAbsoluteUrl(player.link_next, url)
    const previousPageUrl = toAbsoluteUrl(player.link_pre, url)

    return {
      parser: this.id,
      parserName: this.name,
      title: title || vodName || episodeTitle || '网页视频',
      playbackUrl: toAbsoluteUrl(player.url, url),
      nextPlaybackUrl: toAbsoluteUrl(player.url_next, url),
      page: {
        site: this.name,
        vodId: String(vodId || ''),
        sourceId: String(sourceId || ''),
        currentEpisodeIndex: episodeIndex || null,
        currentEpisodeTitle: episodeTitle,
        episodeCount: episodes.length,
        nextPageUrl,
        previousPageUrl,
        episodes: episodes.slice(0, MAX_EPISODES_TO_STORE)
      }
    }
  }
}

const bilibiliParser = {
  id: 'bilibili',
  name: '哔哩哔哩',
  supports(url) {
    try {
      const parsed = new URL(url)
      return /(^|\.)bilibili\.com$/i.test(parsed.hostname) && Boolean(getBilibiliBvid(url))
    } catch {
      return false
    }
  },
  async parse(url) {
    const bvid = getBilibiliBvid(url)
    if (!bvid) throw new Error('未识别到 B 站视频 BV 号')

    const view = await fetchJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`)
    if (view?.code !== 0 || !view?.data?.cid) {
      throw new Error(view?.message || 'B 站视频信息解析失败')
    }

    const pages = Array.isArray(view.data.pages) && view.data.pages.length > 0
      ? view.data.pages
      : [{ cid: view.data.cid, page: 1, part: view.data.title || 'P1' }]
    const pageIndex = getBilibiliPageIndex(url)
    const currentPage = pages.find(page => Number(page.page) === pageIndex) || pages[0]
    const cid = currentPage?.cid || view.data.cid
    const play = await fetchJson(`https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}&fnval=0&qn=16&platform=html5`)
    const playbackUrl = play?.data?.durl?.[0]?.url || ''
    if (play?.code !== 0 || !playbackUrl) {
      throw new Error(play?.message || 'B 站播放地址解析失败')
    }

    const title = decodeHtmlEntities(view.data.title || '') || bvid
    const origin = new URL(url).origin
    return {
      parser: this.id,
      parserName: this.name,
      title,
      playbackUrl,
      httpHeaders: {
        referer: 'https://www.bilibili.com/',
        userAgent: DEFAULT_BROWSER_UA
      },
      page: {
        site: this.name,
        vodId: bvid,
        sourceId: 'html5',
        currentEpisodeIndex: Number(currentPage?.page || pageIndex),
        currentEpisodeTitle: currentPage?.part || title,
        episodeCount: pages.length,
        episodes: pages.slice(0, MAX_EPISODES_TO_STORE).map((page, index) => ({
          index: Number(page.page || index + 1),
          title: page.part || `${title} P${index + 1}`,
          url: `${origin}/video/${bvid}?p=${Number(page.page || index + 1)}`
        }))
      }
    }
  }
}

const twitterParser = {
  id: 'twitter',
  name: 'X / Twitter',
  supports(url) {
    return Boolean(getTwitterStatusId(url))
  },
  async parse(url) {
    const statusId = getTwitterStatusId(url)
    if (!statusId) {
      throw new Error('未识别到 X / Twitter 状态 ID')
    }

    try {
      return await parseWithYtDlp(url, {
        parser: this.id,
        parserName: this.name,
        siteName: this.name
      })
    } catch (ytDlpError) {
      if (!/未检测到 yt-dlp/i.test(ytDlpError.message)) {
        throw new Error(`X / Twitter 暂时无法解析：${ytDlpError.message}`)
      }
    }

    let payload
    try {
      payload = await fetchJson(
        `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(statusId)}&lang=zh-cn`,
        {
          timeoutMs: 6000,
          headers: {
            accept: 'application/json,text/plain,*/*',
            referer: 'https://platform.twitter.com/'
          }
        }
      )
    } catch (err) {
      throw new Error(`X / Twitter 暂时无法解析：当前网络或站点限制无法访问公开视频接口（${err.message}）`)
    }

    const variants = collectTwitterVideoVariants(payload)
      .filter(item => item.url)
      .sort((a, b) => b.bitrate - a.bitrate)
    const playbackUrl = variants[0]?.url || ''
    if (!playbackUrl) {
      throw new Error('X / Twitter 暂未找到可直接播放的视频地址，可能需要登录态或专用解析后端')
    }

    const title = decodeHtmlEntities(payload?.text || payload?.tweet?.text || '') ||
      `X / Twitter ${statusId}`
    return {
      parser: this.id,
      parserName: this.name,
      title: title.slice(0, 120),
      playbackUrl,
      httpHeaders: {
        referer: 'https://x.com/',
        userAgent: DEFAULT_BROWSER_UA
      },
      page: {
        site: this.name,
        vodId: statusId,
        currentEpisodeTitle: title.slice(0, 120),
        episodeCount: variants.length,
        episodes: variants.slice(0, MAX_EPISODES_TO_STORE).map((variant, index) => ({
          index: index + 1,
          title: variants.length > 1 ? `${title.slice(0, 90)} · 源 ${index + 1}` : title.slice(0, 120),
          url,
          playbackUrl: variant.url
        }))
      }
    }
  }
}

const genericParser = {
  id: 'generic',
  name: '通用网页',
  supports(url) {
    try {
      const parsed = new URL(url)
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        !DIRECT_MEDIA_EXTENSIONS.has(getUrlExtension(url))
    } catch {
      return false
    }
  },
  async parse(url) {
    let html = ''
    try {
      html = await fetchText(url)
    } catch (fetchError) {
      try {
        return await parseWithYtDlp(url, {
          parser: this.id,
          parserName: this.name,
          siteName: getHostName(url) || this.name,
          timeoutMs: 18000
        })
      } catch (ytDlpError) {
        throw new Error(`网页请求失败：${fetchError.message}；yt-dlp 也未解析成功：${ytDlpError.message}`)
      }
    }
    const mediaUrls = extractGenericMediaUrls(html, url)
    if (mediaUrls.length === 0) {
      try {
        return await parseWithYtDlp(url, {
          parser: this.id,
          parserName: this.name,
          siteName: getHostName(url) || this.name,
          timeoutMs: 18000
        })
      } catch (err) {
        return createWebpageShellResult(url, {
          parser: this.id,
          parserName: this.name,
          site: getHostName(url) || this.name,
          title: getWebpageFallbackTitle(url, html),
          html,
          error: `未找到可直接播放的视频地址；yt-dlp 也未解析成功：${err.message}`
        })
      }
    }

    const title = extractHtmlTitle(html) || getHostName(url) || '网页视频'
    return {
      parser: this.id,
      parserName: this.name,
      title,
      playbackUrl: mediaUrls[0],
      page: {
        site: getHostName(url) || this.name,
        currentEpisodeTitle: title,
        episodeCount: mediaUrls.length,
        episodes: mediaUrls.slice(0, MAX_EPISODES_TO_STORE).map((mediaUrl, index) => ({
          index: index + 1,
          title: mediaUrls.length > 1 ? `${title} · 源 ${index + 1}` : title,
          url,
          playbackUrl: mediaUrl
        }))
      }
    }
  }
}

const parsers = [yh5dmParser, bilibiliParser, twitterParser, genericParser]

function getParserForUrl(url) {
  return parsers.find(parser => parser.supports(url)) || null
}

async function parseNetworkResourcePage(url) {
  const parser = getParserForUrl(url)
  if (!parser) {
    throw new Error('暂不支持解析该网页资源')
  }
  try {
    return await parser.parse(url)
  } catch (err) {
    return createWebpageShellResult(url, {
      parser: parser.id,
      parserName: parser.name,
      site: getHostName(url) || parser.name,
      error: err?.message || '网页资源解析失败'
    })
  }
}

module.exports = {
  getParserForUrl,
  parseNetworkResourcePage
}
