'use strict'

let playwrightCore = null

function createAbortError() {
  const error = new Error('Search was cancelled')
  error.code = 'TASK_CANCELLED'
  return error
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError()
}

// 等待指定毫秒（替代 Playwright 已弃用的 page.waitForTimeout）
function delay(ms, signal) {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(createAbortError())
      }, { once: true })
    }
  })
}

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
const SEARCH_SOURCE_VERSION = 5

const SEARCH_ENGINES = [
  {
    name: 'bing-rss',
    buildUrl: query => `https://cn.bing.com/search?q=${encodeURIComponent(query)}&format=rss`,
    fetchResults: fetchBingRssResults
  },
  {
    name: 'bing-cn',
    buildUrl: query => `https://cn.bing.com/search?q=${encodeURIComponent(query)}&mkt=zh-CN`,
    extractResults: extractBingResults
  },
  {
    name: 'baidu',
    buildUrl: query => `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&ie=utf-8`,
    extractResults: extractBaiduResults
  },
  {
    name: 'sogou',
    buildUrl: query => `https://www.sogou.com/web?query=${encodeURIComponent(query)}&ie=utf8`,
    extractResults: extractSogouResults
  },
  {
    name: 'startpage',
    buildUrl: query => `https://www.startpage.com/sp/search?query=${encodeURIComponent(query)}&language=zh_CN`,
    extractResults: extractStartpageResults
  },
  {
    name: 'duckduckgo',
    buildUrl: query => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=zh-cn`,
    extractResults: extractDuckDuckGoResults
  }
]

const ANIME_SEARCH_ENGINES = [
  {
    name: 'iwara',
    prepareQuery: query => `${query} site:iwara.tv`,
    fetchResults: fetchBingRssResults,
    resultLimit: 4,
    allowedHosts: ['iwara.tv']
  },
  {
    name: 'pixiv',
    prepareQuery: query => `${query} site:pixiv.net`,
    fetchResults: fetchBingRssResults,
    resultLimit: 4,
    allowedHosts: ['pixiv.net']
  }
]

function getSearchEngines(sourceProfile) {
  if (sourceProfile && typeof sourceProfile === 'object') {
    const trustedEngines = buildTrustedSearchEngines(sourceProfile.trustedSites)
    const baseProfile = sourceProfile.baseProfile
    if (sourceProfile.mode === 'trusted') return trustedEngines
    if (sourceProfile.mode === 'external') {
      if (baseProfile === 'anime') {
        return [
          ...ANIME_SEARCH_ENGINES,
          ...SEARCH_ENGINES
        ]
      }
      return SEARCH_ENGINES
    }
    if (baseProfile === 'anime') {
      return [
        ...trustedEngines,
        ...ANIME_SEARCH_ENGINES,
        ...SEARCH_ENGINES
      ]
    }
    return [
      ...trustedEngines,
      ...SEARCH_ENGINES
    ]
  }
  if (sourceProfile === 'anime') {
    return [
      ...ANIME_SEARCH_ENGINES,
      ...SEARCH_ENGINES
    ]
  }
  return SEARCH_ENGINES
}

function buildTrustedSearchEngines(sites) {
  if (!Array.isArray(sites) || sites.length === 0) return []
  return sites
    .map(normalizeHost)
    .filter(Boolean)
    .map(site => ({
      name: `trusted:${site}`,
      prepareQuery: query => `${query} site:${site}`,
      fetchResults: fetchBingRssResults,
      resultLimit: 8,
      allowedHosts: [site],
      trusted: true
    }))
}

/**
 * Check if playwright-core is available in the current environment.
 * @returns {boolean}
 */
function isAvailable() {
  try {
    require.resolve('playwright-core')
    return true
  } catch (_) {
    return false
  }
}

function _ensurePlaywright() {
  if (!playwrightCore) {
    try {
      playwrightCore = require('playwright-core')
    } catch (e) {
      throw new Error(
        'playwright-core is not installed. ' +
        'Install it with: npm install playwright-core --save-optional ' +
        'or: npx playwright install chromium'
      )
    }
  }
  return playwrightCore
}

/**
 * Launch a headless browser instance.
 * Tries msedge > chrome > chromium.
 * @returns {Promise<object>} browser instance
 */
async function launchBrowser() {
  _ensurePlaywright()

  const pw = playwrightCore
  let browser = null
  let lastError = null

  // Try msedge (Edge)
  try {
    browser = await pw.chromium.launch({
      headless: true,
      channel: 'msedge'
    })
    return browser
  } catch (err) {
    lastError = err
  }

  // Fallback to chrome
  try {
    browser = await pw.chromium.launch({
      headless: true,
      channel: 'chrome'
    })
    return browser
  } catch (err) {
    lastError = err
  }

  // Fallback to generic chromium
  try {
    browser = await pw.chromium.launch({
      headless: true
    })
    return browser
  } catch (err) {
    lastError = err
  }

  throw new Error(
    'Failed to launch any browser. ' +
    'Make sure Chromium-based browser (Edge, Chrome) is installed, ' +
    'or run: npx playwright install chromium. ' +
    `Last error: ${lastError ? lastError.message : 'unknown'}`
  )
}

/**
 * Decode a DuckDuckGo redirect URL to the real target URL.
 * @param {string} redirectUrl
 * @returns {string}
 */
function decodeDuckDuckGoUrl(redirectUrl) {
  if (!redirectUrl) return ''
  try {
    const url = new URL(redirectUrl, 'https://duckduckgo.com')
    const target = url.searchParams.get('uddg')
    if (target) return decodeURIComponent(target)
  } catch (_) {
    // fall through
  }
  return redirectUrl
}

function decodeSearchUrl(rawUrl) {
  if (!rawUrl) return ''
  return decodeDuckDuckGoUrl(rawUrl)
}

function getSiteNameFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch (_) {
    return ''
  }
}

function normalizeHost(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  try {
    const withProtocol = /^[a-z]+:\/\//i.test(text) ? text : `https://${text}`
    return new URL(withProtocol).hostname.replace(/^www\./, '').toLowerCase()
  } catch (_) {
    return text
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .replace(/\/.*$/, '')
      .trim()
      .toLowerCase()
  }
}

