import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useApp } from '../context/AppContext'

const SEEK_STEP = 5
const ARROW_HOLD_DELAY = 300
const ARROW_HOLD_SPEED = 2
const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2]
const SUBTITLE_SCALE_OPTIONS = [0.75, 1, 1.25, 1.5, 2]

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function formatTime(seconds) {
  const value = Number(seconds)
  if (!Number.isFinite(value) || value < 0) return '00:00'
  const total = Math.floor(value)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

function Icon({ path, viewBox = '0 0 24 24' }) {
  return (
    <svg width="16" height="16" viewBox={viewBox} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {path}
    </svg>
  )
}

function formatSpeed(value) {
  const speed = Number(value)
  if (!Number.isFinite(speed)) return '1x'
  return `${speed.toFixed(speed % 1 ? 2 : 0)}x`
}

function getTrackLabel(track, fallback) {
  if (!track) return fallback
  const parts = [track.title, track.lang, track.external ? '外部' : ''].filter(Boolean)
  return parts.length ? parts.join(' / ') : fallback
}

export default function VideoPlayer({ video }) {
  const {
    mpvState,
    mpvStatus,
    playerError,
    setPlayerError,
    queueIndex,
    queueLength,
    playbackMode,
    handleOpenFile,
    handleDropFiles,
    handleStopPlayback,
    handleNext,
    handlePrev,
    handleReplayCurrent,
    handleAdvanceFromEnd,
    registerPlayerCommandTarget
  } = useApp()

  const videoRef = useRef(null)
  const launchTokenRef = useRef(0)
  const html5ResumeRef = useRef(null)
  const html5SaveSnapshotRef = useRef(null)
  const html5SaveTimerRef = useRef(null)
  const stageRef = useRef(null)
  const shellRef = useRef(null)
  const hostBoundsRef = useRef(null)
  const controlsTimerRef = useRef(null)
  const clickTimerRef = useRef(null)
  const arrowHoldRef = useRef({})
  const arrowSpeedRestoreRef = useRef(null)
  const speedRef = useRef(1)
  const pausedRef = useRef(true)
  const canUseMpvRef = useRef(false)
  const autoPausedRef = useRef(false)
  const hostSyncFramesRef = useRef([])
  const hostSyncTimersRef = useRef([])
  const [mode, setMode] = useState(() => (mpvStatus?.available === false ? 'html5' : 'mpv'))
  const [launchState, setLaunchState] = useState('idle')
  const [activeMenu, setActiveMenu] = useState(null)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [webFullscreen, setWebFullscreen] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [html5Url, setHtml5Url] = useState('')
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
  const playbackResumeEnabled = video?.playOptions?.resume !== false

  const mpvEngineAvailable = mpvStatus?.available !== false
  const canUseMpv = mpvEngineAvailable && mode === 'mpv'
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
  const playbackQueue = Array.isArray(video?.playOptions?.queueVideos) ? video.playOptions.queueVideos : null
  const playbackQueueIndex = Number.isInteger(Number(video?.playOptions?.playlistIndex))
    ? Number(video.playOptions.playlistIndex)
    : 0
  const launchPlaybackMode = video?.playOptions?.playbackMode || playbackMode
  const statusLabel = (() => {
    if (!video) return ''
    if (canUseMpv) {
      if (launchState === 'launching') return '正在启动 mpv...'
      return 'mpv 嵌入式播放'
    }
    if (launchState === 'error') return 'HTML5 播放失败'
    if (!html5Url) return '正在加载 HTML5 播放器...'
    return 'HTML5 兜底播放'
  })()

  useEffect(() => {
    speedRef.current = Number.isFinite(speed) ? speed : 1
  }, [speed])

  useEffect(() => {
    pausedRef.current = paused
  }, [paused])

  useEffect(() => {
    canUseMpvRef.current = canUseMpv
  }, [canUseMpv])

  const handleClose = useCallback(() => {
    videoRef.current?.pause?.()
    handleStopPlayback?.()
  }, [handleStopPlayback])

  const handleSeekTo = useCallback((nextPosition) => {
    const value = Number(nextPosition)
    if (!Number.isFinite(value)) return

    if (canUseMpv) {
      window.electronAPI?.mpvSeekTo?.(value)
      return
    }

    const el = videoRef.current
    if (!el) return
    el.currentTime = clamp(value, 0, Number.isFinite(el.duration) ? el.duration : value)
    setHtml5State(prev => ({ ...prev, currentTime: el.currentTime }))
  }, [canUseMpv])

  const handleSeek = useCallback((delta) => {
    if (canUseMpv) {
      window.electronAPI?.mpvSeekRelative?.(delta)
      return
    }

    const el = videoRef.current
    if (!el) return
    el.currentTime = clamp(el.currentTime + delta, 0, Number.isFinite(el.duration) ? el.duration : el.currentTime + delta)
    setHtml5State(prev => ({ ...prev, currentTime: el.currentTime }))
  }, [canUseMpv])

  const handleTogglePause = useCallback(() => {
    if (canUseMpv) {
      window.electronAPI?.mpvCyclePause?.()
      return
    }

    const el = videoRef.current
    if (!el) return
    if (el.paused) {
      el.play().catch(() => {})
    } else {
      el.pause()
    }
  }, [canUseMpv])

  const handleSetVolume = useCallback((nextVolume) => {
    const value = clamp(Number(nextVolume), 0, 100)
    if (canUseMpv) {
      window.electronAPI?.mpvSetVolume?.(value)
      return
    }

    const el = videoRef.current
    if (!el) return
    el.volume = value / 100
    setHtml5State(prev => ({ ...prev, volume: value, muted: el.muted }))
  }, [canUseMpv])

  const handleToggleMute = useCallback(() => {
    if (canUseMpv) {
      window.electronAPI?.mpvToggleMute?.()
      return
    }

    const el = videoRef.current
    if (!el) return
    el.muted = !el.muted
    setHtml5State(prev => ({ ...prev, muted: el.muted }))
  }, [canUseMpv])

  const applySpeed = useCallback((nextSpeed) => {
    const value = clamp(Number(nextSpeed), 0.1, 4)
    if (canUseMpv) {
      window.electronAPI?.mpvSetSpeed?.(value)
      return
    }

    const el = videoRef.current
    if (!el) return
    el.playbackRate = value
    setHtml5State(prev => ({ ...prev, playbackRate: value }))
  }, [canUseMpv])

  const handleSpeedChange = useCallback((nextSpeed) => {
    applySpeed(nextSpeed)
    setActiveMenu(null)
  }, [applySpeed])

  const handleSelectSubtitle = useCallback((trackId) => {
    if (!canUseMpv) {
      setActiveMenu(null)
      return
    }
    window.electronAPI?.mpvSetSubtitleTrack?.(trackId)
    if (trackId !== 'no') window.electronAPI?.mpvSetSubtitleVisible?.(true)
    setActiveMenu(null)
  }, [canUseMpv])

  const handleSelectAudio = useCallback((trackId) => {
    if (canUseMpv) window.electronAPI?.mpvSetAudioTrack?.(trackId)
    setActiveMenu(null)
  }, [canUseMpv])

  const handleToggleSubtitleVisible = useCallback(() => {
    if (canUseMpv) {
      window.electronAPI?.mpvSetSubtitleVisible?.(!subtitleVisible)
    }
  }, [canUseMpv, subtitleVisible])

  const handleSubtitleScaleChange = useCallback((nextScale) => {
    if (canUseMpv) {
      window.electronAPI?.mpvSetSubtitleScale?.(nextScale)
    }
    setActiveMenu(null)
  }, [canUseMpv])

  const handleToggleMenu = useCallback((menuName) => {
    setActiveMenu(current => (current === menuName ? null : menuName))
  }, [])

  const handleScreenshot = useCallback(async () => {
    if (canUseMpv) {
      await window.electronAPI?.mpvScreenshot?.()
      return
    }

    const el = videoRef.current
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
  }, [canUseMpv, setPlayerError])

  const handlePlayerCommand = useCallback((action, value) => {
    if (canUseMpv) return false

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
    canUseMpv,
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
    if (clickTimerRef.current) return
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null
      handleTogglePause()
    }, 180)
  }, [handleTogglePause])

  const handleVideoSurfaceDoubleClick = useCallback((event) => {
    event.preventDefault()
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
    }
    handleToggleFullscreen()
  }, [handleToggleFullscreen])

  const handleHtml5LoadedMetadata = useCallback(() => {
    const el = videoRef.current
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
  }, [])

  const handleHtml5TimeUpdate = useCallback(() => {
    const el = videoRef.current
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
  }, [])

  const handleHtml5VolumeChange = useCallback(() => {
    const el = videoRef.current
    if (!el) return
    setHtml5State(prev => ({
      ...prev,
      volume: Math.round((el.volume ?? 1) * 100),
      muted: el.muted
    }))
  }, [])

  const handleHtml5RateChange = useCallback(() => {
    const el = videoRef.current
    if (!el) return
    setHtml5State(prev => ({ ...prev, playbackRate: el.playbackRate || 1 }))
  }, [])

  const saveHtml5PlaybackState = useCallback((immediate = false) => {
    if (canUseMpv || !video?.fullPath || !window.electronAPI?.savePlaybackState) return

    const el = videoRef.current
    if (!el) return

    const patch = {
      position: el.ended ? 0 : Math.max(0, Number(el.currentTime) || 0),
      volume: Math.max(0, Math.min(100, Math.round((el.volume ?? 1) * 100))),
      speed: Math.max(0.1, Number(el.playbackRate) || 1),
      muted: Boolean(el.muted),
      loopMode: el.loop ? 'inf' : 'off'
    }

    html5SaveSnapshotRef.current = patch

    const save = () => window.electronAPI.savePlaybackState(video.fullPath, patch).catch(() => {})
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
      window.electronAPI.savePlaybackState(video.fullPath, nextPatch).catch(() => {})
    }, 1000)
  }, [canUseMpv, video?.fullPath])

  const handleHtml5PlaybackStateChange = useCallback(() => {
    const el = videoRef.current
    if (!el) return
    setHtml5State(prev => ({ ...prev, paused: el.paused }))
    if (el.paused && Number(el.currentTime) > 0) {
      saveHtml5PlaybackState(true)
    }
  }, [saveHtml5PlaybackState])

  const handleHtml5Seeked = useCallback(() => {
    const el = videoRef.current
    if (!el) return
    setHtml5State(prev => ({
      ...prev,
      currentTime: el.currentTime || 0,
      paused: el.paused
    }))
    saveHtml5PlaybackState(true)
  }, [saveHtml5PlaybackState])

  const handleHtml5Ended = useCallback(() => {
    setHtml5State(prev => ({ ...prev, paused: true }))
    saveHtml5PlaybackState(true)
    handleAdvanceFromEnd?.()
  }, [handleAdvanceFromEnd, saveHtml5PlaybackState])

  const clearHostSyncJobs = useCallback(() => {
    hostSyncFramesRef.current.forEach(id => cancelAnimationFrame(id))
    hostSyncFramesRef.current = []
    hostSyncTimersRef.current.forEach(id => clearTimeout(id))
    hostSyncTimersRef.current = []
  }, [])

  const readMpvHostBounds = useCallback(() => {
    if (!video || !canUseMpv || !stageRef.current) return null

    const rect = stageRef.current.getBoundingClientRect()
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0
    if (
      rect.width < 8 ||
      rect.height < 8 ||
      rect.right <= 0 ||
      rect.bottom <= 0 ||
      rect.left >= viewportWidth ||
      rect.top >= viewportHeight
    ) {
      return null
    }

    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height))
    }
  }, [canUseMpv, video])

  const syncMpvHostBounds = useCallback(() => {
    const nextBounds = readMpvHostBounds()
    if (!nextBounds) return false

    const prev = hostBoundsRef.current
    if (
      prev &&
      prev.x === nextBounds.x &&
      prev.y === nextBounds.y &&
      prev.width === nextBounds.width &&
      prev.height === nextBounds.height
    ) {
      return false
    }

    hostBoundsRef.current = nextBounds
    window.electronAPI?.mpvSetHostBounds?.(nextBounds)?.catch(() => {})
    return true
  }, [readMpvHostBounds])

  const scheduleMpvHostBoundsSync = useCallback((bursts = false) => {
    clearHostSyncJobs()

    const run = () => {
      syncMpvHostBounds()
    }

    const frameOffsets = bursts ? [0, 1, 2, 3, 4, 5, 8, 12] : [0]
    const scheduleFrameChain = (remaining) => {
      const id = requestAnimationFrame(() => {
        hostSyncFramesRef.current = hostSyncFramesRef.current.filter(frameId => frameId !== id)
        run()
        if (remaining > 0) scheduleFrameChain(remaining - 1)
      })
      hostSyncFramesRef.current.push(id)
    }
    scheduleFrameChain(Math.max(...frameOffsets))

    if (bursts) {
      ;[80, 180, 360, 700].forEach(delay => {
        const id = setTimeout(() => {
          hostSyncTimersRef.current = hostSyncTimersRef.current.filter(timerId => timerId !== id)
          run()
        }, delay)
        hostSyncTimersRef.current.push(id)
      })
    }
  }, [clearHostSyncJobs, syncMpvHostBounds])

  useLayoutEffect(() => {
    if (!video || !canUseMpv) {
      clearHostSyncJobs()
      hostBoundsRef.current = null
      window.electronAPI?.mpvSetHostBounds?.(null)?.catch(() => {})
      return undefined
    }

    scheduleMpvHostBoundsSync(true)

    const stageEl = stageRef.current
    const observer = stageEl && typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => scheduleMpvHostBoundsSync(true))
      : null

    if (observer && stageEl) {
      observer.observe(stageEl)
    }

    window.addEventListener('resize', scheduleMpvHostBoundsSync)
    window.addEventListener('scroll', scheduleMpvHostBoundsSync, true)

    return () => {
      clearHostSyncJobs()
      window.removeEventListener('resize', scheduleMpvHostBoundsSync)
      window.removeEventListener('scroll', scheduleMpvHostBoundsSync, true)
      observer?.disconnect()
      hostBoundsRef.current = null
      window.electronAPI?.mpvSetHostBounds?.(null)?.catch(() => {})
    }
  }, [canUseMpv, clearHostSyncJobs, scheduleMpvHostBoundsSync, video])

  useEffect(() => {
    return registerPlayerCommandTarget?.(handlePlayerCommand)
  }, [handlePlayerCommand, registerPlayerCommandTarget])

  useEffect(() => {
    if (mpvStatus?.available === false && mode === 'mpv') {
      setMode('html5')
    }
  }, [mode, mpvStatus?.available])

  useEffect(() => {
    if (!video) return undefined

    const launchId = ++launchTokenRef.current
    const shouldUseMpv = mode === 'mpv' && mpvStatus?.available !== false

    setLaunchState(shouldUseMpv ? 'launching' : 'loading')
    setHtml5Error('')
    setHtml5Url('')
    setPlayerError('')
    html5ResumeRef.current = null

    let cancelled = false

    const loadHtml5 = async () => {
      try {
        const [url, playbackState] = await Promise.all([
          window.electronAPI?.getFileUrl?.(video.fullPath),
          window.electronAPI?.getPlaybackState?.(video.fullPath)
        ])

        if (cancelled || launchTokenRef.current !== launchId) return

        html5ResumeRef.current = playbackResumeEnabled ? (playbackState || null) : null
        setHtml5Url(url || '')
        setHtml5State(prev => ({
          ...prev,
          currentTime: playbackResumeEnabled ? Number(playbackState?.position ?? 0) : 0,
          volume: playbackResumeEnabled && playbackState?.volume != null ? Number(playbackState.volume) : prev.volume,
          muted: playbackResumeEnabled && playbackState?.muted != null ? Boolean(playbackState.muted) : prev.muted,
          playbackRate: playbackResumeEnabled && playbackState?.speed != null ? Number(playbackState.speed) : prev.playbackRate,
          loop: playbackResumeEnabled && playbackState?.loopMode === 'inf'
        }))
        setLaunchState('ready')
      } catch (err) {
        if (cancelled || launchTokenRef.current !== launchId) return
        const message = err?.message || 'HTML5 播放失败'
        setHtml5Error(message)
        setPlayerError(message)
        setLaunchState('error')
      }
    }

    if (shouldUseMpv) {
      const currentHostBounds = readMpvHostBounds()
      if (currentHostBounds) {
        hostBoundsRef.current = currentHostBounds
        window.electronAPI?.mpvSetHostBounds?.(currentHostBounds)?.catch(() => {})
      }

      const playPromise = window.electronAPI?.mpvPlay?.(video.fullPath, {
        ...(video.playOptions || {}),
        hostBounds: currentHostBounds || hostBoundsRef.current || undefined,
        playlist: launchPlaybackMode === 'single' || !Array.isArray(playbackQueue)
          ? [video.fullPath]
          : playbackQueue.map(item => item?.fullPath).filter(Boolean),
        playlistIndex: launchPlaybackMode === 'single' ? 0 : playbackQueueIndex
      })
      if (!playPromise?.then) {
        setMode('html5')
        loadHtml5()
      } else {
        playPromise.then((result) => {
          if (cancelled || launchTokenRef.current !== launchId) return
          if (result?.success) {
            setLaunchState('ready')
            return
          }

          setMode('html5')
          loadHtml5()
        }).catch((err) => {
          if (cancelled || launchTokenRef.current !== launchId) return
          setMode('html5')
          loadHtml5().catch(() => {})
          if (err?.message) {
            setPlayerError('')
          }
        })
      }
    } else {
      loadHtml5()
    }

    return () => {
      cancelled = true
      if (shouldUseMpv) {
        window.electronAPI?.mpvStop?.()
      } else {
        videoRef.current?.pause?.()
      }
    }
  }, [launchPlaybackMode, mode, mpvStatus?.available, playbackQueue, playbackQueueIndex, playbackResumeEnabled, readMpvHostBounds, setPlayerError, video])

  useEffect(() => {
    if (canUseMpv || !html5Url || !video?.fullPath) return undefined
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
    video?.fullPath
  ])

  useEffect(() => {
    return () => {
      if (html5SaveTimerRef.current) {
        clearTimeout(html5SaveTimerRef.current)
        html5SaveTimerRef.current = null
      }
      if (!canUseMpv && video?.fullPath) {
        saveHtml5PlaybackState(true)
      }
    }
  }, [canUseMpv, saveHtml5PlaybackState, video?.fullPath])

  useEffect(() => {
    if (!video) return undefined

    const isFormTarget = (target) => {
      const tagName = target?.tagName?.toLowerCase?.()
      return ['input', 'textarea', 'select'].includes(tagName)
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
      if (isFormTarget(event.target)) return

      switch (event.key) {
        case 'Escape':
          event.preventDefault()
          handleClose()
          break
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

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', clearArrowHolds)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', clearArrowHolds)
      clearArrowHolds()
    }
  }, [applySpeed, handleClose, handleOpenFile, handleSeek, handleTogglePause, video])

  useEffect(() => {
    if (mode !== 'html5' || !html5Url) return
    videoRef.current?.play?.().catch(() => {})
  }, [html5Url, mode, video])

  useEffect(() => {
    if (!video) return undefined

    const pauseForBackground = () => {
      if (pausedRef.current) return
      autoPausedRef.current = true
      if (canUseMpvRef.current) {
        window.electronAPI?.mpvSetPaused?.(true)?.catch(() => {})
        return
      }
      videoRef.current?.pause?.()
    }

    const restoreFromBackground = () => {
      if (!autoPausedRef.current) return
      autoPausedRef.current = false
      if (canUseMpvRef.current) {
        window.electronAPI?.mpvSetPaused?.(false)?.catch(() => {})
        return
      }
      videoRef.current?.play?.().catch(() => {})
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
      window.removeEventListener('pagehide', pauseForBackground)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      autoPausedRef.current = false
    }
  }, [video])

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
          webFullscreen ? 'web-fullscreen' : '',
          activeMenu ? 'menu-open' : '',
          activeMenu ? `menu-${activeMenu}` : '',
          controlsVisible || paused || activeMenu ? 'controls-visible' : 'controls-hidden'
        ].filter(Boolean).join(' ')}
        onMouseEnter={showControls}
        onMouseMove={showControls}
      >
        <button className="player-close" onClick={handleClose} title="关闭 (Esc)" type="button" aria-label="关闭播放器">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>

        <div className="player-stage">
          <div
            className="player-video-surface"
            onClick={handleVideoSurfaceClick}
            onDoubleClick={handleVideoSurfaceDoubleClick}
          >
            {isHtml5 ? (
              html5Url ? (
                <video
                  ref={videoRef}
                  className="player-video"
                  src={html5Url}
                  autoPlay
                  onLoadedMetadata={handleHtml5LoadedMetadata}
                  onTimeUpdate={handleHtml5TimeUpdate}
                  onVolumeChange={handleHtml5VolumeChange}
                  onRateChange={handleHtml5RateChange}
                  onPlay={handleHtml5PlaybackStateChange}
                  onPause={handleHtml5PlaybackStateChange}
                  onSeeked={handleHtml5Seeked}
                  onEnded={handleHtml5Ended}
                  onError={() => {
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

            {isHtml5 && paused && (
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

            <div className="player-toolbar" onClick={event => event.stopPropagation()}>
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
                <span className="player-time-current">{formatTime(progressValue)}</span>
                <span className="player-time-divider">/</span>
                <span className="player-time-total">{formatTime(duration)}</span>
              </div>

              <div className="player-progress-wrap">
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

              <div className="player-right-controls">
                <div className="player-popover-anchor">
                  <button className="player-text-button" type="button" title="清晰度" onClick={() => handleToggleMenu('quality')}>
                    {qualityLabel}
                  </button>
                  {activeMenu === 'quality' && (
                    <div className="player-menu player-menu-right" role="menu">
                      <button className="active" type="button" role="menuitem" onClick={() => setActiveMenu(null)}>原画</button>
                      <span className="player-menu-note">本地文件暂无多清晰度源</span>
                    </div>
                  )}
                </div>

                <div className="player-popover-anchor">
                  <button className="player-text-button" type="button" title="倍速" onClick={() => handleToggleMenu('speed')}>
                    {formatSpeed(speed)}
                  </button>
                  {activeMenu === 'speed' && (
                    <div className="player-menu player-menu-right" role="menu">
                      {SPEED_OPTIONS.map(option => (
                        <button
                          key={option}
                          className={Math.abs(speed - option) < 0.01 ? 'active' : ''}
                          type="button"
                          role="menuitem"
                          onClick={() => handleSpeedChange(option)}
                        >
                          {formatSpeed(option)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="player-popover-anchor">
                  <button className="player-text-button" type="button" title="字幕" onClick={() => handleToggleMenu('subtitle')}>
                    字幕
                  </button>
                  {activeMenu === 'subtitle' && (
                    <div className="player-menu player-menu-right" role="menu">
                      <button className={subtitleId == null ? 'active' : ''} type="button" role="menuitem" onClick={() => handleSelectSubtitle('no')}>关闭字幕</button>
                      {canUseMpv && subtitleTracks.length ? subtitleTracks.map(track => (
                        <button
                          key={track.id}
                          className={subtitleId === Number(track.id) ? 'active' : ''}
                          type="button"
                          role="menuitem"
                          onClick={() => handleSelectSubtitle(track.id)}
                        >
                          {getTrackLabel(track, `字幕 ${track.id}`)}
                        </button>
                      )) : (
                        <span className="player-menu-note">没有检测到字幕轨</span>
                      )}
                    </div>
                  )}
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
                  {activeMenu === 'settings' && (
                    <div className="player-menu player-menu-right player-settings-menu" role="menu">
                      <div className="player-menu-group">
                        <span className="player-menu-title">字幕大小</span>
                        <div className="player-menu-options">
                          {SUBTITLE_SCALE_OPTIONS.map(option => (
                            <button
                              key={option}
                              className={Math.abs(subtitleScale - option) < 0.01 ? 'active' : ''}
                              type="button"
                              role="menuitem"
                              onClick={() => handleSubtitleScaleChange(option)}
                            >
                              {Math.round(option * 100)}%
                            </button>
                          ))}
                        </div>
                      </div>
                      <button type="button" role="menuitem" onClick={handleToggleSubtitleVisible}>
                        {subtitleVisible ? '隐藏字幕' : '显示字幕'}
                      </button>
                      <div className="player-menu-group">
                        <span className="player-menu-title">音轨</span>
                        {canUseMpv && audioTracks.length ? audioTracks.map(track => (
                          <button
                            key={track.id}
                            className={audioId === Number(track.id) ? 'active' : ''}
                            type="button"
                            role="menuitem"
                            onClick={() => handleSelectAudio(track.id)}
                          >
                            {getTrackLabel(track, `音轨 ${track.id}`)}
                          </button>
                        )) : (
                          <span className="player-menu-note">没有可切换音轨</span>
                        )}
                      </div>
                    </div>
                  )}
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
                <button
                  className="btn btn-icon player-control-btn"
                  onClick={handleToggleWebFullscreen}
                  type="button"
                  title={webFullscreen ? '退出网页全屏' : '网页全屏'}
                  aria-label={webFullscreen ? '退出网页全屏' : '网页全屏'}
                >
                  <Icon path={webFullscreen ? <path d="M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6" /> : <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" />} />
                </button>
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
          </div>
        </div>
        </div>
      </div>
    </div>
  )
}
