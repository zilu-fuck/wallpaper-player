const net = require('net')

// 主机名/地址的私网判定工具，供 IPC 与 remote 层共用。

function normalizeHostname(value) {
  return String(value || '').trim().replace(/^www\./i, '').toLowerCase()
}

function isLocalHostname(hostname) {
  const host = normalizeHostname(hostname)
  return !host.includes('.') || host === 'localhost' || host.endsWith('.localhost') ||
    host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.internal')
}

// 将 ::ffff: 前缀的 IPv4-mapped IPv6 地址还原为 IPv4 点分形式，否则返回空字符串。
// 注意 WHATWG URL 会把 [::ffff:127.0.0.1] 序列化为 [::ffff:7f00:1]，
// 因此除了标准的点分结尾，还要处理十六进制段（两段式 7f00:1 或四段式 7f00:0:0:1 之外的紧凑形式）。
function demapIpv4MappedIpv6(host) {
  const lower = String(host || '').trim().toLowerCase()
  if (!lower.startsWith('::ffff:')) return ''
  const rest = lower.slice('::ffff:'.length)
  if (!rest) return ''
  // 标准形式：::ffff:127.0.0.1（点分结尾）
  const dotted = rest.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (dotted) return dotted.slice(1).join('.')
  // 十六进制形式：::ffff:7f00:1（两段）或 ::ffff:7f00:0:1 等多段，取最后两个段拼接
  const parts = rest.split(':').filter(Boolean)
  if (parts.length >= 2) {
    const hi = parseInt(parts[parts.length - 2], 16)
    const lo = parseInt(parts[parts.length - 1], 16)
    if (Number.isFinite(hi) && Number.isFinite(lo) && hi >= 0 && hi <= 0xffff && lo >= 0 && lo <= 0xffff) {
      return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
    }
  }
  return ''
}

function isPrivateIpAddress(hostname) {
  const host = String(hostname || '').trim().replace(/^\[|\]$/g, '').toLowerCase()
  const version = net.isIP(host)
  if (version === 4) {
    const [a, b] = host.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
  }
  if (version === 6) {
    if (host === '::' || host === '::1' || host.startsWith('fc') || host.startsWith('fd')) return true
    if (/^fe[89ab]/.test(host)) return true
    // IPv4-mapped：还原为 IPv4 后复用 IPv4 判定；无法还原时保守拒绝
    const mapped = demapIpv4MappedIpv6(host)
    if (mapped) return isPrivateIpAddress(mapped)
    if (host.startsWith('::ffff:')) return true
  }
  return false
}

function isPrivateOrLocalHostname(hostname) {
  return isLocalHostname(hostname) || isPrivateIpAddress(hostname)
}

// 判断 http(s) URL 的主机名是否为私网/本地地址；非 http(s) 或解析失败返回 false。
function isPrivateOrLocalUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim())
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    return isPrivateOrLocalHostname(parsed.hostname)
  } catch {
    return false
  }
}

// 判断某 URL 是否“可信的内网上下文”：网页/资源 URL 本身指向内网时，
// 其解析出的子资源地址允许指向内网（用户显式添加的局域网场景）。
// 规则：来源 URL 为内网则放行；否则目标 URL 必须为公网。
function assertResolvedTargetPublic(sourceUrl, targetUrl, errorMessage = '解析出的地址指向本地或内网，已拒绝') {
  if (!isPrivateOrLocalUrl(sourceUrl) && isPrivateOrLocalUrl(targetUrl)) {
    throw new Error(errorMessage)
  }
}

// 校验 http(s) URL 是否指向私网或本机，用于 SSRF 防线。
// 命中内网则抛出带原因的错误；非 http(s) 协议或无效 URL 一律拒绝。
function assertPublicHttpUrl(url, errorMessage = '为安全起见，暂不支持本地/内网地址') {
  let parsed
  try {
    parsed = new URL(String(url || '').trim())
  } catch {
    throw new Error('网络地址无效')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('仅支持 http/https 地址')
  }
  if (isPrivateOrLocalHostname(parsed.hostname)) {
    throw new Error(errorMessage)
  }
  return parsed
}

module.exports = {
  assertPublicHttpUrl,
  assertResolvedTargetPublic,
  demapIpv4MappedIpv6,
  isLocalHostname,
  isPrivateIpAddress,
  isPrivateOrLocalHostname,
  isPrivateOrLocalUrl,
  normalizeHostname
}
