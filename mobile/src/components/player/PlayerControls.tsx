import { Brain, Download, Expand, Heart, Minimize, MonitorPlay, MoreHorizontal, Pause, Play, Tag } from 'lucide-react-native'
import { Pressable, StyleSheet, View } from 'react-native'
import { colors } from '../../theme'
import { HIT_SLOP, TOP_SAFE_OFFSET } from '../../screens/player/playerLayout'
import { PlaybackProgress } from './PlaybackProgress'

type Props = {
  visible: boolean
  isPlaying: boolean
  currentTime: number
  duration: number
  fullscreenMode: boolean
  favorite: boolean
  bottomOffset: number
  onTogglePlayback: () => void
  onSeek: (time: number) => void
  onFavorite: () => void
  onTags: () => void
  onAnalysis: () => void
  onCache: () => void
  onDesktopPlay: () => void
  onMore: () => void
  onFullscreen: () => void
  onInteract: () => void
}

export function PlayerControls({
  visible,
  isPlaying,
  currentTime,
  duration,
  fullscreenMode,
  favorite,
  bottomOffset,
  onTogglePlayback,
  onSeek,
  onFavorite,
  onTags,
  onAnalysis,
  onCache,
  onDesktopPlay,
  onMore,
  onFullscreen,
  onInteract
}: Props) {
  if (!visible) return null
  const FullscreenIcon = fullscreenMode ? Minimize : Expand

  return (
    <View style={styles.shell} pointerEvents="box-none">
      <View style={[fullscreenMode ? styles.bottomRight : styles.topRight, fullscreenMode && { bottom: bottomOffset + 42 }]} pointerEvents="box-none">
        <Pressable style={styles.iconButton} onPress={() => { onInteract(); onFullscreen() }} hitSlop={HIT_SLOP}>
          <FullscreenIcon color={colors.text} size={21} />
        </Pressable>
        {fullscreenMode ? (
          <>
            <Pressable style={styles.iconButton} onPress={() => { onInteract(); onFavorite() }} hitSlop={HIT_SLOP}>
              <Heart color={favorite ? colors.danger : colors.text} fill={favorite ? colors.danger : 'none'} size={20} />
            </Pressable>
            <Pressable style={styles.iconButton} onPress={() => { onInteract(); onTags() }} hitSlop={HIT_SLOP}>
              <Tag color={colors.text} size={20} />
            </Pressable>
            <Pressable style={styles.iconButton} onPress={() => { onInteract(); onAnalysis() }} hitSlop={HIT_SLOP}>
              <Brain color={colors.text} size={20} />
            </Pressable>
            <Pressable style={styles.iconButton} onPress={() => { onInteract(); onCache() }} hitSlop={HIT_SLOP}>
              <Download color={colors.text} size={20} />
            </Pressable>
            <Pressable style={styles.iconButton} onPress={() => { onInteract(); onDesktopPlay() }} hitSlop={HIT_SLOP}>
              <MonitorPlay color={colors.text} size={20} />
            </Pressable>
          </>
        ) : null}
        <Pressable style={styles.iconButton} onPress={() => { onInteract(); onMore() }} hitSlop={HIT_SLOP}>
          <MoreHorizontal color={colors.text} size={23} />
        </Pressable>
      </View>

      <Pressable style={styles.centerButton} onPress={() => { onInteract(); onTogglePlayback() }} hitSlop={HIT_SLOP}>
        {isPlaying
          ? <Pause color={colors.text} fill={colors.text} size={34} />
          : <Play color={colors.text} fill={colors.text} size={38} />}
      </Pressable>

      <View style={[styles.bottomControls, { bottom: bottomOffset }]}>
        <PlaybackProgress
          currentTime={currentTime}
          duration={duration}
          onSeek={onSeek}
          onScrubChange={() => onInteract()}
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
    top: TOP_SAFE_OFFSET + 8,
    right: 12,
    flexDirection: 'row',
    gap: 8
  },
  bottomRight: {
    position: 'absolute',
    right: 12,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: 8,
    maxWidth: '72%'
  },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
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
    position: 'absolute',
    left: 12,
    right: 12
  }
})
