import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { ArrowLeft, Play } from 'lucide-react-native'
import { colors } from '../../theme'
import type { VideoItem } from '../../types'
import { BOTTOM_SAFE_OFFSET, HIT_SLOP, TOP_SAFE_OFFSET } from '../../screens/player/playerLayout'
import { FavoriteAnimation } from './FavoriteAnimation'
import { PlaybackProgress } from './PlaybackProgress'
import { PlayerControls } from './PlayerControls'
import { TranscodingStatus } from './TranscodingStatus'
import { VideoActionBar } from './VideoActionBar'
import { VideoErrorState } from './VideoErrorState'
import { VideoInfo } from './VideoInfo'

type Props = {
  video: VideoItem
  favorite: boolean
  status: 'loading' | 'ready' | 'buffering' | 'error'
  error: string
  isPlaying: boolean
  currentTime: number
  duration: number
  controlsVisible: boolean
  heartBurst: boolean
  speedBoostMode: 'forward' | 'rewind' | null
  gestureHint: string
  networkSlow: boolean
  transcoding: boolean
  transcodeProgress: number
  groupLine: string
  detailLine: string
  landscapeMode: boolean
  onBack: () => void
  onRetry: () => void
  onTogglePlayback: () => void
  onSeek: (time: number) => void
  onFavorite: () => void
  onTags: () => void
  onCache: () => void
  onDesktopPlay: () => void
  onMore: () => void
  onFullscreen: () => void
  onControlsInteract: () => void
  onTranscode: () => void
  onCancelTranscode: () => void
  onErrorDetails: () => void
}

export function VideoOverlay({
  video,
  favorite,
  status,
  error,
  isPlaying,
  currentTime,
  duration,
  controlsVisible,
  heartBurst,
  speedBoostMode,
  gestureHint,
  networkSlow,
  transcoding,
  transcodeProgress,
  groupLine,
  detailLine,
  landscapeMode,
  onBack,
  onRetry,
  onTogglePlayback,
  onSeek,
  onFavorite,
  onTags,
  onCache,
  onDesktopPlay,
  onMore,
  onFullscreen,
  onControlsInteract,
  onTranscode,
  onCancelTranscode,
  onErrorDetails
}: Props) {
  const infoBottom = BOTTOM_SAFE_OFFSET + (controlsVisible ? 88 : 54)
  const actionsBottom = BOTTOM_SAFE_OFFSET + (controlsVisible ? 112 : 74)
  const progressBottom = BOTTOM_SAFE_OFFSET + 7

  return (
    <View style={styles.overlayLayer} pointerEvents="box-none">
      {(!landscapeMode || controlsVisible) ? (
        <View style={styles.topOverlay} pointerEvents="box-none">
          <Pressable style={styles.backButton} onPress={onBack} hitSlop={HIT_SLOP}>
            <ArrowLeft color={colors.text} size={22} />
          </Pressable>
        </View>
      ) : null}

      {status === 'loading' || status === 'buffering' ? (
        <View style={styles.centerState} pointerEvents="none">
          <ActivityIndicator color={colors.text} size="small" />
        </View>
      ) : null}

      {status === 'error' && !transcoding ? (
        <VideoErrorState
          error={error}
          onRetry={onRetry}
          onTranscode={onTranscode}
          onDetails={onErrorDetails}
        />
      ) : null}

      {transcoding ? (
        <TranscodingStatus
          progress={transcodeProgress}
          onCancel={onCancelTranscode}
        />
      ) : null}

      {!isPlaying && status !== 'error' && !controlsVisible ? (
        <View style={styles.pauseBadge} pointerEvents="none">
          <Play color={colors.text} size={38} fill={colors.text} />
        </View>
      ) : null}

      <FavoriteAnimation visible={heartBurst} />

      {speedBoostMode ? (
        <View style={styles.speedHint} pointerEvents="none">
          <Text style={styles.speedHintText}>{speedBoostMode === 'rewind' ? '2x 快退中' : '2x 快进中'}</Text>
        </View>
      ) : null}

      {gestureHint ? (
        <View style={styles.gestureHint} pointerEvents="none">
          <Text style={styles.gestureHintText}>{gestureHint}</Text>
        </View>
      ) : null}

      {networkSlow && status !== 'error' ? (
        <View style={styles.networkHint} pointerEvents="none">
          <Text style={styles.networkHintText}>网络较慢，正在缓冲</Text>
        </View>
      ) : null}

      {!landscapeMode ? (
        <VideoActionBar
          favorite={favorite}
          bottomOffset={actionsBottom}
          onFavorite={onFavorite}
          onTags={onTags}
          onCache={onCache}
          onDesktopPlay={onDesktopPlay}
          onMore={onMore}
        />
      ) : null}

      {!landscapeMode ? (
        <VideoInfo
          video={video}
          favorite={favorite}
          groupLine={groupLine}
          detailLine={detailLine}
          bottomOffset={infoBottom}
        />
      ) : null}

      {!controlsVisible ? (
        <View style={[styles.progressArea, { bottom: progressBottom }]} pointerEvents="box-none">
          <PlaybackProgress
            compact
            currentTime={currentTime}
            duration={duration}
            showTimes
            onSeek={onSeek}
          />
        </View>
      ) : null}

      <PlayerControls
        visible={controlsVisible && status !== 'error'}
        isPlaying={isPlaying}
        currentTime={currentTime}
        duration={duration}
        fullscreenMode={landscapeMode}
        favorite={favorite}
        bottomOffset={BOTTOM_SAFE_OFFSET + 7}
        onTogglePlayback={onTogglePlayback}
        onSeek={onSeek}
        onFavorite={onFavorite}
        onTags={onTags}
        onCache={onCache}
        onDesktopPlay={onDesktopPlay}
        onMore={onMore}
        onFullscreen={onFullscreen}
        onInteract={onControlsInteract}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  overlayLayer: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0
  },
  topOverlay: {
    position: 'absolute',
    top: TOP_SAFE_OFFSET + 8,
    left: 12,
    right: 12,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center'
  },
  backButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.38)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  centerState: {
    position: 'absolute',
    alignSelf: 'center',
    top: '46%',
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  pauseBadge: {
    position: 'absolute',
    alignSelf: 'center',
    top: '44%',
    width: 78,
    height: 78,
    borderRadius: 39,
    backgroundColor: 'rgba(0,0,0,0.42)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  speedHint: {
    position: 'absolute',
    top: TOP_SAFE_OFFSET + 16,
    alignSelf: 'center',
    minHeight: 34,
    paddingHorizontal: 14,
    borderRadius: 17,
    backgroundColor: 'rgba(0,0,0,0.48)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  speedHintText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '800'
  },
  gestureHint: {
    position: 'absolute',
    alignSelf: 'center',
    top: '47%',
    minWidth: 88,
    minHeight: 38,
    paddingHorizontal: 14,
    borderRadius: 19,
    backgroundColor: 'rgba(0,0,0,0.58)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  gestureHintText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '800'
  },
  networkHint: {
    position: 'absolute',
    left: 18,
    top: TOP_SAFE_OFFSET + 66,
    minHeight: 30,
    paddingHorizontal: 12,
    borderRadius: 15,
    backgroundColor: 'rgba(0,0,0,0.42)',
    justifyContent: 'center'
  },
  networkHintText: {
    color: 'rgba(255,255,255,0.78)',
    fontSize: 12,
    fontWeight: '700'
  },
  progressArea: {
    position: 'absolute',
    left: 12,
    right: 12
  }
})
