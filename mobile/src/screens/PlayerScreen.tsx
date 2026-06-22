import * as Clipboard from 'expo-clipboard'
import { useEventListener } from 'expo'
import * as ScreenOrientation from 'expo-screen-orientation'
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
import type { NativeVideoPlayerHandle } from '../components/player/NativeVideoPlayer'
import { PlayerMoreSheet, type AspectMode } from '../components/player/PlayerMoreSheet'
import { TagEditorSheet } from '../components/player/TagEditorSheet'
import { VideoAnalysisSheet } from '../components/player/VideoAnalysisSheet'
import { VideoFeedItem } from '../components/player/VideoFeedItem'
import { VideoOverlay } from '../components/player/VideoOverlay'
import type { NavigationContext } from '../../App'
import {
  getPlaybackState,
  cancelTranscode,
  getVideoAnalysis,
  getTranscodeStatus,
  playOnDesktop,
  resolveRemoteUrl,
  revealOnDesktop,
  savePlaybackState,
  startVideoAnalysis,
  startTranscode,
  toggleFavorite,
  updateVideoTags
} from '../services/api'
import { loadLocalPlayback, saveLocalPlayback } from '../stores/playback'
import { colors } from '../theme'
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

export function PlayerScreen({ navigation, device, video, videos }: Props) {
  const dimensions = useWindowDimensions()
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
  const [reloadKey, setReloadKey] = useState(0)
  const [gestureHint, setGestureHint] = useState('')
  const [isPlaying, setIsPlaying] = useState(true)
  const [favoriteById, setFavoriteById] = useState<Record<string, boolean>>({})
  const [heartBurst, setHeartBurst] = useState(false)
  const [status, setStatus] = useState<'loading' | 'ready' | 'buffering' | 'error'>('loading')
  const [networkSlow, setNetworkSlow] = useState(false)
  const [transcoding, setTranscoding] = useState(false)
  const [transcodeProgress, setTranscodeProgress] = useState(0)
  const [analysisSheetVisible, setAnalysisSheetVisible] = useState(false)
  const [analysisById, setAnalysisById] = useState<Record<string, VideoAnalysisResponse | null>>({})
  const [analysisLoading, setAnalysisLoading] = useState(false)
  const [analysisStarting, setAnalysisStarting] = useState(false)
  const [speedBoostMode, setSpeedBoostMode] = useState<'forward' | 'rewind' | null>(null)
  const [controlsVisible, setControlsVisible] = useState(false)
  const [moreSheetVisible, setMoreSheetVisible] = useState(false)
  const [tagSheetVisible, setTagSheetVisible] = useState(false)
  const [tagsSaving, setTagsSaving] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [videoSize, setVideoSize] = useState<{ width: number, height: number } | null>(null)
  const [playbackRate, setPlaybackRateState] = useState(1)
  const [aspectMode, setAspectMode] = useState<AspectMode>('fit')
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
  const transcodeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const analysisTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const rewindTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const ignoreNextPressRef = useRef(false)
  const speedBoostActiveRef = useRef(false)
  const speedBoostModeRef = useRef<'forward' | 'rewind' | null>(null)
  const originalPlaybackRateRef = useRef(1)
  const wasPlayingBeforeBackgroundRef = useRef(false)
  const dragStartIndexRef = useRef(initialIndex)
  const positionSnapshotRef = useRef<Record<string, number>>({})
  const transcodingQualityRef = useRef('compatible')

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

  const player = useVideoPlayer({
    uri: streamUrl,
    headers: {
      Authorization: `Bearer ${device.token}`
    }
  }, (instance) => {
    instance.loop = false
    instance.timeUpdateEventInterval = 0.25
    instance.playbackRate = playbackRate
    instance.play()
  })
  const playerRef = useRef(player)

  useEffect(() => {
    playerRef.current = player
  }, [player])

  useEffect(() => {
    activeIndexRef.current = activeIndex
    activeVideoRef.current = activeVideo
  }, [activeIndex, activeVideo])

  useEffect(() => {
    fullscreenModeRef.current = fullscreenMode
  }, [fullscreenMode])

  useEffect(() => {
    setActiveIndex(initialIndex)
    requestAnimationFrame(() => {
      listRef.current?.scrollToIndex({ index: initialIndex, animated: false })
    })
  }, [initialIndex])

  useEventListener(player, 'statusChange', ({ status: nextStatus, error: playerError }) => {
    if (nextStatus === 'error') {
      setStatus('error')
      setNetworkSlow(false)
      setError(playerError?.message || '播放失败')
      return
    }
    if (nextStatus === 'readyToPlay') {
      setStatus('ready')
      setError('')
      return
    }
    if (nextStatus === 'loading') {
      setStatus(currentTime > 0 ? 'buffering' : 'loading')
    }
  })

  useEventListener(player, 'playingChange', ({ isPlaying: nextIsPlaying }) => {
    setIsPlaying(nextIsPlaying)
  })

  useEventListener(player, 'timeUpdate', ({ currentTime: nextTime, bufferedPosition }) => {
    const nextCurrentTime = Math.max(0, Number(nextTime) || 0)
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
      const buffered = Number(bufferedPosition)
      const isSlow = isPlaying && Number.isFinite(buffered) && buffered >= 0 && buffered - nextCurrentTime < 1.2 && nextDuration - nextCurrentTime > 2
      setNetworkSlow(isSlow)
      if (status === 'buffering' && !isSlow) setStatus('ready')
    }
  })

  useEventListener(player, 'sourceLoad', ({ duration: loadedDuration, availableVideoTracks }) => {
    const loadedSize = availableVideoTracks.find(track => track.size?.width && track.size?.height)?.size
    setDuration(Math.max(0, Number(loadedDuration) || 0))
    setVideoSize(loadedSize ? { width: loadedSize.width, height: loadedSize.height } : null)
    setStatus('ready')
    setNetworkSlow(false)
    setError('')
  })

  useEventListener(player, 'videoTrackChange', ({ videoTrack }) => {
    const size = videoTrack?.size
    if (size?.width && size?.height) {
      setVideoSize({ width: size.width, height: size.height })
    }
  })

  const savePositionForVideo = useCallback(async (item: VideoItem, position: number) => {
    const safePosition = Math.max(0, Number(position) || 0)
    await saveLocalPlayback(device.id, item.id, safePosition)
    savePlaybackState(device, item.id, safePosition).catch(() => {})
  }, [device])

  const readCurrentPosition = useCallback(() => {
    try {
      const position = Number(playerRef.current?.currentTime)
      if (Number.isFinite(position) && position >= 0) {
        lastKnownTimeRef.current = position
        return position
      }
    } catch {
      // expo-video SharedObject may already be released during cleanup.
    }
    return Math.max(0, Number(lastKnownTimeRef.current) || 0)
  }, [])

  const getCurrentPlaying = useCallback(() => {
    try {
      return Boolean(playerRef.current?.playing)
    } catch {
      return false
    }
  }, [])

  const playCurrentPlayer = useCallback(() => {
    try {
      playerRef.current?.play()
      return true
    } catch {
      return false
    }
  }, [])

  const pauseCurrentPlayer = useCallback(() => {
    try {
      playerRef.current?.pause()
      return true
    } catch {
      return false
    }
  }, [])

  const seekCurrentPlayer = useCallback((position: number) => {
    try {
      playerRef.current.currentTime = position
      return true
    } catch {
      return false
    }
  }, [])

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
    let cancelled = false
    const item = activeVideo

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
        const [remote, local] = await Promise.all([
          getPlaybackState(device, item.id).catch(() => null),
          loadLocalPlayback(device.id, item.id)
        ])
        if (cancelled) return
        const position = Math.max(remote?.position || 0, local?.position || 0)
        if (position > 5) {
          try {
            player.currentTime = position
          } catch {
            return
          }
          lastKnownTimeRef.current = position
          setCurrentTime(position)
        }
      } catch {
        // 进度恢复失败不影响播放本身。
      }
    }

    restore()
    return () => {
      cancelled = true
      const snapshot = positionSnapshotRef.current[item.id]
      delete positionSnapshotRef.current[item.id]
      const position = Math.max(0, Number.isFinite(snapshot) ? snapshot : Number(lastKnownTimeRef.current) || 0)
      savePositionForVideo(item, position).catch(() => {})
    }
  }, [activeVideo, device, player, savePositionForVideo])

  useEffect(() => {
    const interval = setInterval(async () => {
      const position = readCurrentPosition()
      if (Math.abs(position - lastSavedRef.current) < 5) return
      lastSavedRef.current = position
      await savePositionForVideo(activeVideo, position)
    }, 5000)

    return () => clearInterval(interval)
  }, [activeVideo, readCurrentPosition, savePositionForVideo])

  const showGestureHint = useCallback((text: string, timeout = 1100) => {
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current)
    setGestureHint(text)
    hintTimerRef.current = setTimeout(() => {
      setGestureHint('')
      hintTimerRef.current = null
    }, timeout)
  }, [])

  const scheduleControlsHide = useCallback(() => {
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current)
    controlsTimerRef.current = setTimeout(() => {
      setControlsVisible(false)
      controlsTimerRef.current = null
    }, CONTROLS_HIDE_DELAY_MS)
  }, [])

  const showControls = useCallback(() => {
    setControlsVisible(true)
    scheduleControlsHide()
  }, [scheduleControlsHide])

  const triggerHeartBurst = useCallback(() => {
    if (heartTimerRef.current) clearTimeout(heartTimerRef.current)
    setHeartBurst(true)
    heartTimerRef.current = setTimeout(() => {
      setHeartBurst(false)
      heartTimerRef.current = null
    }, 680)
  }, [])

  const toggleFavoriteState = useCallback(async () => {
    const item = activeVideoRef.current
    const previous = favoriteById[item.id] ?? Boolean(item.favorite)
    const next = !previous
    setFavoriteById(current => ({ ...current, [item.id]: next }))
    triggerHeartBurst()
    try {
      const result = await toggleFavorite(device, item.id)
      setFavoriteById(current => ({ ...current, [item.id]: result.favorite }))
    } catch {
      setFavoriteById(current => ({ ...current, [item.id]: previous }))
      showGestureHint('收藏失败')
    }
  }, [device, favoriteById, showGestureHint, triggerHeartBurst])

  const togglePlayback = useCallback(() => {
    if (status === 'error') return
    if (getCurrentPlaying() || isPlaying) {
      pauseCurrentPlayer()
      setControlsVisible(true)
      if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current)
      return
    }
    playCurrentPlayer()
    showControls()
  }, [getCurrentPlaying, isPlaying, pauseCurrentPlayer, playCurrentPlayer, showControls, status])

  const handleVideoPress = useCallback(() => {
    if (ignoreNextPressRef.current) {
      ignoreNextPressRef.current = false
      return
    }
    if (status === 'error') return

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
  }, [status, toggleFavoriteState, togglePlayback])

  const startSpeedBoost = useCallback((event?: GestureResponderEvent) => {
    if (status === 'error') return
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
    status
  ])

  const stopSpeedBoost = useCallback(() => {
    if (!speedBoostActiveRef.current) return
    if (rewindTimerRef.current) {
      clearInterval(rewindTimerRef.current)
      rewindTimerRef.current = null
    }
    setCurrentPlaybackRate(originalPlaybackRateRef.current)
    speedBoostActiveRef.current = false
    speedBoostModeRef.current = null
    setSpeedBoostMode(null)
    setTimeout(() => {
      ignoreNextPressRef.current = false
    }, 0)
  }, [setCurrentPlaybackRate])

  const restorePortraitOrientation = useCallback(() => {
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {})
    setTimeout(() => {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {})
    }, 250)
  }, [])

  const restoreCurrentPagePosition = useCallback((animated = false) => {
    requestAnimationFrame(() => {
      const index = clamp(activeIndexRef.current, 0, videoList.length - 1)
      listRef.current?.scrollToIndex({ index, animated })
    })
  }, [videoList.length])

  const leaveFullscreen = useCallback(async () => {
    setFullscreenMode(false)
    setControlsVisible(true)
    setMoreSheetVisible(false)
    setTagSheetVisible(false)
    stopSpeedBoost()
    restorePortraitOrientation()
    restoreCurrentPagePosition(false)
  }, [restoreCurrentPagePosition, restorePortraitOrientation, stopSpeedBoost])

  const toggleFullscreen = useCallback(async () => {
    if (fullscreenModeRef.current) {
      await leaveFullscreen()
      return
    }

    setMoreSheetVisible(false)
    setTagSheetVisible(false)
    stopSpeedBoost()
    setFullscreenMode(true)
    setControlsVisible(true)
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => {
      restorePortraitOrientation()
      showGestureHint('横屏全屏暂时不可用')
      setFullscreenMode(false)
    })
    showControls()
  }, [leaveFullscreen, restorePortraitOrientation, showControls, showGestureHint, stopSpeedBoost])

  useEffect(() => () => {
    if (tapTimerRef.current) clearTimeout(tapTimerRef.current)
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current)
    if (heartTimerRef.current) clearTimeout(heartTimerRef.current)
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current)
    if (transcodeTimerRef.current) clearInterval(transcodeTimerRef.current)
    if (analysisTimerRef.current) clearInterval(analysisTimerRef.current)
    if (rewindTimerRef.current) clearInterval(rewindTimerRef.current)
    restorePortraitOrientation()
  }, [restorePortraitOrientation])

  const handleBack = useCallback(async () => {
    await saveCurrentPosition()
    if (fullscreenMode) {
      await leaveFullscreen()
      return
    }
    if (navigation.canGoBack) {
      navigation.back()
    } else {
      navigation.navigate({ name: 'library', device })
    }
  }, [device, fullscreenMode, leaveFullscreen, navigation, saveCurrentPosition])

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      handleBack()
      return true
    })
    return () => subscription.remove()
  }, [handleBack])

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      if (nextState === 'active') {
        if (wasPlayingBeforeBackgroundRef.current && status !== 'error') {
          playCurrentPlayer()
        }
        wasPlayingBeforeBackgroundRef.current = false
        return
      }

      wasPlayingBeforeBackgroundRef.current = getCurrentPlaying() || isPlaying
      pauseCurrentPlayer()
      saveCurrentPosition().catch(() => {})
    })

    return () => subscription.remove()
  }, [getCurrentPlaying, isPlaying, pauseCurrentPlayer, playCurrentPlayer, saveCurrentPosition, status])

  const handleRetry = useCallback(() => {
    setError('')
    setStatus('loading')
    setReloadKey(key => key + 1)
  }, [])

  const stopTranscodePolling = useCallback(() => {
    if (transcodeTimerRef.current) {
      clearInterval(transcodeTimerRef.current)
      transcodeTimerRef.current = null
    }
  }, [])

  const stopAnalysisPolling = useCallback(() => {
    if (analysisTimerRef.current) {
      clearInterval(analysisTimerRef.current)
      analysisTimerRef.current = null
    }
  }, [])

  const storeAnalysisState = useCallback((videoId: string, state: VideoAnalysisResponse | null) => {
    setAnalysisById(current => ({ ...current, [videoId]: state }))
  }, [])

  const fetchAnalysisState = useCallback(async (videoId = activeVideoRef.current.id, options: { silent?: boolean } = {}) => {
    if (!options.silent) setAnalysisLoading(true)
    try {
      const result = await getVideoAnalysis(device, videoId)
      storeAnalysisState(videoId, result)
      const running = Boolean(result.job?.running)
      const terminal = ['success', 'error', 'cancelled'].includes(result.recent?.status || '')
      if (!running && terminal) stopAnalysisPolling()
      return result
    } catch (analysisError) {
      if (!options.silent) {
        showGestureHint(analysisError instanceof Error ? analysisError.message : '读取分析状态失败', 1600)
      }
      return null
    } finally {
      if (!options.silent) setAnalysisLoading(false)
    }
  }, [device, showGestureHint, stopAnalysisPolling, storeAnalysisState])

  const pollAnalysisState = useCallback(async (videoId: string) => {
    const result = await fetchAnalysisState(videoId, { silent: true })
    if (!result) return
    const running = Boolean(result.job?.running)
    const terminal = ['success', 'error', 'cancelled'].includes(result.recent?.status || '')
    if (running || !terminal) return
    stopAnalysisPolling()
    if (result.recent?.status === 'success') {
      await fetchAnalysisState(videoId, { silent: true })
      if (activeVideoRef.current.id === videoId) showGestureHint('视频分析完成')
      return
    }
    if (activeVideoRef.current.id === videoId && result.recent?.status === 'error') {
      showGestureHint(result.recent.error || '视频分析失败', 1800)
    }
  }, [fetchAnalysisState, showGestureHint, stopAnalysisPolling])

  const startAnalysisPolling = useCallback((videoId: string) => {
    stopAnalysisPolling()
    analysisTimerRef.current = setInterval(() => {
      pollAnalysisState(videoId)
    }, 1600)
  }, [pollAnalysisState, stopAnalysisPolling])

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
    if (activeVideoRef.current.id === videoId) {
      setError('')
      setStatus('loading')
      setReloadKey(key => key + 1)
      showGestureHint(`${qualityLabel}已准备好`)
    }
  }, [showGestureHint])

  const handleCancelTranscode = useCallback(async () => {
    stopTranscodePolling()
    setTranscoding(false)
    setTranscodeProgress(0)
    await cancelTranscode(device, activeVideoRef.current.id, transcodingQualityRef.current).catch(() => {})
    showGestureHint('已取消转码')
  }, [device, showGestureHint, stopTranscodePolling])

  const pollTranscodeStatus = useCallback(async (videoId: string, quality = 'compatible', qualityLabel = '兼容格式') => {
    try {
      const statusResult = await getTranscodeStatus(device, videoId, quality)
      setTranscodeProgress(Math.max(0, Math.min(1, Number(statusResult.progress) || 0)))
      if (statusResult.status === 'ready') {
        stopTranscodePolling()
        applyTranscodeReady(videoId, statusResult.streamUrl, qualityLabel)
      } else if (statusResult.status === 'error') {
        stopTranscodePolling()
        setTranscoding(false)
        setError(statusResult.error || '转码失败')
        setStatus('error')
      }
    } catch (transcodeError) {
      stopTranscodePolling()
      setTranscoding(false)
      setError(transcodeError instanceof Error ? transcodeError.message : '转码状态读取失败')
      setStatus('error')
    }
  }, [applyTranscodeReady, device, stopTranscodePolling])

  const handleTranscode = useCallback(async (quality = 'compatible', qualityLabel = '兼容格式') => {
    const item = activeVideoRef.current
    transcodingQualityRef.current = quality
    setTranscoding(true)
    setTranscodeProgress(0.02)
    setControlsVisible(false)
    stopTranscodePolling()

    try {
      const result = await startTranscode(device, item.id, quality)
      setTranscodeProgress(Math.max(0.02, Math.min(1, Number(result.progress) || 0.02)))
      if (result.status === 'ready') {
        applyTranscodeReady(item.id, result.streamUrl, qualityLabel)
        return
      }
      if (result.status === 'error') {
        throw new Error(result.error || '转码启动失败')
      }
      pollTranscodeStatus(item.id, quality, qualityLabel)
      transcodeTimerRef.current = setInterval(() => {
        pollTranscodeStatus(item.id, quality, qualityLabel)
      }, 1200)
    } catch (transcodeError) {
      setTranscoding(false)
      setError(transcodeError instanceof Error ? transcodeError.message : '转码启动失败')
      setStatus('error')
    }
  }, [applyTranscodeReady, device, pollTranscodeStatus, stopTranscodePolling])

  const handleOpenAnalysis = useCallback(() => {
    const item = activeVideoRef.current
    setAnalysisSheetVisible(true)
    setControlsVisible(false)
    fetchAnalysisState(item.id).then((result) => {
      if (result?.job?.running) startAnalysisPolling(item.id)
    })
  }, [fetchAnalysisState, startAnalysisPolling])

  const handleStartAnalysis = useCallback(async () => {
    const item = activeVideoRef.current
    setAnalysisStarting(true)
    stopAnalysisPolling()
    try {
      const result = await startVideoAnalysis(device, item.id)
      storeAnalysisState(item.id, result)
      if (result.accepted || result.job?.currentVideo) {
        showGestureHint('已在电脑端开始分析')
        startAnalysisPolling(item.id)
        return
      }
      if (result.job?.running) {
        showGestureHint('电脑端正在分析其他视频，请稍后再试', 1800)
        return
      }
      showGestureHint(result.error || (result.reason === 'disabled' ? '请先在电脑端开启视频理解' : '无法开始分析'), 1800)
    } catch (analysisError) {
      showGestureHint(analysisError instanceof Error ? analysisError.message : '视频分析启动失败', 1800)
    } finally {
      setAnalysisStarting(false)
    }
  }, [device, showGestureHint, startAnalysisPolling, stopAnalysisPolling, storeAnalysisState])

  const handleQualitySelect = useCallback((quality: string) => {
    setMoreSheetVisible(false)
    if (quality === QUALITY_ORIGINAL) {
      stopTranscodePolling()
      setTranscoding(false)
      setTranscodeProgress(0)
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
  }, [handleTranscode, showGestureHint, stopTranscodePolling])

  const handleSeek = useCallback((time: number) => {
    const nextTime = clamp(time, 0, duration || time)
    seekCurrentPlayer(nextTime)
    lastKnownTimeRef.current = nextTime
    setCurrentTime(nextTime)
    savePositionForVideo(activeVideo, nextTime).catch(() => {})
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
    try {
      await revealOnDesktop(device, activeVideo.id)
      showGestureHint('已在电脑中定位')
      setMoreSheetVisible(false)
    } catch (revealError) {
      showGestureHint(revealError instanceof Error ? revealError.message : '定位文件失败', 1600)
    }
  }, [activeVideo.id, device, showGestureHint])

  const handleCopyName = useCallback(async () => {
    await Clipboard.setStringAsync(getVideoTitle(activeVideo))
    showGestureHint('已复制视频名称')
    setMoreSheetVisible(false)
  }, [activeVideo, showGestureHint])

  const handleSaveTags = useCallback(async (tags: string[]) => {
    const normalizedTags = uniqueCustomTags(tags)
    setTagsSaving(true)
    try {
      const result = await updateVideoTags(device, activeVideo.id, normalizedTags)
      const customTags = result.customTags || normalizedTags
      const previousCustomTagSet = new Set(activeVideo.customTags || [])
      const systemTags = activeVideo.systemTags?.length
        ? activeVideo.systemTags
        : (activeVideo.tags || []).filter(tag => !previousCustomTagSet.has(tag))
      const mergedTags = uniqueCustomTags([...systemTags, ...customTags])
      setVideoOverrides(current => ({
        ...current,
        [activeVideo.id]: {
          customTags,
          tags: mergedTags,
          group: mergedTags[0] || activeVideo.group
        }
      }))
      setTagSheetVisible(false)
      showGestureHint(customTags.length > 0 ? '标签已保存' : '自定义标签已清空')
    } catch (tagError) {
      showGestureHint(tagError instanceof Error ? tagError.message : '标签保存失败', 1600)
    } finally {
      setTagsSaving(false)
    }
  }, [activeVideo, device, showGestureHint])

  const handleHideFromPlaylist = useCallback(async () => {
    const item = activeVideoRef.current
    await saveCurrentPosition()
    setMoreSheetVisible(false)
    setTagSheetVisible(false)
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
  }, [device, navigation, saveCurrentPosition, showGestureHint, videoList.length])

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
    setMoreSheetVisible(false)
    setTagSheetVisible(false)
    setAnalysisSheetVisible(false)
    setAnalysisLoading(false)
    setAnalysisStarting(false)
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
              isPlaying={isPlaying}
              currentTime={currentTime}
              duration={duration}
              controlsVisible={controlsVisible}
              heartBurst={heartBurst}
              speedBoostMode={speedBoostMode}
              gestureHint={gestureHint}
              networkSlow={networkSlow}
              transcoding={transcoding}
              transcodeProgress={transcodeProgress}
              analysisLabel={analysisActionLabel}
              analysisActive={analysisRunning || analysisAvailable}
              groupLine={groupLine}
              detailLine={detailLine}
              landscapeMode={fullscreenMode}
              onBack={handleBack}
              onRetry={handleRetry}
              onTogglePlayback={togglePlayback}
              onSeek={handleSeek}
              onFavorite={toggleFavoriteState}
              onTags={() => {
                setTagSheetVisible(true)
                setControlsVisible(false)
              }}
              onAnalysis={handleOpenAnalysis}
              onCache={handleTranscode}
              onDesktopPlay={handleDesktopPlay}
              onMore={() => {
                setMoreSheetVisible(true)
                setControlsVisible(true)
              }}
              onFullscreen={toggleFullscreen}
              onControlsInteract={showControls}
              onTranscode={handleTranscode}
              onCancelTranscode={handleCancelTranscode}
              onErrorDetails={() => showGestureHint(error || '暂无更多详情', 1600)}
            />
            <PlayerMoreSheet
              visible={moreSheetVisible}
              video={activeVideo}
              playbackRate={playbackRate}
              aspectMode={aspectMode}
              selectedQuality={selectedQuality}
              detailLine={detailLine}
              onClose={() => setMoreSheetVisible(false)}
              onSpeedChange={handlePlaybackRateChange}
              onAspectModeChange={handleAspectModeChange}
              onQualitySelect={handleQualitySelect}
              onSubtitleSelect={() => showGestureHint('暂无可选字幕')}
              onAudioTrackSelect={() => showGestureHint('暂无可选音轨')}
              onCopyName={handleCopyName}
              onRevealOnDesktop={handleRevealOnDesktop}
              onFileInfo={() => showGestureHint(detailLine || '暂无文件信息', 1800)}
              onHideFromPlaylist={handleHideFromPlaylist}
            />
            <TagEditorSheet
              visible={tagSheetVisible}
              video={activeVideo}
              availableCustomTags={availableCustomTags}
              saving={tagsSaving}
              onClose={() => setTagSheetVisible(false)}
              onSave={handleSaveTags}
            />
            <VideoAnalysisSheet
              visible={analysisSheetVisible}
              video={activeVideo}
              state={activeAnalysisState}
              loading={analysisLoading}
              starting={analysisStarting}
              currentTime={currentTime}
              onClose={() => setAnalysisSheetVisible(false)}
              onRefresh={() => fetchAnalysisState(activeVideoRef.current.id)}
              onStart={handleStartAnalysis}
              onSeek={(time) => {
                handleSeek(time)
                setAnalysisSheetVisible(false)
              }}
            />
          </>
        ) : null}
      </VideoFeedItem>
    )
  }, [
    activeIndex,
    activeAnalysisState,
    activeVideo,
    analysisActionLabel,
    analysisAvailable,
    analysisLoading,
    analysisRunning,
    analysisSheetVisible,
    analysisStarting,
    controlsVisible,
    currentTime,
    availableCustomTags,
    detailLine,
    device,
    duration,
    effectiveFit,
    error,
    favorite,
    gestureHint,
    groupLine,
    handleAspectModeChange,
    handleBack,
    handleCopyName,
    handleDesktopPlay,
    handleHideFromPlaylist,
    handleOpenAnalysis,
    handleQualitySelect,
    handlePlaybackRateChange,
    handleRevealOnDesktop,
    handleRetry,
    handleSeek,
    handleSaveTags,
    handleStartAnalysis,
    handleCancelTranscode,
    handleTranscode,
    handleVideoPress,
    heartBurst,
    isPlaying,
    fullscreenMode,
    moreSheetVisible,
    networkSlow,
    pageHeight,
    pageWidth,
    playbackRate,
    player,
    selectedQuality,
    showControls,
    showGestureHint,
    speedBoostMode,
    startSpeedBoost,
    status,
    tagSheetVisible,
    tagsSaving,
    fetchAnalysisState,
    stopSpeedBoost,
    thumbnailUrl,
    transcoding,
    transcodeProgress,
    toggleFavoriteState,
    toggleFullscreen,
    togglePlayback
  ])

  return (
    <View style={styles.shell} {...edgeBackResponder.panHandlers}>
      <FlatList
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
          setTimeout(() => {
            listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false })
          }, 50)
        }}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  shell: {
    flex: 1,
    backgroundColor: colors.black
  }
})
