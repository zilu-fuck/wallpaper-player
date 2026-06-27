'use strict'

// Patterns to strip from raw filenames
const RESOLUTION_PATTERNS = [
  /\b(?:2160p|4K|UHD|1080p|1080|720p|480p|360p|240p|144p)\b/ig,
  /\b(?:3840x2160|1920x1080|1280x720|852x480|640x360)\b/ig
]

const ENCODING_PATTERNS = [
  /\b(?:x265|x264|h265|h264|hevc|avc|av1|vp9|vp8|mpeg4|divx|xvid)\b/ig,
  /\b(?:10bit|8bit|Hi10P|BluRay|Blu-ray|BDRip|WEBRip|WEB-DL|WEB|HDTV|HDRip|DVDRip|BRRip)\b/ig,
  /\b(?:AAC|AC3|DTS|FLAC|MP3|OPUS|TrueHD|DDP5[.]1)\b/ig,
  /\b(?:HEVC\.|H\.264|H\.265)\b/ig
]

const GROUP_PATTERNS = [
  /[-.[\]]\s*(SubsPlease|Erai-raws|HorribleSubs|AnimeRG|Judas|EMBER|Tigole|QxR|RARBG|YTS|eztv|Kawaii|HelloWorld|ReinForce|CR\-?\s*Rip|Ohys|B-GK|CM|VARYG|Moozzi2|SSA|SSW|ANK)\s*[-.[\]]?/ig
]

const EXTENSION_PATTERN = /\.(?:mp4|mkv|avi|mov|wmv|flv|webm|m4v|ts|m2ts|iso)$/i

const BRACKET_CONTENT = /\[.*?\]|【.*?】/g
const TITLE_NOISE_PATTERN = /(?:立即播放|在线播放|在线观看|免费观看|免费|播放|高清|超清|蓝光|全集|视频|影片|电影|电视剧|动漫|动画|正片|预告片|片花)/ig
const GENERIC_TITLE_PATTERN = /^(?:视频|电影|动漫|动画|电视剧|下载|新建文件夹|学习资料|全部|未分类)$/i

function cleanTitle(rawTitle) {
  if (!rawTitle || typeof rawTitle !== 'string') return ''

  let title = rawTitle.trim()

  // Remove file extension
  title = title.replace(EXTENSION_PATTERN, '')

  // Remove resolution patterns
  for (const pattern of RESOLUTION_PATTERNS) {
    title = title.replace(pattern, '')
  }

  // Remove encoding patterns
  for (const pattern of ENCODING_PATTERNS) {
    title = title.replace(pattern, '')
  }

  // Remove subtitle group names
  for (const pattern of GROUP_PATTERNS) {
    title = title.replace(pattern, '')
  }

  // Remove standalone bracketed content (often subber tags, crc, etc.)
  title = title.replace(BRACKET_CONTENT, '')

  // Collapse whitespace and trim
  title = title.replace(/\s+/g, ' ').replace(/[-_]+/g, ' ').trim()
  title = title.replace(/\s*[.]\s*/g, ' ').trim()

  return title
}

function normalizeSearchTitle(rawTitle) {
  const cleaned = cleanTitle(rawTitle)
  return cleaned
    .replace(TITLE_NOISE_PATTERN, ' ')
    .replace(/([\u4e00-\u9fa5A-Za-z])第([一二三四五六七八九十百千万\d]+)季/g, '$1 第$2季')
    .replace(/\s+/g, ' ')
    .trim()
}

function isWeakSearchTitle(rawTitle) {
  const normalized = normalizeSearchTitle(rawTitle)
  if (!normalized) return true
  if (GENERIC_TITLE_PATTERN.test(normalized)) return true

  const core = normalized
    .replace(/\bS\d{1,2}E\d{1,3}(?:E\d{1,3})?\b/ig, ' ')
    .replace(/\b(?:Episode|Ep|EP)\s*\d+\b/ig, ' ')
    .replace(/第\s*\d+\s*[话集卷]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!core) return true
  if (/^\d{1,4}$/.test(core)) return true
  if (/^[\d\s第季话集卷]+$/.test(core)) return true
  return core.length <= 1
}

const SEASON_EPISODE_PATTERNS = [
  // S01E02, S1E2, S01E02E03
  { type: 'episode', pattern: /\bS(\d{1,2})E(\d{1,3})(?:E(\d{1,3}))?\b/ig },
  // Season 1 Episode 2
  { type: 'episode', pattern: /Season\s+(\d+)\s+Episode\s+(\d+)/ig },
  // 第2季, 第2话, 第02集
  { type: 'episode', pattern: /第\s*(\d+)\s*[季话集卷]/g },
  // Episode 2, Ep 2, EP02
  { type: 'episode', pattern: /\b(?:Episode|Ep|EP)\s*(\d+)\b/ig },
  // Season 2, Season2
  { type: 'season', pattern: /\bSeason\s*(\d+)\b/ig },
  // Part 1, Part I, Vol. 2
  { type: 'season', pattern: /\b(?:Part|Volume|Vol)\s*[. ]*(\d+)\b/ig }
]

const CHINESE_NUMBERS = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10
}

