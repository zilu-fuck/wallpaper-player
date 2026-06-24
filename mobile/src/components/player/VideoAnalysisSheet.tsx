import { ActivityIndicator, PanResponder, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Brain, ChevronDown, PlayCircle, RefreshCw } from 'lucide-react-native'
import { useEffect, useMemo, useState } from 'react'
import { colors } from '../../theme'
import type { VideoAnalysisResponse, VideoAnalysisResult, VideoAnalysisTimelineItem, VideoItem } from '../../types'
import { BOTTOM_SAFE_OFFSET } from '../../screens/player/playerLayout'
import { getVideoTitle } from '../../screens/player/playerUtils'

type Props = {
  visible: boolean
  video: VideoItem
  state: VideoAnalysisResponse | null
  loading: boolean
  starting: boolean
  currentTime: number
  onClose: () => void
  onRefresh: () => void
  onStart: () => void
  onSeek: (time: number) => void
  onAddTags?: (tags: string[]) => void
}

function formatTime(seconds?: number) {
  const value = Number(seconds)
  if (!Number.isFinite(value) || value < 0) return '00:00'
  const total = Math.floor(value)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
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

function uniqueTags(tags: string[]) {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of tags) {
    const tag = String(value || '').trim()
    const key = tag.toLocaleLowerCase()
    if (!tag || seen.has(key)) continue
    seen.add(key)
    result.push(tag)
  }
  return result
}

