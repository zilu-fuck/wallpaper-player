import * as Clipboard from 'expo-clipboard'
import { useEventListener } from 'expo'
import { lockOrientation } from '../services/orientation'
import { useVideoPlayer } from 'expo-video'
import type { VideoContentFit } from 'expo-video'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AppState,
  BackHandler,
  FlatList,
  PanResponder,
  Platform,
  StyleSheet,
  View,
  useWindowDimensions
} from 'react-native'
import type {
  AppStateStatus,
  NativeScrollEvent,
  NativeSyntheticEvent,
  GestureResponderEvent
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { NativeVideoPlayerHandle } from '../components/player/NativeVideoPlayer'
import { PlayerMoreSheet, type AspectMode } from '../components/player/PlayerMoreSheet'
import { TagEditorSheet } from '../components/player/TagEditorSheet'
import { VideoAnalysisSheet } from '../components/player/VideoAnalysisSheet'
import { VideoFeedItem } from '../components/player/VideoFeedItem'
import { VideoOverlay } from '../components/player/VideoOverlay'
import type { NavigationContext } from '../../App'
import {
  cancelTranscode,
  cancelVideoAnalysis,
  addTagsToVideos,
  clearTranscodeCache,
  getVideoAnalysis,
  getTranscodeStatus,
  playOnDesktop,
  resolveRemoteUrl,
  revealOnDesktop,
  startVideoAnalysis,
  startTranscode,
  toggleFavorite
} from '../services/api'
import { closePlaybackSession, openPlaybackSession, recordPlayback, syncPendingPlayback, type PlaybackSession } from '../persistence/playback'
import { loadMobileSettings, saveMobileSettings } from '../persistence/settings'
import { emitVideoLibraryUpdate } from '../services/library-events'
import { openTagEdit, saveTagEdit, type TagEditSession } from '../services/tag-editing'
import type { MobilePlayerBackgroundMode } from '../persistence/settings'
import { colors } from '../theme'
import { TaskObserver } from '../services/task-observer'
import { ExpoPlaybackAdapter, type PlaybackOwner } from '../services/playback-adapter'
import { usePageActivity } from '../hooks/usePageActivity'
import { usePlayerSheet, type PlayerSheetLease } from '../hooks/usePlayerSheet'
import { useTagEditorDraft } from '../hooks/useTagEditorDraft'
import { AccessibleModal } from '../components/AccessibleModal'
import { useAccessibilityPreferences } from '../hooks/useAccessibilityPreferences'
import type { StoredDevice, VideoAnalysisResponse, VideoItem } from '../types'
import {
  appendRetryParam,
  clamp,
  getVideoDetailLine,
  getVideoGroupLine,
  getVideoTags,
  getVideoTitle,
  resolveThumbnailUrl
} from './player/playerUtils'
import { CONTROLS_HIDE_DELAY_MS, DOUBLE_TAP_MS, LONG_PRESS_DELAY_MS } from './player/playerLayout'

type Props = {
  navigation: NavigationContext
  device: StoredDevice
  video: VideoItem
  videos: VideoItem[]
  focused?: boolean
}

const QUALITY_ORIGINAL = '原画'
const QUALITY_TO_TRANSCODE: Record<string, string> = {
  '1080p': '1080p',
  '720p': '720p',
  '480p': '480p'
}

function uniqueCustomTags(tags: string[]) {
  return [...new Set(tags.filter(tag => typeof tag === 'string' && tag.trim()).map(tag => tag.trim()))]
}

export function PlayerScreen({ navigation, device, video, videos, focused = true }: Props) {
  const { screenReaderEnabled, reduceMotion } = useAccessibilityPreferences()
  const taskActive = usePageActivity(focused)
  const taskActiveRef = useRef(taskActive)
  taskActiveRef.current = taskActive
  const dimensions = useWindowDimensions()
  const safeAreaInsets = useSafeAreaInsets()
  const pageHeight = Math.max(1, dimensions.height)
  const pageWidth = Math.max(1, dimensions.width)
  const listRef = useRef<FlatList<VideoItem> | null>(null)
  const videoViewRef = useRef<NativeVideoPlayerHandle | null>(null)
  const [videoOverrides, setVideoOverrides] = useState<Record<string, Partial<VideoItem>>>({})
  const [hiddenVideoIds, setHiddenVideoIds] = useState<Record<string, boolean>>({})
  const baseVideoList = useMemo(() => (videos.length > 0 ? videos : [video]), [video, videos])
  const videoList = useMemo(() => baseVideoList
    .filter(item => !hiddenVideoIds[item.id])
    .map(item => ({
      ...item,
      ...(videoOverrides[item.id] || {})
    })), [baseVideoList, hiddenVideoIds, videoOverrides])
  const initialIndex = useMemo(() => {
    const found = baseVideoList.findIndex(item => item.id === video.id)
    return found >= 0 ? found : 0
  }, [baseVideoList, video.id])

  const [activeIndex, setActiveIndex] = useState(initialIndex)
  const activeIndexRef = useRef(activeIndex)
  const activeVideo = videoList[clamp(activeIndex, 0, videoList.length - 1)] || video
  const activeVideoRef = useRef(activeVideo)
  const [error, setError] = useState('')
  const [progressMessage, setProgressMessage] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [gestureHint, setGestureHint] = useState('')
  const [isPlaying, setIsPlaying] = useState(taskActive)
  const [favoriteById, setFavoriteById] = useState<Record<string, boolean>>({})
  const [heartBurst, setHeartBurst] = useState(false)
  const [status, setStatus] = useState<'loading' | 'ready' | 'buffering' | 'error'>('loading')
  const [networkSlow, setNetworkSlow] = useState(false)
  const [transcoding, setTranscoding] = useState(false)
  const [transcodeProgress, setTranscodeProgress] = useState(0)
  const [transcodeQueuePosition, setTranscodeQueuePosition] = useState(0)
  const sheets = usePlayerSheet(JSON.stringify([device.id, device.bindingId, activeVideo.id]), taskActive)
  const moreSheetVisible = sheets.current?.kind === 'more'
  const tagSheetVisible = sheets.current?.kind === 'tags'
  const analysisSheetVisible = sheets.current?.kind === 'analysis'
  const closeMoreSheet = useCallback(() => {
    const lease = sheets.currentRef.current
    if (lease?.kind === 'more') sheets.close(lease)
  }, [sheets.close])
  const [selectedAnalysisTags, setSelectedAnalysisTags] = useState<string[]>([])
  const [analysisTagsSaving, setAnalysisTagsSaving] = useState(false)
  const analysisTagActionRef = useRef(0)
  const analysisTagsRequestRef = useRef<PlayerSheetLease | null>(null)
  useEffect(() => {
    if (!analysisSheetVisible) { analysisTagActionRef.current++; analysisTagsRequestRef.current = null; setSelectedAnalysisTags([]); setAnalysisTagsSaving(false) }
  }, [analysisSheetVisible, activeVideo.id])
  const [analysisById, setAnalysisById] = useState<Record<string, VideoAnalysisResponse | null>>({})
  const [analysisLoading, setAnalysisLoading] = useState(false)
  const [analysisStarting, setAnalysisStarting] = useState(false)
  const [analysisCancelling, setAnalysisCancelling] = useState(false)
  const [speedBoostMode, setSpeedBoostMode] = useState<'forward' | 'rewind' | null>(null)
  const [controlsVisible, setControlsVisible] = useState(false)
  const [tagsSaving, setTagsSaving] = useState(false)
  const [tagsLoading, setTagsLoading] = useState(false)
  const [tagsError, setTagsError] = useState('')
  const [tagEditingVideo, setTagEditingVideo] = useState<VideoItem | null>(null)
  const [tagEditKey, setTagEditKey] = useState(0)
  const tagEditorDraft = useTagEditorDraft(tagEditingVideo || activeVideo, tagEditKey)
  const tagSessionRef = useRef<TagEditSession | null>(null)
  const tagGenerationRef = useRef(0)
  const tagSaveGenerationRef = useRef<number | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [videoSize, setVideoSize] = useState<{ width: number, height: number } | null>(null)
  const [playbackRate, setPlaybackRateState] = useState(1)
  const [aspectMode, setAspectMode] = useState<AspectMode>('fit')
  const [playerBackgroundMode, setPlayerBackgroundMode] = useState<MobilePlayerBackgroundMode>('black')
  const [qualityById, setQualityById] = useState<Record<string, string>>({})
  const [fullscreenMode, setFullscreenMode] = useState(false)
  const fullscreenModeRef = useRef(false)
  const lastSavedRef = useRef(0)
  const lastKnownTimeRef = useRef(0)
  const lastTapRef = useRef(0)
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const heartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pressResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scrollRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pageRestoreFrameRef = useRef<number | null>(null)
  const transcodeObserver = useMemo(() => new TaskObserver<Awaited<ReturnType<typeof getTranscodeStatus>>>(), [])
  const analysisObserver = useMemo(() => new TaskObserver<VideoAnalysisResponse>(), [])
  const taskKey = JSON.stringify([device.id, device.bindingId, device.token, device.endpoint, activeVideo.id])
  const taskOwner = useMemo(() => ({ key: taskKey }), [taskKey])
  const taskOwnerRef = useRef(taskOwner)
  taskOwnerRef.current = taskOwner
  const transcodeIntentRef = useRef<{ owner: typeof taskOwner, videoId: string, quality: string, label: string, interestId: string } | null>(null)
  const transcodeActionRef = useRef(0)
  const analysisActionRef = useRef(0)
  const analysisIntentRef = useRef<{ owner: typeof taskOwner, videoId: string, interestId?: string, cancelRequested?: boolean } | null>(null)
  const rewindTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const ignoreNextPressRef = useRef(false)
  const speedBoostActiveRef = useRef(false)
  const speedBoostModeRef = useRef<'forward' | 'rewind' | null>(null)
  const originalPlaybackRateRef = useRef(1)
  const wasPlayingBeforeBackgroundRef = useRef(false)
  const previousFocusedRef = useRef(focused)
  const wasPlayingBeforeBlurRef = useRef(false)
  const appStateRef = useRef(AppState.currentState)
  const dragStartIndexRef = useRef(initialIndex)
  const pageSizeRef = useRef({ width: pageWidth, height: pageHeight })
  const positionSnapshotRef = useRef<Record<string, number>>({})
  const playbackSessionRef = useRef<PlaybackSession | null>(null)
  const pendingRestoreRef = useRef<{ session: PlaybackSession, player: ReturnType<typeof useVideoPlayer>, owner: PlaybackOwner, position: number } | null>(null)
  const pendingPositionIntentRef = useRef<{ videoId: string, position: number } | null>(null)
  const transcodingQualityRef = useRef('compatible')

  const closeTagEditor = useCallback((expected?: PlayerSheetLease | null) => {
    if (expected && !sheets.isCurrent(expected)) return
    tagGenerationRef.current += 1
    tagSessionRef.current = null
    tagSaveGenerationRef.current = null
    const lease = sheets.currentRef.current
    if (lease?.kind === 'tags') sheets.close(lease)
    setTagsLoading(false)
    setTagsSaving(false)
    setTagsError('')
  }, [sheets.close, sheets.isCurrent])

  const requestCloseSheet = useCallback((lease: PlayerSheetLease | null) => {
    sheets.run(lease, () => { if (lease?.kind === 'tags') closeTagEditor(lease); else sheets.close(lease) })
  }, [sheets.run, sheets.close, closeTagEditor])

  const handleOpenTagEditor = useCallback(async () => {
    if (!sheets.open('tags')) return
    const generation = ++tagGenerationRef.current
    const target = { ...activeVideoRef.current }
    tagSessionRef.current = null
    tagSaveGenerationRef.current = null
    setTagEditingVideo(target)
    setTagEditKey(generation * 2)
    setTagsLoading(true)
    setTagsSaving(false)
    setTagsError('')
    setControlsVisible(false)
    try {
      const session = await openTagEdit(device, target)
      if (generation !== tagGenerationRef.current) return
      tagSessionRef.current = session
      setTagEditingVideo(session.video)
      setTagEditKey(generation * 2 + 1)
    } catch (err) {
      if (generation === tagGenerationRef.current) setTagsError(err instanceof Error ? err.message : '读取标签失败，请重试')
    } finally {
      if (generation === tagGenerationRef.current) setTagsLoading(false)
    }
  }, [device, sheets.open])

  useEffect(() => closeTagEditor(), [activeVideo.id, closeTagEditor])
  useEffect(() => () => { tagGenerationRef.current += 1; tagSessionRef.current = null }, [])

  const streamUrl = useMemo(
    () => appendRetryParam(resolveRemoteUrl(device, activeVideo.streamUrl), reloadKey),
    [activeVideo.streamUrl, device, reloadKey]
  )
  const thumbnailUrl = useMemo(() => resolveThumbnailUrl(device, activeVideo), [activeVideo, device])
  const favorite = favoriteById[activeVideo.id] ?? Boolean(activeVideo.favorite)
  const selectedQuality = qualityById[activeVideo.id] || QUALITY_ORIGINAL
  const autoContentFit: VideoContentFit = videoSize && videoSize.height > videoSize.width ? 'cover' : 'contain'
  const contentFit: VideoContentFit = aspectMode === 'fill' ? 'cover' : 'contain'
  const effectiveFit = aspectMode === 'fit' ? autoContentFit : contentFit
  const activeTags = useMemo(() => getVideoTags(activeVideo), [activeVideo])
  const activeIsNetworkResource = activeVideo.sourceType === 'network'
  const availableCustomTags = useMemo(() => {
    const tags = videoList.flatMap(item => item.customTags || [])
    return uniqueCustomTags(tags)
  }, [videoList])
  const groupLine = useMemo(() => getVideoGroupLine(activeVideo, device, activeTags), [activeTags, activeVideo, device])
  const detailLine = useMemo(() => getVideoDetailLine(activeVideo, duration, videoSize), [activeVideo, duration, videoSize])
  const activeAnalysisState = analysisById[activeVideo.id] || null
  const analysisRunning = Boolean(activeAnalysisState?.job?.running || ['started', 'running'].includes(activeAnalysisState?.recent?.status || ''))
  const analysisAvailable = Boolean(activeAnalysisState?.analysis?.available || activeAnalysisState?.recent?.analysis?.available)
  const analysisActionLabel = analysisRunning ? '分析中' : analysisAvailable ? '结果' : '分析'

  const player = useVideoPlayer(null, (instance) => {
    instance.loop = false
    instance.timeUpdateEventInterval = 0.25
    instance.playbackRate = playbackRate
  })
  const playbackAdapter = useMemo(() => new ExpoPlaybackAdapter(player), [player])
  const playerRef = useRef(player)
  playerRef.current = player
  const mountedRef = useRef(true)
  const nativeOwnerRef = useRef({ player, videoId: activeVideo.id, source: streamUrl, deviceId: device.id, bindingId: device.bindingId, token: device.token })
  if (nativeOwnerRef.current.player !== player || nativeOwnerRef.current.videoId !== activeVideo.id || nativeOwnerRef.current.source !== streamUrl ||
      nativeOwnerRef.current.deviceId !== device.id || nativeOwnerRef.current.bindingId !== device.bindingId || nativeOwnerRef.current.token !== device.token) {
    nativeOwnerRef.current = { player, videoId: activeVideo.id, source: streamUrl, deviceId: device.id, bindingId: device.bindingId, token: device.token }
  }
  const nativeOwner = nativeOwnerRef.current
  const progressOwnerRef = useRef<typeof nativeOwner | null>(null)
  const ownsNativeEvent = () => mountedRef.current && nativeOwnerRef.current === nativeOwner && playbackAdapter.owns(nativeOwner)
  const ownsTask = useCallback((owner: typeof taskOwner) => mountedRef.current && taskActiveRef.current && taskOwnerRef.current === owner, [])
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, [])

  useEffect(() => {
    activeIndexRef.current = activeIndex
    activeVideoRef.current = activeVideo
  }, [activeIndex, activeVideo])

  useEffect(() => {
    const previous = pageSizeRef.current
    pageSizeRef.current = { width: pageWidth, height: pageHeight }
    if (previous.width === pageWidth && previous.height === pageHeight) return
    const frame = requestAnimationFrame(() => {
      const index = clamp(activeIndexRef.current, 0, videoList.length - 1)
      listRef.current?.scrollToOffset({ offset: pageHeight * index, animated: false })
    })
    return () => cancelAnimationFrame(frame)
  }, [pageHeight, pageWidth, videoList.length])

  useEffect(() => {
    fullscreenModeRef.current = fullscreenMode
  }, [fullscreenMode])

  useEffect(() => {
    let mounted = true
    loadMobileSettings().then((settings) => {
      if (mounted) setPlayerBackgroundMode(settings.playerBackgroundMode)
    })
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    setActiveIndex(initialIndex)
    const frame = requestAnimationFrame(() => {
      listRef.current?.scrollToIndex({ index: initialIndex, animated: false })
    })
    return () => cancelAnimationFrame(frame)
  }, [initialIndex])

  const applyPendingRestore = useCallback(() => {
    const pending = pendingRestoreRef.current
    if (!pending || pending.session !== playbackSessionRef.current || pending.player !== playerRef.current || pending.owner !== nativeOwnerRef.current) return
    try {
      if (!playbackAdapter.ready(pending.owner)) return
      playbackAdapter.seek(pending.position)
      lastKnownTimeRef.current = pending.position
      lastSavedRef.current = pending.position
      setCurrentTime(pending.position)
      pendingRestoreRef.current = null
      playbackAdapter.activate(pending.owner, () => taskActiveRef.current)
    } catch {
      setProgressMessage('进度恢复尚未完成，请重试播放')
    }
  }, [playbackAdapter])

  useEventListener(player, 'sourceChange', ({ source }) => {
    if (ownsNativeEvent()) playbackAdapter.sourceChanged(nativeOwner, source)
  })

  useEventListener(player, 'statusChange', ({ status: nextStatus, error: playerError }) => {
    if (!ownsNativeEvent() || !playbackAdapter.statusChanged(nativeOwner, nextStatus, playerError?.message)) return
    if (nextStatus === 'error') {
      setStatus('error')
      setNetworkSlow(false)
      setError(playerError?.message || '播放失败')
      return
    }
    if (nextStatus === 'readyToPlay') {
      applyPendingRestore()
      playbackAdapter.activate(nativeOwner, () => taskActiveRef.current && !pendingRestoreRef.current && progressOwnerRef.current === nativeOwner)
      setStatus('ready')
      setError('')
      return
    }
    if (nextStatus === 'loading') {
      setStatus(currentTime > 0 ? 'buffering' : 'loading')
    }
  })

  useEventListener(player, 'playingChange', ({ isPlaying: nextIsPlaying }) => {
    if (!ownsNativeEvent() || !playbackAdapter.ready(nativeOwner) || nextIsPlaying !== player.playing) return
    setIsPlaying(nextIsPlaying)
  })

  useEventListener(player, 'timeUpdate', () => {
    if (!ownsNativeEvent() || progressOwnerRef.current !== nativeOwner || !playbackAdapter.acceptsTime(nativeOwner)) return
    if (pendingRestoreRef.current) return
    const nextCurrentTime = Math.max(0, Number(player.currentTime) || 0)
    let nextDuration = 0
    try {
      nextDuration = Math.max(0, Number(player.duration) || 0)
    } catch {
      nextDuration = duration
    }
    lastKnownTimeRef.current = nextCurrentTime
    setCurrentTime(nextCurrentTime)
    if (nextDuration > 0) setDuration(nextDuration)
    if (status !== 'error') {
      const buffered = Number(player.bufferedPosition)
      const isSlow = isPlaying && Number.isFinite(buffered) && buffered >= 0 && buffered - nextCurrentTime < 1.2 && nextDuration - nextCurrentTime > 2
      setNetworkSlow(isSlow)
      if (status === 'buffering' && !isSlow) setStatus('ready')
    }
  })

  useEventListener(player, 'sourceLoad', ({ videoSource, duration: loadedDuration, availableVideoTracks }) => {
    if (!ownsNativeEvent() || !playbackAdapter.sourceLoaded(nativeOwner, videoSource,
      () => taskActiveRef.current && !pendingRestoreRef.current && progressOwnerRef.current === nativeOwner)) return
    applyPendingRestore()
    const loadedSize = availableVideoTracks.find(track => track.size?.width && track.size?.height)?.size
    setDuration(Math.max(0, Number(loadedDuration) || 0))
    setVideoSize(loadedSize ? { width: loadedSize.width, height: loadedSize.height } : null)
    setStatus(playbackAdapter.ready(nativeOwner) ? 'ready' : 'loading')
    setNetworkSlow(false)
    setError('')
  })

  useEventListener(player, 'videoTrackChange', () => {
    if (!ownsNativeEvent() || !playbackAdapter.ready(nativeOwner)) return
    const size = player.videoTrack?.size
    if (size?.width && size?.height) {
      setVideoSize({ width: size.width, height: size.height })
    }
  })

  useEventListener(player, 'playToEnd', () => {
    if (!ownsNativeEvent() || !playbackAdapter.ended(nativeOwner)) return
    lastKnownTimeRef.current = playbackAdapter.getState().position
    setCurrentTime(lastKnownTimeRef.current)
    setIsPlaying(false); setNetworkSlow(false)
  })

  useEffect(() => {
    playbackAdapter.load(nativeOwner,
      () => taskActiveRef.current && !pendingRestoreRef.current && progressOwnerRef.current === nativeOwner,
      loadError => {
        if (!mountedRef.current || nativeOwnerRef.current !== nativeOwner) return
        setStatus('error'); setError(loadError instanceof Error ? loadError.message : '媒体加载失败')
      })
    return () => playbackAdapter.stop(nativeOwner)
  }, [nativeOwner, playbackAdapter])

  const savePositionForVideo = useCallback(async (item: VideoItem, position: number, explicitIntent = false) => {
    const safePosition = Math.max(0, Number(position) || 0)
    const session = playbackSessionRef.current
    if (!session || session.videoId !== item.id) {
      if (explicitIntent) pendingPositionIntentRef.current = { videoId: item.id, position: safePosition }
      return
    }
    if (pendingRestoreRef.current) {
      if (explicitIntent) {
        pendingRestoreRef.current.position = safePosition
        await recordPlayback(session, safePosition, true)
      }
      return
    }
    try { await recordPlayback(session, safePosition, explicitIntent) } catch (err) {
      if (playbackSessionRef.current === session) setProgressMessage(err instanceof Error ? err.message : '手机进度保存失败，请重试')
      throw err
    }
  }, [])

  const readCurrentPosition = useCallback(() => {
    try {
      const position = Number(playbackAdapter.getState().position)
      if (Number.isFinite(position) && position >= 0) {
        lastKnownTimeRef.current = position
        return position
      }
    } catch {
      // expo-video SharedObject may already be released during cleanup.
    }
    return Math.max(0, Number(lastKnownTimeRef.current) || 0)
  }, [playbackAdapter])

  const getCurrentPlaying = useCallback(() => {
    try {
      return Boolean(playerRef.current?.playing)
    } catch {
      return false
    }
  }, [])

  const playCurrentPlayer = useCallback(() => {
    try {
      playbackAdapter.play()
      return true
    } catch {
      return false
    }
  }, [playbackAdapter])

  const pauseCurrentPlayer = useCallback(() => {
    try {
      playbackAdapter.pause()
      return true
    } catch {
      return false
    }
  }, [playbackAdapter])

  const seekCurrentPlayer = useCallback((position: number) => {
    try {
      playbackAdapter.seek(position)
      return true
    } catch {
      return false
    }
  }, [playbackAdapter])

  const getCurrentPlaybackRate = useCallback(() => {
    try {
      const rate = Number(playerRef.current?.playbackRate)
      return Number.isFinite(rate) && rate > 0 ? rate : playbackRate
    } catch {
      return playbackRate
    }
  }, [playbackRate])

  const setCurrentPlaybackRate = useCallback((rate: number) => {
    try {
      playerRef.current.playbackRate = rate
      return true
    } catch {
      return false
    }
  }, [])

  const saveCurrentPosition = useCallback(async () => {
    const position = readCurrentPosition()
    await savePositionForVideo(activeVideoRef.current, position)
  }, [readCurrentPosition, savePositionForVideo])

  useEffect(() => {
    const previous = previousFocusedRef.current
    previousFocusedRef.current = focused
    if (previous === focused) return
    if (!focused) {
      wasPlayingBeforeBlurRef.current = getCurrentPlaying() || wasPlayingBeforeBackgroundRef.current
      pauseCurrentPlayer()
      void saveCurrentPosition().catch(() => {})
    } else if (AppState.currentState === 'active' && wasPlayingBeforeBlurRef.current) {
      playCurrentPlayer(); wasPlayingBeforeBlurRef.current = false
    }
  }, [focused, getCurrentPlaying, pauseCurrentPlayer, playCurrentPlayer, saveCurrentPosition])

  useEffect(() => {
    let cancelled = false
    const item = activeVideo
    let ownedSession: PlaybackSession | null = null
    playbackSessionRef.current = null
    progressOwnerRef.current = null
    pendingRestoreRef.current = null
    pendingPositionIntentRef.current = null
    setProgressMessage('')

    setError('')
    setStatus('loading')
    setNetworkSlow(false)
    setCurrentTime(0)
    setDuration(0)
    setVideoSize(null)
    lastSavedRef.current = 0
    lastKnownTimeRef.current = 0

    async function restore() {
      try {
        const session = await openPlaybackSession(device, item.id, sync => {
          if (!cancelled) setProgressMessage(sync.message)
        })
        if (cancelled) { closePlaybackSession(session); return }
        ownedSession = session
        playbackSessionRef.current = session
        progressOwnerRef.current = nativeOwner
        const intent = pendingPositionIntentRef.current
        const position = intent?.videoId === item.id ? intent.position : session.position
        pendingRestoreRef.current = { session, player, owner: nativeOwner, position }
        applyPendingRestore()
        if (intent?.videoId === item.id) {
          pendingPositionIntentRef.current = null
          await recordPlayback(session, position, true)
        }
      } catch (err) {
        if (!cancelled) setProgressMessage(err instanceof Error ? err.message : '播放进度恢复失败，请重试')
      }
    }

    restore()
    return () => {
      cancelled = true
      if (progressOwnerRef.current === nativeOwner) progressOwnerRef.current = null
      const snapshot = positionSnapshotRef.current[item.id]
      delete positionSnapshotRef.current[item.id]
      const position = Math.max(0, Number.isFinite(snapshot) ? snapshot : Number(lastKnownTimeRef.current) || 0)
      if (ownedSession) {
        if (!pendingRestoreRef.current) void recordPlayback(ownedSession, position).catch(() => {})
        closePlaybackSession(ownedSession)
        if (playbackSessionRef.current === ownedSession) playbackSessionRef.current = null
      }
    }
  }, [activeVideo.id, device.id, device.bindingId, device.token, device.endpoint, nativeOwner, player, applyPendingRestore])

  useEffect(() => {
    if (!taskActive) return
    const interval = setInterval(() => {
      const session = playbackSessionRef.current
      if (!session || pendingRestoreRef.current) return
      void syncPendingPlayback(session.device, session.videoId).then(sync => {
        if (playbackSessionRef.current === session) setProgressMessage(sync.message)
      }).catch(err => {
        if (playbackSessionRef.current === session) setProgressMessage(err instanceof Error ? err.message : '进度同步失败')
      })
      const position = readCurrentPosition()
      if (Math.abs(position - lastSavedRef.current) < 5) return
      lastSavedRef.current = position
      void savePositionForVideo(activeVideoRef.current, position).catch(() => { lastSavedRef.current = -1 })
    }, 5000)

    return () => clearInterval(interval)
  }, [readCurrentPosition, savePositionForVideo, taskActive])

  const showGestureHint = useCallback((text: string, timeout = 1100) => {
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current)
    hintTimerRef.current = null
    if (sheets.notify(text)) { setGestureHint(''); return }
    setGestureHint(text)
    hintTimerRef.current = setTimeout(() => {
      setGestureHint('')
      hintTimerRef.current = null
    }, timeout)
  }, [sheets.notify])

  const scheduleControlsHide = useCallback(() => {
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current)
    controlsTimerRef.current = null
    if (screenReaderEnabled) return
    controlsTimerRef.current = setTimeout(() => {
      setControlsVisible(false)
      controlsTimerRef.current = null
    }, CONTROLS_HIDE_DELAY_MS)
  }, [screenReaderEnabled])

  const showControls = useCallback((holding = false) => {
    setControlsVisible(true)
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current)
    controlsTimerRef.current = null
    if (!holding) scheduleControlsHide()
  }, [scheduleControlsHide])

  useEffect(() => {
    if (screenReaderEnabled && controlsTimerRef.current) clearTimeout(controlsTimerRef.current)
    if (reduceMotion) {
      if (heartTimerRef.current) clearTimeout(heartTimerRef.current)
      heartTimerRef.current = null
      setHeartBurst(false)
    }
  }, [screenReaderEnabled, reduceMotion])

  const triggerHeartBurst = useCallback(() => {
    if (heartTimerRef.current) clearTimeout(heartTimerRef.current)
    heartTimerRef.current = null
    if (reduceMotion) return
    setHeartBurst(true)
    heartTimerRef.current = setTimeout(() => {
      setHeartBurst(false)
      heartTimerRef.current = null
    }, 680)
  }, [reduceMotion])

  const toggleFavoriteState = useCallback(async () => {
    if (!ownsNativeEvent() || !taskActiveRef.current) return
    const item = activeVideoRef.current
    const previous = favoriteById[item.id] ?? Boolean(item.favorite)
    const next = !previous
    setFavoriteById(current => ({ ...current, [item.id]: next }))
    triggerHeartBurst()
    try {
      const result = await toggleFavorite(device, item.id, !previous)
      setFavoriteById(current => ({ ...current, [item.id]: result.favorite }))
      emitVideoLibraryUpdate({
        deviceId: device.id,
        bindingId: device.bindingId,
        videoId: item.id,
        patch: { favorite: result.favorite }
      })
    } catch {
      setFavoriteById(current => ({ ...current, [item.id]: previous }))
      showGestureHint('收藏失败')
    }
  }, [device, favoriteById, showGestureHint, triggerHeartBurst, nativeOwner])

  const togglePlayback = useCallback(() => {
    if (!ownsNativeEvent() || !taskActiveRef.current || status === 'error') return
    if (getCurrentPlaying() || isPlaying) {
      pauseCurrentPlayer()
      setControlsVisible(true)
      if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current)
      return
    }
    playCurrentPlayer()
    showControls()
  }, [getCurrentPlaying, isPlaying, pauseCurrentPlayer, playCurrentPlayer, showControls, status, nativeOwner])

  const handleVideoPress = useCallback(() => {
    if (!ownsNativeEvent() || !taskActiveRef.current) return
    if (ignoreNextPressRef.current) {
      ignoreNextPressRef.current = false
      return
    }
    if (status === 'error') return

    if (screenReaderEnabled) { togglePlayback(); return }

    const now = Date.now()
    if (now - lastTapRef.current < DOUBLE_TAP_MS) {
      if (tapTimerRef.current) {
        clearTimeout(tapTimerRef.current)
        tapTimerRef.current = null
      }
      lastTapRef.current = 0
      toggleFavoriteState()
      return
    }

    lastTapRef.current = now
    if (tapTimerRef.current) clearTimeout(tapTimerRef.current)
    tapTimerRef.current = setTimeout(() => {
      tapTimerRef.current = null
      lastTapRef.current = 0
      togglePlayback()
    }, DOUBLE_TAP_MS)
  }, [screenReaderEnabled, status, toggleFavoriteState, togglePlayback, nativeOwner])

  const startSpeedBoost = useCallback((event?: GestureResponderEvent) => {
    if (!ownsNativeEvent() || !taskActiveRef.current || status === 'error') return
    ignoreNextPressRef.current = true
    speedBoostActiveRef.current = true
    const mode = event && event.nativeEvent.locationX < pageWidth / 2 ? 'rewind' : 'forward'
    speedBoostModeRef.current = mode
    try {
      originalPlaybackRateRef.current = getCurrentPlaybackRate()
      playCurrentPlayer()
      setSpeedBoostMode(mode)
      if (mode === 'forward') {
        setCurrentPlaybackRate(2)
        return
      }

      if (rewindTimerRef.current) clearInterval(rewindTimerRef.current)
      rewindTimerRef.current = setInterval(() => {
        if (!ownsNativeEvent() || !taskActiveRef.current) return
        const current = readCurrentPosition()
        const next = clamp(current - 0.45, 0, duration || current)
        seekCurrentPlayer(next)
        lastKnownTimeRef.current = next
        setCurrentTime(next)
      }, 180)
    } catch {
      speedBoostActiveRef.current = false
      ignoreNextPressRef.current = false
      speedBoostModeRef.current = null
    }
  }, [
    duration,
    getCurrentPlaybackRate,
    pageWidth,
    playCurrentPlayer,
    readCurrentPosition,
    seekCurrentPlayer,
    setCurrentPlaybackRate,
    status,
    nativeOwner
  ])

  const stopSpeedBoost = useCallback(() => {
    if (!ownsNativeEvent() || !speedBoostActiveRef.current) return
    if (rewindTimerRef.current) {
      clearInterval(rewindTimerRef.current)
      rewindTimerRef.current = null
    }
    setCurrentPlaybackRate(originalPlaybackRateRef.current)
    speedBoostActiveRef.current = false
    speedBoostModeRef.current = null
    setSpeedBoostMode(null)
    if (pressResetTimerRef.current) clearTimeout(pressResetTimerRef.current)
    pressResetTimerRef.current = setTimeout(() => {
      ignoreNextPressRef.current = false
      pressResetTimerRef.current = null
    }, 0)
  }, [setCurrentPlaybackRate, nativeOwner])

  useEffect(() => {
    setSpeedBoostMode(null)
    return () => {
      if (tapTimerRef.current) clearTimeout(tapTimerRef.current)
      if (pressResetTimerRef.current) clearTimeout(pressResetTimerRef.current)
      if (rewindTimerRef.current) clearInterval(rewindTimerRef.current)
      if (scrollRetryTimerRef.current) clearTimeout(scrollRetryTimerRef.current)
      tapTimerRef.current = null; pressResetTimerRef.current = null; rewindTimerRef.current = null; scrollRetryTimerRef.current = null
      speedBoostActiveRef.current = false; speedBoostModeRef.current = null; ignoreNextPressRef.current = false; lastTapRef.current = 0
      try { nativeOwner.player.playbackRate = playbackRate } catch {}
    }
  }, [nativeOwner])

  const restorePortraitOrientation = useCallback(() => {
    lockOrientation('portrait').catch(() => {})
  }, [])

  const restoreCurrentPagePosition = useCallback((animated = false) => {
    if (pageRestoreFrameRef.current !== null) cancelAnimationFrame(pageRestoreFrameRef.current)
    pageRestoreFrameRef.current = requestAnimationFrame(() => {
      pageRestoreFrameRef.current = null
      if (!ownsNativeEvent()) return
      const index = clamp(activeIndexRef.current, 0, videoList.length - 1)
      listRef.current?.scrollToOffset({ offset: pageHeight * index, animated })
    })
  }, [pageHeight, videoList.length, nativeOwner])

  const leaveFullscreen = useCallback(async () => {
    fullscreenModeRef.current = false
    setFullscreenMode(false)
    setControlsVisible(true)
    closeMoreSheet()
    closeTagEditor()
    stopSpeedBoost()
    restorePortraitOrientation()
    restoreCurrentPagePosition(false)
  }, [restoreCurrentPagePosition, restorePortraitOrientation, stopSpeedBoost])

  const toggleFullscreen = useCallback(async () => {
    if (fullscreenModeRef.current) {
      await leaveFullscreen()
      return
    }

    closeMoreSheet()
    closeTagEditor()
    stopSpeedBoost()
    fullscreenModeRef.current = true
    setFullscreenMode(true)
    setControlsVisible(true)
    lockOrientation('landscape').catch(() => {
      if (!ownsNativeEvent() || !fullscreenModeRef.current) return
      restorePortraitOrientation()
      showGestureHint('横屏全屏暂时不可用')
      fullscreenModeRef.current = false
      setFullscreenMode(false)
    })
    showControls()
  }, [leaveFullscreen, restorePortraitOrientation, showControls, showGestureHint, stopSpeedBoost, nativeOwner])

  useEffect(() => () => {
    if (tapTimerRef.current) clearTimeout(tapTimerRef.current)
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current)
    if (heartTimerRef.current) clearTimeout(heartTimerRef.current)
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current)
    if (pressResetTimerRef.current) clearTimeout(pressResetTimerRef.current)
    if (scrollRetryTimerRef.current) clearTimeout(scrollRetryTimerRef.current)
    if (pageRestoreFrameRef.current !== null) cancelAnimationFrame(pageRestoreFrameRef.current)
    transcodeObserver.stop()
    analysisObserver.stop()
    if (rewindTimerRef.current) clearInterval(rewindTimerRef.current)
    restorePortraitOrientation()
  }, [restorePortraitOrientation])

  const handleBack = useCallback(async () => {
    const lease = sheets.currentRef.current
    if (sheets.isCurrent(lease)) {
      if (lease?.kind === 'tags') closeTagEditor(lease); else sheets.close(lease)
      return
    }
    try { await saveCurrentPosition() } catch { return }
    if (fullscreenMode) {
      await leaveFullscreen()
      return
    }
    if (navigation.canGoBack) {
      navigation.back()
    } else {
      navigation.navigate({ name: 'library', device })
    }
  }, [device, fullscreenMode, leaveFullscreen, navigation, saveCurrentPosition, closeTagEditor, sheets.close, sheets.isCurrent])

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      handleBack()
      return true
    })
    return () => subscription.remove()
  }, [handleBack])

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      const previousState = appStateRef.current
      appStateRef.current = nextState
      if (nextState === 'active') {
        const session = playbackSessionRef.current
        if (session) void syncPendingPlayback(session.device, session.videoId).then(sync => {
          if (playbackSessionRef.current === session) setProgressMessage(sync.message)
        }).catch(err => setProgressMessage(err instanceof Error ? err.message : '进度同步失败'))
        if (focused && wasPlayingBeforeBackgroundRef.current && status !== 'error') {
          playCurrentPlayer()
        }
        wasPlayingBeforeBackgroundRef.current = false
        return
      }

      if (previousState === 'active') {
        wasPlayingBeforeBackgroundRef.current = getCurrentPlaying() || isPlaying
        pauseCurrentPlayer()
        saveCurrentPosition().catch(() => {})
      }
    })

    return () => subscription.remove()
  }, [focused, getCurrentPlaying, isPlaying, pauseCurrentPlayer, playCurrentPlayer, saveCurrentPosition, status])

  const handleRetry = useCallback(() => {
    setError('')
    setStatus('loading')
    setReloadKey(key => key + 1)
  }, [])

  const stopTranscodePolling = useCallback(() => { transcodeObserver.stop() }, [transcodeObserver])
  const stopAnalysisPolling = useCallback(() => { analysisObserver.stop() }, [analysisObserver])
  const storeAnalysisState = useCallback((videoId: string, state: VideoAnalysisResponse | null) => {
    setAnalysisById(current => ({ ...current, [videoId]: state }))
  }, [])
  const fetchAnalysisState = useCallback(async (videoId = activeVideoRef.current.id, options: { silent?: boolean } = {}) => {
    const owner = taskOwner
    if (!ownsTask(owner) || activeVideoRef.current.sourceType === 'network') return null
    if (!options.silent) setAnalysisLoading(true)
    try {
      const interest = analysisIntentRef.current
      const result = await analysisObserver.request(signal => getVideoAnalysis(device, videoId, signal,
        interest?.owner === owner && interest.videoId === videoId ? interest.interestId : undefined))
      if (!result || !ownsTask(owner)) return null
      if (result.job?.interestCancelled && analysisIntentRef.current?.owner === owner) analysisIntentRef.current = null
      storeAnalysisState(videoId, result)
      return result
    } catch (error) {
      if (ownsTask(owner) && !options.silent) showGestureHint(error instanceof Error ? error.message : '读取分析状态失败', 1600)
      return null
    } finally { if (ownsTask(owner) && !options.silent) setAnalysisLoading(false) }
  }, [analysisObserver, device, ownsTask, showGestureHint, storeAnalysisState, taskOwner])
  const startAnalysisPolling = useCallback((videoId: string, interestId?: string) => {
    const owner = taskOwner
    if (!ownsTask(owner)) return
    const previous = analysisIntentRef.current
    const selected = interestId || (previous?.owner === owner && previous.videoId === videoId ? previous.interestId : undefined)
    analysisIntentRef.current = { owner, videoId, interestId: selected }
    analysisObserver.poll(signal => getVideoAnalysis(device, videoId, signal, selected), result => {
      if (!ownsTask(owner)) return false
      storeAnalysisState(videoId, result)
      if (result.job?.running && result.job.currentVideo && !result.job.interestCancelled) return true
      analysisIntentRef.current = null
      if (result.recent?.status === 'success') showGestureHint('视频分析完成')
      else if (result.recent?.status === 'error') showGestureHint(result.recent.error || '视频分析失败', 1800)
      return false
    }, error => {
      if (!ownsTask(owner)) return
      analysisIntentRef.current = null
      showGestureHint(error instanceof Error ? error.message : '读取分析状态失败', 1600)
    }, 1600)
  }, [analysisObserver, device, ownsTask, showGestureHint, storeAnalysisState, taskOwner])

  const applyTranscodeReady = useCallback((videoId: string, streamUrl?: string, qualityLabel = '兼容格式') => {
    if (!streamUrl) return
    setVideoOverrides(current => ({
      ...current,
      [videoId]: {
        ...(current[videoId] || {}),
        streamUrl
      }
    }))
    setTranscoding(false)
    setTranscodeProgress(1)
    setTranscodeQueuePosition(0)
    if (activeVideoRef.current.id === videoId) {
      setError('')
      setStatus('loading')
      setReloadKey(key => key + 1)
      showGestureHint(`${qualityLabel}已准备好`)
    }
  }, [showGestureHint])

  const handleCancelTranscode = useCallback(async () => {
    if (!ownsTask(taskOwner)) return
    const owner = taskOwner
    const intent = transcodeIntentRef.current, action = ++transcodeActionRef.current
    const interestId = intent?.interestId
    stopTranscodePolling()
    setTranscoding(false)
    setTranscodeProgress(0)
    setTranscodeQueuePosition(0)
    transcodeIntentRef.current = null
    const result = await cancelTranscode(device, activeVideoRef.current.id, transcodingQualityRef.current, interestId).catch(() => null)
    if (action !== transcodeActionRef.current || taskOwnerRef.current !== owner || !mountedRef.current) return
    if (!result && intent) { transcodeIntentRef.current = intent; setTranscoding(true) }
    if (ownsTask(owner)) showGestureHint(result?.shared ? '已停止等待，其他设备仍在准备' : result ? '已取消转码' : '取消未确认，请稍后重试')
  }, [device, showGestureHint, stopTranscodePolling, ownsTask, taskOwner])

  const pollTranscodeStatus = useCallback((videoId: string, quality = 'compatible', qualityLabel = '兼容格式', interestId = transcodeIntentRef.current?.interestId || 'legacy') => {
    const owner = taskOwner
    if (!ownsTask(owner)) return
    transcodeIntentRef.current = { owner, videoId, quality, label: qualityLabel, interestId }
    transcodeObserver.poll(signal => getTranscodeStatus(device, videoId, quality, signal, interestId), result => {
      if (!ownsTask(owner)) return false
      setTranscodeProgress(Math.max(0, Math.min(1, Number(result.progress) || 0)))
      setTranscodeQueuePosition(Number(result.queuePosition) || 0)
      if (result.status === 'ready') {
        transcodeIntentRef.current = null; applyTranscodeReady(videoId, result.streamUrl, qualityLabel); return false
      }
      if (result.status === 'error' || result.status === 'cancelled') {
        transcodeIntentRef.current = null; setTranscoding(false); setTranscodeQueuePosition(0)
        setError(result.error || (result.status === 'cancelled' ? '转码已取消' : '转码失败')); setStatus('error'); return false
      }
      return true
    }, error => {
      if (!ownsTask(owner)) return
      transcodeIntentRef.current = null; setTranscoding(false); setTranscodeQueuePosition(0)
      setError(error instanceof Error ? error.message : '转码状态读取失败'); setStatus('error')
    }, 1200)
  }, [applyTranscodeReady, device, ownsTask, transcodeObserver, taskOwner])

  const handleTranscode = useCallback(async (quality = 'compatible', qualityLabel = '兼容格式') => {
    const item = activeVideoRef.current
    if (item.sourceType === 'network') {
      showGestureHint('网络资源暂不支持转码缓存', 1600)
      return
    }
    if (!ownsTask(taskOwner)) return
    transcodeActionRef.current++
    transcodingQualityRef.current = quality
    setTranscoding(true)
    setTranscodeProgress(0.02)
    setTranscodeQueuePosition(0)
    setControlsVisible(false)
    stopTranscodePolling()
    const owner = taskOwner
    if (!ownsTask(owner)) return
    const previous = transcodeIntentRef.current
    const interestId = previous?.owner === owner && previous.quality === quality ? previous.interestId
      : `ti_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`
    transcodeIntentRef.current = { owner, videoId: item.id, quality, label: qualityLabel, interestId }

    try {
      const result = await transcodeObserver.request(signal => startTranscode(device, item.id, quality, signal, interestId))
      if (!ownsTask(owner)) return
      if (!result) return
      setTranscodeProgress(Math.max(0.02, Math.min(1, Number(result.progress) || 0.02)))
      setTranscodeQueuePosition(Number(result.queuePosition) || 0)
      if (result.status === 'ready') {
        transcodeIntentRef.current = null
        applyTranscodeReady(item.id, result.streamUrl, qualityLabel)
        return
      }
      if (result.status === 'error' || result.status === 'cancelled') {
        transcodeIntentRef.current = null
        throw new Error(result.error || '转码启动失败')
      }
      pollTranscodeStatus(item.id, quality, qualityLabel, interestId)
    } catch (transcodeError) {
      if (!ownsTask(owner)) return
      setTranscoding(false)
      setTranscodeQueuePosition(0)
      setError(transcodeError instanceof Error ? transcodeError.message : '转码启动失败')
      setStatus('error')
    }
  }, [applyTranscodeReady, device, pollTranscodeStatus, showGestureHint, stopTranscodePolling, transcodeObserver, ownsTask, taskOwner])

  const handleOpenAnalysis = useCallback(() => {
    if (!ownsTask(taskOwner)) return
    const item = activeVideoRef.current
    if (item.sourceType === 'network') {
      showGestureHint('网络资源暂不支持视频分析', 1600)
      return
    }
    closeTagEditor()
    if (!sheets.open('analysis')) return
    setControlsVisible(false)
    fetchAnalysisState(item.id).then((result) => {
      if (result?.job?.running) startAnalysisPolling(item.id, result.job.canCancel ? result.job.interestId : undefined)
    })
  }, [fetchAnalysisState, showGestureHint, startAnalysisPolling, ownsTask, taskOwner, closeTagEditor, sheets.open])

  const handleStartAnalysis = useCallback(async () => {
    const item = activeVideoRef.current
    if (item.sourceType === 'network') {
      showGestureHint('网络资源暂不支持视频分析', 1600)
      return
    }
    const owner = taskOwner
    if (!ownsTask(owner)) return
    const action = ++analysisActionRef.current, previous = analysisIntentRef.current
    const interestId = previous?.owner === owner && previous.videoId === item.id && previous.interestId && !previous.cancelRequested ? previous.interestId
      : `ai_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`
    analysisIntentRef.current = { owner, videoId: item.id, interestId }
    setAnalysisCancelling(false)
    setAnalysisStarting(true)
    stopAnalysisPolling()
    try {
      const result = await analysisObserver.request(signal => startVideoAnalysis(device, item.id, signal, interestId))
      if (!result || !ownsTask(owner) || action !== analysisActionRef.current) return
      storeAnalysisState(item.id, result)
      if (result.reason === 'stopping') {
        analysisIntentRef.current = null; showGestureHint(result.error || '上次分析正在收尾，请稍后重试', 1800); return
      }
      if (result.accepted || result.job?.currentVideo) {
        showGestureHint('已在电脑端开始分析')
        startAnalysisPolling(item.id, interestId)
        return
      }
      analysisIntentRef.current = null
      if (result.job?.running) {
        showGestureHint('电脑端正在分析其他视频，请稍后再试', 1800)
        return
      }
      showGestureHint(result.error || (result.reason === 'disabled' ? '请先在电脑端开启视频理解' : '无法开始分析'), 1800)
    } catch (analysisError) {
      if (ownsTask(owner) && action === analysisActionRef.current) showGestureHint(analysisError instanceof Error ? analysisError.message : '视频分析启动失败', 1800)
    } finally {
      if (ownsTask(owner) && action === analysisActionRef.current) setAnalysisStarting(false)
    }
  }, [device, showGestureHint, startAnalysisPolling, stopAnalysisPolling, storeAnalysisState, analysisObserver, ownsTask, taskOwner])

  const handleCancelAnalysis = useCallback(async () => {
    const owner = taskOwner, item = activeVideoRef.current, intent = analysisIntentRef.current
    const state = analysisById[item.id], interestId = intent?.owner === owner ? intent.interestId : state?.job?.canCancel ? state.job.interestId : undefined
    if (!ownsTask(owner) || !interestId || !device.capabilities?.analysisInterests) return
    const action = ++analysisActionRef.current
    if (intent?.owner === owner) intent.cancelRequested = true
    stopAnalysisPolling(); setAnalysisStarting(false); setAnalysisCancelling(true)
    try {
      const result = await cancelVideoAnalysis(device, item.id, interestId, state?.job?.interestId === interestId ? state.job.jobId : undefined)
      if (!ownsTask(owner) || action !== analysisActionRef.current) return
      analysisIntentRef.current = null
      setAnalysisById(current => {
        const value = current[item.id]
        return value ? { ...current, [item.id]: { ...value, job: value.job ? { ...value.job, canCancel: false, interestCancelled: true } : null } } : current
      })
      showGestureHint(result.shared ? '已取消本次分析，其他设备或窗口仍在分析' : '分析已取消', 2000)
    } catch (error) {
      if (ownsTask(owner) && action === analysisActionRef.current) showGestureHint(error instanceof Error ? error.message : '取消未确认，请重试', 1800)
    } finally { if (ownsTask(owner) && action === analysisActionRef.current) setAnalysisCancelling(false) }
  }, [analysisById, device, ownsTask, showGestureHint, stopAnalysisPolling, taskOwner])

  useEffect(() => {
    if (transcodeIntentRef.current?.owner !== taskOwner) transcodeIntentRef.current = null
    if (analysisIntentRef.current?.owner !== taskOwner) analysisIntentRef.current = null
    if (!taskActive) {
      stopTranscodePolling(); stopAnalysisPolling(); setAnalysisLoading(false); setAnalysisStarting(false); setAnalysisCancelling(false)
    } else {
      const transcode = transcodeIntentRef.current, analysis = analysisIntentRef.current
      if (transcode) pollTranscodeStatus(transcode.videoId, transcode.quality, transcode.label, transcode.interestId)
      if (analysis) startAnalysisPolling(analysis.videoId, analysis.interestId)
    }
    return () => { stopTranscodePolling(); stopAnalysisPolling() }
  }, [taskActive, taskOwner, stopTranscodePolling, stopAnalysisPolling, pollTranscodeStatus, startAnalysisPolling])

  const handleQualitySelect = useCallback((quality: string) => {
    if (!ownsTask(taskOwner)) return
    closeMoreSheet()
    if (quality === QUALITY_ORIGINAL) {
      transcodeActionRef.current++
      transcodeIntentRef.current = null
      stopTranscodePolling()
      setTranscoding(false)
      setTranscodeProgress(0)
      setTranscodeQueuePosition(0)
      setQualityById(current => {
        const next = { ...current }
        delete next[activeVideoRef.current.id]
        return next
      })
      setVideoOverrides(current => {
        const currentOverride = current[activeVideoRef.current.id]
        if (!currentOverride?.streamUrl) return current
        const { streamUrl: _streamUrl, ...rest } = currentOverride
        return {
          ...current,
          [activeVideoRef.current.id]: rest
        }
      })
      setStatus('loading')
      setReloadKey(key => key + 1)
      showGestureHint('正在使用原画')
      return
    }

    const transcodeQuality = QUALITY_TO_TRANSCODE[quality]
    if (!transcodeQuality) {
      showGestureHint('暂不支持该清晰度', 1400)
      return
    }
    setQualityById(current => ({ ...current, [activeVideoRef.current.id]: quality }))
    handleTranscode(transcodeQuality, quality)
  }, [handleTranscode, showGestureHint, stopTranscodePolling, ownsTask, taskOwner])

  const handleClearTranscodeCache = useCallback(async () => {
    closeMoreSheet()
    try {
      const result = await clearTranscodeCache(device)
      showGestureHint(`已清理 ${result.removed} 个缓存`, 1600)
    } catch (cacheError) {
      showGestureHint(cacheError instanceof Error ? cacheError.message : '清理缓存失败', 1600)
    }
  }, [device, showGestureHint])

  const handleSeek = useCallback((time: number) => {
    const nextTime = clamp(time, 0, duration || time)
    seekCurrentPlayer(nextTime)
    lastKnownTimeRef.current = nextTime
    setCurrentTime(nextTime)
    savePositionForVideo(activeVideo, nextTime, true).catch(() => {})
    showControls()
  }, [activeVideo, duration, savePositionForVideo, seekCurrentPlayer, showControls])

  const handlePlaybackRateChange = useCallback((speed: number) => {
    setPlaybackRateState(speed)
    setCurrentPlaybackRate(speed)
    showGestureHint(`播放速度 ${speed.toFixed(1)}x`)
  }, [setCurrentPlaybackRate, showGestureHint])

  const handleAspectModeChange = useCallback((mode: AspectMode) => {
    setAspectMode(mode)
    showGestureHint(mode === 'fit' ? '画面比例：适应' : mode === 'fill' ? '画面比例：填充' : '画面比例：原始比例')
  }, [showGestureHint])

  const handlePlayerBackgroundModeChange = useCallback((mode: MobilePlayerBackgroundMode) => {
    setPlayerBackgroundMode(mode)
    saveMobileSettings({ playerBackgroundMode: mode }).catch(() => {})
    showGestureHint(mode === 'cover' ? '播放背景：封面' : '播放背景：黑色')
  }, [showGestureHint])

  const handleDesktopPlay = useCallback(async () => {
    await saveCurrentPosition()
    try {
      await playOnDesktop(device, activeVideo.id, readCurrentPosition() || currentTime)
      showGestureHint('已在电脑端播放')
    } catch (playError) {
      showGestureHint(playError instanceof Error ? playError.message : '电脑端播放失败', 1600)
    }
  }, [activeVideo.id, currentTime, device, readCurrentPosition, saveCurrentPosition, showGestureHint])

  const handleRevealOnDesktop = useCallback(async () => {
    const lease = sheets.currentRef.current
    if (activeVideo.sourceType === 'network') {
      showGestureHint('网络资源没有本地文件位置', 1600)
      return
    }
    try {
      await revealOnDesktop(device, activeVideo.id)
      if (!sheets.isCurrent(lease)) return
      showGestureHint('已在电脑中定位')
      closeMoreSheet()
    } catch (revealError) {
      if (sheets.isCurrent(lease)) showGestureHint(revealError instanceof Error ? revealError.message : '定位文件失败', 1600)
    }
  }, [activeVideo.id, activeVideo.sourceType, device, showGestureHint, closeMoreSheet, sheets.isCurrent])

  const handleCopyName = useCallback(async () => {
    const lease = sheets.currentRef.current
    try {
      await Clipboard.setStringAsync(getVideoTitle(activeVideo))
      if (!sheets.isCurrent(lease)) return
      showGestureHint('已复制视频名称')
      sheets.close(lease)
    } catch {
      if (sheets.isCurrent(lease)) showGestureHint('复制失败，请重试', 1800)
    }
  }, [activeVideo, showGestureHint, sheets.close, sheets.isCurrent])

  const handleSaveTags = useCallback(async (tags: string[]) => {
    const session = tagSessionRef.current
    if (!session) { setTagsError('标签尚未读取成功，请重新载入'); return }
    const generation = tagGenerationRef.current
    if (tagSaveGenerationRef.current === generation) return
    tagSaveGenerationRef.current = generation
    const target = session.video
    const normalizedTags = uniqueCustomTags(tags)
    setTagsSaving(true)
    try {
      const result = await saveTagEdit(session, normalizedTags)
      const customTags = result.customTags || normalizedTags
      const previousCustomTagSet = new Set(target.customTags || [])
      const systemTags = target.systemTags ?? (target.tags || []).filter(tag => !previousCustomTagSet.has(tag))
      const mergedTags = uniqueCustomTags([...systemTags, ...customTags])
      setVideoOverrides(current => ({
        ...current,
        [target.id]: {
          customTags,
          customTagsRevision: result.customTagsRevision,
          tags: mergedTags,
          group: mergedTags[0] || target.group
        }
      }))
      emitVideoLibraryUpdate({
        deviceId: session.device.id,
        bindingId: session.device.bindingId,
        videoId: target.id,
        patch: {
          customTags,
          customTagsRevision: result.customTagsRevision,
          tags: mergedTags,
          group: mergedTags[0] || target.group
        }
      })
      if (generation === tagGenerationRef.current) {
        closeTagEditor()
        showGestureHint(result.replayed && result.operationRevision !== result.customTagsRevision ? '保存已确认，标签已有后续修改'
          : customTags.length > 0 ? '标签已保存' : '自定义标签已清空')
      }
    } catch (tagError) {
      if (generation === tagGenerationRef.current) setTagsError(tagError instanceof Error ? tagError.message : '标签保存失败')
    } finally {
      if (tagSaveGenerationRef.current === generation) tagSaveGenerationRef.current = null
      if (generation === tagGenerationRef.current) setTagsSaving(false)
    }
  }, [closeTagEditor, showGestureHint])

  const handleAddAnalysisTags = useCallback(async (tags: string[]) => {
    const lease = sheets.currentRef.current
    if (lease?.kind !== 'analysis' || !sheets.isCurrent(lease) || analysisTagsRequestRef.current === lease) return
    analysisTagsRequestRef.current = lease
    const action = ++analysisTagActionRef.current
    setAnalysisTagsSaving(true)
    const target = activeVideoRef.current
    try {
      const result = await addTagsToVideos(device, [target.id], uniqueCustomTags(tags))
      if (result.failed?.length) throw new Error(result.failed[0].message)
      const updated = result.updated?.[0]
      const customTags = updated?.customTags || uniqueCustomTags([...(target.customTags || []), ...tags])
      const systemTags = target.systemTags ?? (target.tags || []).filter(tag => !(target.customTags || []).includes(tag))
      const mergedTags = uniqueCustomTags([...systemTags, ...customTags])
      const patch = { customTags, customTagsRevision: updated?.customTagsRevision, tags: mergedTags, group: mergedTags[0] || target.group }
      emitVideoLibraryUpdate({ deviceId: device.id, bindingId: device.bindingId, videoId: target.id, patch })
      if (sheets.isCurrent(lease) && action === analysisTagActionRef.current) {
        setVideoOverrides(current => ({ ...current, [target.id]: patch }))
        setSelectedAnalysisTags(current => current.filter(tag => !tags.includes(tag)))
        showGestureHint('标签已添加')
      }
    } catch (err) {
      if (sheets.isCurrent(lease) && action === analysisTagActionRef.current) showGestureHint(err instanceof Error ? err.message : '标签添加失败', 1600)
    } finally {
      if (analysisTagsRequestRef.current === lease) analysisTagsRequestRef.current = null
      if (sheets.isCurrent(lease) && action === analysisTagActionRef.current) setAnalysisTagsSaving(false)
    }
  }, [device, showGestureHint, sheets.isCurrent])

  const handleHideFromPlaylist = useCallback(async () => {
    const lease = sheets.currentRef.current
    const item = activeVideoRef.current
    await saveCurrentPosition()
    if (!sheets.isCurrent(lease)) return
    closeMoreSheet()
    closeTagEditor()
    if (videoList.length <= 1) {
      showGestureHint('已从当前列表隐藏')
      navigation.navigate({ name: 'library', device })
      return
    }
    setHiddenVideoIds(current => ({ ...current, [item.id]: true }))
    setActiveIndex(index => clamp(index, 0, videoList.length - 2))
    setReloadKey(0)
    setControlsVisible(false)
    showGestureHint('已从当前列表隐藏')
  }, [device, navigation, saveCurrentPosition, showGestureHint, videoList.length, closeMoreSheet, closeTagEditor, sheets.isCurrent])

  const goToIndex = useCallback((nextIndex: number) => {
    const bounded = clamp(nextIndex, 0, videoList.length - 1)
    if (bounded === activeIndexRef.current) return
    positionSnapshotRef.current[activeVideoRef.current.id] = readCurrentPosition()
    saveCurrentPosition().catch(() => {})
    stopTranscodePolling()
    stopAnalysisPolling()
    setTranscoding(false)
    setTranscodeProgress(0)
    setReloadKey(0)
    setControlsVisible(false)
    closeMoreSheet()
    closeTagEditor()
    sheets.close(sheets.currentRef.current)
    setAnalysisLoading(false)
    setAnalysisStarting(false)
    fullscreenModeRef.current = false
    setFullscreenMode(false)
    restorePortraitOrientation()
    setActiveIndex(bounded)
  }, [readCurrentPosition, restorePortraitOrientation, saveCurrentPosition, stopAnalysisPolling, stopTranscodePolling, videoList.length])

  const handleScrollBeginDrag = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    dragStartIndexRef.current = clamp(
      Math.round(event.nativeEvent.contentOffset.y / pageHeight),
      0,
      videoList.length - 1
    )
  }, [pageHeight, videoList.length])

  const settleToSingleStep = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const rawIndex = clamp(Math.round(event.nativeEvent.contentOffset.y / pageHeight), 0, videoList.length - 1)
    const startIndex = clamp(dragStartIndexRef.current, 0, videoList.length - 1)
    const nextIndex = clamp(rawIndex, startIndex - 1, startIndex + 1)
    dragStartIndexRef.current = nextIndex
    if (rawIndex !== nextIndex) {
      listRef.current?.scrollToIndex({ index: nextIndex, animated: true })
    }
    goToIndex(nextIndex)
  }, [goToIndex, pageHeight, videoList.length])

  const edgeBackResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (event, gesture) => {
      const startX = event.nativeEvent.pageX - gesture.dx
      const horizontal = Math.abs(gesture.dx)
      const vertical = Math.abs(gesture.dy)
      return startX < 34 && gesture.dx > 28 && horizontal > vertical * 1.4
    },
    onPanResponderRelease: (_event, gesture) => {
      if (gesture.dx > 72) {
        handleBack()
      }
    }
  }), [handleBack])

  const renderVideoPage = useCallback(({ item, index }: { item: VideoItem, index: number }) => {
    const isActive = index === activeIndex
    const itemThumbnail = isActive ? thumbnailUrl : resolveThumbnailUrl(device, item)
    return (
      <VideoFeedItem
        video={item}
        thumbnailUrl={itemThumbnail}
        isActive={isActive}
        width={pageWidth}
        height={pageHeight}
        player={player}
        contentFit={effectiveFit}
        useCoverBackground={playerBackgroundMode === 'cover'}
        videoRef={videoViewRef}
        onPress={handleVideoPress}
        onLongPress={startSpeedBoost}
        onPressOut={stopSpeedBoost}
      >
        {isActive ? (
          <>
            <VideoOverlay
              video={activeVideo}
              favorite={favorite}
              status={status}
              error={error}
              progressMessage={progressMessage}
              isPlaying={isPlaying}
              currentTime={currentTime}
              duration={duration}
              controlsVisible={controlsVisible || screenReaderEnabled}
              heartBurst={heartBurst}
              speedBoostMode={speedBoostMode}
              gestureHint={gestureHint}
              networkSlow={networkSlow}
              transcoding={transcoding}
              transcodeProgress={transcodeProgress}
              transcodeQueuePosition={transcodeQueuePosition}
              analysisLabel={analysisActionLabel}
              analysisActive={analysisRunning || analysisAvailable}
              networkResource={activeIsNetworkResource}
              groupLine={groupLine}
              detailLine={detailLine}
              landscapeMode={fullscreenMode}
              safeAreaInsets={safeAreaInsets}
              onBack={handleBack}
              onRetry={handleRetry}
              onTogglePlayback={togglePlayback}
              onSeek={handleSeek}
              onFavorite={toggleFavoriteState}
              onTags={handleOpenTagEditor}
              onAnalysis={handleOpenAnalysis}
              onCache={() => handleTranscode()}
              onDesktopPlay={handleDesktopPlay}
              onMore={() => {
                closeTagEditor()
                sheets.open('more')
                setControlsVisible(true)
              }}
              onFullscreen={toggleFullscreen}
              onControlsInteract={showControls}
              onTranscode={() => handleTranscode()}
              onCancelTranscode={handleCancelTranscode}
              onErrorDetails={() => showGestureHint(error || '暂无更多详情', 1600)}
            />
          </>
        ) : null}
      </VideoFeedItem>
    )
  }, [
    activeIndex,
    activeIsNetworkResource,
    activeVideo,
    analysisActionLabel,
    analysisAvailable,
    analysisRunning,
    controlsVisible,
    currentTime,
    detailLine,
    device,
    duration,
    effectiveFit,
    error,
    progressMessage,
    favorite,
    gestureHint,
    groupLine,
    handleBack,
    handleDesktopPlay,
    handleOpenAnalysis,
    handleRetry,
    handleSeek,
    handleCancelTranscode,
    handleTranscode,
    handleVideoPress,
    heartBurst,
    screenReaderEnabled,
    isPlaying,
    fullscreenMode,
    networkSlow,
    pageHeight,
    pageWidth,
    player,
    playerBackgroundMode,
    safeAreaInsets,
    showControls,
    showGestureHint,
    speedBoostMode,
    startSpeedBoost,
    status,
    handleOpenTagEditor,
    closeTagEditor,
    stopSpeedBoost,
    thumbnailUrl,
    transcoding,
    transcodeProgress,
    toggleFavoriteState,
    toggleFullscreen,
    togglePlayback,
    sheets.open
  ])

  return (
    <View style={styles.shell} {...edgeBackResponder.panHandlers}>
      <FlatList
        accessibilityElementsHidden={Boolean(sheets.presented)} importantForAccessibility={sheets.presented ? 'no-hide-descendants' : 'auto'}
        ref={listRef}
        data={videoList}
        keyExtractor={item => item.id}
        renderItem={renderVideoPage}
        initialScrollIndex={initialIndex}
        getItemLayout={(_data, index) => ({ length: pageHeight, offset: pageHeight * index, index })}
        pagingEnabled
        snapToInterval={pageHeight}
        snapToAlignment="start"
        decelerationRate="normal"
        disableIntervalMomentum
        showsVerticalScrollIndicator={false}
        bounces={false}
        windowSize={3}
        initialNumToRender={3}
        maxToRenderPerBatch={3}
        removeClippedSubviews={Platform.OS === 'android'}
        scrollEnabled={!fullscreenMode && !moreSheetVisible && !tagSheetVisible && !analysisSheetVisible}
        onScrollBeginDrag={handleScrollBeginDrag}
        onScrollEndDrag={(event) => {
          if (!event.nativeEvent.velocity || Math.abs(event.nativeEvent.velocity.y || 0) < 0.05) {
            settleToSingleStep(event)
          }
        }}
        onMomentumScrollEnd={settleToSingleStep}
        onScrollToIndexFailed={(info) => {
          if (scrollRetryTimerRef.current) clearTimeout(scrollRetryTimerRef.current)
          scrollRetryTimerRef.current = setTimeout(() => {
            scrollRetryTimerRef.current = null
            if (!ownsNativeEvent()) return
            listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false })
          }, 50)
        }}
      />
      {sheets.presented ? <AccessibleModal label={sheets.presented.kind === 'more' ? '播放设置' : sheets.presented.kind === 'tags' ? '管理标签' : '视频分析'}
        supportedOrientations={['portrait', 'portrait-upside-down', 'landscape-left', 'landscape-right']}
        onClose={() => requestCloseSheet(sheets.presented)}>
        {sheets.presented.kind === 'more' ? <PlayerMoreSheet visible video={activeVideo} playbackRate={playbackRate} aspectMode={aspectMode}
          favorite={favorite} onFavorite={() => sheets.run(sheets.presented, toggleFavoriteState)}
          onTags={() => sheets.run(sheets.presented, handleOpenTagEditor)} onAnalysis={() => sheets.run(sheets.presented, handleOpenAnalysis)}
          onCache={() => sheets.run(sheets.presented, () => { sheets.close(sheets.presented); handleTranscode() })}
          onDesktopPlay={() => sheets.run(sheets.presented, handleDesktopPlay)}
          playerBackgroundMode={playerBackgroundMode} selectedQuality={selectedQuality} detailLine={detailLine} notice={sheets.notice} networkResource={activeIsNetworkResource}
          onClose={() => requestCloseSheet(sheets.presented)}
          onSpeedChange={speed => sheets.run(sheets.presented, () => handlePlaybackRateChange(speed))}
          onAspectModeChange={mode => sheets.run(sheets.presented, () => handleAspectModeChange(mode))}
          onPlayerBackgroundModeChange={mode => sheets.run(sheets.presented, () => handlePlayerBackgroundModeChange(mode))}
          onQualitySelect={quality => sheets.run(sheets.presented, () => handleQualitySelect(quality))}
          onSubtitleSelect={() => sheets.run(sheets.presented, () => showGestureHint('暂无可选字幕'))}
          onAudioTrackSelect={() => sheets.run(sheets.presented, () => showGestureHint('暂无可选音轨'))}
          onCopyName={() => sheets.run(sheets.presented, handleCopyName)} onRevealOnDesktop={() => sheets.run(sheets.presented, handleRevealOnDesktop)}
          onClearTranscodeCache={() => sheets.run(sheets.presented, handleClearTranscodeCache)}
          onFileInfo={() => sheets.run(sheets.presented, () => showGestureHint(detailLine || '暂无文件信息', 1800))}
          onHideFromPlaylist={() => sheets.run(sheets.presented, handleHideFromPlaylist)} />
          : sheets.presented.kind === 'tags' ? <TagEditorSheet visible video={tagEditingVideo || activeVideo} editor={tagEditorDraft}
            availableCustomTags={availableCustomTags} saving={tagsSaving} loading={tagsLoading} error={tagsError} editKey={tagEditKey} notice={sheets.notice}
            onReload={() => sheets.run(sheets.presented, handleOpenTagEditor)} onClose={() => requestCloseSheet(sheets.presented)}
            onSave={tags => sheets.run(sheets.presented, () => handleSaveTags(tags))} />
          : <VideoAnalysisSheet visible video={activeVideo} state={activeAnalysisState} loading={analysisLoading} starting={analysisStarting}
            cancelling={analysisCancelling} currentTime={currentTime} notice={sheets.notice} selectedTags={selectedAnalysisTags} addingTags={analysisTagsSaving}
            onSelectionChange={tags => sheets.run(sheets.presented, () => setSelectedAnalysisTags(tags))}
            onClose={() => requestCloseSheet(sheets.presented)} onRefresh={() => sheets.run(sheets.presented, () => fetchAnalysisState(activeVideoRef.current.id))}
            onStart={() => sheets.run(sheets.presented, handleStartAnalysis)}
            onCancel={device.capabilities?.analysisInterests ? () => sheets.run(sheets.presented, handleCancelAnalysis) : undefined}
            onAddTags={tags => sheets.run(sheets.presented, () => handleAddAnalysisTags(tags))}
            onSeek={time => sheets.run(sheets.presented, () => { handleSeek(time); sheets.close(sheets.presented) })} />}
      </AccessibleModal> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  shell: {
    flex: 1,
    backgroundColor: colors.black
  }
})
