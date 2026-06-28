const path = require('path')
const { execFile, execFileSync } = require('child_process')
const { promisify } = require('util')
const { getResourcePath, isExistingFile } = require('./paths')

const execFileAsync = promisify(execFile)

const DEFAULT_TIMEOUT_MS = 45000
const DEFAULT_BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36'
const WINDOWS_INTERNET_SETTINGS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
const SUPPORTED_COOKIE_BROWSERS = new Set(['chrome', 'edge', 'firefox'])
const LOCAL_HOSTS = new Set(['localhost', 'localhost.localdomain'])

let detectedYtDlpPath = null
let detectError = ''
let detectPromise = null
let lastProxyState = null

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isPrivateIp(hostname) {
  const value = String(hostname || '').trim().toLowerCase()
  if (!value) return false
  if (LOCAL_HOSTS.has(value)) return true
  if (value === '::1' || value.startsWith('127.')) return true
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!match) return false
  const [a, b] = match.slice(1).map(Number)
  return a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
}

function getHostname(value) {
  try {
    return new URL(String(value || '').trim()).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function wildcardMatches(pattern, hostname) {
  const normalized = String(pattern || '').trim().toLowerCase()
  if (!normalized) return false
  const regex = new RegExp(`^${escapeRegExp(normalized).replace(/\\\*/g, '.*')}$`, 'i')
  return regex.test(hostname)
}

function getCandidatePaths() {
  const exeName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
  return [
    process.env.WALLPAPER_PLAYER_YTDLP,
    getResourcePath('vendor', 'yt-dlp', exeName),
    getResourcePath('vendor', 'yt-dlp', 'yt-dlp.exe'),
    getResourcePath('vendor', 'yt-dlp', 'yt-dlp'),
    getResourcePath('vendor', exeName),
    getResourcePath('vendor', 'yt-dlp.exe'),
    getResourcePath('vendor', 'yt-dlp'),
    exeName,
    'yt-dlp'
  ].filter(Boolean)
}

async function canRunCommand(command) {
  try {
    await execFileAsync(command, ['--version'], {
      timeout: 3000,
      windowsHide: true,
      encoding: 'utf8'
    })
    return true
  } catch {
    return false
  }
}

async function detectYtDlp(refresh = false) {
  if (!refresh && detectedYtDlpPath) return detectedYtDlpPath
  if (detectPromise) return detectPromise

  detectPromise = (async () => {
    detectedYtDlpPath = null
    detectError = ''
    const tried = new Set()

    for (const candidate of getCandidatePaths()) {
      const normalized = String(candidate || '').trim()
      if (!normalized || tried.has(normalized)) continue
      tried.add(normalized)

      const looksLikePath = path.isAbsolute(normalized) || normalized.includes(path.sep) || normalized.includes('/')
      if (looksLikePath) {
        const resolved = path.resolve(normalized)
        if (isExistingFile(resolved)) {
          detectedYtDlpPath = resolved
          return detectedYtDlpPath
        }
        continue
      }

      if (await canRunCommand(normalized)) {
        detectedYtDlpPath = normalized
        return detectedYtDlpPath
      }
    }

    detectError = '未检测到 yt-dlp。请执行 npm run prepare-vendor，或把 yt-dlp 加入 PATH。'
    return null
  })().finally(() => {
    detectPromise = null
  })

  return detectPromise
}

function getProxyFromEnv() {
  const env = process.env
  const value = env.ALL_PROXY || env.all_proxy || env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || ''
  const proxy = normalizeProxyUrl(value)
  return proxy ? { source: 'environment', proxy } : null
}

function queryRegistryValue(name) {
  if (process.platform !== 'win32') return ''
  try {
    const output = execFileSync('reg', ['query', WINDOWS_INTERNET_SETTINGS_KEY, '/v', name], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 1500
    })
    const line = output.split(/\r?\n/).find(item => item.includes(name))
    return line?.replace(/^.*REG_\w+\s+/, '').trim() || ''
  } catch {
    return ''
  }
}

function normalizeProxyUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw
  return `http://${raw}`
}

function pickWindowsProxyServer(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (!raw.includes('=')) return normalizeProxyUrl(raw)

  const entries = Object.fromEntries(raw
    .split(';')
    .map(part => part.split('='))
    .filter(parts => parts.length >= 2)
    .map(([key, ...rest]) => [key.trim().toLowerCase(), rest.join('=').trim()])
    .filter(([, proxy]) => proxy))

  if (entries.https) return normalizeProxyUrl(entries.https)
  if (entries.http) return normalizeProxyUrl(entries.http)
  if (entries.socks) {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(entries.socks)
      ? entries.socks
      : `socks5://${entries.socks}`
  }
  return ''
}

function getWindowsProxy() {
  if (process.platform !== 'win32') return null
  const enabled = /0x1$/i.test(queryRegistryValue('ProxyEnable'))
  if (!enabled) return null
  const proxy = pickWindowsProxyServer(queryRegistryValue('ProxyServer'))
  const override = queryRegistryValue('ProxyOverride')
  return proxy ? { source: 'windows', proxy, override } : null
}