export function VideoAnalysisSheet({
  visible,
  video,
  state,
  loading,
  starting,
  currentTime,
  onClose,
  onRefresh,
  onStart,
  onSeek,
  onAddTags
}: Props) {
  const [selectedAnalysisTags, setSelectedAnalysisTags] = useState<string[]>([])
  const panResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_event, gesture) => gesture.dy > 16 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
    onPanResponderRelease: (_event, gesture) => {
      if (gesture.dy > 48) onClose()
    }
  }), [onClose])

  const analysis = state?.analysis?.available ? state.analysis : state?.recent?.analysis?.available ? state.recent.analysis : null
  useEffect(() => {
    if (!visible) setSelectedAnalysisTags([])
  }, [analysis?.savedAt, analysis?.sourceVideo?.original_filename, video.id, visible])

  if (!visible) return null

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
  const canStart = !disabled && !running && !starting
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
  const stateDotStyle = statusTone === 'error'
    ? styles.stateDotError
    : statusTone === 'running'
      ? styles.stateDotRunning
      : statusTone === 'ready'
        ? styles.stateDotReady
        : styles.stateDotEmpty

  return (
    <View style={styles.backdrop}>
      <Pressable style={styles.backdropPress} onPress={onClose} />
      <View style={styles.sheet} {...panResponder.panHandlers}>
        <View style={styles.handleWrap}>
          <View style={styles.handle} />
        </View>
        <View style={styles.header}>
          <View style={styles.titleIcon}>
            <Brain color={colors.text} size={19} />
          </View>
          <View style={styles.headerText}>
            <Text style={styles.kicker}>视频分析</Text>
            <Text style={styles.title} numberOfLines={1}>{getAnalysisTitle(video, analysis)}</Text>
          </View>
          <Pressable style={styles.closeButton} onPress={onClose}>
            <ChevronDown color={colors.text} size={22} />
          </Pressable>
        </View>

        <View style={[styles.stateBox, statusTone === 'error' && styles.stateBoxError, statusTone === 'running' && styles.stateBoxRunning, statusTone === 'ready' && styles.stateBoxReady]}>
          <View style={styles.stateRow}>
            {running ? <ActivityIndicator color={colors.accent} size="small" /> : <View style={[styles.stateDot, stateDotStyle]} />}
            <Text style={styles.stateTitle}>{statusTitle}</Text>
          </View>
          <Text style={styles.stateText} numberOfLines={3}>{statusText}</Text>
        </View>

        {analysis ? (
          <View style={styles.metaRow}>
            <View style={styles.metaPill}>
              <Text style={styles.metaValue}>{timeline.length}</Text>
              <Text style={styles.metaLabel}>段落</Text>
            </View>
            <View style={styles.metaPill}>
              <Text style={styles.metaValue}>{analyzedCount}</Text>
              <Text style={styles.metaLabel}>视觉分析</Text>
            </View>
            <View style={styles.metaPill}>
              <Text style={styles.metaValue}>{characters.length}</Text>
              <Text style={styles.metaLabel}>人物</Text>
            </View>
          </View>
        ) : null}

        <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>

          {analysis?.summary ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>摘要</Text>
              <Text style={styles.summary}>{analysis.summary}</Text>
            </View>
          ) : null}

          {tags.length ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>标签</Text>
              <View style={styles.tagWrap}>
                {tags.map(tag => (
                  <View style={styles.tag} key={tag}>
                    <Text style={styles.tagText}>{tag}</Text>
                  </View>
                ))}
              </View>
            </View>
          ) : null}

          {canAddTags ? (
            <View style={styles.section}>
              <View style={styles.sectionHeaderRow}>
                <Text style={styles.sectionTitle}>候选标签</Text>
                <Pressable
                  style={[styles.addTagsButton, !selectedAnalysisTags.length && styles.addTagsButtonDisabled]}
                  disabled={!selectedAnalysisTags.length}
                  onPress={() => {
                    onAddTags?.(selectedAnalysisTags)
                    setSelectedAnalysisTags([])
                  }}
                >
                  <Text style={styles.addTagsButtonText}>
                    {selectedAnalysisTags.length ? `添加 ${selectedAnalysisTags.length}` : '选择后添加'}
                  </Text>
                </Pressable>
              </View>
              <View style={styles.tagWrap}>
                {candidateTags.map(tag => {
                  const selected = selectedAnalysisTags.includes(tag)
                  return (
                    <Pressable
                      key={tag}
                      style={[styles.tag, selected && styles.tagSelected]}
                      onPress={() => setSelectedAnalysisTags(current => (
                        current.includes(tag)
                          ? current.filter(item => item !== tag)
                          : [...current, tag]
                      ))}
                    >
                      <Text style={[styles.tagText, selected && styles.tagTextSelected]}>{tag}</Text>
                    </Pressable>
                  )
                })}
              </View>
            </View>
          ) : null}

          {timelineItems.length ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>时间线</Text>
              {timelineItems.map((item, index) => {
                const active = item === currentSegment
                return (
                  <Pressable
                    key={`${item.start_time}-${index}`}
                    style={[styles.timelineItem, active && styles.timelineItemActive]}
                    onPress={() => onSeek(Number(item.start_time) || 0)}
                  >
                    <Text style={styles.timelineTime}>{formatTime(item.start_time)}</Text>
                    <View style={styles.timelineText}>
                      <Text style={styles.timelineTitle} numberOfLines={2}>{getTimelineTitle(item)}</Text>
                      {item.description ? <Text style={styles.timelineDescription} numberOfLines={3}>{item.description}</Text> : null}
                    </View>
                  </Pressable>
                )
              })}
            </View>
          ) : null}

        </ScrollView>

        <View style={styles.footerActions}>
          <Pressable style={[styles.footerButton, !canStart && styles.footerButtonDisabled]} onPress={onStart} disabled={!canStart}>
            {starting ? <ActivityIndicator color={colors.text} size="small" /> : <PlayCircle color={colors.text} size={18} />}
            <Text style={styles.footerButtonText}>{analysis ? '重新分析' : '开始分析'}</Text>
          </Pressable>
          <Pressable style={styles.footerButtonSecondary} onPress={onRefresh} disabled={loading}>
            {loading ? <ActivityIndicator color={colors.text} size="small" /> : <RefreshCw color={colors.text} size={18} />}
            <Text style={styles.footerButtonText}>刷新</Text>
          </Pressable>
        </View>
      </View>
    </View>
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
    maxHeight: '82%',
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    backgroundColor: 'rgba(12,12,12,0.97)',
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
    paddingBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12
  },
  titleIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(79,182,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  headerText: {
    flex: 1,
    minWidth: 0
  },
  kicker: {
    color: 'rgba(255,255,255,0.58)',
    fontSize: 11,
    fontWeight: '800'
  },
  title: {
    marginTop: 2,
    color: colors.text,
    fontSize: 16,
    fontWeight: '800'
  },
  closeButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  scroll: {
    minHeight: 120
  },
  content: {
    paddingHorizontal: 16,
    paddingBottom: 12,
    gap: 12
  },
  stateBox: {
    marginHorizontal: 16,
    marginBottom: 10,
    borderRadius: 10,
    padding: 12,
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.08)',
    gap: 6
  },
  stateBoxError: {
    backgroundColor: 'rgba(255,107,107,0.14)',
    borderColor: 'rgba(255,107,107,0.24)'
  },
  stateBoxRunning: {
    backgroundColor: 'rgba(79,182,255,0.12)',
    borderColor: 'rgba(79,182,255,0.22)'
  },
  stateBoxReady: {
    backgroundColor: 'rgba(88,214,141,0.12)',
    borderColor: 'rgba(88,214,141,0.22)'
  },
  stateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  stateTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '800'
  },
  stateText: {
    color: 'rgba(255,255,255,0.66)',
    fontSize: 13,
    lineHeight: 19
  },
  stateDot: {
    width: 9,
    height: 9,
    borderRadius: 5
  },
  stateDotError: {
    backgroundColor: colors.danger
  },
  stateDotRunning: {
    backgroundColor: colors.accent
  },
  stateDotReady: {
    backgroundColor: colors.success
  },
  stateDotEmpty: {
    backgroundColor: 'rgba(255,255,255,0.45)'
  },
  section: {
    gap: 8
  },
  sectionTitle: {
    color: 'rgba(255,255,255,0.68)',
    fontSize: 12,
    fontWeight: '800'
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8
  },
  addTagsButton: {
    minHeight: 30,
    borderRadius: 8,
    paddingHorizontal: 10,
    backgroundColor: colors.accentStrong,
    alignItems: 'center',
    justifyContent: 'center'
  },
  addTagsButtonDisabled: {
    opacity: 0.5
  },
  addTagsButtonText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '900'
  },
  summary: {
    color: colors.text,
    fontSize: 14,
    lineHeight: 21
  },
  metaRow: {
    paddingHorizontal: 16,
    marginBottom: 10,
    flexDirection: 'row',
    gap: 8
  },
  metaPill: {
    flex: 1,
    minHeight: 56,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2
  },
  metaValue: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '900'
  },
  metaLabel: {
    color: 'rgba(255,255,255,0.56)',
    fontSize: 11,
    fontWeight: '700'
  },
  tagWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8
  },
  tag: {
    minHeight: 28,
    paddingHorizontal: 10,
    borderRadius: 14,
    backgroundColor: 'rgba(79,182,255,0.16)',
    borderWidth: 1,
    borderColor: 'rgba(79,182,255,0.16)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  tagSelected: {
    backgroundColor: colors.accentStrong,
    borderColor: colors.accentStrong
  },
  tagText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '800'
  },
  tagTextSelected: {
    color: colors.text
  },
  timelineItem: {
    minHeight: 64,
    borderRadius: 10,
    padding: 10,
    backgroundColor: 'rgba(255,255,255,0.06)',
    flexDirection: 'row',
    gap: 10
  },
  timelineItemActive: {
    backgroundColor: 'rgba(79,182,255,0.18)'
  },
  timelineTime: {
    width: 54,
    color: colors.accent,
    fontSize: 12,
    fontWeight: '900'
  },
  timelineText: {
    flex: 1,
    minWidth: 0,
    gap: 4
  },
  timelineTitle: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '800'
  },
  timelineDescription: {
    color: 'rgba(255,255,255,0.62)',
    fontSize: 12,
    lineHeight: 18
  },
  footerActions: {
    paddingTop: 10,
    paddingHorizontal: 16,
    paddingBottom: BOTTOM_SAFE_OFFSET + 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.1)',
    backgroundColor: 'rgba(12,12,12,0.98)',
    flexDirection: 'row',
    gap: 10
  },
  footerButton: {
    flex: 1,
    minHeight: 42,
    borderRadius: 10,
    backgroundColor: colors.accentStrong,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8
  },
  footerButtonDisabled: {
    opacity: 0.45
  },
  footerButtonSecondary: {
    flex: 1,
    minHeight: 42,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.1)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8
  },
  footerButtonText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '900'
  }
})
