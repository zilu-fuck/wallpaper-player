import { Copy, EyeOff, FileText, FolderOpen } from 'lucide-react-native'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useTheme } from '../../theme-context'
import type { ThemeColors } from '../../theme'
import type { VideoItem } from '../../types'
import { getVideoTitle } from '../../screens/player/playerUtils'
import type { MobilePlayerBackgroundMode } from '../../persistence/settings'
import { PlayerSheetFrame } from './PlayerSheetFrame'

export type AspectMode = 'fit' | 'fill' | 'original'

type Props = {
  visible: boolean
  notice?: string
  video: VideoItem
  playbackRate: number
  aspectMode: AspectMode
  playerBackgroundMode: MobilePlayerBackgroundMode
  selectedQuality: string
  detailLine: string
  networkResource?: boolean
  favorite: boolean
  onFavorite: () => void
  onTags: () => void
  onAnalysis: () => void
  onCache: () => void
  onDesktopPlay: () => void
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

export function PlayerMoreSheet(props: Props) {
  const { colors } = useTheme(), styles = createStyles(colors)
  if (!props.visible) return null
  const choices = <T extends string | number,>(label: string, options: Array<{ value: T; label: string }>, selected: T, select: (value: T) => void) => <View style={styles.section}>
    <Text accessibilityRole="header" style={styles.heading}>{label}</Text><View style={styles.wrap}>{options.map(option => <Pressable key={option.value}
      accessibilityRole="radio" accessibilityLabel={label + '：' + option.label} accessibilityState={{ checked: selected === option.value }}
      style={[styles.pill, selected === option.value && styles.selected]} onPress={() => select(option.value)}>
      <Text style={[styles.text, selected === option.value && styles.onSelected]}>{option.label}</Text></Pressable>)}</View></View>
  const item = (label: string, action: () => void, value?: string, icon?: React.ReactNode) => <Pressable key={label} accessibilityRole="button"
    accessibilityLabel={label + (value ? '，' + value : '')} onPress={action} style={styles.item}>
    <View style={styles.row}>{icon}<Text style={styles.label}>{label}</Text></View>{value ? <Text style={styles.value}>{value}</Text> : null}</Pressable>
  return <PlayerSheetFrame title="播放设置" onClose={props.onClose} notice={props.notice}>
    <Text style={styles.name}>{getVideoTitle(props.video)}</Text><Text style={styles.value}>{props.detailLine}</Text>
    {choices('播放速度', speedOptions.map(value => ({ value, label: value.toFixed(1) + 'x' })), props.playbackRate, props.onSpeedChange)}
    {choices('画面比例', aspectOptions, props.aspectMode, props.onAspectModeChange)}
    {choices('播放背景', backgroundOptions, props.playerBackgroundMode, props.onPlayerBackgroundModeChange)}
    {!props.networkResource ? choices('清晰度', qualityOptions.map(value => ({ value, label: value })), props.selectedQuality, props.onQualitySelect) : null}
    <Text accessibilityRole="header" style={styles.heading}>视频操作</Text>
    {item(props.favorite ? '取消收藏' : '收藏', props.onFavorite)}
    {item('管理标签', props.onTags)}
    {!props.networkResource ? item('视频分析', props.onAnalysis) : null}
    {!props.networkResource ? item('缓存兼容格式', props.onCache) : null}
    {item('在电脑端播放', props.onDesktopPlay)}
    {item('字幕选择', props.onSubtitleSelect, '暂无可选字幕')}{item('音轨选择', props.onAudioTrackSelect, '默认音轨')}
    {item('复制视频名称', props.onCopyName, undefined, <Copy color={colors.text} size={20} />)}
    {!props.networkResource ? item('在电脑中定位文件', props.onRevealOnDesktop, undefined, <FolderOpen color={colors.text} size={20} />) : null}
    {!props.networkResource ? item('清理转码缓存', props.onClearTranscodeCache, '释放电脑端缓存') : null}
    {item(props.networkResource ? '查看资源信息' : '查看文件信息', props.onFileInfo, props.detailLine, <FileText color={colors.text} size={20} />)}
    {item('从播放列表隐藏', props.onHideFromPlaylist, undefined, <EyeOff color={colors.danger} size={20} />)}
  </PlayerSheetFrame>
}
const createStyles = (colors: ThemeColors) => StyleSheet.create({
  name: { color: colors.text, fontSize: 16, fontWeight: '700' }, value: { color: colors.muted, fontSize: 13 },
  section: { gap: 8 }, heading: { color: colors.text, fontSize: 14, fontWeight: '800' }, wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pill: { minHeight: 48, maxWidth: '100%', padding: 12, backgroundColor: colors.surfaceElevated, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  selected: { backgroundColor: colors.accentStrong }, onSelected: { color: colors.onAccent }, text: { color: colors.text, fontSize: 14, fontWeight: '700' },
  item: { minHeight: 48, padding: 12, gap: 6, borderRadius: 8, backgroundColor: colors.surfaceElevated }, row: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  label: { color: colors.text, fontSize: 14, fontWeight: '700', flex: 1, minWidth: 0 }
})
