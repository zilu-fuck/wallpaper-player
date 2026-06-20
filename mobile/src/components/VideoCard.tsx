import { Film, Heart } from 'lucide-react-native'
import { useEffect, useMemo, useState } from 'react'
import { Image, Pressable, StyleSheet, Text, View } from 'react-native'
import type { StoredDevice, VideoItem } from '../types'
import { useTheme } from '../theme-context'
import { formatBytes } from '../utils/url'
import { resolveRemoteUrl } from '../services/api'

type Props = {
  device: StoredDevice
  video: VideoItem
  onPress: () => void
  onToggleFavorite?: () => void
  width?: number
}

function withQueryToken(url: string, key: string, token: string) {
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}${key}=${encodeURIComponent(token)}`
}

export function VideoCard({ device, video, onPress, onToggleFavorite, width }: Props) {
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
  const [imageFailed, setImageFailed] = useState(false)

  useEffect(() => {
    setImageFailed(false)
  }, [thumbnailUrl])

  return (
    <Pressable style={({ pressed }) => [styles.card, { width: width ?? '100%' }, pressed && styles.pressed]} onPress={onPress}>
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
          <Pressable style={styles.favoriteButton} onPress={onToggleFavorite}>
            <Heart
              color={video.favorite ? colors.text : colors.muted}
              fill={video.favorite ? colors.danger : 'none'}
              size={17}
            />
          </Pressable>
        ) : null}
      </View>
      <View style={styles.body}>
        <Text style={styles.name} numberOfLines={2}>{video.name || video.fileName || video.id}</Text>
        <Text style={styles.meta} numberOfLines={1}>
          {[video.extension?.replace('.', '').toUpperCase(), formatBytes(video.size), video.directoryName || video.group].filter(Boolean).join(' · ')}
        </Text>
        {video.tags?.length ? (
          <Text style={styles.tags} numberOfLines={1}>{video.tags.join(' / ')}</Text>
        ) : null}
      </View>
    </Pressable>
  )
}

const createStyles = (colors: ReturnType<typeof useTheme>['colors']) => StyleSheet.create({
  card: {
    borderRadius: 8,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden'
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
