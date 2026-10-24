import { useState } from 'react'
import { Expand, Minimize, MoreHorizontal, Pause, Play } from 'lucide-react-native'
import { Pressable, StyleSheet, View } from 'react-native'
import type { EdgeInsets } from 'react-native-safe-area-context'
import { colors } from '../../theme'
import { HIT_SLOP } from '../../screens/player/playerLayout'
import { PlaybackProgress } from './PlaybackProgress'

type Props = {
  visible: boolean
  isPlaying: boolean
  currentTime: number
  duration: number
  fullscreenMode: boolean
  bottomOffset: number
  safeAreaInsets: EdgeInsets
  onTogglePlayback: () => void
  onSeek: (time: number) => void
  onMore: () => void
  onFullscreen: () => void
  onInteract: (holding?: boolean) => void
  onProgressHeight?: (height: number) => void
}

export function PlayerControls({
  visible,
  isPlaying,
  currentTime,
  duration,
  fullscreenMode,
  bottomOffset,
  safeAreaInsets,
  onTogglePlayback,
  onSeek,
  onMore,
  onFullscreen,
  onInteract,
  onProgressHeight
}: Props) {
  const [progressHeight, setProgressHeight] = useState(80)
  if (!visible) return null
  const FullscreenIcon = fullscreenMode ? Minimize : Expand

  return (
    <View style={styles.shell} pointerEvents="box-none">
      <View style={[
        fullscreenMode ? styles.bottomRight : styles.topRight,
        fullscreenMode
          ? { right: safeAreaInsets.right + 12, bottom: bottomOffset + progressHeight + 12 }
          : { right: safeAreaInsets.right + 12, top: safeAreaInsets.top + 8 }
      ]} pointerEvents="box-none">
        <Pressable accessibilityRole="button" accessibilityLabel={fullscreenMode ? '退出横屏全屏' : '进入横屏全屏'} style={styles.iconButton} onPress={() => { onInteract(); onFullscreen() }} hitSlop={HIT_SLOP}>
          <FullscreenIcon color={colors.text} size={21} />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="更多播放设置" style={styles.iconButton} onPress={() => { onInteract(); onMore() }} hitSlop={HIT_SLOP}>
          <MoreHorizontal color={colors.text} size={23} />
        </Pressable>
      </View>

      <Pressable accessibilityRole="button" accessibilityLabel={isPlaying ? '暂停' : '播放'} style={styles.centerButton} onPress={() => { onInteract(); onTogglePlayback() }} hitSlop={HIT_SLOP}>
        {isPlaying
          ? <Pause color={colors.text} fill={colors.text} size={34} />
          : <Play color={colors.text} fill={colors.text} size={38} />}
      </Pressable>

      <View onLayout={event => { const height = event.nativeEvent.layout.height; if (height > 0) { setProgressHeight(height); onProgressHeight?.(height) } }} style={[styles.bottomControls, {
        bottom: bottomOffset,
        left: safeAreaInsets.left + 12,
        right: safeAreaInsets.right + 12
      }]}>
        <PlaybackProgress
          currentTime={currentTime}
          duration={duration}
          onSeek={onSeek}
          onScrubChange={onInteract}
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  shell: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(0,0,0,0.12)'
  },
  topRight: {
    position: 'absolute',
    flexDirection: 'row',
    gap: 8
  },
  bottomRight: {
    position: 'absolute',
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: 8,
    maxWidth: '72%'
  },
  iconButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(0,0,0,0.38)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  centerButton: {
    position: 'absolute',
    alignSelf: 'center',
    top: '43%',
    width: 78,
    height: 78,
    borderRadius: 39,
    backgroundColor: 'rgba(0,0,0,0.42)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  bottomControls: {
    position: 'absolute'
  }
})
