import { useCallback, useMemo, useState } from 'react'
import { PanResponder, StyleSheet, Text, View } from 'react-native'
import type { GestureResponderEvent, LayoutChangeEvent } from 'react-native'
import { colors } from '../../theme'
import { clamp, formatTime } from '../../screens/player/playerUtils'

type Props = {
  currentTime: number
  duration: number
  compact?: boolean
  showTimes?: boolean
  onSeek: (time: number) => void
  onScrubChange?: (scrubbing: boolean) => void
}

export function PlaybackProgress({
  currentTime,
  duration,
  compact = false,
  showTimes = true,
  onSeek,
  onScrubChange
}: Props) {
  const [width, setWidth] = useState(0)
  const [scrubbing, setScrubbing] = useState(false)
  const [scrubTime, setScrubTime] = useState(0)
  const displayTime = scrubbing ? scrubTime : currentTime
  const progress = duration > 0 ? clamp(displayTime / duration, 0, 1) : 0

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    setWidth(event.nativeEvent.layout.width)
  }, [])

  const setScrubFromLocation = useCallback((locationX: number) => {
    if (duration <= 0 || width <= 0) return
    const nextTime = clamp(locationX / width, 0, 1) * duration
    setScrubTime(nextTime)
    if (!scrubbing) {
      setScrubbing(true)
      onScrubChange?.(true)
    }
  }, [duration, onScrubChange, scrubbing, width])

  const commitScrub = useCallback(() => {
    if (duration > 0) {
      onSeek(clamp(scrubTime, 0, duration))
    }
    setScrubbing(false)
    onScrubChange?.(false)
  }, [duration, onScrubChange, onSeek, scrubTime])

  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => duration > 0,
    onMoveShouldSetPanResponder: () => duration > 0,
    onPanResponderGrant: (event: GestureResponderEvent) => {
      setScrubFromLocation(event.nativeEvent.locationX)
    },
    onPanResponderMove: (event: GestureResponderEvent) => {
      setScrubFromLocation(event.nativeEvent.locationX)
    },
    onPanResponderRelease: commitScrub,
    onPanResponderTerminate: commitScrub
  }), [commitScrub, duration, setScrubFromLocation])

  const previewLeft = width > 0 && duration > 0
    ? clamp(progress * width - 28, 0, Math.max(0, width - 56))
    : 0

  return (
    <View style={compact ? styles.compactShell : styles.shell} pointerEvents="box-none">
      {scrubbing ? (
        <View style={[styles.scrubPreview, { left: previewLeft }]}>
          <Text style={styles.scrubPreviewText}>{formatTime(scrubTime)}</Text>
        </View>
      ) : null}
      {showTimes ? (
        <View style={styles.times} pointerEvents="none">
          <Text style={styles.timeText}>{formatTime(displayTime)}</Text>
          <Text style={styles.timeText}>{duration > 0 ? formatTime(duration) : '--:--'}</Text>
        </View>
      ) : null}
      <View style={styles.touch} onLayout={handleLayout} {...responder.panHandlers}>
        <View style={[styles.track, compact && styles.trackCompact, scrubbing && styles.trackActive]}>
          <View style={[styles.fill, { width: `${progress * 100}%` }]} />
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  shell: {
    width: '100%'
  },
  compactShell: {
    width: '100%'
  },
  times: {
    marginBottom: 3,
    flexDirection: 'row',
    justifyContent: 'space-between'
  },
  timeText: {
    color: 'rgba(255,255,255,0.62)',
    fontSize: 10,
    fontWeight: '700',
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowRadius: 3,
    textShadowOffset: { width: 0, height: 1 }
  },
  touch: {
    height: 24,
    justifyContent: 'center'
  },
  track: {
    height: 4,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.28)',
    overflow: 'hidden'
  },
  trackCompact: {
    height: 2,
    backgroundColor: 'rgba(255,255,255,0.2)'
  },
  trackActive: {
    height: 5,
    backgroundColor: 'rgba(255,255,255,0.3)'
  },
  fill: {
    height: '100%',
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.9)'
  },
  scrubPreview: {
    position: 'absolute',
    bottom: 30,
    width: 56,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.62)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  scrubPreviewText: {
    color: colors.text,
    fontSize: 11,
    fontWeight: '800'
  }
})
