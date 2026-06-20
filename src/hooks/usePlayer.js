import { useState, useCallback, useMemo, useEffect, useRef } from 'react'

const SUPPORTED_EXTENSIONS = new Set([
  '.mp4', '.webm', '.mkv', '.avi', '.mov', '.wmv', '.flv',
  '.m4v', '.mpg', '.mpeg', '.3gp', '.ogv', '.ts', '.vob',
  '.rmvb', '.rm', '.asf', '.divx', '.f4v'
])

function makeToken() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function getVideoKey(video) {
  return video?.playbackKey || video?.fullPath || video?.filePath || ''
}

function pathKey(filePath) {
  return String(filePath || '').replace(/\\/g, '/').toLowerCase()
}

function findVideoIndex(list, video) {
  if (!Array.isArray(list) || !video) return -1
  const key = getVideoKey(video)
  const file = pathKey(video.fullPath || video.filePath)
  return list.findIndex(item => (
    getVideoKey(item) === key ||
    pathKey(item?.fullPath || item?.filePath) === file
  ))
}

function stableShuffle(list) {
  return [...list].sort((a, b) => {
    const ak = getVideoKey(a)
    const bk = getVideoKey(b)
    let ah = 2166136261
    let bh = 2166136261
    for (let i = 0; i < ak.length; i++) ah = Math.imul(ah ^ ak.charCodeAt(i), 16777619)
    for (let i = 0; i < bk.length; i++) bh = Math.imul(bh ^ bk.charCodeAt(i), 16777619)
    if (ah === bh) return ak.localeCompare(bk, 'zh')
    return ah - bh
  })
}

function orderQueueForMode(list, playbackMode) {
  const source = Array.isArray(list) ? list : []
  return playbackMode === 'shuffle' ? stableShuffle(source) : source
}

function createStandaloneVideo(filePath) {
  const normalizedPath = String(filePath || '')
  const fileName = normalizedPath.split(/[/\\]/).pop() || normalizedPath
  const dotIndex = fileName.lastIndexOf('.')
  const name = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName
  const extension = dotIndex > -1 ? fileName.slice(dotIndex).toLowerCase() : ''

  return {
    id: normalizedPath,
    playbackKey: normalizedPath,
    fullPath: normalizedPath,
    fileName: name,
    name,
    extension,
    group: '外部文件',
    tags: [],
    favoriteKey: normalizedPath
  }
}

function isSupportedVideoPath(filePath) {
  const ext = String(filePath || '').toLowerCase().match(/\.[^.\\/]+$/)?.[0] || ''
  return SUPPORTED_EXTENSIONS.has(ext)
}