const SPECIAL_TYPE_PATTERNS = [
  { type: 'OVA', pattern: /\b(?:OVA|OAD|ONA)\b/i },
  { type: 'movie', pattern: /\b(?:剧场版|Movie|Film|The Movie)\b/i },
  { type: 'special', pattern: /\b(?:Special|SP|特典|Extra)\b/i },
  { type: 'movie', pattern: /\b剧场\s*版\b/ }
]

function extractPatterns(title) {
  if (!title || typeof title !== 'string') {
    return { seasonPatterns: [], episodePatterns: [], specialTypes: [] }
  }

  const seasonPatterns = []
  const episodePatterns = []
  const specialTypes = []

  // Extract season/episode info
  for (const rule of SEASON_EPISODE_PATTERNS) {
    const matches = title.matchAll(rule.pattern)
    for (const match of matches) {
      if (rule.type === 'episode') {
        episodePatterns.push({
          raw: match[0],
          seasonNum: match[1] ? parseInt(match[1], 10) : null,
          episodeNum: match[2] ? parseInt(match[2], 10) : null,
          episodeEndNum: match[3] ? parseInt(match[3], 10) : null
        })
      } else if (rule.type === 'season') {
        seasonPatterns.push({
          raw: match[0],
          seasonNum: match[1] ? parseInt(match[1], 10) : null
        })
      }
    }
  }

  // Extract special types
  for (const rule of SPECIAL_TYPE_PATTERNS) {
    if (rule.pattern.test(title)) {
      if (!specialTypes.includes(rule.type)) {
        specialTypes.push(rule.type)
      }
    }
  }

  return { seasonPatterns, episodePatterns, specialTypes }
}

function parseNumberToken(value) {
  const text = String(value || '').trim()
  if (!text) return null
  if (/^\d+$/.test(text)) return parseInt(text, 10)
  if (CHINESE_NUMBERS[text]) return CHINESE_NUMBERS[text]
  if (text.length === 2 && text[0] === '十' && CHINESE_NUMBERS[text[1]]) return 10 + CHINESE_NUMBERS[text[1]]
  if (text.length === 2 && text[1] === '十' && CHINESE_NUMBERS[text[0]]) return CHINESE_NUMBERS[text[0]] * 10
  if (text.length === 3 && text[1] === '十' && CHINESE_NUMBERS[text[0]] && CHINESE_NUMBERS[text[2]]) {
    return CHINESE_NUMBERS[text[0]] * 10 + CHINESE_NUMBERS[text[2]]
  }
  return null
}

function numberToChinese(num) {
  const number = Number(num)
  if (!Number.isFinite(number) || number <= 0 || number > 99) return String(num)
  const digits = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九']
  if (number <= 10) return number === 10 ? '十' : digits[number]
  const tens = Math.floor(number / 10)
  const ones = number % 10
  if (tens === 1) return `十${ones ? digits[ones] : ''}`
  return `${digits[tens]}十${ones ? digits[ones] : ''}`
}

function getNextTargets(title) {
  const text = String(title || '')
  const targets = []
  const push = (type, number) => {
    if (!Number.isFinite(number) || number <= 0) return
    if (!targets.some(item => item.type === type && item.number === number)) {
      targets.push({ type, number })
    }
  }

  for (const match of text.matchAll(/\bS(\d{1,2})E(\d{1,3})\b/ig)) {
    const season = parseInt(match[1], 10)
    const episode = parseInt(match[2], 10)
    push('episode', episode + 1)
    push('season', season + 1)
  }
  for (const match of text.matchAll(/第\s*([一二三四五六七八九十\d]+)\s*季/g)) {
    const season = parseNumberToken(match[1])
    if (season) push('season', season + 1)
  }
  for (const match of text.matchAll(/第\s*([一二三四五六七八九十\d]+)\s*[话集卷]/g)) {
    const episode = parseNumberToken(match[1])
    if (episode) push('episode', episode + 1)
  }
  for (const match of text.matchAll(/\b(?:Episode|Ep|EP)\s*(\d+)\b/ig)) {
    const episode = parseInt(match[1], 10)
    push('episode', episode + 1)
  }
  return targets
}

