import { memo } from 'react'
import { Image, Pressable, StyleSheet, View } from 'react-native'
import { Film } from 'lucide-react-native'
import type { GestureResponderEvent } from 'react-native'
import type { VideoContentFit, VideoPlayer } from 'expo-video'
import type { NativeVideoPlayerHandle } from './NativeVideoPlayer'
import { NativeVideoPlayer } from './NativeVideoPlayer'
import type { VideoItem } from '../../types'
import { LONG_PRESS_DELAY_MS } from '../../screens/player/playerLayout'

type Props = {
  video: VideoItem
  thumbnailUrl: string
  isActive: boolean
  width: number
  height: number
  player: VideoPlayer
  contentFit: VideoContentFit
  useCoverBackground: boolean
  videoRef: React.RefObject<NativeVideoPlayerHandle | null>
  children?: React.ReactNode
  onPress: () => void
  onLongPress: (event: GestureResponderEvent) => void
  onPressOut: () => void
}

function VideoFeedItemBase({
  thumbnailUrl,
  isActive,
  width,
  height,
  player,
  contentFit,
  useCoverBackground,
  videoRef,
  children,
  onPress,
  onLongPress,
  onPressOut
}: Props) {
  return (
    <View style={[styles.page, { width, height }]}>
      {useCoverBackground && thumbnailUrl ? (
        <>
          <Image source={{ uri: thumbnailUrl, cache: 'force-cache' }} style={styles.backgroundImage} blurRadius={contentFit === 'contain' ? 28 : 18} />
          <View style={styles.backgroundOverlay} />
        </>
      ) : null}
      {isActive ? (
        <>
          <NativeVideoPlayer
            ref={videoRef}
            player={player}
            contentFit={contentFit}
          />
          <Pressable
            style={styles.touchLayer}
            delayLongPress={LONG_PRESS_DELAY_MS}
            onPress={onPress}
            onLongPress={onLongPress}
            onPressOut={onPressOut}
          />
          {children}
        </>
      ) : thumbnailUrl ? (
        <Image source={{ uri: thumbnailUrl, cache: 'force-cache' }} style={styles.previewImage} resizeMode="contain" />
      ) : (
        <View style={styles.previewFallback}>
          <Film color="rgba(255,255,255,0.44)" size={44} />
        </View>
      )}
    </View>
  )
}

export const VideoFeedItem = memo(VideoFeedItemBase)

const styles = StyleSheet.create({
  page: {
    backgroundColor: '#000',
    overflow: 'hidden'
  },
  backgroundImage: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    width: '100%',
    height: '100%'
  },
  backgroundOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(0,0,0,0.48)'
  },
  previewImage: {
    width: '100%',
    height: '100%'
  },
  previewFallback: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#05070a'
  },
  touchLayer: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0
  }
})