function isBypassedByWindowsOverride(url, override) {
  const hostname = getHostname(url)
  if (!hostname || !override) return false
  return String(override)
    .split(';')
    .map(item => item.trim())
    .filter(Boolean)
    .some(pattern => {
      if (pattern.toLowerCase() === '<local>') {
        return !hostname.includes('.') || isPrivateIp(hostname)
      }
      return wildcardMatches(pattern, hostname)
    })
}

function shouldBypassProxy(url, proxy) {
  const hostname = getHostname(url)
  if (!hostname) return false
  if (isPrivateIp(hostname)) return true
  if (proxy?.source === 'windows' && isBypassedByWindowsOverride(url, proxy.override)) return true
  return false
}

function getSystemProxy(url = '') {
  const proxy = getProxyFromEnv() || getWindowsProxy()
  const bypassed = Boolean(proxy && url && shouldBypassProxy(url, proxy))
  lastProxyState = proxy && !bypassed
    ? { enabled: true, source: proxy.source, proxy: proxy.proxy, bypassed: false }
    : { enabled: false, source: proxy?.source || '', proxy: '', bypassed }
  return lastProxyState
}

function getProcessEnv(proxyState) {
  if (!proxyState?.enabled || !proxyState.proxy) return process.env
  return {
    ...process.env,
    HTTP_PROXY: process.env.HTTP_PROXY || process.env.http_proxy || proxyState.proxy,
    HTTPS_PROXY: process.env.HTTPS_PROXY || process.env.https_proxy || proxyState.proxy,
    ALL_PROXY: process.env.ALL_PROXY || process.env.all_proxy || proxyState.proxy
  }
}

function getCookiesFromBrowser() {
  const browser = String(process.env.WALLPAPER_PLAYER_YTDLP_COOKIES_FROM_BROWSER || '').trim().toLowerCase()
  return SUPPORTED_COOKIE_BROWSERS.has(browser) ? browser : ''
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim())
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function getHeaderValue(headers, key) {
  if (!headers || typeof headers !== 'object') return ''
  const match = Object.entries(headers).find(([name]) => name.toLowerCase() === key.toLowerCase())
  return typeof match?.[1] === 'string' ? match[1].trim() : ''
}

function normalizeHttpHeaders(info, proxyState) {
  const headers = info?.http_headers || info?.httpHeaders || {}
  const referer = getHeaderValue(headers, 'referer') || getHeaderValue(headers, 'referrer')
  const userAgent = getHeaderValue(headers, 'user-agent') || DEFAULT_BROWSER_UA
  return {
    referer,
    userAgent
  }
}

function formatRank(format) {
  const hasVideo = format?.vcodec && format.vcodec !== 'none'
  const hasAudio = format?.acodec && format.acodec !== 'none'
  const extBonus = format?.ext === 'mp4' ? 100000 : 0
  return [
    hasVideo && hasAudio ? 1000000 : 0,
    hasVideo ? 100000 : 0,
    hasAudio ? 10000 : 0,
    extBonus,
    Number(format?.height || 0) * 100,
    Number(format?.tbr || format?.vbr || format?.abr || 0)
  ].reduce((sum, value) => sum + value, 0)
}

function normalizeFormat(format) {
  if (!format?.url || !isHttpUrl(format.url)) return null
  return {
    url: format.url,
    formatId: format.format_id || format.formatId || '',
    ext: format.ext || '',
    protocol: format.protocol || '',
    height: Number(format.height || 0),
    width: Number(format.width || 0),
    fps: Number(format.fps || 0),
    tbr: Number(format.tbr || format.vbr || format.abr || 0),
    vcodec: format.vcodec || '',
    acodec: format.acodec || '',
    rank: formatRank(format)
  }
}

function getFormats(info) {
  const formats = []
  const seen = new Set()

  const push = (format) => {
    const normalized = normalizeFormat(format)
    if (!normalized || seen.has(normalized.url)) return
    seen.add(normalized.url)
    formats.push(normalized)
  }

  if (info?.url) push(info)
  if (Array.isArray(info?.requested_downloads)) info.requested_downloads.forEach(push)
  if (Array.isArray(info?.formats)) info.formats.forEach(push)
  if (Array.isArray(info?.requested_formats)) info.requested_formats.forEach(push)

  return formats.sort((a, b) => b.rank - a.rank)
}

function getSelectedFormat(info) {
  const requested = Array.isArray(info?.requested_downloads)
    ? info.requested_downloads.map(normalizeFormat).find(Boolean)
    : null
  if (requested) return requested

  const direct = normalizeFormat(info)
  if (direct) return direct

  return getFormats(info)[0] || null
}

function getInfoTitle(info, fallbackUrl) {
  if (typeof info?.title === 'string' && info.title.trim()) return info.title.trim()
  if (typeof info?.fulltitle === 'string' && info.fulltitle.trim()) return info.fulltitle.trim()
  try {
    const parsed = new URL(fallbackUrl)
    return parsed.hostname.replace(/^www\./i, '') || '网页视频'
  } catch {
    return '网页视频'
  }
}