function buildBaseTitle(title) {
  let base = String(title || '')

  // Only strip a leading release/episode index when the rest clearly contains
  // episode markers. Numeric titles such as "86" or "24 Season 1" are valid.
  const leadingIndexMatch = base.match(/^\s*\d{1,3}\s+((?:第\s*\d+\s*[话集卷]|\bS\d{1,2}E\d{1,3}\b|\b(?:Episode|Ep|EP)\s*\d+\b)\s+.+)$/i)
  if (leadingIndexMatch) {
    base = base.replace(/^\s*\d{1,3}\s+/, ' ')
  }

  return base
    .replace(/\bS\d{1,2}E\d{1,3}(?:E\d{1,3})?\b/ig, ' ')
    .replace(/\b(?:Episode|Ep|EP)\s*\d+\b/ig, ' ')
    .replace(/第\s*[一二三四五六七八九十百千万\d]+\s*季/g, ' ')
    .replace(/第\s*\d+\s*[话集卷]/g, ' ')
    .replace(/第\s*[一二三四五六七八九十百千万]+\s*[话集卷]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function generateSearchQueries(title, intent, keywords, options = {}) {
  if (!title || typeof title !== 'string') return []
  const cleaned = title.trim()
  const baseTitle = buildBaseTitle(cleaned)
  const sourceProfile = options.sourceProfile || 'general'
  const nextTargets = getNextTargets(cleaned)
  const extraKeywords = Array.isArray(keywords)
    ? keywords.filter(k => k && typeof k === 'string')
    : []

  const queries = []
  if (baseTitle && baseTitle !== cleaned) {
    queries.push(baseTitle)
    queries.push(`${baseTitle} 在线观看`)
    queries.push(`${baseTitle} 在线播放`)
    queries.push(`${baseTitle} 完整版`)
    queries.push(`${baseTitle} 豆瓣 IMDb`)
  }

  switch (intent) {
    case 'sequel': {
      const sequelTitle = baseTitle || cleaned
      const hasExplicitTargets = nextTargets.length > 0
      queries.push(`${cleaned} 续集`)
      queries.push(`${cleaned} sequel`)
      queries.push(`${cleaned} 下一季`)
      queries.push(`${cleaned} next season release date`)
      queries.push(`${cleaned} next season watch online`)
      queries.push(`${cleaned} bilibili`)
      queries.push(`${cleaned} Prime Video`)
      queries.push(`${cleaned} YouTube trailer`)
      if (!hasExplicitTargets) {
        queries.push(`${sequelTitle} 第二季 在线观看`)
        queries.push(`${sequelTitle} 第二季 在线播放`)
        queries.push(`${sequelTitle} 第二季 完整版`)
        queries.push(`${sequelTitle} 第二季 免费`)
        queries.push(`${sequelTitle} season 2 full episode`)
      }
      for (const target of nextTargets) {
        const targetBaseTitle = sequelTitle
        if (target.type === 'episode') {
          const zh = numberToChinese(target.number)
          queries.push(`${targetBaseTitle} 第${zh}集 在线观看`)
          queries.push(`${targetBaseTitle} 第${zh}集 在线播放`)
          queries.push(`${targetBaseTitle} episode ${target.number} watch online`)
        }
        if (target.type === 'season') {
          const zh = numberToChinese(target.number)
          queries.push(`${targetBaseTitle} 第${zh}季 在线观看`)
          queries.push(`${targetBaseTitle} 第${zh}季 在线播放`)
          queries.push(`${targetBaseTitle} season ${target.number} watch online`)
        }
      }
      if (baseTitle && baseTitle !== cleaned) {
        queries.push(`${baseTitle} 第二季`)
        queries.push(`${baseTitle} sequel`)
        if (!hasExplicitTargets) {
          queries.push(`${baseTitle} 第二季 播放`)
          queries.push(`${baseTitle} 第二季 在线观看`)
          queries.push(`${baseTitle} 第二季 在线播放`)
          queries.push(`${baseTitle} 第二季 完整版`)
          queries.push(`${baseTitle} 第二季 bilibili`)
          queries.push(`${baseTitle} season 2 Prime Video`)
          queries.push(`${baseTitle} season 2 watch online`)
        }
      }
      break
    }
    case 'same_series': {
      queries.push(`${cleaned} 系列`)
      queries.push(`${cleaned} series`)
      queries.push(`${cleaned} anime series list`)
      queries.push(`${cleaned} 系列作品`)
      if (baseTitle && baseTitle !== cleaned) {
        queries.push(`${baseTitle} 系列`)
        queries.push(`${baseTitle} series`)
      }
      break
    }
    case 'watch_order': {
      queries.push(`${cleaned} 观看顺序`)
      queries.push(`${cleaned} watch order`)
      queries.push(`${cleaned} 系列 顺序`)
      queries.push(`${cleaned} season guide`)
      if (baseTitle && baseTitle !== cleaned) {
        queries.push(`${baseTitle} 观看顺序`)
      }
      break
    }
    case 'auto':
    default: {
      queries.push(`${cleaned}`)
      queries.push(`${cleaned} 在线观看`)
      queries.push(`${cleaned} 在线播放`)
      queries.push(`${cleaned} 完整版`)
      queries.push(`${cleaned} 介绍`)
      queries.push(`${cleaned} 播出平台`)
      queries.push(`${cleaned} 豆瓣 IMDb`)
      if (sourceProfile === 'anime') {
        queries.push(`${cleaned} 动漫 介绍`)
        queries.push(`${cleaned} anime information`)
      }
      queries.push(`${cleaned} 系列`)
      break
    }
  }

  // 附加用户编辑的关键词，生成补充查询
  for (const kw of extraKeywords) {
    if (!cleaned.includes(kw)) {
      queries.push(`${cleaned} ${kw}`)
    }
  }

  // Deduplicate and filter empty
  return [...new Set(queries)].filter(Boolean)
}

module.exports = {
  buildBaseTitle,
  cleanTitle,
  extractPatterns,
  generateSearchQueries,
  getNextTargets,
  isWeakSearchTitle,
  normalizeSearchTitle
}
