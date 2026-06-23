import { memo, useCallback } from 'react'
import { Check, Film, Heart } from 'lucide-react-native'
import { useEffect, useMemo, useState } from 'react'
import { Image, Pressable, StyleSheet, Text, View } from 'react-native'
import type { StoredDevice, VideoItem } from '../types'
import { useTheme } from '../theme-context'
import { formatBytes } from '../utils/url'
import { resolveRemoteUrl } from '../services/api'

type Props = {
  device: StoredDevice
  video: VideoItem
  onPress: (video: VideoItem) => void
  onLongPress?: (video: VideoItem) => void
  onToggleFavorite?: (video: VideoItem) => void
  selected?: boolean
  selectionMode?: boolean
  width?: number
}

function withQueryToken(url: string, key: string, token: string) {
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}${key}=${encodeURIComponent(token)}`
}

function formatDuration(seconds?: number) {
  const total = Math.round(Number(seconds) || 0)
  if (total <= 0) return ''
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`
}

function getVideoMetaLine(video: VideoItem) {
  const media = video.media || null
  const resolution = media?.width && media?.height ? `${media.width}x${media.height}` : ''
  const duration = formatDuration(media?.durationSeconds)
  const codec = media?.videoCodec ? media.videoCodec.toUpperCase() : ''
  return [
    video.extension?.replace('.', '').toUpperCase(),
    duration,
    resolution,
    codec,
    formatBytes(video.size),
    video.directoryName || video.group
  ].filter(Boolean).join(' · ')
}

function VideoCardComponent({
  device,
  video,
  onPress,
  onLongPress,
  onToggleFavorite,
  selected = false,
  selectionMode = false,
  width
}: Props) {
  const { colors } = useTheme()
  const styles = createStyles(colors)
  const thumbnailUrl = useMemo(
    () => withQueryToken(
      resolveRemoteUrl(device, video.thumbnailUrl),
      video.thumbnailToken ? 'thumbnailToken' : 'token',
      video.thumbnailToken || device.token
    ),
    [device, video.thumbnailToken, video.thumbnailUrl]
  )
  const metaLine = useMemo(() => getVideoMetaLine(video), [video])
  const [imageFailed, setImageFailed] = useState(false)

  useEffect(() => {
    setImageFailed(false)
  }, [thumbnailUrl])

  const handlePress = useCallback(() => {
    onPress(video)
  }, [onPress, video])

  const handleLongPress = useCallback(() => {
    onLongPress?.(video)
  }, [onLongPress, video])

  const handleToggleFavorite = useCallback(() => {
    onToggleFavorite?.(video)
  }, [onToggleFavorite, video])

  return (
    <Pressable
      style={({ pressed }) => [
        styles.card,
        { width: width ?? '100%' },
        selected && styles.cardSelected,
        pressed && styles.pressed
      ]}
      onPress={handlePress}
      onLongPress={onLongPress ? handleLongPress : undefined}
      delayLongPress={170}
    >
      <View style={styles.thumb}>
        {!imageFailed ? (
          <Image
            source={{ uri: thumbnailUrl }}
            style={styles.image}
            resizeMode="cover"
            onError={() => setImageFailed(true)}
          />
        ) : null}
        <View style={styles.thumbFallback}>
          <Film color={colors.muted} size={24} />
        </View>
        {onToggleFavorite ? (
          <Pressable style={styles.favoriteButton} onPress={handleToggleFavorite}>
            <Heart
              color={video.favorite ? colors.text : colors.muted}
              fill={video.favorite ? colors.danger : 'none'}
              size={17}
            />
          </Pressable>
        ) : null}
        {selectionMode ? (
          <View style={[styles.selectionBadge, selected && styles.selectionBadgeActive]}>
            {selected ? <Check color="#ffffff" size={16} strokeWidth={3} /> : null}
          </View>
        ) : null}
      </View>
      <View style={styles.body}>
        <Text style={styles.name} numberOfLines={2}>{video.name || video.fileName || video.id}</Text>
        <Text style={styles.meta} numberOfLines={1}>
          {metaLine}
        </Text>
        {video.tags?.length ? (
          <Text style={styles.tags} numberOfLines={1}>{video.tags.join(' / ')}</Text>
        ) : null}
      </View>
    </Pressable>
  )
}

export const VideoCard = memo(VideoCardComponent)

const createStyles = (colors: ReturnType<typeof useTheme>['colors']) => StyleSheet.create({
  card: {
    borderRadius: 8,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden'
  },
  cardSelected: {
    borderColor: colors.accentStrong
  },
  pressed: {
    backgroundColor: colors.surfaceElevated
  },
  thumb: {
    aspectRatio: 16 / 9,
    backgroundColor: colors.surfaceElevated,
    position: 'relative'
  },
  image: {
    ...StyleSheet.absoluteFill,
    zIndex: 2
  },
  thumbFallback: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center'
  },
  favoriteButton: {
    position: 'absolute',
    right: 7,
    top: 7,
    zIndex: 3,
    width: 30,
    height: 30,
    borderRadius: 8,
    backgroundColor: 'rgba(11,15,20,0.72)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  selectionBadge: {
    position: 'absolute',
    left: 7,
    bottom: 7,
    zIndex: 4,
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.78)',
    backgroundColor: 'rgba(11,15,20,0.52)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  selectionBadgeActive: {
    borderColor: colors.accentStrong,
    backgroundColor: colors.accentStrong
  },
  body: {
    minHeight: 72,
    paddingHorizontal: 9,
    paddingTop: 8,
    paddingBottom: 9,
    gap: 4
  },
  name: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '700'
  },
  meta: {
    color: colors.muted,
    fontSize: 11
  },
  tags: {
    color: colors.subtle,
    fontSize: 10
  }
})
