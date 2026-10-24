import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { PlayCircle, RefreshCw } from 'lucide-react-native'
import { useTheme } from '../../theme-context'
import type { ThemeColors } from '../../theme'
import type { VideoAnalysisResponse, VideoAnalysisResult, VideoAnalysisTimelineItem, VideoItem } from '../../types'
import { getVideoTitle } from '../../screens/player/playerUtils'
import { formatTime, uniqueTags } from '../../utils/url'
import { PlayerSheetFrame } from './PlayerSheetFrame'

type Props = {
  visible: boolean; video: VideoItem; state: VideoAnalysisResponse | null; loading: boolean; starting: boolean; cancelling?: boolean
  currentTime: number; notice?: string; selectedTags: string[]; addingTags?: boolean; onSelectionChange: (tags: string[]) => void
  onClose: () => void; onRefresh: () => void; onStart: () => void; onCancel?: () => void; onSeek: (time: number) => void
  onAddTags?: (tags: string[]) => void
}
function getTimelineTitle(item: VideoAnalysisTimelineItem) {
  if (item.title) return item.title
  return `${formatTime(item.start_time)} - ${formatTime(item.end_time)}`
}

function getProgressMessage(state: VideoAnalysisResponse | null) {
  const event = state?.job?.lastEvent || state?.recent?.event
  if (event?.message) return event.message
  if (state?.recent?.message) return state.recent.message
  if (state?.job?.running) return state.job.currentVideo ? '电脑端正在分析当前视频' : '电脑端正在分析其他视频'
  if (state?.recent?.status === 'error') return state.recent.error || '分析失败'
  if (state?.recent?.status === 'success') return '分析完成'
  return ''
}

function getAnalysisTitle(video: VideoItem, analysis: VideoAnalysisResult | null) {
  return analysis?.naming?.episode_title || analysis?.sourceVideo?.original_filename || getVideoTitle(video)
}