function isAllowedHost(url, allowedHosts) {
  if (!Array.isArray(allowedHosts) || allowedHosts.length === 0) return true
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    return allowedHosts.some(host => hostname === host || hostname.endsWith('.' + host))
  } catch (_) {
    return false
  }
}

function normalizeWhitespace(value) {
  return (value || '').replace(/\s+/g, ' ').trim()
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function normalizeSearchResult(rawResult) {
  const url = decodeSearchUrl(rawResult.rawUrl)
  return {
    title: normalizeWhitespace(rawResult.title),
    url,
    snippet: normalizeWhitespace(rawResult.snippet),
    siteName: normalizeWhitespace(rawResult.siteName) || getSiteNameFromUrl(url),
    bodyText: '',
    timestamp: ''
  }
}

const GENERIC_QUERY_TOKENS = new Set([
  'anime',
  'series',
  'season',
  'episode',
  'movie',
  'film',
  'watch',
  'order',
  'guide',
  'list',
  'next',
  'end',
  'the',
  'and',
  'with',
  '动漫',
  '动画',
  '系列',
  '作品',
  '续集',
  '下一季',
  '观看顺序'
])

function tokenizeQuery(query) {
  return String(query || '')
    .toLowerCase()
    .split(/[\s"'()\-_:：,，.。/\\[\]【】]+/)
    .map(token => token.trim())
    .filter(token => token.length >= 3 && !/^\d+$/.test(token))
}

function isRelevantResult(result, queryTokens) {
  if (!queryTokens.length) return true
  const strongTokens = queryTokens.filter(token => !GENERIC_QUERY_TOKENS.has(token))
  const haystack = [
    result.title,
    result.snippet,
    result.siteName,
    result.url
  ].join(' ').toLowerCase()
  if (strongTokens.length > 0) {
    return strongTokens.some(token => haystack.includes(token))
  }
  return queryTokens.filter(token => haystack.includes(token)).length >= Math.min(2, queryTokens.length)
}

async function fetchText(url, timeout, signal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  const abort = () => controller.abort()
  try {
    throwIfAborted(signal)
    signal?.addEventListener('abort', abort, { once: true })
    const response = await fetch(url, {
      headers: { 'User-Agent': DEFAULT_USER_AGENT },
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.text()
  } finally {
    signal?.removeEventListener('abort', abort)
    clearTimeout(timer)
  }
}

async function fetchBingRssResults(query, timeout, options = {}) {
  const xml = await fetchText(`https://cn.bing.com/search?q=${encodeURIComponent(query)}&format=rss`, timeout, options.signal)
  const items = []
  const itemPattern = /<item\b[\s\S]*?<\/item>/gi
  const readTag = (item, tag) => {
    const match = item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
    return decodeHtmlEntities(match ? match[1] : '')
  }
  for (const match of xml.matchAll(itemPattern)) {
    const item = match[0]
    items.push({
      title: readTag(item, 'title'),
      rawUrl: readTag(item, 'link'),
      snippet: readTag(item, 'description'),
      siteName: ''
    })
  }
  return items
}

function extractBingResults() {
  const items = []
  document.querySelectorAll('#b_results .b_algo').forEach((el) => {
    const titleEl = el.querySelector('h2 a')
    if (!titleEl) return

    const snippetEl = el.querySelector('.b_caption p, .b_lineclamp2, p')
    const siteEl = el.querySelector('cite')
    items.push({
      title: titleEl.textContent || '',
      rawUrl: titleEl.href || titleEl.getAttribute('href') || '',
      snippet: snippetEl ? snippetEl.textContent || '' : '',
      siteName: siteEl ? siteEl.textContent || '' : ''
    })
  })
  return items
}

function extractStartpageResults() {
  const items = []
  document.querySelectorAll('a.result-title').forEach((titleEl) => {
    if (!titleEl) return

    const resultEl = titleEl.closest('.result') || titleEl.closest('article') || titleEl.parentElement
    const snippetEl = resultEl ? resultEl.querySelector('.result-desc, .description, p') : null
    const siteEl = resultEl ? resultEl.querySelector('.result-url, cite') : null
    items.push({
      title: titleEl.textContent || '',
      rawUrl: titleEl.href || titleEl.getAttribute('href') || '',
      snippet: snippetEl ? snippetEl.textContent || '' : '',
      siteName: siteEl ? siteEl.textContent || '' : ''
    })
  })
  return items
}

function extractBaiduResults() {
  const items = []
  document.querySelectorAll('.result, .result-op, .c-container').forEach((el) => {
    const titleEl = el.querySelector('h3.t a, h3 a, .t a')
    if (!titleEl) return

    let dataUrl = ''
    const dataTools = el.getAttribute('data-tools')
    if (dataTools) {
      try {
        dataUrl = JSON.parse(dataTools).url || ''
      } catch (_) {
        dataUrl = ''
      }
    }

    const snippetEl = el.querySelector('.c-abstract, .c-span-last, .content-right_8Zs40')
    const siteEl = el.querySelector('.c-showurl, .c-color-gray, .c-gap-right-small')
    items.push({
      title: titleEl.textContent || '',
      rawUrl: dataUrl || titleEl.getAttribute('mu') || titleEl.href || titleEl.getAttribute('href') || '',
      snippet: snippetEl ? snippetEl.textContent || '' : '',
      siteName: siteEl ? siteEl.textContent || '' : ''
    })
  })
  return items
}

function extractSogouResults() {
  const items = []
  document.querySelectorAll('.vrwrap, .rb, .results > div, .result').forEach((el) => {
    const titleEl = el.querySelector('.vr-title a, h3 a, .pt a')
    if (!titleEl) return

    const snippetEl = el.querySelector('.str_info, .text-layout, .ft, .fz-mid')
    const siteEl = el.querySelector('.citeurl, .cite-url, .site')
    items.push({
      title: titleEl.textContent || '',
      rawUrl: titleEl.href || titleEl.getAttribute('href') || '',
      snippet: snippetEl ? snippetEl.textContent || '' : '',
      siteName: siteEl ? siteEl.textContent || '' : ''
    })
  })
  return items
}

function extractDuckDuckGoResults() {
  const items = []
  document.querySelectorAll('.result').forEach((el) => {
    const titleEl = el.querySelector('.result__a')
    if (!titleEl) return

    const snippetEl = el.querySelector('.result__snippet')
    const metaEl = el.querySelector('.result__url')
    items.push({
      title: titleEl.textContent || '',
      rawUrl: titleEl.href || titleEl.getAttribute('href') || '',
      snippet: snippetEl ? snippetEl.textContent || '' : '',
      siteName: metaEl ? metaEl.textContent || '' : ''
    })
  })
  return items
}

async function searchWithEngine(context, engine, query, timeout, options = {}) {
  const signal = options.signal
  const engineQuery = typeof engine.prepareQuery === 'function' ? engine.prepareQuery(query) : query
  throwIfAborted(signal)
  if (engine.fetchResults) {
    return engine.fetchResults(engineQuery, timeout, options)
  }

  let page = null
  try {
    page = await context.newPage()
    throwIfAborted(signal)
    await page.goto(engine.buildUrl(engineQuery), { waitUntil: 'domcontentloaded', timeout })
    await delay(2000, signal)
    throwIfAborted(signal)
    const results = await page.evaluate(engine.extractResults)
    return results
  } finally {
    if (page) {
      await page.close().catch(() => {})
    }
  }
}

async function enrichResultWithPageContent(context, result, timeout, options = {}) {
  if (!result.url || !result.url.startsWith('http')) return
  const signal = options.signal

  let resultPage = null
  try {
    throwIfAborted(signal)
    resultPage = await context.newPage()
    await resultPage.goto(result.url, { waitUntil: 'domcontentloaded', timeout: Math.min(timeout, 15000) })
    await delay(1000, signal)
    throwIfAborted(signal)

    const finalUrl = resultPage.url()
    if (finalUrl && finalUrl.startsWith('http')) {
      result.url = finalUrl
    }

    const extracted = await resultPage.evaluate(() => {
      const article = document.querySelector('article')
      const main = document.querySelector('main')
      const content = article || main || document.body
      if (!content) return { bodyText: '', siteName: '', timestamp: '' }

      const text = (content.textContent || '').trim().slice(0, 3000)
      const ogSite = document.querySelector('meta[property="og:site_name"]')
      const siteName = ogSite
        ? ogSite.getAttribute('content')
        : (document.title ? document.title.split(/[-|]/)[0].trim() : '')
      const timeEl = document.querySelector('time')
      const timestamp = timeEl ? (timeEl.getAttribute('datetime') || timeEl.textContent) : ''

      return { bodyText: text, siteName, timestamp }
    })

    result.bodyText = extracted.bodyText || ''
    if (extracted.siteName) result.siteName = extracted.siteName
    if (extracted.timestamp) result.timestamp = extracted.timestamp
  } catch (err) {
    if (err?.code === 'TASK_CANCELLED' || signal?.aborted) throw createAbortError()
    // Failed to visit this result page, skip
  } finally {
    if (resultPage) {
      await resultPage.close().catch(() => {})
    }
  }
}

/**
 * Search for a query on a search engine and collect results.
 * Tries multiple search engines and falls back when one fails or has no results.
 * @param {object} browser - browser instance from launchBrowser()
 * @param {string} query - search query
 * @param {object} [options]
 * @param {number} [options.maxPages=5] - max result pages to visit
 * @param {number} [options.timeout=30] - timeout in seconds
 * @returns {Promise<Array<{title: string, url: string, snippet: string, bodyText: string, siteName: string, timestamp: string}>>}
 */
async function searchAndCollect(browser, query, options) {
  if (!browser) throw new Error('Browser instance is required')
  if (!query || typeof query !== 'string') throw new Error('Query must be a non-empty string')

  const maxPages = (options && options.maxPages) || 5
  const maxResults = Math.max(maxPages * 4, 12)
  const timeout = ((options && options.timeout) || 30) * 1000
  const signal = options && options.signal
  const onDetail = options && typeof options.onDetail === 'function' ? options.onDetail : null
  const sourceProfile = options && options.sourceProfile

  throwIfAborted(signal)
  const context = await browser.newContext({
    userAgent: DEFAULT_USER_AGENT,
    locale: 'zh-CN'
  })

  const results = []
  const queryTokens = tokenizeQuery(query)

  try {
    const seenUrls = new Set()
    const engines = getSearchEngines(sourceProfile)

    for (const engine of engines) {
      throwIfAborted(signal)
      let searchResults = []
      const engineQuery = typeof engine.prepareQuery === 'function' ? engine.prepareQuery(query) : query

      try {
        onDetail?.({
          stage: 'browsing',
          title: engine.trusted ? `信任来源: ${engine.name.replace(/^trusted:/, '')}` : `搜索源: ${engine.name}`,
          message: `正在用 ${engine.name} 搜索「${engineQuery}」`
        })
        searchResults = await searchWithEngine(context, engine, query, timeout, { signal })
      } catch (err) {
        if (err?.code === 'TASK_CANCELLED' || signal?.aborted) throw createAbortError()
        console.warn(`[ai-search] ${engine.name} search failed:`, err.message)
        onDetail?.({
          stage: 'browsing',
          title: engine.trusted ? `信任来源跳过: ${engine.name.replace(/^trusted:/, '')}` : `搜索源跳过: ${engine.name}`,
          message: err.message,
          level: 'warning'
        })
        continue
      }

      if (engine.resultLimit && searchResults.length > engine.resultLimit) {
        searchResults = searchResults.slice(0, engine.resultLimit)
      }

      const engineResults = []
      for (const r of searchResults) {
        const result = normalizeSearchResult(r)
        if (!result.url || seenUrls.has(result.url)) continue
        if (!isAllowedHost(result.url, engine.allowedHosts)) continue
        if (engine.trusted) {
          result.trusted = true
          result.trustedSite = engine.allowedHosts?.[0] || ''
        }
        seenUrls.add(result.url)
        if (isRelevantResult(result, queryTokens)) {
          engineResults.push(result)
        }
      }

      if (engineResults.length > 0) {
        results.push(...engineResults)
        onDetail?.({
          stage: 'browsing',
          title: engine.trusted ? `信任来源找到 ${engineResults.length} 条线索` : `找到 ${engineResults.length} 条线索`,
          message: `${engine.name} 累计收集 ${results.length} 条候选结果`
        })
        if (results.length >= maxResults) break
      }
    }

    results.splice(maxResults)

    // Visit top result pages to extract more content (up to maxPages)
    const pagesToVisit = results.slice(0, Math.min(maxPages, results.length))
    for (const result of pagesToVisit) {
      throwIfAborted(signal)
      onDetail?.({
        stage: 'browsing',
        title: '读取网页内容',
        message: result.title || result.url,
        detail: result.url
      })
      await enrichResultWithPageContent(context, result, timeout, { signal })
    }

  } finally {
    await context.close()
  }

  return results
}

/**
 * Classify a source's reliability.
 * @param {string} url - source URL
 * @param {string} siteName - source site name
 * @returns {{ level: string, score: number }}
 */
function classifySource(url, siteName) {
  const urlLower = (url || '').toLowerCase()
  const nameLower = (siteName || '').toLowerCase()

  // 解析 hostname 用于精确后缀匹配，避免子串误判（如 notawiki.com 命中 'wiki'）
  let hostname = ''
  try {
    hostname = new URL(url).hostname.toLowerCase()
  } catch (_) {
    // 非法 URL 退回到全 URL 子串匹配
  }

  if (isVideoPageUrl(url)) {
    return { level: 'video', score: 1.0 }
  }

  /**
   * 匹配规则：
   * - 含 '.' 的条目（如 'imdb.com'、'amazon.com/dp'）用 hostname 后缀匹配，
   *   带 '/' 的附加 pathname 检查；siteName 作为补充。
   * - 不含 '.' 的短词（如 'wiki'、'blog'、'bbs'）仅在 siteName 上匹配，
   *   避免 URL 路径或子域误命中。
   */
  function matchDomain(domain) {
    if (domain.includes('.')) {
      const [hostPart, pathPart] = domain.split('/')
      const hostHit = hostname === hostPart || hostname.endsWith('.' + hostPart)
      if (hostHit) {
        if (pathPart) {
          try {
            return new URL(url).pathname.toLowerCase().includes('/' + pathPart)
          } catch (_) {
            return false
          }
        }
        return true
      }
      // siteName 中包含主域名作为补充信号
      return nameLower.includes(hostPart)
    }
    // 短词：仅匹配 siteName，不匹配 URL，降低误判
    return nameLower.includes(domain)
  }

  // Official sources
  const officialDomains = [
    'aniplex', 'crunchyroll.com', 'funimation.com', 'hidive.com', 'netflix.com',
    'disneyplus.com', 'primevideo.com', 'amazon.com/dp', 'hulu.com', 'max.com',
    'hbomax.com', 'hbo.com', 'paramountplus.com', 'peacocktv.com',
    'bilibili.com', 'iqiyi.com', 'youku.com', 'v.qq.com', 'wetv.vip',
    'tv.sohu.com', 'mgtv.com'
  ]
  for (const domain of officialDomains) {
    if (matchDomain(domain)) {
      return { level: 'official', score: 1.0 }
    }
  }

  // Database / encyclopedia sources
  const dbDomains = [
    'imdb.com', 'tmdb.org', 'themoviedb.org', 'bangumi.tv', 'bgm.tv',
    'douban.com', 'myanimelist.net', 'anilist.co', 'anidb.net',
    'baike.baidu.com', 'baike.sogou.com', 'steamcommunity.com', 'wikipedia.org', 'zh.wikipedia.org',
    'animenewsnetwork.com', 'vndb.org'
  ]
  for (const domain of dbDomains) {
    if (matchDomain(domain)) {
      return { level: 'database', score: 0.9 }
    }
  }

  // Forum / community sources
  const forumDomains = [
    'reddit.com', 'tieba.baidu.com', 'bbs', 'forum', 'community',
    'zhihu.com', 'quora.com', 'stackexchange.com', 'stackoverflow.com',
    'gamefaqs', 'neogaf', 'resetera', 'iwara.tv', 'pixiv.net'
  ]
  for (const domain of forumDomains) {
    if (matchDomain(domain)) {
      return { level: 'forum', score: 0.6 }
    }
  }

  // News / release reports
  const newsDomains = [
    'ithome.com', '163.com', 'news.qq.com', 'sina.com.cn',
    'msn.cn', 'thepaper.cn', 'mtime.com', 'variety.com', 'deadline.com',
    'hollywoodreporter.com', 'comicbook.com'
  ]
  for (const domain of newsDomains) {
    if (matchDomain(domain)) {
      return { level: 'news', score: 0.65 }
    }
  }

  // Blog / encyclopedia
  const encyclopediaDomains = [
    'fandom.com', 'wikia.com', 'wiki', 'pedia',
    'blog', 'medium.com'
  ]
  for (const domain of encyclopediaDomains) {
    if (matchDomain(domain)) {
      return { level: 'encyclopedia', score: 0.7 }
    }
  }

  return { level: 'low', score: 0.3 }
}

function isVideoPageUrl(url) {
  let parsed = null
  try {
    parsed = new URL(String(url || ''))
  } catch (_) {
    return false
  }
  const hostname = parsed.hostname.replace(/^www\./, '').toLowerCase()
  const pathname = parsed.pathname.toLowerCase()
  if (hostname.endsWith('bilibili.com')) return /\/video\/(?:av|bv)/i.test(pathname) || pathname.includes('/bangumi/play/') || pathname.includes('/bangumi/media/')
  if (hostname.endsWith('youtube.com')) return pathname === '/watch' || pathname.startsWith('/playlist')
  if (hostname === 'youtu.be') return pathname.length > 1
  if (hostname.endsWith('nicovideo.jp')) return pathname.startsWith('/watch/')
  if (hostname.endsWith('dailymotion.com')) return pathname.startsWith('/video/')
  if (hostname.endsWith('vimeo.com')) return /^\/\d+/.test(pathname)
  if (hostname.endsWith('iqiyi.com')) return pathname.includes('/v_') || pathname.includes('/w_')
  if (hostname.endsWith('v.qq.com')) return pathname.includes('/x/cover/') || pathname.includes('/x/page/')
  if (hostname.endsWith('youku.com')) return pathname.includes('/video/')
  if (hostname.endsWith('mgtv.com')) return pathname.includes('/b/')
  if (hostname.endsWith('primevideo.com')) return pathname.includes('/detail/') || pathname.includes('/dp/')
  if (hostname.endsWith('amazon.com')) return pathname.includes('/gp/video/') || pathname.includes('/dp/')
  if (hostname.endsWith('netflix.com')) return pathname.includes('/title/') || pathname.includes('/watch/')
  if (hostname.endsWith('crunchyroll.com')) return pathname.includes('/series/') || pathname.includes('/watch/')
  if (hostname.endsWith('disneyplus.com')) return pathname.includes('/movies/') || pathname.includes('/series/')
  if (hostname.endsWith('hulu.com')) return pathname.includes('/series/') || pathname.includes('/movie/') || pathname.includes('/watch/')
  if (hostname.endsWith('max.com')) return pathname.includes('/shows/') || pathname.includes('/movies/')
  if (hostname.endsWith('iwara.tv')) return pathname.includes('/video/')
  if (hostname.endsWith('abema.tv')) return pathname.includes('/video/')
  return isGenericPlayablePath(pathname)
}

function isGenericPlayablePath(pathname) {
  const path = String(pathname || '').toLowerCase()
  if (!path || path === '/') return false
  if (/(?:watch[-_/]?order|guide|wiki|news|review|article|blog|tag|search|category|list|rank|forum|topic)/i.test(path)) {
    return false
  }
  if (/(?:\/|^)(?:vodplay|vod-play|voddetail|vod-detail|v_play|playurl)(?:\/|[-_.]|$)/i.test(path)) return true
  if (/\/vod\/(?:play|detail)(?:\/|$)/i.test(path)) return true
  if (/\/index\.php\/vod\/(?:play|detail)(?:\/|$)/i.test(path)) return true

  const segments = path
    .split('/')
    .map(segment => segment.trim())
    .filter(Boolean)
  if (segments.length < 2) return false
  const playableSegments = new Set(['play', 'player', 'watch', 'video', 'videos', 'episode', 'episodes', 'detail', 'details', 'show', 'shows'])
  return segments.some(segment => playableSegments.has(segment))
}

/**
 * Close a browser instance.
 * @param {object} browser - browser instance from launchBrowser()
 */
async function closeBrowser(browser) {
  if (!browser) return
  try {
    await browser.close()
  } catch (_) {
    // ignore close errors
  }
}

module.exports = {
  isAvailable,
  launchBrowser,
  searchAndCollect,
  classifySource,
  closeBrowser,
  SEARCH_SOURCE_VERSION,
  normalizeHost,
  isVideoPageUrl
}
