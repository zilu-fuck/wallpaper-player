import { resolveRemoteUrl } from '../../services/api'
import type { StoredDevice, VideoItem } from '../../types'
import { formatBytes } from '../../utils/url'

export function appendRetryParam(url: string, retryKey: number) {
  if (!retryKey) return url
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}retry=${retryKey}`
}

export function withQueryToken(url: string, key: string, token: string) {
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}${key}=${encodeURIComponent(token)}`
}

export function resolveThumbnailUrl(device: StoredDevice, video: VideoItem) {
  if (video.sourceType === 'network') return ''
  return withQueryToken(
    resolveRemoteUrl(device, video.thumbnailUrl),
    video.thumbnailToken ? 'thumbnailToken' : 'token',
    video.thumbnailToken || device.token
  )
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

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

export function uniqueText(parts: Array<string | undefined>) {
  const seen = new Set<string>()
  return parts
    .map(part => (part || '').trim())
    .filter(part => {
      if (!part || seen.has(part)) return false
      seen.add(part)
      return true
    })
}

export function getVideoTitle(video: VideoItem) {
  return video.name || video.fileName || video.id
}

export function getVideoTags(video: VideoItem) {
  return uniqueText([
    ...(video.customTags || []),
    ...(video.systemTags || []),
    ...(video.tags || [])
  ]).slice(0, 3)
}

export function getVideoGroupLine(video: VideoItem, device: StoredDevice, tags = getVideoTags(video)) {
  const parts = uniqueText([
    video.network?.site,
    video.directoryName,
    video.group,
    ...tags
  ])
  return parts.length > 0 ? parts.join(' · ') : device.name
}

export function getVideoDetailLine(
  video: VideoItem,
  duration: number,
  videoSize: { width: number, height: number } | null
) {
  const extension = (video.extension || '').replace(/^\./, '').toUpperCase()
  const resolution = videoSize ? `${videoSize.width}×${videoSize.height}` : ''
  return uniqueText([
    video.sourceType === 'network' ? (extension || 'WEB') : (extension || 'VIDEO'),
    formatBytes(video.size),
    resolution,
    duration > 0 ? formatTime(duration) : ''
  ]).join(' · ')
}
