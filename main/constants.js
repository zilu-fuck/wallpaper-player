const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.webm', '.mkv', '.avi', '.mov', '.wmv', '.flv',
  '.m4v', '.mpg', '.mpeg', '.3gp', '.ogv', '.ts', '.m2ts', '.mts', '.vob',
  '.rmvb', '.rm', '.asf', '.divx', '.f4v'
])

const NETWORK_VIDEO_EXTENSIONS = new Set([
  ...VIDEO_EXTENSIONS,
  '.m3u8', '.m3u', '.mpd'
])

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'])

// 扫描缓存 TTL（ms）：watcher 主动失效之外的兜底
const SCAN_CACHE_TTL = 60_000

module.exports = {
  VIDEO_EXTENSIONS,
  NETWORK_VIDEO_EXTENSIONS,
  IMAGE_EXTENSIONS,
  SCAN_CACHE_TTL
}