function getEpisodeTitle(title, format, index, total) {
  const details = [
    format.height ? `${format.height}p` : '',
    format.ext || '',
    format.formatId ? `#${format.formatId}` : ''
  ].filter(Boolean).join(' · ')
  if (total <= 1) return title
  return details ? `${title} · ${details}` : `${title} · 源 ${index}`
}

function normalizeYtDlpResult(info, url, options = {}, proxyState = getSystemProxy()) {
  const entries = Array.isArray(info?.entries) ? info.entries.filter(Boolean) : []
  const playableEntries = entries
    .map((entry, index) => ({
      entry,
      index,
      selected: getSelectedFormat(entry)
    }))
    .filter(item => item.selected?.url)
  const selected = getSelectedFormat(info) || playableEntries[0]?.selected
  const selectedInfo = getSelectedFormat(info) ? info : (playableEntries[0]?.entry || info)
  if (!selected?.url) {
    throw new Error('yt-dlp 未返回可直接播放的视频地址')
  }

  const title = getInfoTitle(info, url)
  const formats = getFormats(info)
  const httpHeaders = normalizeHttpHeaders(selectedInfo, proxyState)
  const episodeEntries = entries.length > 0
    ? playableEntries.map(({ entry, index, selected: entrySelected }) => {
      const entryTitle = getInfoTitle(entry, url)
      return {
        index: index + 1,
        title: entryTitle,
        url: entry.webpage_url || entry.original_url || url,
        playbackUrl: entrySelected.url,
        httpHeaders: normalizeHttpHeaders(entry, proxyState)
      }
    })
    : formats.slice(0, 24).map((format, index) => ({
      index: index + 1,
      title: getEpisodeTitle(title, format, index + 1, formats.length),
      url,
      playbackUrl: format.url,
      httpHeaders
    }))

  return {
    parser: options.parser || 'yt-dlp',
    parserName: options.parserName || 'yt-dlp',
    title,
    playbackUrl: selected.url,
    httpHeaders,
    page: {
      site: options.siteName || info?.extractor_key || info?.extractor || 'yt-dlp',
      vodId: String(info?.id || ''),
      sourceId: String(info?.extractor_key || info?.extractor || 'yt-dlp'),
      currentEpisodeIndex: null,
      currentEpisodeTitle: title,
      episodeCount: episodeEntries.length || 1,
      episodes: episodeEntries
    }
  }
}

function cleanYtDlpError(err) {
  const output = `${err?.stderr || ''}\n${err?.stdout || ''}`
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && line !== 'null')
    .map(line => line.replace(/^ERROR:\s*/i, ''))
    .slice(-4)
    .join('；')
  return sanitizeErrorMessage(output || err?.message || 'yt-dlp 解析失败')
}

function sanitizeErrorMessage(value) {
  return String(value || '')
    .replace(/https?:\/\/[^\s；]+/gi, '[链接]')
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^@\s；]+@[^/\s；]+/gi, '[代理]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}:\d+\b/g, '[代理]')
    .replace(/\s+/g, ' ')
    .trim()
}

async function parseWithYtDlp(url, options = {}) {
  const ytdlpPath = await detectYtDlp()
  if (!ytdlpPath) {
    throw new Error(detectError || '未检测到 yt-dlp')
  }

  const targetUrl = String(url || '').trim()
  const proxyState = getSystemProxy(targetUrl)
  const args = [
    '--dump-single-json',
    '--no-warnings',
    '--no-playlist',
    '--skip-download',
    '--socket-timeout', '20',
    '--user-agent', DEFAULT_BROWSER_UA,
    '--format', 'best[protocol^=http]/best'
  ]
  if (proxyState.enabled && proxyState.proxy) {
    args.push('--proxy', proxyState.proxy)
  }
  const cookiesFromBrowser = getCookiesFromBrowser()
  if (cookiesFromBrowser) {
    args.push('--cookies-from-browser', cookiesFromBrowser)
  }
  args.push(targetUrl)

  let stdout
  try {
    const result = await execFileAsync(ytdlpPath, args, {
      timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      maxBuffer: 24 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
      env: getProcessEnv(proxyState)
    })
    stdout = result.stdout
  } catch (err) {
    throw new Error(cleanYtDlpError(err))
  }

  let info
  try {
    info = JSON.parse(String(stdout || '').replace(/^\uFEFF/, ''))
  } catch {
    throw new Error('yt-dlp 返回内容不是有效 JSON')
  }

  return normalizeYtDlpResult(info, targetUrl, options, proxyState)
}

function getYtDlpStatus() {
  const proxyState = getSystemProxy()
  return {
    available: Boolean(detectedYtDlpPath),
    path: detectedYtDlpPath,
    error: detectedYtDlpPath ? '' : detectError,
    proxy: {
      enabled: Boolean(proxyState?.enabled),
      source: proxyState?.source || '',
      bypassed: Boolean(proxyState?.bypassed)
    },
    cookiesFromBrowser: getCookiesFromBrowser()
  }
}

module.exports = {
  detectYtDlp,
  getYtDlpStatus,
  getSystemProxy,
  parseWithYtDlp
}
