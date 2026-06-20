import { forwardRef } from 'react'
import type { ComponentRef } from 'react'
import { Platform, StyleSheet } from 'react-native'
import { VideoView } from 'expo-video'
import type { VideoContentFit, VideoPlayer } from 'expo-video'

export type NativeVideoPlayerHandle = ComponentRef<typeof VideoView>

type Props = {
  player: VideoPlayer
  contentFit: VideoContentFit
}

export const NativeVideoPlayer = forwardRef<NativeVideoPlayerHandle, Props>(({
  player,
  contentFit
}, ref) => (
  <VideoView
    ref={ref}
    player={player}
    style={styles.video}
    contentFit={contentFit}
    fullscreenOptions={{ enable: false }}
    allowsPictureInPicture
    nativeControls={false}
    surfaceType={Platform.OS === 'android' ? 'textureView' : undefined}
  />
))

const styles = StyleSheet.create({
  video: {
    width: '100%',
    height: '100%'
  }
})