export function VideoAnalysisSheet({ visible, video, state, loading, starting, cancelling = false, currentTime, notice,
  selectedTags: selectedAnalysisTags, addingTags = false, onSelectionChange, onClose, onRefresh, onStart, onCancel, onSeek, onAddTags }: Props) {
  const { colors } = useTheme(), styles = createStyles(colors)
  if (!visible) return null
  const analysis = state?.analysis?.available ? state.analysis : state?.recent?.analysis?.available ? state.recent.analysis : null
  const timeline = Array.isArray(analysis?.timeline) ? analysis.timeline : []
  const currentSegment = timeline.find(item => (
    currentTime >= Number(item.start_time || 0) &&
    currentTime <= Number(item.end_time || 0)
  ))
  const timelineItems = currentSegment
    ? [currentSegment, ...timeline.filter(item => item !== currentSegment)].slice(0, 8)
    : timeline.slice(0, 8)
  const tags = Array.isArray(analysis?.tags) ? analysis.tags.slice(0, 8) : []
  const candidateTags = uniqueTags([
    ...(Array.isArray(analysis?.tags) ? analysis.tags : []),
    ...(Array.isArray(analysis?.keywords) ? analysis.keywords : [])
  ]).slice(0, 24)
  const canAddTags = Boolean(onAddTags && candidateTags.length)
  const characters = Array.isArray(analysis?.characters) ? analysis.characters : []
  const analyzedCount = timeline.filter(item => item.vlm_status === 'analyzed').length
  const running = Boolean(state?.job?.running)
  const disabled = state?.enabled === false
  const pluginUnavailable = disabled && (state?.reason === 'plugin_unavailable' || state?.analysis?.reason === 'plugin_unavailable')
  const progressMessage = getProgressMessage(state)
  const canJoin = Boolean(onCancel && state?.job?.running && state.job.currentVideo && !state.job.canCancel)
  const canStart = !loading && !disabled && (!running || canJoin) && !starting && !cancelling
  const canCancel = Boolean(onCancel && (starting || (state?.job?.currentVideo && state.job.canCancel)))
  const statusTone = disabled || state?.recent?.status === 'error'
    ? 'error'
    : running
      ? 'running'
      : analysis
        ? 'ready'
        : 'empty'
  const statusTitle = pluginUnavailable
    ? '插件未启用'
    : disabled
      ? '电脑端尚未开启'
    : running
      ? (state?.job?.currentVideo ? '正在分析当前视频' : '分析队列忙碌中')
      : state?.recent?.status === 'error'
        ? '上次分析失败'
      : analysis
        ? '已生成分析结果'
        : '还没有分析结果'
  const statusText = pluginUnavailable
    ? (state?.error || '请在电脑端插件管理中启用视频分析插件。')
    : disabled
      ? '请先在电脑端插件管理中启用视频分析，并完成模型配置。'
    : running
      ? (progressMessage || '电脑端正在运行模型，手机会自动刷新结果。')
      : state?.recent?.status === 'error'
        ? (state.recent.error || '请检查电脑端模型配置后重试。')
        : analysis
          ? (analysis.savedAt ? `保存时间 ${analysis.savedAt.replace('T', ' ').slice(0, 16)}` : '结果已保存，可随时重新打开。')
          : '点击开始后，模型会在电脑端运行，手机只接收进度和结果。'
  return <PlayerSheetFrame title="视频分析" onClose={onClose} notice={notice}>
    <Text style={styles.name}>{getAnalysisTitle(video, analysis)}</Text>
    <View style={[styles.stateBox, { borderColor: statusTone === 'error' ? colors.danger : colors.border }]}>
      <View style={styles.row}>{running ? <ActivityIndicator color={colors.accent} size="small" /> : null}
        <Text style={styles.heading}>{statusTitle}</Text></View>
      <Text accessibilityLiveRegion="polite" style={styles.text}>{statusText}</Text>
    </View>
    <View style={styles.actions}>
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: !canStart, busy: starting }} style={styles.primary} onPress={onStart} disabled={!canStart}>
        {starting ? <ActivityIndicator color={colors.onAccent} size="small" /> : <PlayCircle color={colors.onAccent} size={18} />}
        <Text style={styles.primaryText}>{canJoin ? '加入当前分析' : analysis ? '重新分析' : '开始分析'}</Text></Pressable>
      {canCancel ? <Pressable accessibilityRole="button" accessibilityLabel="取消本次分析" accessibilityState={{ disabled: cancelling, busy: cancelling }}
        style={styles.secondary} onPress={onCancel} disabled={cancelling}><Text style={styles.buttonText}>{cancelling ? '取消中…' : '取消本次分析'}</Text></Pressable> : null}
      <Pressable accessibilityRole="button" accessibilityLabel="刷新分析状态" accessibilityState={{ disabled: loading, busy: loading }} style={styles.secondary} onPress={onRefresh} disabled={loading}>
        {loading ? <ActivityIndicator color={colors.text} size="small" /> : <RefreshCw color={colors.text} size={18} />}<Text style={styles.buttonText}>刷新</Text></Pressable>
    </View>
    {analysis ? <View style={styles.wrap}>{[[timeline.length, '段落'], [analyzedCount, '视觉分析'], [characters.length, '人物']].map(([value, label]) =>
      <View key={label} style={styles.meta}><Text style={styles.heading}>{value}</Text><Text style={styles.muted}>{label}</Text></View>)}</View> : null}
    {analysis?.summary ? <View style={styles.section}><Text accessibilityRole="header" style={styles.heading}>摘要</Text><Text style={styles.text}>{analysis.summary}</Text></View> : null}
    {tags.length ? <View style={styles.section}><Text accessibilityRole="header" style={styles.heading}>标签</Text><View style={styles.wrap}>
      {tags.map(tag => <View key={tag} style={styles.tag}><Text style={styles.text}>{tag}</Text></View>)}</View></View> : null}
    {canAddTags ? <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.heading}>候选标签</Text>
      <View style={styles.wrap}>{candidateTags.map(tag => {
        const selected = selectedAnalysisTags.includes(tag)
        return <Pressable key={tag} accessibilityRole="checkbox" accessibilityLabel={'候选标签：' + tag}
          accessibilityState={{ checked: selected, disabled: addingTags }} disabled={addingTags}
          style={[styles.tag, selected && styles.selected]} onPress={() => onSelectionChange(selected
            ? selectedAnalysisTags.filter(item => item !== tag) : [...selectedAnalysisTags, tag])}>
          <Text style={[styles.text, selected && styles.onSelected]}>{tag}</Text></Pressable>
      })}</View>
      <Pressable accessibilityRole="button" accessibilityLabel="添加选中分析标签" accessibilityState={{ disabled: !selectedAnalysisTags.length || addingTags, busy: addingTags }}
        disabled={!selectedAnalysisTags.length || addingTags} style={styles.primary} onPress={() => onAddTags?.(selectedAnalysisTags)}>
        <Text style={styles.primaryText}>{addingTags ? '添加中…' : selectedAnalysisTags.length ? '添加 ' + selectedAnalysisTags.length + ' 个标签' : '选择后添加'}</Text></Pressable>
    </View> : null}
    {timelineItems.length ? <View style={styles.section}><Text accessibilityRole="header" style={styles.heading}>时间线预览</Text>
      {timelineItems.map((item, index) => <Pressable key={item.start_time + '-' + index} accessibilityRole="button"
        accessibilityLabel={'跳转到 ' + formatTime(item.start_time) + '，' + getTimelineTitle(item)} accessibilityState={{ selected: item === currentSegment }}
        style={[styles.timeline, item === currentSegment && styles.timelineActive]} onPress={() => onSeek(Number(item.start_time) || 0)}>
        <Text style={styles.muted}>{formatTime(item.start_time)}</Text><Text style={styles.heading}>{getTimelineTitle(item)}</Text>
        {item.description ? <Text style={styles.text}>{item.description}</Text> : null}
      </Pressable>)}</View> : null}
  </PlayerSheetFrame>
}
const createStyles = (colors: ThemeColors) => StyleSheet.create({
  name: { color: colors.muted, fontSize: 14 }, text: { color: colors.text, fontSize: 14, flexShrink: 1 },
  muted: { color: colors.muted, fontSize: 13 }, heading: { color: colors.text, fontSize: 14, fontWeight: '800', flexShrink: 1 },
  section: { gap: 8 }, stateBox: { padding: 12, gap: 8, backgroundColor: colors.surfaceElevated, borderWidth: 1, borderRadius: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 }, wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  meta: { flexGrow: 1, flexBasis: 80, minWidth: 0, padding: 12, gap: 4, alignItems: 'center', backgroundColor: colors.surfaceElevated, borderRadius: 10 },
  tag: { minHeight: 48, maxWidth: '100%', padding: 12, justifyContent: 'center', borderRadius: 12, backgroundColor: colors.surfaceElevated },
  selected: { backgroundColor: colors.accentStrong }, onSelected: { color: colors.onAccent },
  timeline: { minHeight: 48, padding: 12, gap: 6, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceElevated },
  timelineActive: { borderColor: colors.accent }, actions: { gap: 10 },
  primary: { minHeight: 48, padding: 12, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: colors.accentStrong },
  primaryText: { color: colors.onAccent, fontSize: 14, fontWeight: '800', flexShrink: 1 },
  secondary: { minHeight: 48, padding: 12, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: colors.surfaceElevated },
  buttonText: { color: colors.text, fontSize: 14, fontWeight: '800', flexShrink: 1 }
})
