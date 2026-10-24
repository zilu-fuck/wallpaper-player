import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useAppFields, useAppSelection } from '../context/AppContext'
import VideoAnalysisPanel from './VideoAnalysisPanel'
import PlayerAnalysisStatus from './player/PlayerAnalysisStatus'
import PlayerProgressPreview from './player/PlayerProgressPreview'
import PlayerToolbarMenu, { formatSpeed } from './player/PlayerToolbarMenu'
import { formatTime } from './player/playerFormat'
import { getPlaybackState, savePlaybackState } from '../api/media'
import { MpvAdapter, Html5Adapter, WebpageAdapter } from '../api/player'
import { useMpvHost, useProgressPreview } from '../hooks/usePlayerResources'

const SEEK_STEP = 5
const ARROW_HOLD_DELAY = 300
const ARROW_HOLD_SPEED = 2

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function Icon({ path, viewBox = '0 0 24 24' }) {
  return (
    <svg width="16" height="16" viewBox={viewBox} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {path}
    </svg>
  )
}

function getQueueItemTitle(item, index, isNetworkList) {
  if (isNetworkList) {
    return item?.page?.currentEpisodeTitle || item?.title || item?.name || item?.fileName || `第 ${index + 1} 集`
  }
  return item?.name || item?.fileName || item?.fullPath?.split(/[/\\]/).pop() || `视频 ${index + 1}`
}

function getQueueItemMeta(item, isNetworkList) {
  if (isNetworkList) {
    try {
      const parsed = new URL(item?.url || item?.fullPath || '')
      return parsed.hostname
    } catch {
      return '网络资源'
    }
  }
  const filePath = String(item?.fullPath || item?.filePath || '')
  const dir = filePath.split(/[/\\]/).slice(0, -1).join('\\')
  return dir || item?.group || '本地视频'
}