export function usePlayer({ queueVideos = [], playbackMode = 'order' } = {}) {
  const [playingVideo, setPlayingVideo] = useState(null)
  const [playerError, setPlayerError] = useState('')
  const [mpvState, setMpvState] = useState(null)
  const [sessionQueueVideos, setSessionQueueVideos] = useState(null)
  const mpvStateRef = useRef(null)
  const playerCommandTargetRef = useRef(null)

  const queue = useMemo(() => {
    if (Array.isArray(sessionQueueVideos)) return sessionQueueVideos
    return orderQueueForMode(queueVideos, playbackMode)
  }, [queueVideos, playbackMode, sessionQueueVideos])

  const queueIndex = useMemo(() => {
    if (!playingVideo) return -1
    if (mpvState?.filePath) {
      const currentPath = pathKey(mpvState.filePath)
      const byPath = queue.findIndex(item => pathKey(item?.fullPath || item?.filePath) === currentPath)
      if (byPath >= 0) return byPath
    }
    const currentKey = getVideoKey(playingVideo)
    return queue.findIndex(item => getVideoKey(item) === currentKey)
  }, [mpvState?.filePath, queue, playingVideo])

  const activeQueue = useMemo(() => {
    if (!playingVideo) return queue
    if (queueIndex >= 0) return queue
    return [playingVideo]
  }, [queue, playingVideo, queueIndex])

  const handlePlay = useCallback((video, options = {}) => {
    if (!video) return null
    const nextPlaybackMode = options.playbackMode ||
      (options.preserveQueueOrder ? playingVideo?.playOptions?.playbackMode : null) ||
      playbackMode
    let queueVideosForPlayback = null
    if (Array.isArray(options.queueVideos)) {
      queueVideosForPlayback = options.preserveQueueOrder
        ? options.queueVideos
        : orderQueueForMode(options.queueVideos, nextPlaybackMode)
      setSessionQueueVideos(queueVideosForPlayback)
    } else if (options.queueVideos === null) {
      queueVideosForPlayback = [video]
      setSessionQueueVideos(queueVideosForPlayback)
    }

    const nextVideo = {
      ...video,
      playbackToken: makeToken(),
      playOptions: {
        resume: options.resume !== false,
        queueVideos: queueVideosForPlayback,
        playbackMode: nextPlaybackMode,
        playlistIndex: queueVideosForPlayback ? findVideoIndex(queueVideosForPlayback, video) : 0
      }
    }
    setPlayerError('')
    setMpvState(null)
    setPlayingVideo(nextVideo)
    return nextVideo
  }, [playbackMode, playingVideo?.playOptions?.playbackMode])

  const handlePlayPath = useCallback(async (filePath, options = {}) => {
    if (!filePath || !isSupportedVideoPath(filePath)) {
      setPlayerError('文件格式不受支持')
      return null
    }

    try {
      await window.electronAPI?.allowVideoFile(filePath)
    } catch {}

    const playOptions = Object.hasOwn(options, 'queueVideos')
      ? options
      : { ...options, queueVideos: null }
    return handlePlay(createStandaloneVideo(filePath), playOptions)
  }, [handlePlay])

  const handleOpenFile = useCallback(async () => {
    try {
      const filePath = await window.electronAPI?.openVideoFile()
      if (!filePath) return null
      return handlePlayPath(filePath)
    } catch (err) {
      setPlayerError(err?.message || '打开文件失败')
      return null
    }
  }, [handlePlayPath])

  const handleDropFiles = useCallback(async (payload) => {
    const entries = Array.isArray(payload) ? payload : Array.from(payload || [])
    const filePath = entries
      .map(item => item?.path || item?.fullPath || item)
      .find(item => typeof item === 'string' && isSupportedVideoPath(item))

    if (!filePath) return null
    return handlePlayPath(filePath)
  }, [handlePlayPath])

  const handleClosePlayer = useCallback(() => {
    setPlayingVideo(null)
    setPlayerError('')
    setMpvState(null)
    setSessionQueueVideos(null)
  }, [])

  const handleStopPlayback = useCallback(() => {
    window.electronAPI?.mpvStop?.()
    handleClosePlayer()
  }, [handleClosePlayer])

  const runPlayerCommand = useCallback((action, value) => {
    const handled = playerCommandTargetRef.current?.(action, value)
    if (handled) return

    switch (action) {
      case 'play-pause':
        window.electronAPI?.mpvCyclePause?.()
        break
      case 'seek-backward':
        window.electronAPI?.mpvSeekRelative?.(-(value ?? 5))
        break
      case 'seek-forward':
        window.electronAPI?.mpvSeekRelative?.(value ?? 5)
        break
      case 'volume-up':
        window.electronAPI?.mpvSetVolume?.(Math.min(100, (mpvStateRef.current?.volume ?? 100) + (value ?? 5)))
        break
      case 'volume-down':
        window.electronAPI?.mpvSetVolume?.(Math.max(0, (mpvStateRef.current?.volume ?? 100) - (value ?? 5)))
        break
      case 'mute':
        window.electronAPI?.mpvToggleMute?.()
        break
      case 'screenshot':
        window.electronAPI?.mpvScreenshot?.()
        break
      default:
        break
    }
  }, [])

  const handleNext = useCallback(() => {
    if (!activeQueue.length || queueIndex < 0) return null
    const nextVideo = activeQueue[queueIndex + 1]
    if (!nextVideo) return null
    return handlePlay(nextVideo, { queueVideos: activeQueue, preserveQueueOrder: true })
  }, [activeQueue, queueIndex, handlePlay])

  const handlePrev = useCallback(() => {
    if (!activeQueue.length || queueIndex < 0) return null
    const prevVideo = activeQueue[queueIndex - 1]
    if (!prevVideo) return null
    return handlePlay(prevVideo, { queueVideos: activeQueue, preserveQueueOrder: true })
  }, [activeQueue, queueIndex, handlePlay])

  const handleReplayCurrent = useCallback(() => {
    const currentVideo = queueIndex >= 0 ? activeQueue[queueIndex] : playingVideo
    if (!currentVideo) return null
    return handlePlay(currentVideo, { resume: false, queueVideos: activeQueue, preserveQueueOrder: true })
  }, [activeQueue, handlePlay, playingVideo, queueIndex])

  const handleAdvanceFromEnd = useCallback(() => {
    if (!playingVideo) return null
    const activePlaybackMode = playingVideo?.playOptions?.playbackMode || playbackMode
    if (activePlaybackMode === 'single') {
      return handleReplayCurrent()
    }
    if (queueIndex < 0) {
      handleClosePlayer()
      return null
    }
    const next = activeQueue[queueIndex + 1]
    if (!next) {
      handleClosePlayer()
      return null
    }
    return handlePlay(next, { queueVideos: activeQueue, preserveQueueOrder: true })
  }, [activeQueue, handleClosePlayer, handlePlay, handleReplayCurrent, playbackMode, playingVideo, queueIndex])

  useEffect(() => {
    mpvStateRef.current = mpvState
  }, [mpvState])

  useEffect(() => {
    const removeState = window.electronAPI?.onMpvState?.((state) => {
      setMpvState(state)
    })

    const removeEnded = window.electronAPI?.onMpvEnded?.((data) => {
      if (data?.reason === 'eof') {
        handleAdvanceFromEnd()
      } else if (data?.reason === 'quit') {
        handleClosePlayer()
      }
    })

    const removeError = window.electronAPI?.onMpvError?.((data) => {
      setPlayerError(data?.message || 'mpv 播放出错')
    })

    const removeShortcut = window.electronAPI?.onPlayerShortcut?.((payload) => {
      switch (payload?.action) {
        case 'open-file':
          handleOpenFile()
          break
        case 'play-pause':
          runPlayerCommand('play-pause')
          break
        case 'next':
          handleNext()
          break
        case 'prev':
          handlePrev()
          break
        case 'stop':
          handleStopPlayback()
          break
        case 'seek-backward':
          runPlayerCommand('seek-backward', payload?.value)
          break
        case 'seek-forward':
          runPlayerCommand('seek-forward', payload?.value)
          break
        case 'volume-up':
          runPlayerCommand('volume-up', payload?.value)
          break
        case 'volume-down':
          runPlayerCommand('volume-down', payload?.value)
          break
        case 'mute':
          runPlayerCommand('mute')
          break
        case 'screenshot':
          runPlayerCommand('screenshot')
          break
        default:
          break
      }
    })

    return () => {
      removeShortcut?.()
      removeState?.()
      removeEnded?.()
      removeError?.()
    }
  }, [handleAdvanceFromEnd, handleClosePlayer, handleNext, handleOpenFile, handlePrev, handleStopPlayback, runPlayerCommand])

  const registerPlayerCommandTarget = useCallback((handler) => {
    playerCommandTargetRef.current = typeof handler === 'function' ? handler : null
    return () => {
      if (playerCommandTargetRef.current === handler) {
        playerCommandTargetRef.current = null
      }
    }
  }, [])

  return {
    playingVideo,
    mpvState,
    playerError,
    setPlayerError,
    queue: activeQueue,
    queueIndex,
    queueLength: activeQueue.length,
    handlePlay,
    handlePlayPath,
    handleOpenFile,
    handleDropFiles,
    handleClosePlayer,
    handleStopPlayback,
    handleNext,
    handlePrev,
    handleReplayCurrent,
    handleAdvanceFromEnd,
    registerPlayerCommandTarget
  }
}
