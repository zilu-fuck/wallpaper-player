export function normalizeEndpoint(input: string) {
  const trimmed = input.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `http://${trimmed}`
}

export function joinUrl(endpoint: string, path: string) {
  const base = normalizeEndpoint(endpoint)
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${base}${suffix}`
}

export function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`
}

export function safeSearchText(...parts: Array<string | string[] | undefined>) {
  return parts
    .flatMap(part => Array.isArray(part) ? part : [part])
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

// 给 URL 追加查询参数（token / retry 等）
export function withQueryToken(url: string, key: string, token: string) {
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}${key}=${encodeURIComponent(token)}`
}

// 秒数格式化为 mm:ss 或 h:mm:ss
export function formatTime(seconds: number) {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0))
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const rest = safe % 60
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
  }
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

// 去重并 trim 的标签列表（大小写不敏感去重，保留首现原始大小写）
export function uniqueTags(tags: string[]) {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of Array.isArray(tags) ? tags : []) {
    const tag = String(raw || '').trim()
    const key = tag.toLocaleLowerCase()
    if (!tag || seen.has(key)) continue
    seen.add(key)
    result.push(tag)
  }
  return result
}

// 多组字符串/数组去重合并（端点列表），统一归一化为可访问 URL
export function uniqueEndpoints(...groups: Array<string | string[] | undefined>) {
  const seen = new Set<string>()
  const result: string[] = []
  for (const group of groups) {
    const items = Array.isArray(group) ? group : [group]
    for (const raw of items) {
      const value = normalizeEndpoint(String(raw || '').trim())
      if (!value || seen.has(value)) continue
      seen.add(value)
      result.push(value)
    }
  }
  return result
}