function VideoPlayer({ video }) {
  const {
    mpvStatus,
    playerError,
    setPlayerError,
    queueItems,
    queueIndex,
    queueLength,
    handlePlay,
    handleOpenFile,
    handleDropFiles,
    handleStopPlayback,
    handleNext,
    handlePrev,
    handleReplayCurrent,
    handleAdvanceFromEnd,
    handleAppendCustomTags,
    registerPlayerCommandTarget
  } = useAppFields([
    'mpvStatus', 'playerError', 'setPlayerError', 'queueItems',
    'queueIndex', 'queueLength', 'handlePlay', 'handleOpenFile',
    'handleDropFiles', 'handleStopPlayback', 'handleNext', 'handlePrev',
    'handleReplayCurrent', 'handleAdvanceFromEnd', 'handleAppendCustomTags', 'registerPlayerCommandTarget'
  ])
  const analysisEnabled = useAppSelection(state => Boolean(state.pluginsLoaded && state.settings?.videoAnalysis?.enabled && state.plugins?.some(plugin => plugin.id === 'video-analysis' && plugin.enabled)))

  const playbackTarget = video?.url || video?.fullPath || ''
  const playbackIntentKey = JSON.stringify([playbackTarget, video?.sourceType, video?.resourceKind,
    video?.openMode, video?.playbackUrl, video?.httpHeaders, video?.playbackToken, video?.playOptions?.resume])
  const [engineOverride, setEngineOverride] = useState(null)
  const mode = engineOverride?.key === playbackIntentKey ? engineOverride.mode
    : mpvStatus?.available === false ? 'html5' : 'mpv'
  const setMode = useCallback(next => setEngineOverride({ key: playbackIntentKey, mode: next }), [playbackIntentKey])
  const viewSessionKey = JSON.stringify([playbackIntentKey, mode])
  const viewSessionKeyRef = useRef(viewSessionKey)
  viewSessionKeyRef.current = viewSessionKey
  const adapterRecordRef = useRef(null)
  const videoDataRef = useRef(video)
  videoDataRef.current = video
  const advanceRef = useRef(handleAdvanceFromEnd)
  advanceRef.current = handleAdvanceFromEnd
  const ownedAdapter = useCallback(() => {
    const record = adapterRecordRef.current
    return record?.key === viewSessionKey && viewSessionKeyRef.current === viewSessionKey ? record.adapter : null
  }, [viewSessionKey])
  const readOwnedVideo = useCallback(event => {
    if (!(ownedAdapter() instanceof Html5Adapter)) return null
    const element = event?.currentTarget || videoRef.current
    return element === videoRef.current ? element : null
  }, [ownedAdapter])
  const nativeCommand = useCallback(command => {
    const adapter = ownedAdapter()
    if (!(adapter instanceof MpvAdapter)) return Promise.resolve(undefined)
    return adapter.command(command).catch(error => {
      if (ownedAdapter() === adapter) setPlayerError(error.message)
      return undefined
    })
  }, [ownedAdapter, setPlayerError])
  const bindVideo = useCallback(element => {
    videoRef.current = element
    const adapter = ownedAdapter()
    if (adapter instanceof Html5Adapter) adapter.attach(element)
  }, [ownedAdapter])
  const bindWebpage = useCallback(frame => {
    webpageRef.current = frame
    const adapter = ownedAdapter()
    if (frame && adapter instanceof WebpageAdapter) adapter.load(frame, frame.src)
  }, [ownedAdapter])

  const videoRef = useRef(null)
  const webpageRef = useRef(null)
  const launchTokenRef = useRef(0)
  const html5ResumeRef = useRef(null)
  const html5SaveSnapshotRef = useRef(null)
  const html5SaveTimerRef = useRef(null)
  const stageRef = useRef(null)
  const videoSurfaceRef = useRef(null)
  const shellRef = useRef(null)
  const toolbarRef = useRef(null)
  const controlsTimerRef = useRef(null)
  const clickTimerRef = useRef(null)
  const arrowHoldRef = useRef({})
  const arrowSpeedRestoreRef = useRef(null)
  const speedRef = useRef(1)
  const autoPausedRef = useRef(null)
  const [launchState, setLaunchState] = useState('idle')
  const [activeMenu, setActiveMenu] = useState(null)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [webFullscreen, setWebFullscreen] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [html5Source, setHtml5Source] = useState(null)
  const html5Url = html5Source?.key === playbackIntentKey ? html5Source.url : ''
  const setHtml5Url = useCallback(url => setHtml5Source({ key: playbackIntentKey, url }), [playbackIntentKey])
  const [webpageSource, setWebpageSource] = useState(null)
  const webviewUrl = webpageSource?.key === playbackIntentKey ? webpageSource.url : ''
  const setWebviewUrl = useCallback(url => setWebpageSource({ key: playbackIntentKey, url }), [playbackIntentKey])
  const [activePlaybackUrl, setActivePlaybackUrl] = useState('')
  const [activeHttpHeaders, setActiveHttpHeaders] = useState(null)
  const [mpvState, setMpvState] = useState(null)
  const [html5State, setHtml5State] = useState({
    currentTime: 0,
    duration: 0,
    paused: true,
    volume: 100,
    muted: false,
    playbackRate: 1,
    loop: false
  })
  const [html5Error, setHtml5Error] = useState('')
  const [analysisState, setAnalysisState] = useState({ status: 'idle', data: null, error: '' })
  const [analysisOpen, setAnalysisOpen] = useState(false)
  const [analysisJob, setAnalysisJob] = useState(null)
  const [playlistOpen, setPlaylistOpen] = useState(false)
  const playbackResumeEnabled = video?.playOptions?.resume !== false
  const isNetworkResource = video?.sourceType === 'network'
  const { progressPreview, showProgressPreview, hideProgressPreview } = useProgressPreview(
    playbackIntentKey, isNetworkResource ? '' : video?.fullPath || '')
  const isWebpageShell = Boolean(isNetworkResource && video?.resourceKind === 'webpage' && video?.openMode === 'webview' && !video?.playbackUrl)
  const isWebpageMode = Boolean(isWebpageShell || webviewUrl)
  const pageUrl = webviewUrl || playbackTarget
  const pageHost = (() => {
    try {
      return new URL(pageUrl).hostname.replace(/^www\./i, '')
    } catch {
      return '网页资源'
    }
  })()
  const videoAnalysisEnabled = Boolean(!isNetworkResource && analysisEnabled)

  const mpvEngineAvailable = mpvStatus?.available !== false
  const canUseMpv = !isWebpageMode && mpvEngineAvailable && mode === 'mpv'
  const { readMpvHostBounds, scheduleMpvHostBoundsSync } = useMpvHost(
    viewSessionKey, Boolean(video && canUseMpv), stageRef, videoSurfaceRef, ownedAdapter)
  const isHtml5 = !canUseMpv
  const state = isHtml5 ? html5State : (mpvState || {})
  const rawPosition = Number(state.timePos ?? state.currentTime ?? 0)
  const rawDuration = Number(state.duration ?? 0)
  const position = Number.isFinite(rawPosition) ? Math.max(0, rawPosition) : 0
  const duration = Number.isFinite(rawDuration) ? Math.max(0, rawDuration) : 0
  const paused = Boolean(state.paused)
  const volume = clamp(Number(state.volume ?? 100), 0, 100)
  const muted = Boolean(state.muted)
  const speed = Number(state.speed ?? state.playbackRate ?? 1)
  const subtitleScale = clamp(Number(state.subtitleScale ?? 1), 0.5, 3)
  const subtitleVisible = state.subtitleVisible !== false
  const trackList = Array.isArray(state.trackList) ? state.trackList : []
  const audioTracks = trackList.filter(track => track?.type === 'audio')
  const subtitleTracks = trackList.filter(track => track?.type === 'sub')
  const audioId = state.audioId == null ? null : Number(state.audioId)
  const subtitleId = state.subtitleId == null ? null : Number(state.subtitleId)
  const statusLabel = (() => {
    if (!video) return ''
    if (isWebpageMode) return '正在打开内置网页...'
    if (canUseMpv) {
      if (launchState === 'launching') return '正在启动 mpv...'
      return 'mpv 嵌入式播放'
    }
    if (launchState === 'error') return 'HTML5 播放失败'
    if (!html5Url) return '正在加载 HTML5 播放器...'
    return 'HTML5 兜底播放'
  })()
  const analysisAvailable = analysisState.status === 'ready' && analysisState.data?.available
  const analysisRunning = analysisState.status === 'analyzing'
  const playlistItems = Array.isArray(queueItems) ? queueItems : []
  const playlistAvailable = playlistItems.length > 1
  const playlistIsNetwork = Boolean(isNetworkResource && video?.resourceKind === 'webpage')
  const playlistTitle = playlistIsNetwork ? '剧集' : (isNetworkResource ? '网络视频' : '本地视频')
  const analysisButtonTitle = (() => {
    if (!videoAnalysisEnabled) return '请先在设置中启用视频理解'
    if (analysisState.status === 'checking') return '正在读取视频理解结果'
    if (analysisRunning) return '正在分析当前视频'
    if (analysisAvailable) return analysisOpen ? '隐藏最新分析结果' : '显示最新分析结果'
    return '暂无分析结果，请从视频卡片菜单发起分析'
  })()

  useEffect(() => {
    speedRef.current = Number.isFinite(speed) ? speed : 1
  }, [speed])

  useEffect(() => {
    if (!playlistAvailable) {
      setPlaylistOpen(false)
    }
  }, [playlistAvailable])

  useEffect(() => {
    let canceled = false
    setAnalysisOpen(false)

    if (!videoAnalysisEnabled || !video?.fullPath || !window.electronAPI?.getVideoAnalysis) {
      setAnalysisState({ status: 'idle', data: null, error: '' })
      return () => {
        canceled = true
      }
    }

    setAnalysisJob(null)
    setAnalysisState({ status: 'checking', data: null, error: '' })
    window.electronAPI.getVideoAnalysis(video.fullPath)
      .then((result) => {
        if (!canceled) {
          setAnalysisState({ status: result?.available ? 'ready' : 'missing', data: result, error: '' })
        }
      })
      .catch((err) => {
        if (!canceled) {
          setAnalysisState({ status: 'error', data: null, error: err?.message || '读取视频理解结果失败' })
        }
      })

    return () => {
      canceled = true
    }
  }, [video?.fullPath, videoAnalysisEnabled])

  useEffect(() => {
    if (!videoAnalysisEnabled || !video?.fullPath || !window.electronAPI?.onVideoAnalysisEvent) return undefined
    let disposed = false, queriedJobId = ''
    const remove = window.electronAPI.onVideoAnalysisEvent((payload) => {
      if (!payload || payload.videoPath !== video.fullPath) return
      if (['started', 'running'].includes(payload.status) && queriedJobId !== payload.jobId) {
        queriedJobId = payload.jobId
        window.electronAPI.getVideoAnalysisJob?.().then(job => {
          if (!disposed && job?.jobId === payload.jobId && job.videoPath === video.fullPath) {
            setAnalysisJob(current => current?.jobId === job.jobId ? { ...current, canCancel: Boolean(job.canCancel), interestId: job.interestId } : current)
          }
        }).catch(() => {})
      }

      if (payload.status === 'started') {
        setAnalysisOpen(false)
        setAnalysisJob({ jobId: payload.jobId, canCancel: false, message: payload.message || '开始分析当前视频' })
        setAnalysisState({ status: 'analyzing', data: null, error: '' })
        return
      }

      if (payload.status === 'running') {
        setAnalysisJob(prev => ({
          ...(prev?.jobId === payload.jobId ? prev : { canCancel: false }),
          jobId: payload.jobId,
          message: payload.event?.message || payload.event?.stage || '正在分析',
          stage: payload.event?.stage,
          stageStatus: payload.event?.status
        }))
        setAnalysisState(prev => prev.status === 'analyzing' ? prev : { status: 'analyzing', data: null, error: '' })
        return
      }

      if (payload.status === 'success') {
        setAnalysisJob(null)
        setAnalysisState({ status: payload.analysis?.available ? 'ready' : 'missing', data: payload.analysis, error: '' })
        setAnalysisOpen(Boolean(payload.analysis?.available))
        return
      }

      if (payload.status === 'cancelled') {
        setAnalysisJob(null)
        setAnalysisState({ status: 'missing', data: null, error: '' })
        return
      }

      if (payload.status === 'error') {
        setAnalysisJob(null)
        setAnalysisState({ status: 'error', data: null, error: payload.error || '视频理解分析失败' })
      }
    })

    return () => { disposed = true; remove?.() }
  }, [video?.fullPath, videoAnalysisEnabled])

  const handleClose = useCallback(() => {
    const adapter = ownedAdapter()
    if (!adapter) return
    void adapter.stop().catch(() => {})
    setMpvState(null)
    handleStopPlayback?.()
  }, [handleStopPlayback, ownedAdapter])

  const handleSeekTo = useCallback((nextPosition) => {
    if (isWebpageMode) return
    const value = Number(nextPosition)
    if (!Number.isFinite(value)) return

    if (canUseMpv) {
      ownedAdapter()?.seek(value)?.catch(() => {})
      return
    }

    const el = videoRef.current
    const adapter = ownedAdapter()
    if (!(adapter instanceof Html5Adapter)) return
    const position = clamp(value, 0, Number.isFinite(el?.duration) ? el.duration : value)
    void adapter.seek(position)
    setHtml5State(prev => ({ ...prev, currentTime: position }))
  }, [canUseMpv, isWebpageMode, nativeCommand, ownedAdapter, readOwnedVideo])

  const updateProgressPreview = useCallback((event) => {
    if (!duration || duration <= 0) return

    const bounds = event.currentTarget.getBoundingClientRect()
    const toolbarBounds = toolbarRef.current?.getBoundingClientRect()
    const ratio = clamp((event.clientX - bounds.left) / bounds.width, 0, 1)
    const previewTime = ratio * duration
    const previewEdge = 84
    const previewMax = toolbarBounds ? Math.max(previewEdge, toolbarBounds.width - previewEdge) : Math.max(previewEdge, bounds.width - previewEdge)
    const previewLeft = toolbarBounds
      ? clamp(event.clientX - toolbarBounds.left, previewEdge, previewMax)
      : clamp(event.clientX - bounds.left, Math.min(previewEdge, bounds.width / 2), previewMax)
    setActiveMenu(null)
    showProgressPreview(previewTime, `${previewLeft}px`)
  }, [duration, showProgressPreview])

  const handleSeek = useCallback((delta) => {
    if (isWebpageMode) return
    if (canUseMpv) {
      nativeCommand({ command: 'seekRelative', value: delta })
      return
    }

    const el = readOwnedVideo()
    if (!el) return
    const position = clamp(el.currentTime + delta, 0, Number.isFinite(el.duration) ? el.duration : el.currentTime + delta)
    void ownedAdapter()?.seek(position)
    setHtml5State(prev => ({ ...prev, currentTime: position }))
  }, [canUseMpv, isWebpageMode])

  const handleTogglePause = useCallback(() => {
    if (isWebpageMode) return
    autoPausedRef.current = null
    if (canUseMpv) {
      nativeCommand({ command: 'cyclePause' })
      return
    }

    const el = readOwnedVideo()
    if (!el) return
    if (el.paused) {
      ownedAdapter()?.play()?.catch(() => {})
    } else {
      ownedAdapter()?.pause()?.catch(() => {})
    }
  }, [canUseMpv, isWebpageMode])

  const handleSetVolume = useCallback((nextVolume) => {
    if (isWebpageMode) return
    const value = clamp(Number(nextVolume), 0, 100)
    if (canUseMpv) {
      nativeCommand({ command: 'setVolume', value })
      return
    }

    const el = readOwnedVideo()
    if (!el) return
    el.volume = value / 100
    setHtml5State(prev => ({ ...prev, volume: value, muted: el.muted }))
  }, [canUseMpv, isWebpageMode])

  const handleToggleMute = useCallback(() => {
    if (isWebpageMode) return
    if (canUseMpv) {
      nativeCommand({ command: 'toggleMute' })
      return
    }

    const el = readOwnedVideo()
    if (!el) return
    el.muted = !el.muted
    setHtml5State(prev => ({ ...prev, muted: el.muted }))
  }, [canUseMpv, isWebpageMode])

  const applySpeed = useCallback((nextSpeed) => {
    if (isWebpageMode) return
    const value = clamp(Number(nextSpeed), 0.1, 4)
    if (canUseMpv) {
      nativeCommand({ command: 'setSpeed', value })
      return
    }

    const el = readOwnedVideo()
    if (!el) return
    el.playbackRate = value
    setHtml5State(prev => ({ ...prev, playbackRate: value }))
  }, [canUseMpv, isWebpageMode])

  const handleSpeedChange = useCallback((nextSpeed) => {
    applySpeed(nextSpeed)
    setActiveMenu(null)
  }, [applySpeed])

  const handleSelectSubtitle = useCallback((trackId) => {
    if (!canUseMpv) {
      setActiveMenu(null)
      return
    }
    nativeCommand({ command: 'setSubtitleTrack', value: trackId })
    if (trackId !== 'no') nativeCommand({ command: 'setSubtitleVisible', value: true })
    setActiveMenu(null)
  }, [canUseMpv])

  const handleSelectAudio = useCallback((trackId) => {
    if (canUseMpv) nativeCommand({ command: 'setAudioTrack', value: trackId })
    setActiveMenu(null)
  }, [canUseMpv])

  const handleToggleSubtitleVisible = useCallback(() => {
    if (canUseMpv) {
      nativeCommand({ command: 'setSubtitleVisible', value: !subtitleVisible })
    }
  }, [canUseMpv, subtitleVisible, nativeCommand])

  const handleSubtitleScaleChange = useCallback((nextScale) => {
    if (canUseMpv) {
      nativeCommand({ command: 'setSubtitleScale', value: nextScale })
    }
    setActiveMenu(null)
  }, [canUseMpv])

  const handleToggleMenu = useCallback((menuName) => {
    hideProgressPreview()
    setActiveMenu(current => (current === menuName ? null : menuName))
  }, [hideProgressPreview])

  const handleToggleAnalysis = useCallback(() => {
    if (!analysisAvailable) return
    setPlaylistOpen(false)
    setAnalysisOpen(value => !value)
    setActiveMenu(null)
  }, [analysisAvailable])

  const handleTogglePlaylist = useCallback(() => {
    if (!playlistAvailable) return
    hideProgressPreview()
    setAnalysisOpen(false)
    setActiveMenu(null)
    setPlaylistOpen(value => !value)
  }, [hideProgressPreview, playlistAvailable])

  const handlePlayQueueItem = useCallback((item) => {
    if (!item) return
    handlePlay?.(item, {
      queueVideos: playlistItems.length ? playlistItems : [item],
      preserveQueueOrder: true
    })
  }, [handlePlay, playlistItems])

  const handleCancelAnalysis = useCallback(async () => {
    const jobId = analysisJob?.jobId
    if (!jobId || analysisJob.canCancel === false) return
    const owned = analysisJob.interestId ? analysisJob : await window.electronAPI?.getVideoAnalysisJob?.()
    if (owned?.jobId !== jobId || !owned.canCancel || !owned.interestId) return
    const result = await window.electronAPI?.cancelVideoAnalysis?.(jobId, owned.interestId)
    if (result?.released) setAnalysisJob(current => current?.jobId === jobId ? { ...current, canCancel: false,
      message: result.shared ? '已取消本次分析，其他设备或窗口仍在分析' : '正在取消分析' } : current)
  }, [analysisJob])

  const handleScreenshot = useCallback(async () => {
    if (canUseMpv) {
      await nativeCommand({ command: 'screenshot' })
      return
    }

    const el = readOwnedVideo()
    if (!el) return

    const canvas = document.createElement('canvas')
    canvas.width = el.videoWidth || 0
    canvas.height = el.videoHeight || 0
    const ctx = canvas.getContext('2d')
    if (!ctx || !canvas.width || !canvas.height) return

    try {
      ctx.drawImage(el, 0, 0, canvas.width, canvas.height)
      const link = document.createElement('a')
      link.download = `shot-${Date.now()}.png`
      link.href = canvas.toDataURL('image/png')
      link.click()
    } catch (err) {
      setPlayerError(err?.message || '截图失败')
    }
  }, [canUseMpv, setPlayerError, nativeCommand, readOwnedVideo])

  const handlePlayerCommand = useCallback((action, value) => {
    if (isWebpageMode) return ['play-pause', 'seek-backward', 'seek-forward', 'volume-up', 'volume-down', 'mute', 'screenshot'].includes(action)

    switch (action) {
      case 'play-pause':
        handleTogglePause()
        return true
      case 'seek-backward':
        handleSeek(-(value ?? SEEK_STEP))
        return true
      case 'seek-forward':
        handleSeek(value ?? SEEK_STEP)
        return true
      case 'volume-up':
        handleSetVolume(volume + (value ?? 5))
        return true
      case 'volume-down':
        handleSetVolume(volume - (value ?? 5))
        return true
      case 'mute':
        handleToggleMute()
        return true
      case 'screenshot':
        handleScreenshot()
        return true
      default:
        return false
    }
  }, [
    isWebpageMode,
    handleScreenshot,
    handleSeek,
    handleSetVolume,
    handleToggleMute,
    handleTogglePause,
    volume
  ])

  const handleToggleWebFullscreen = useCallback(() => {
    setWebFullscreen(value => !value)
    setActiveMenu(null)
  }, [])

  const handleToggleFullscreen = useCallback(() => {
    const el = shellRef.current
    if (!el) return

    if (document.fullscreenElement) {
      document.exitFullscreen?.()
    } else {
      el.requestFullscreen?.()
    }
    setActiveMenu(null)
  }, [])

  const handleTogglePictureInPicture = useCallback(async () => {
    if (canUseMpv) return
    const el = videoRef.current
    if (!el || !document.pictureInPictureEnabled) return

    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture()
      } else {
        await el.requestPictureInPicture()
      }
    } catch {}
  }, [canUseMpv])

  const showControls = useCallback(() => {
    setControlsVisible(true)
    if (controlsTimerRef.current) {
      clearTimeout(controlsTimerRef.current)
      controlsTimerRef.current = null
    }
    if (!paused && !activeMenu) {
      controlsTimerRef.current = setTimeout(() => {
        setControlsVisible(false)
      }, 2600)
    }
  }, [activeMenu, paused])

  const handleVideoSurfaceClick = useCallback(() => {
    if (isWebpageMode) return
    if (clickTimerRef.current) return
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null
      handleTogglePause()
    }, 180)
  }, [handleTogglePause, isWebpageMode])

  const handleVideoSurfaceDoubleClick = useCallback((event) => {
    event.preventDefault()
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
    }
    handleToggleFullscreen()
  }, [handleToggleFullscreen])

  const handleHtml5LoadedMetadata = useCallback(event => {
    const el = readOwnedVideo(event)
    if (!el) return

    const resume = html5ResumeRef.current
    if (resume) {
      if (Number.isFinite(resume.position) && resume.position > 0) {
        try {
          el.currentTime = resume.position
        } catch {}
      }
      if (resume.volume != null) el.volume = clamp(Number(resume.volume) / 100, 0, 1)
      if (resume.speed != null) el.playbackRate = clamp(Number(resume.speed), 0.1, 4)
      if (resume.muted != null) el.muted = Boolean(resume.muted)
      if (resume.loopMode === 'inf') el.loop = true
    }

    setHtml5State({
      currentTime: el.currentTime || 0,
      duration: el.duration || 0,
      paused: el.paused,
      volume: Math.round((el.volume ?? 1) * 100),
      muted: el.muted,
      playbackRate: el.playbackRate || 1,
      loop: el.loop
    })
  }, [readOwnedVideo])

  const handleHtml5TimeUpdate = useCallback((event) => {
    const el = readOwnedVideo(event)
    if (!el) return
    setHtml5State(prev => ({
      ...prev,
      currentTime: el.currentTime || 0,
      duration: el.duration || prev.duration,
      paused: el.paused,
      volume: Math.round((el.volume ?? 1) * 100),
      muted: el.muted,
      playbackRate: el.playbackRate || 1,
      loop: el.loop
    }))
  }, [readOwnedVideo])

  const handleHtml5VolumeChange = useCallback((event) => {
    const el = readOwnedVideo(event)
    if (!el) return
    setHtml5State(prev => ({
      ...prev,
      volume: Math.round((el.volume ?? 1) * 100),
      muted: el.muted
    }))
  }, [readOwnedVideo])

  const handleHtml5RateChange = useCallback((event) => {
    const el = readOwnedVideo(event)
    if (!el) return
    setHtml5State(prev => ({ ...prev, playbackRate: el.playbackRate || 1 }))
  }, [readOwnedVideo])

  const saveHtml5PlaybackState = useCallback((immediate = false) => {
    if (canUseMpv || !playbackTarget || !window.electronAPI?.savePlaybackState) return

    const el = readOwnedVideo()
    if (!el) return
    const snapshot = ownedAdapter()?.getState()
    if (snapshot?.phase === 'loading' && snapshot.explicitPosition === undefined) return

    const patch = {
      position: el.ended ? 0 : Math.max(0, Number(el.currentTime) || 0),
      volume: Math.max(0, Math.min(100, Math.round((el.volume ?? 1) * 100))),
      speed: Math.max(0.1, Number(el.playbackRate) || 1),
      muted: Boolean(el.muted),
      loopMode: el.loop ? 'inf' : 'off'
    }

    html5SaveSnapshotRef.current = patch

    const save = () => savePlaybackState(playbackTarget, patch).catch(() => {})
    if (immediate) {
      if (html5SaveTimerRef.current) {
        clearTimeout(html5SaveTimerRef.current)
        html5SaveTimerRef.current = null
      }
      save()
      return
    }

    if (html5SaveTimerRef.current) return
    html5SaveTimerRef.current = setTimeout(() => {
      html5SaveTimerRef.current = null
      const nextPatch = html5SaveSnapshotRef.current
      if (!nextPatch) return
      savePlaybackState(playbackTarget, nextPatch).catch(() => {})
    }, 1000)
  }, [canUseMpv, playbackTarget, readOwnedVideo, ownedAdapter])

  const handleHtml5PlaybackStateChange = useCallback((event) => {
    const el = readOwnedVideo(event)
    if (!el) return
    setHtml5State(prev => ({ ...prev, paused: el.paused }))
    if (el.paused && Number(el.currentTime) > 0) {
      saveHtml5PlaybackState(true)
    }
  }, [readOwnedVideo, saveHtml5PlaybackState])

  const handleHtml5Seeked = useCallback((event) => {
    const el = readOwnedVideo(event)
    if (!el) return
    setHtml5State(prev => ({
      ...prev,
      currentTime: el.currentTime || 0,
      paused: el.paused
    }))
    saveHtml5PlaybackState(true)
  }, [readOwnedVideo, saveHtml5PlaybackState])

  const handleHtml5Ended = useCallback(() => {
    if (!readOwnedVideo()) return
    setHtml5State(prev => ({ ...prev, paused: true }))
    saveHtml5PlaybackState(true)
  }, [readOwnedVideo, saveHtml5PlaybackState])

  useLayoutEffect(() => {
    if (video && canUseMpv) scheduleMpvHostBoundsSync(true)
  }, [
    activeMenu,
    analysisAvailable,
    analysisRunning,
    analysisOpen,
    analysisState.status,
    canUseMpv,
    playlistAvailable,
    playlistOpen,
    scheduleMpvHostBoundsSync,
    playbackIntentKey
  ])

  useEffect(() => {
    return registerPlayerCommandTarget?.(handlePlayerCommand)
  }, [handlePlayerCommand, registerPlayerCommandTarget])

  useEffect(() => {
    if (isWebpageShell && mode !== 'html5') {
      setMode('html5')
    } else if (mpvStatus?.available === false && mode === 'mpv') {
      setMode('html5')
    }
  }, [isWebpageShell, mode, mpvStatus?.available])

  useEffect(() => {
    const item = videoDataRef.current
    if (!item) return undefined
    const launchId = ++launchTokenRef.current
    const useWebpage = isWebpageShell || Boolean(webviewUrl)
    const shouldUseMpv = !useWebpage && mode === 'mpv' && mpvStatus?.available !== false
    const adapter = useWebpage ? new WebpageAdapter() : shouldUseMpv ? new MpvAdapter() : new Html5Adapter()
    const record = { key: viewSessionKey, adapter, ended: false }
    adapterRecordRef.current = record
    let cancelled = false
    const owns = () => !cancelled && adapterRecordRef.current === record && viewSessionKeyRef.current === viewSessionKey
    setLaunchState(isWebpageShell ? 'ready' : shouldUseMpv ? 'launching' : 'loading')
    setHtml5Error(''); setHtml5Url(''); setWebviewUrl(useWebpage ? webviewUrl || playbackTarget : '')
    setActivePlaybackUrl(''); setActiveHttpHeaders(null); setPlayerError(''); setMpvState(null)
    html5ResumeRef.current = null
    const unsubscribe = adapter.subscribe(snapshot => {
      if (!owns()) return
      if (snapshot.native) setMpvState(snapshot.native)
      if (adapter instanceof Html5Adapter) setHtml5State(previous => ({ ...previous,
        currentTime: snapshot.position, duration: snapshot.duration, paused: snapshot.paused,
        volume: snapshot.volume, muted: snapshot.muted, playbackRate: snapshot.speed }))
      if (snapshot.phase === 'ended' && !record.ended) { record.ended = true; advanceRef.current?.() }
      if (snapshot.phase === 'error') {
        if (snapshot.errorCode === 'player_stop_timeout') { setPlayerError(snapshot.error); setLaunchState('error') }
        else if (shouldUseMpv) setMode('html5')
        else { setHtml5Error(snapshot.error || 'HTML5 播放器不支持当前格式'); setPlayerError(snapshot.error || '播放失败') }
      }
    })
    const loadHtml5 = async () => {
      let url = item.playbackUrl || playbackTarget, headers = item.httpHeaders || null
      if (isNetworkResource && item.resourceKind === 'webpage') {
        const result = await window.electronAPI.resolveNetworkResource(item)
        if (!owns()) return
        if (!result?.success) throw new Error(result?.error || '网页资源解析失败')
        if (!result.resource?.playbackUrl && result.resource?.page?.openMode === 'webview') {
          record.adapter = new WebpageAdapter()
          await adapter.stop(); unsubscribe()
          setWebviewUrl(result.resource.url || playbackTarget); setLaunchState('ready'); return
        }
        url = result.resource?.playbackUrl || playbackTarget; headers = result.resource?.httpHeaders || headers
      }
      const [fileUrl, saved] = await Promise.all([
        isNetworkResource ? Promise.resolve(url) : window.electronAPI.getFileUrl(item.fullPath),
        getPlaybackState(playbackTarget)
      ])
      if (!owns()) return
      const restore = { position: playbackResumeEnabled ? Number(saved?.position || 0) : 0,
        volume: saved?.volume, speed: saved?.speed, muted: saved?.muted, loop: saved?.loopMode === 'inf' }
      html5ResumeRef.current = null
      adapter.load(fileUrl, restore)
      adapter.attach(videoRef.current)
      setActiveHttpHeaders(headers); setActivePlaybackUrl(fileUrl); setHtml5Url(fileUrl); setLaunchState('ready')
    }
    if (useWebpage) {
      setActivePlaybackUrl(webviewUrl || playbackTarget)
      if (webpageRef.current) adapter.load(webpageRef.current, webviewUrl || playbackTarget)
    }
    else if (shouldUseMpv) {
      adapter.load({ target: playbackTarget, source: isNetworkResource ? 'network' : 'local',
        resume: playbackResumeEnabled, title: item.name || item.fileName, kind: item.resourceKind,
        hostBounds: readMpvHostBounds() || undefined
      }).then(result => {
        if (!owns()) return
        if (result?.webpageUrl) { setWebviewUrl(result.webpageUrl); setMode('html5') }
        else setLaunchState('ready')
      }).catch(error => {
        if (!owns()) return
        if (error.code === 'player_stop_timeout') { setPlayerError(error.message); setLaunchState('error') }
        else setMode('html5')
      })
    } else {
      // Retain this engine for the current intent when availability changes in the background.
      setMode('html5')
      loadHtml5().catch(error => {
        if (!owns()) return
        setHtml5Error(error.message || 'HTML5 播放失败'); setPlayerError(error.message || '播放失败'); setLaunchState('error')
      })
    }
    return () => {
      cancelled = true
      if (html5SaveTimerRef.current) { clearTimeout(html5SaveTimerRef.current); html5SaveTimerRef.current = null }
      if (clickTimerRef.current) { clearTimeout(clickTimerRef.current); clickTimerRef.current = null }
      if (controlsTimerRef.current) { clearTimeout(controlsTimerRef.current); controlsTimerRef.current = null }
      unsubscribe()
      if (adapterRecordRef.current === record) adapterRecordRef.current = null
      if (record.adapter instanceof Html5Adapter) {
        const snapshot = record.adapter.getState()
        if (snapshot.phase !== 'idle' && snapshot.phase !== 'loading') {
          void savePlaybackState(playbackTarget, { position: snapshot.phase === 'ended' ? 0 : snapshot.position,
            volume: snapshot.volume, speed: snapshot.speed, muted: snapshot.muted, loopMode: snapshot.loop ? 'inf' : 'off' }).catch(() => {})
        } else if (snapshot.explicitPosition !== undefined) {
          void savePlaybackState(playbackTarget, { position: snapshot.explicitPosition }).catch(() => {})
        }
      }
      void record.adapter.stop().catch(() => {})
    }
  }, [viewSessionKey, isNetworkResource, isWebpageShell, mode, playbackResumeEnabled, playbackTarget,
    readMpvHostBounds, setHtml5Url, setMode, setPlayerError, setWebviewUrl])

  useEffect(() => {
    if (canUseMpv || !html5Url || !playbackTarget) return undefined
    saveHtml5PlaybackState(false)
  }, [
    canUseMpv,
    html5State.currentTime,
    html5State.muted,
    html5State.playbackRate,
    html5State.volume,
    html5State.loop,
    html5Url,
    saveHtml5PlaybackState,
    playbackTarget
  ])

  useEffect(() => {
    if (!video) return undefined

    const isTextEntryTarget = (target) => {
      const tagName = target?.tagName?.toLowerCase?.()
      return target?.isContentEditable || ['input', 'textarea', 'select'].includes(tagName)
    }

    const isInteractiveTarget = (target) => {
      const tagName = target?.tagName?.toLowerCase?.()
      return isTextEntryTarget(target) || ['button', 'a'].includes(tagName)
    }

    const startArrowHold = (key) => {
      if (arrowHoldRef.current[key]) return

      const direction = key === 'ArrowLeft' ? -1 : 1
      const holdState = {
        direction,
        longPress: false,
        timer: null
      }

      holdState.timer = setTimeout(() => {
        holdState.longPress = true
        if (arrowSpeedRestoreRef.current == null) {
          arrowSpeedRestoreRef.current = speedRef.current || 1
        }
        applySpeed(ARROW_HOLD_SPEED)
      }, ARROW_HOLD_DELAY)

      arrowHoldRef.current[key] = holdState
    }

    const finishArrowHold = (key) => {
      const holdState = arrowHoldRef.current[key]
      if (!holdState) return false

      if (holdState.timer) clearTimeout(holdState.timer)
      delete arrowHoldRef.current[key]

      if (holdState.longPress) {
        const hasOtherLongPress = Object.values(arrowHoldRef.current).some(item => item?.longPress)
        if (!hasOtherLongPress && arrowSpeedRestoreRef.current != null) {
          const restoreSpeed = arrowSpeedRestoreRef.current
          arrowSpeedRestoreRef.current = null
          applySpeed(restoreSpeed)
        }
      } else {
        handleSeek(holdState.direction * SEEK_STEP)
      }

      return true
    }

    const clearArrowHolds = () => {
      Object.values(arrowHoldRef.current).forEach(holdState => {
        if (holdState?.timer) clearTimeout(holdState.timer)
      })
      arrowHoldRef.current = {}

      if (arrowSpeedRestoreRef.current != null) {
        const restoreSpeed = arrowSpeedRestoreRef.current
        arrowSpeedRestoreRef.current = null
        applySpeed(restoreSpeed)
      }
    }

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        if (isTextEntryTarget(event.target)) return
        event.preventDefault()
        event.stopImmediatePropagation()
        if (activeMenu) {
          setActiveMenu(null)
        } else if (webFullscreen) {
          setWebFullscreen(false)
        } else {
          handleClose()
        }
        return
      }
      if (isInteractiveTarget(event.target)) return
      if (event.ctrlKey || event.metaKey) return

      switch (event.key) {
        case ' ':
          event.preventDefault()
          handleTogglePause()
          break
        case 'ArrowLeft':
        case 'ArrowRight':
          event.preventDefault()
          startArrowHold(event.key)
          break
        case 'o':
        case 'O':
          event.preventDefault()
          handleOpenFile?.()
          break
        default:
          break
      }
    }

    const onKeyUp = (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      if (!arrowHoldRef.current[event.key]) return
      event.preventDefault()
      finishArrowHold(event.key)
    }

    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', clearArrowHolds)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', clearArrowHolds)
      clearArrowHolds()
    }
  }, [activeMenu, applySpeed, handleClose, handleOpenFile, handleSeek, handleTogglePause, playbackIntentKey, webFullscreen])

  useEffect(() => {
    if (mode !== 'html5' || !html5Url) return
    const adapter = ownedAdapter()
    if (document.hidden) {
      autoPausedRef.current = adapter
      adapter?.pause()?.catch(() => {})
    } else {
      adapter?.play()?.catch(() => {})
    }
  }, [html5Url, mode, playbackIntentKey, ownedAdapter])

  useEffect(() => {
    if (!video) return undefined
    window.electronAPI?.setMediaPlaybackActive?.(true)?.catch(() => {})
    return () => {
      window.electronAPI?.setMediaPlaybackActive?.(false)?.catch(() => {})
    }
  }, [viewSessionKey, ownedAdapter])

  useEffect(() => {
    if (!video || isWebpageMode) return undefined
    let active = true

    const pauseForBackground = () => {
      if (!active) return
      const adapter = ownedAdapter(), snapshot = adapter?.getState()
      if (!adapter || (snapshot.paused && snapshot.phase !== 'loading' && snapshot.phase !== 'idle')) return
      autoPausedRef.current = adapter
      adapter.pause()?.catch(() => {})
    }

    const restoreFromBackground = () => {
      if (!active) return
      const adapter = ownedAdapter()
      if (!adapter || autoPausedRef.current !== adapter) return
      autoPausedRef.current = null
      adapter.play()?.catch(() => {})
    }

    const handleVisibilityChange = () => {
      if (document.hidden) {
        pauseForBackground()
      } else {
        restoreFromBackground()
      }
    }

    window.addEventListener('pagehide', pauseForBackground)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    handleVisibilityChange()

    return () => {
      active = false
      window.removeEventListener('pagehide', pauseForBackground)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      autoPausedRef.current = null
    }
  }, [viewSessionKey, ownedAdapter, isWebpageMode])

  useEffect(() => {
    showControls()
    return () => {
      if (controlsTimerRef.current) {
        clearTimeout(controlsTimerRef.current)
        controlsTimerRef.current = null
      }
    }
  }, [showControls])

  useEffect(() => {
    if (activeMenu) setControlsVisible(true)
  }, [activeMenu])

  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  useEffect(() => {
    return () => {
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current)
        clickTimerRef.current = null
      }
    }
  }, [])

  if (!video) return null

  const progressMax = duration > 0 ? duration : Math.max(position, 1)
  const progressValue = clamp(position, 0, progressMax)
  const progressPercent = progressMax > 0 ? (progressValue / progressMax) * 100 : 0
  const qualityLabel = '原画'
  const hasNext = queueLength > 1 && queueIndex >= 0 && queueIndex < queueLength - 1
  const hasPrev = queueLength > 1 && queueIndex > 0
  const activeToolbarMenu = activeMenu ? (
    <PlayerToolbarMenu
      activeMenu={activeMenu}
      speed={speed}
      subtitleId={subtitleId}
      subtitleScale={subtitleScale}
      subtitleVisible={subtitleVisible}
      audioId={audioId}
      canUseMpv={canUseMpv}
      subtitleTracks={subtitleTracks}
      audioTracks={audioTracks}
      onClose={() => setActiveMenu(null)}
      onSpeedChange={handleSpeedChange}
      onSelectSubtitle={handleSelectSubtitle}
      onSubtitleScaleChange={handleSubtitleScaleChange}
      onToggleSubtitleVisible={handleToggleSubtitleVisible}
      onSelectAudio={handleSelectAudio}
    />
  ) : null
  const renderToolbarMenu = (menuName) => !canUseMpv && activeMenu === menuName ? activeToolbarMenu : null
  return (
    <div
      className={`player-overlay${webFullscreen ? ' player-overlay-web-fullscreen' : ''}`}
      onClick={(event) => event.target === event.currentTarget && handleClose()}
      onDragOver={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
      onDrop={(event) => {
        event.preventDefault()
        event.stopPropagation()
        handleDropFiles?.(Array.from(event.dataTransfer?.files || []))
      }}
    >
      <div
        ref={shellRef}
        className={[
          'player-container',
          'player-shell',
          canUseMpv ? 'mpv-shell' : 'html5-shell',
          isWebpageMode ? 'webview-shell' : '',
          webFullscreen ? 'web-fullscreen' : '',
          activeMenu ? 'menu-open' : '',
          activeMenu ? `menu-${activeMenu}` : '',
          playlistAvailable ? 'playlist-available' : '',
          analysisOpen && analysisAvailable ? 'analysis-open' : '',
          playlistOpen && playlistAvailable ? 'playlist-open' : '',
          controlsVisible ? 'controls-visible' : 'controls-hidden'
        ].filter(Boolean).join(' ')}
        onMouseEnter={showControls}
        onMouseMove={showControls}
      >
        {!isWebpageMode && (
        <div className="player-topbar" onClick={event => event.stopPropagation()}>
          <button className="player-close" onClick={handleClose} title="关闭 (Esc)" type="button" aria-label="关闭播放器">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
          <div className="player-header-text">
            <span className="player-title">{video?.name || video?.fileName || '视频'}</span>
            <span className="player-meta">
              {(video?.extension || '').replace(/^\./, '').toUpperCase() || 'VIDEO'}
              {video?.size ? ` · ${(video.size / 1024 / 1024 / 1024).toFixed(1)} GB` : ''}
              {video?.group ? ` · ${video.group}` : ''}
            </span>
          </div>
          <div className="player-topbar-tools">
            {videoAnalysisEnabled ? (
              <button
                className={`btn btn-icon player-control-btn player-analysis-toggle${analysisOpen ? ' active' : ''}`}
                onClick={handleToggleAnalysis}
                type="button"
                disabled={!analysisAvailable || analysisRunning || analysisState.status === 'checking'}
                title={analysisButtonTitle}
                aria-label="视频理解"
              >
                {analysisState.status === 'checking' || analysisRunning ? (
                  <span className="player-analysis-spinner" aria-hidden="true" />
                ) : (
                  <Icon path={<><path d="M4 5h16v10H4z" /><path d="M8 19h8" /><path d="M10 15v4M14 15v4" /><path d="M8 9h8M8 12h5" /></>} />
                )}
              </button>
            ) : null}
            {playlistAvailable ? (
              <button
                className={`btn btn-icon player-control-btn player-playlist-toggle${playlistOpen ? ' active' : ''}`}
                onClick={handleTogglePlaylist}
                type="button"
                title={playlistOpen ? '收起列表' : `展开${playlistTitle}`}
                aria-label={playlistOpen ? '收起播放列表' : '展开播放列表'}
              >
                <Icon path={<><path d="M8 6h12" /><path d="M8 12h12" /><path d="M8 18h12" /><path d="M4 6h.01M4 12h.01M4 18h.01" /></>} />
              </button>
            ) : null}
            <button
              className="btn btn-icon player-control-btn"
              onClick={handleToggleFullscreen}
              type="button"
              title={isFullscreen ? '退出全屏' : '全屏'}
              aria-label={isFullscreen ? '退出全屏' : '全屏'}
            >
              <Icon path={isFullscreen ? <path d="M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6" /> : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />} />
            </button>
          </div>
        </div>
        )}

        {isWebpageMode && (
          <div className="player-webview-bar" onClick={event => event.stopPropagation()}>
            <div className="player-webview-title">
              <span className="player-webview-dot" aria-hidden="true" />
              <strong>{video?.name || video?.fileName || '网页资源'}</strong>
              <span>{pageHost}</span>
            </div>
            <div className="player-webview-actions">
              <button
                className="btn btn-icon player-webview-tool"
                type="button"
                onClick={handleToggleWebFullscreen}
                title={webFullscreen ? '退出网页全屏' : '网页全屏'}
                aria-label={webFullscreen ? '退出网页全屏' : '网页全屏'}
              >
                <Icon path={webFullscreen ? <path d="M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6" /> : <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" />} />
              </button>
              <button className="btn btn-icon player-webview-close" onClick={handleClose} title="关闭 (Esc)" type="button" aria-label="关闭播放器">
                <Icon path={<path d="M18 6L6 18M6 6l12 12" />} />
              </button>
            </div>
          </div>
        )}

        <div className="player-stage">
          <div
            ref={videoSurfaceRef}
            className="player-video-surface"
            onClick={handleVideoSurfaceClick}
            onDoubleClick={handleVideoSurfaceDoubleClick}
          >
            {isWebpageMode ? (
              pageUrl ? (
                <div className="player-webview-frame" onClick={event => event.stopPropagation()}>
                  <webview
                    key={viewSessionKey}
                    ref={bindWebpage}
                    className="player-webview"
                    src={pageUrl}
                    partition="persist:wallpaper-player-web"
                    allowpopups="true"
                    webpreferences="contextIsolation=yes,nodeIntegration=no"
                  />
                </div>
              ) : (
                <div className="player-stage-card">
                  <div className="player-stage-icon">
                    <Icon path={<path d="M10 13a5 5 0 0 0 7.07 0l2.12-2.12a5 5 0 0 0-7.07-7.07L11 4.93M14 11a5 5 0 0 0-7.07 0L4.81 13.12a5 5 0 0 0 7.07 7.07L13 19.07" />} />
                  </div>
                  <div>
                    <p className="player-stage-title">网页地址无效</p>
                    <p className="player-stage-copy">当前资源没有可打开的网页地址。</p>
                  </div>
                </div>
              )
            ) : isHtml5 ? (
              html5Url ? (
                <video
                  key={viewSessionKey}
                  ref={bindVideo}
                  className="player-video"
                  src={html5Url}
                  onLoadedMetadata={handleHtml5LoadedMetadata}
                  onTimeUpdate={handleHtml5TimeUpdate}
                  onVolumeChange={handleHtml5VolumeChange}
                  onRateChange={handleHtml5RateChange}
                  onPlay={handleHtml5PlaybackStateChange}
                  onPause={handleHtml5PlaybackStateChange}
                  onSeeked={handleHtml5Seeked}
                  onEnded={handleHtml5Ended}
                  onError={event => {
                    if (!readOwnedVideo(event)) return
                    const message = 'HTML5 播放器不支持当前格式'
                    setHtml5Error(message)
                    setPlayerError(message)
                  }}
                >
                  当前浏览器不支持此视频格式。
                </video>
              ) : (
                <div className="player-stage-card">
                  <div className="player-stage-icon">
                    <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                  </div>
                  <div>
                    <p className="player-stage-title">
                      {launchState === 'error' ? 'HTML5 播放失败' : '正在准备 HTML5 播放器'}
                    </p>
                    <p className="player-stage-copy">{html5Error || statusLabel}</p>
                  </div>
                </div>
              )
            ) : (
              <div className="player-mpv-host-surface" ref={stageRef}>
                {launchState === 'launching' ? (
                  <div className="player-stage-card">
                    <div className="player-stage-icon">
                      <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <polygon points="5 3 19 12 5 21 5 3" />
                      </svg>
                    </div>
                    <div>
                      <p className="player-stage-title">正在启动 mpv</p>
                      <p className="player-stage-copy">视频加载后会使用应用自定义控制栏。</p>
                    </div>
                  </div>
                ) : (
                  <div className="player-mpv-underlay" aria-hidden="true" />
                )}
              </div>
            )}

            {isHtml5 && !isWebpageMode && paused && (
              <button
                className="player-center-play"
                onClick={(event) => {
                  event.stopPropagation()
                  handleTogglePause()
                }}
                type="button"
                title="播放"
                aria-label="播放"
              >
                <Icon path={<path d="M7 5l12 7-12 7V5z" />} />
              </button>
            )}

            {(playerError || html5Error) && (
              <div className="player-alert" role="status">
                <span className="player-alert-dot" />
                <span>{html5Error || playerError}</span>
              </div>
            )}

          </div>

          {canUseMpv && activeToolbarMenu ? (
            <aside className="player-native-menu-panel" aria-label="播放选项" onClick={event => event.stopPropagation()}>
              {activeToolbarMenu}
            </aside>
          ) : null}

          {playlistAvailable ? (
            <div className="player-playlist-rail" onClick={event => event.stopPropagation()}>
              <button
                className={`player-playlist-handle${playlistOpen ? ' active' : ''}`}
                type="button"
                onClick={handleTogglePlaylist}
                title={playlistOpen ? '收起列表' : `展开${playlistTitle}`}
                aria-label={playlistOpen ? '收起播放列表' : '展开播放列表'}
              >
                <Icon path={<><path d="M8 6h12" /><path d="M8 12h12" /><path d="M8 18h12" /><path d="M4 6h.01M4 12h.01M4 18h.01" /></>} />
              </button>
            </div>
          ) : null}

          {analysisOpen && analysisAvailable ? (
            <div className="player-analysis-sidecar">
              <VideoAnalysisPanel
                analysis={analysisState.data}
                currentTime={progressValue}
                onSeek={handleSeekTo}
                onClose={() => setAnalysisOpen(false)}
                bindVideo={video}
                onAddTags={(targetVideo, tags) => handleAppendCustomTags?.([targetVideo], tags)}
              />
            </div>
          ) : null}

          {playlistOpen && playlistAvailable ? (
            <aside className="player-playlist-sidecar" aria-label={playlistTitle} onClick={event => event.stopPropagation()}>
              <div className="player-playlist-header">
                <div>
                  <p>{playlistTitle}</p>
                  <span>{playlistItems.length} 个视频</span>
                </div>
                <button
                  className="btn btn-icon player-playlist-close"
                  type="button"
                  onClick={() => setPlaylistOpen(false)}
                  title="收起列表"
                  aria-label="收起列表"
                >
                  <Icon path={<path d="M18 6L6 18M6 6l12 12" />} />
                </button>
              </div>
              <div className="player-playlist-list">
                {playlistItems.map((item, index) => {
                  const active = index === queueIndex
                  const episodeIndex = item?.page?.currentEpisodeIndex || index + 1
                  return (
                    <button
                      key={item?.playbackKey || item?.url || item?.fullPath || `${index}`}
                      className={`player-playlist-item${active ? ' active' : ''}`}
                      type="button"
                      onClick={() => handlePlayQueueItem(item)}
                      title={getQueueItemTitle(item, index, playlistIsNetwork)}
                    >
                      <span className="player-playlist-index">{playlistIsNetwork ? episodeIndex : index + 1}</span>
                      <span className="player-playlist-text">
                        <span className="player-playlist-name">{getQueueItemTitle(item, index, playlistIsNetwork)}</span>
                        <span className="player-playlist-meta">{getQueueItemMeta(item, playlistIsNetwork)}</span>
                      </span>
                      {active ? <span className="player-playlist-now">播放中</span> : null}
                    </button>
                  )
                })}
              </div>
            </aside>
          ) : null}
        </div>

        {!isWebpageMode && (
        <div className="player-toolbar" ref={toolbarRef} onClick={event => event.stopPropagation()}>
          <PlayerAnalysisStatus
            analysisRunning={analysisRunning}
            analysisJob={analysisJob}
            analysisState={analysisState}
            onCancelAnalysis={handleCancelAnalysis}
          />

            <div className="player-progress-row">
              <span className="player-time-current">{formatTime(progressValue)}</span>
              <div
                className="player-progress-wrap"
                onMouseMove={updateProgressPreview}
                onMouseEnter={updateProgressPreview}
                onMouseLeave={hideProgressPreview}
              >
                <input
                  className="player-range player-progress-range"
                  type="range"
                  min="0"
                  max={progressMax}
                  step="0.1"
                  value={progressValue}
                  style={{ '--player-progress': `${progressPercent}%` }}
                  onChange={(event) => handleSeekTo(event.target.value)}
                  aria-label="播放进度"
                />
              </div>
              <span className="player-time-total">{formatTime(duration)}</span>
            </div>

            <div className="player-controls-row">
              <div className="player-left-controls">
                <button
                  className="btn btn-icon player-control-btn"
                  onClick={handlePrev}
                  type="button"
                  disabled={!hasPrev}
                  title="上一首"
                  aria-label="上一首"
                >
                  <Icon path={<path d="M18 6L8 12l10 6V6zM6 6h2v12H6z" />} />
                </button>
                <button
                  className="btn btn-icon player-control-btn player-play-toggle"
                  onClick={handleTogglePause}
                  type="button"
                  title={paused ? '播放' : '暂停'}
                  aria-label={paused ? '播放' : '暂停'}
                >
                  {paused ? (
                    <Icon path={<path d="M7 5l12 7-12 7V5z" />} />
                  ) : (
                    <Icon path={<><rect x="7" y="5" width="3" height="14" /><rect x="14" y="5" width="3" height="14" /></>} />
                  )}
                </button>
                <button
                  className="btn btn-icon player-control-btn"
                  onClick={handleNext}
                  type="button"
                  disabled={!hasNext}
                  title="下一首"
                  aria-label="下一首"
                >
                  <Icon path={<path d="M6 6l10 6-10 6V6zM16 6h2v12h-2z" />} />
                </button>
                <button
                  className="btn btn-icon player-control-btn"
                  onClick={handleReplayCurrent}
                  type="button"
                  title="重新播放"
                  aria-label="重新播放"
                >
                  <Icon path={<path d="M7 7h10V3l5 5-5 5V9H7a4 4 0 000 8h4v2H7a6 6 0 110-12z" />} />
                </button>
              </div>

              <div className="player-right-controls">
                <div className="player-popover-anchor">
                  <button className="player-text-button" type="button" title="清晰度" onClick={() => handleToggleMenu('quality')}>
                    {qualityLabel}
                  </button>
                  {renderToolbarMenu('quality')}
                </div>

                <div className="player-popover-anchor">
                  <button className="player-text-button" type="button" title="倍速" onClick={() => handleToggleMenu('speed')}>
                    {formatSpeed(speed)}
                  </button>
                  {renderToolbarMenu('speed')}
                </div>

                <div className="player-popover-anchor">
                  <button className="player-text-button" type="button" title="字幕" onClick={() => handleToggleMenu('subtitle')}>
                    字幕
                  </button>
                  {renderToolbarMenu('subtitle')}
                </div>

                <div className="player-volume-control">
                  <button
                    className="btn btn-icon player-control-btn"
                    onClick={handleToggleMute}
                    type="button"
                    title={muted ? '取消静音' : '静音'}
                    aria-label={muted ? '取消静音' : '静音'}
                  >
                    <Icon
                      path={muted || volume <= 0 ? (
                        <>
                          <path d="M11 5L6 10H2v4h4l5 5V5z" />
                          <path d="M16 9l6 6M22 9l-6 6" />
                        </>
                      ) : (
                        <path d="M11 5L6 10H2v4h4l5 5V5zM16 8a6 6 0 010 8M18.5 5.5a10 10 0 010 13" />
                      )}
                    />
                  </button>
                  <input
                    className="player-range player-volume-range"
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    value={volume}
                    style={{ '--player-volume': `${volume}%` }}
                    onChange={(event) => handleSetVolume(event.target.value)}
                    aria-label="音量"
                  />
                </div>

                <div className="player-popover-anchor">
                  <button className="btn btn-icon player-control-btn" type="button" title="设置" aria-label="设置" onClick={() => handleToggleMenu('settings')}>
                    <Icon path={<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1-2 2-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.6V20h-3v-.2a1.7 1.7 0 00-1-1.6 1.7 1.7 0 00-1.9.3l-.1.1-2-2 .1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.6-1H4v-3h.2a1.7 1.7 0 001.6-1 1.7 1.7 0 00-.3-1.9l-.1-.1 2-2 .1.1a1.7 1.7 0 001.9.3 1.7 1.7 0 001-1.6V4h3v.2a1.7 1.7 0 001 1.6 1.7 1.7 0 001.9-.3l.1-.1 2 2-.1.1a1.7 1.7 0 00-.3 1.9 1.7 1.7 0 001.6 1h.2v3h-.2a1.7 1.7 0 00-1.6 1z" /></>} />
                  </button>
                  {renderToolbarMenu('settings')}
                </div>

                <button
                  className="btn btn-icon player-control-btn"
                  onClick={handleTogglePictureInPicture}
                  type="button"
                  disabled={canUseMpv || !document.pictureInPictureEnabled}
                  title={canUseMpv ? 'mpv 模式暂不支持画中画' : '画中画'}
                  aria-label="画中画"
                >
                  <Icon path={<><rect x="3" y="5" width="18" height="14" rx="2" /><rect x="12" y="11" width="7" height="5" rx="1" /></>} />
                </button>
                </div>
            </div>
            <PlayerProgressPreview duration={duration} progressPreview={progressPreview} />
        </div>
        )}
      </div>
    </div>
  )
}

export default memo(VideoPlayer)
