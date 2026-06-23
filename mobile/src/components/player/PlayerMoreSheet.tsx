import { Check, ChevronDown, Copy, EyeOff, FileText, FolderOpen } from 'lucide-react-native'
import { useMemo } from 'react'
import { PanResponder, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { colors } from '../../theme'
import type { VideoItem } from '../../types'
import { BOTTOM_SAFE_OFFSET } from '../../screens/player/playerLayout'
import { getVideoTitle } from '../../screens/player/playerUtils'
import type { MobilePlayerBackgroundMode } from '../../stores/settings'

export type AspectMode = 'fit' | 'fill' | 'original'

type Props = {
  visible: boolean
  video: VideoItem
  playbackRate: number
  aspectMode: AspectMode
  playerBackgroundMode: MobilePlayerBackgroundMode
  selectedQuality: string
  detailLine: string
  onClose: () => void
  onSpeedChange: (speed: number) => void
  onAspectModeChange: (mode: AspectMode) => void
  onPlayerBackgroundModeChange: (mode: MobilePlayerBackgroundMode) => void
  onQualitySelect: (quality: string) => void
  onSubtitleSelect: () => void
  onAudioTrackSelect: () => void
  onCopyName: () => void
  onRevealOnDesktop: () => void
  onClearTranscodeCache: () => void
  onFileInfo: () => void
  onHideFromPlaylist: () => void
}

const speedOptions = [0.5, 1, 1.5, 2]
const aspectOptions: Array<{ value: AspectMode, label: string }> = [
  { value: 'fit', label: '适应' },
  { value: 'fill', label: '填充' },
  { value: 'original', label: '原始比例' }
]
const backgroundOptions: Array<{ value: MobilePlayerBackgroundMode, label: string }> = [
  { value: 'black', label: '黑色' },
  { value: 'cover', label: '封面' }
]
const qualityOptions = ['原画', '1080p', '720p', '480p']

export function PlayerMoreSheet({
  visible,
  video,
  playbackRate,
  aspectMode,
  playerBackgroundMode,
  selectedQuality,
  detailLine,
  onClose,
  onSpeedChange,
  onAspectModeChange,
  onPlayerBackgroundModeChange,
  onQualitySelect,
  onSubtitleSelect,
  onAudioTrackSelect,
  onCopyName,
  onRevealOnDesktop,
  onClearTranscodeCache,
  onFileInfo,
  onHideFromPlaylist
}: Props) {
  const panResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_event, gesture) => gesture.dy > 16 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
    onPanResponderRelease: (_event, gesture) => {
      if (gesture.dy > 48) onClose()
    }
  }), [onClose])

  if (!visible) return null

  return (
    <View style={styles.backdrop}>
      <Pressable style={styles.backdropPress} onPress={onClose} />
      <View style={styles.sheet} {...panResponder.panHandlers}>
        <View style={styles.handleWrap}>
          <View style={styles.handle} />
        </View>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.title} numberOfLines={1}>{getVideoTitle(video)}</Text>
            <Text style={styles.subtitle} numberOfLines={1}>{detailLine}</Text>
          </View>
          <Pressable style={styles.closeButton} onPress={onClose}>
            <ChevronDown color={colors.text} size={22} />
          </Pressable>
        </View>

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
          <Text style={styles.sectionTitle}>播放速度</Text>
          <View style={styles.optionRow}>
            {speedOptions.map(speed => (
              <Pressable
                key={speed}
                style={[styles.pill, playbackRate === speed && styles.pillActive]}
                onPress={() => onSpeedChange(speed)}
              >
                <Text style={[styles.pillText, playbackRate === speed && styles.pillTextActive]}>
                  {speed.toFixed(1)}x
                </Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.sectionTitle}>画面比例</Text>
          <View style={styles.optionRow}>
            {aspectOptions.map(option => (
              <Pressable
                key={option.value}
                style={[styles.pill, aspectMode === option.value && styles.pillActive]}
                onPress={() => onAspectModeChange(option.value)}
              >
                <Text style={[styles.pillText, aspectMode === option.value && styles.pillTextActive]}>
                  {option.label}
                </Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.sectionTitle}>播放背景</Text>
          <View style={styles.optionRow}>
            {backgroundOptions.map(option => (
              <Pressable
                key={option.value}
                style={[styles.pill, playerBackgroundMode === option.value && styles.pillActive]}
                onPress={() => onPlayerBackgroundModeChange(option.value)}
              >
                <Text style={[styles.pillText, playerBackgroundMode === option.value && styles.pillTextActive]}>
                  {option.label}
                </Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.sectionTitle}>清晰度</Text>
          <View style={styles.optionRow}>
            {qualityOptions.map((quality) => (
              <Pressable
                key={quality}
                style={[styles.pill, selectedQuality === quality && styles.pillActive]}
                onPress={() => onQualitySelect(quality)}
              >
                <Text style={[styles.pillText, selectedQuality === quality && styles.pillTextActive]}>{quality}</Text>
              </Pressable>
            ))}
          </View>

          <MenuItem label="字幕选择" value="暂无可选字幕" onPress={onSubtitleSelect} />
          <MenuItem label="音轨选择" value="默认音轨" onPress={onAudioTrackSelect} />
          <MenuItem label="复制视频名称" icon={<Copy color={colors.text} size={19} />} onPress={onCopyName} />
          <MenuItem label="在电脑中定位文件" icon={<FolderOpen color={colors.text} size={19} />} onPress={onRevealOnDesktop} />
          <MenuItem label="清理转码缓存" value="释放电脑端缓存" onPress={onClearTranscodeCache} />
          <MenuItem label="查看文件信息" value={detailLine} icon={<FileText color={colors.text} size={19} />} onPress={onFileInfo} />
          <MenuItem label="从播放列表隐藏" danger icon={<EyeOff color={colors.danger} size={19} />} onPress={onHideFromPlaylist} />
        </ScrollView>
      </View>
    </View>
  )
}

function MenuItem({
  label,
  value,
  icon,
  danger = false,
  onPress
}: {
  label: string
  value?: string
  icon?: React.ReactNode
  danger?: boolean
  onPress: () => void
}) {
  return (
    <Pressable style={styles.menuItem} onPress={onPress}>
      <View style={styles.menuLeft}>
        {icon || <Check color={danger ? colors.danger : 'rgba(255,255,255,0.56)'} size={18} />}
        <Text style={[styles.menuLabel, danger && styles.menuDanger]}>{label}</Text>
      </View>
      {value ? <Text style={styles.menuValue} numberOfLines={1}>{value}</Text> : null}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(0,0,0,0.34)',
    justifyContent: 'flex-end'
  },
  backdropPress: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0
  },
  sheet: {
    maxHeight: '78%',
    paddingBottom: BOTTOM_SAFE_OFFSET + 12,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    backgroundColor: 'rgba(12,12,12,0.96)',
    overflow: 'hidden'
  },
  handleWrap: {
    height: 22,
    alignItems: 'center',
    justifyContent: 'center'
  },
  handle: {
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.24)'
  },
  header: {
    paddingHorizontal: 16,
    paddingBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12
  },
  headerText: {
    flex: 1
  },
  title: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '800'
  },
  subtitle: {
    marginTop: 3,
    color: 'rgba(255,255,255,0.62)',
    fontSize: 12
  },
  closeButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  content: {
    paddingHorizontal: 16,
    paddingBottom: 8,
    gap: 10
  },
  sectionTitle: {
    marginTop: 8,
    color: 'rgba(255,255,255,0.7)',
    fontSize: 12,
    fontWeight: '800'
  },
  optionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8
  },
  pill: {
    minHeight: 36,
    paddingHorizontal: 14,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  pillActive: {
    backgroundColor: 'rgba(79,182,255,0.22)'
  },
  pillText: {
    color: 'rgba(255,255,255,0.78)',
    fontSize: 13,
    fontWeight: '800'
  },
  pillTextActive: {
    color: colors.text
  },
  menuItem: {
    minHeight: 46,
    borderRadius: 8,
    paddingHorizontal: 10,
    backgroundColor: 'rgba(255,255,255,0.05)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12
  },
  menuLeft: {
    minWidth: 0,
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10
  },
  menuLabel: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '700'
  },
  menuDanger: {
    color: colors.danger
  },
  menuValue: {
    maxWidth: '45%',
    color: 'rgba(255,255,255,0.56)',
    fontSize: 12
  }
})
