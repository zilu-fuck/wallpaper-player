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
  return video?.playbackKey || video?.url || video?.fullPath || video?.filePath || ''
}

function getUniqueVideoKeys(list) {
  const keys = []
  const seen = new Set()
  for (const video of Array.isArray(list) ? list : []) {
    const key = getVideoKey(video)
    if (!key || seen.has(key)) continue
    seen.add(key)
    keys.push(key)
  }
  return keys
}

function pathKey(filePath) {
  return String(filePath || '').replace(/\\/g, '/').toLowerCase()
}

function isNetworkUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function normalizeNetworkUrl(value) {
  try {
    return new URL(String(value || '').trim()).toString()
  } catch {
    return String(value || '').trim()
  }
}

function createVideoIndex(list) {
  const index = new Map()
  for (const video of Array.isArray(list) ? list : []) {
    const key = getVideoKey(video)
    const file = pathKey(video.url || video.fullPath || video.filePath)
    if (key && !index.has(key)) index.set(key, video)
    if (file && !index.has(file)) index.set(file, video)
  }
  return index
}

function stableShuffleKeys(keys) {
  return [...keys].sort((ak, bk) => {
    let ah = 2166136261
    let bh = 2166136261
    for (let i = 0; i < ak.length; i++) ah = Math.imul(ah ^ ak.charCodeAt(i), 16777619)
    for (let i = 0; i < bk.length; i++) bh = Math.imul(bh ^ bk.charCodeAt(i), 16777619)
    if (ah === bh) return ak.localeCompare(bk, 'zh')
    return ah - bh
  })
}

function orderQueueKeysForMode(list, playbackMode) {
  const keys = getUniqueVideoKeys(list)
  return playbackMode === 'shuffle' ? stableShuffleKeys(keys) : keys
}

function keyMatchesPath(key, filePath) {
  const normalizedPath = pathKey(filePath)
  return Boolean(normalizedPath) && (
    key === normalizedPath ||
    pathKey(key) === normalizedPath
  )
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

function createNetworkVideo(resource) {
  const url = String(resource?.url || '').trim()
  const normalizedUrl = normalizeNetworkUrl(url)
  const fallbackName = (() => {
    try {
      const parsed = new URL(url)
      return decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '') || parsed.hostname || '网络视频'
    } catch {
      return '网络视频'
    }
  })()

  return {
    id: resource?.id || url,
    playbackKey: normalizedUrl,
    sourceType: 'network',
    resourceKind: resource?.kind || 'direct',
    openMode: resource?.page?.openMode || '',
    playbackUrl: resource?.playbackUrl || '',
    httpHeaders: resource?.httpHeaders || null,
    parser: resource?.parser || '',
    page: resource?.page || null,
    url: normalizedUrl,
    fullPath: normalizedUrl,
    fileName: resource?.title || fallbackName,
    name: resource?.title || fallbackName,
    extension: (() => {
      try {
        return new URL(url).pathname.toLowerCase().match(/\.[^.\\/]+$/)?.[0] || ''
      } catch {
        return ''
      }
    })(),
    group: '网络资源',
    tags: [],
    favoriteKey: normalizedUrl
  }
}

function createNetworkEpisodeVideos(resource) {
  const episodes = Array.isArray(resource?.page?.episodes) ? resource.page.episodes : []
  return episodes
    .filter(episode => episode?.url && isNetworkUrl(episode.url))
    .map(episode => createNetworkVideo({
      ...resource,
      id: `${resource?.id || resource?.url || 'network'}:${episode.index || episode.url}`,
      title: episode.title || resource?.title,
      url: episode.url,
      playbackUrl: episode.playbackUrl || '',
      httpHeaders: episode.httpHeaders || resource?.httpHeaders || null,
      page: {
        ...(resource?.page || {}),
        openMode: episode.openMode || resource?.page?.openMode || '',
        currentEpisodeIndex: episode.index || null,
        currentEpisodeTitle: episode.title || ''
      }
    }))
}

function isSupportedVideoPath(filePath) {
  const ext = String(filePath || '').toLowerCase().match(/\.[^.\\/]+$/)?.[0] || ''
  return SUPPORTED_EXTENSIONS.has(ext)
}

export function usePlayer({ queueVideos = [], videoSource = queueVideos, playbackMode = 'order' } = {}) {
  const [playingVideo, setPlayingVideo] = useState(null)
  const [playerError, setPlayerError] = useState('')
  const [currentPlaybackPath, setCurrentPlaybackPath] = useState('')
  const [sessionQueueKeys, setSessionQueueKeys] = useState(null)
  const [sessionQueueVideos, setSessionQueueVideos] = useState([])
  const playerCommandTargetRef = useRef(null)
  const videoIndex = useMemo(() => createVideoIndex(videoSource), [videoSource])
  const sessionVideoIndex = useMemo(() => createVideoIndex(sessionQueueVideos), [sessionQueueVideos])
  const sourceQueueKeys = useMemo(() => (
    orderQueueKeysForMode(queueVideos, playbackMode)
  ), [queueVideos, playbackMode])
  const activeQueueKeys = useMemo(() => (
    Array.isArray(sessionQueueKeys) ? sessionQueueKeys : sourceQueueKeys
  ), [sessionQueueKeys, sourceQueueKeys])

  const resolveQueueVideoAt = useCallback((index) => {
    const key = activeQueueKeys[index]
    if (!key) return null
    const sessionVideo = sessionQueueKeys
      ? sessionVideoIndex.get(key) || sessionVideoIndex.get(pathKey(key))
      : null
    if (sessionVideo) return sessionVideo
    const indexedVideo = videoIndex.get(key) || videoIndex.get(pathKey(key))
    if (indexedVideo) return indexedVideo
    if (playingVideo && (getVideoKey(playingVideo) === key || keyMatchesPath(key, playingVideo.fullPath || playingVideo.filePath))) {
      return playingVideo
    }
    return null
  }, [activeQueueKeys, playingVideo, sessionQueueKeys, sessionVideoIndex, videoIndex])

  const queueItems = useMemo(() => (
    activeQueueKeys
      .map((_, index) => resolveQueueVideoAt(index))
      .filter(Boolean)
  ), [activeQueueKeys, resolveQueueVideoAt])

  const queueIndex = useMemo(() => {
    if (!playingVideo) return -1
    if (currentPlaybackPath && playingVideo.sourceType !== 'network') {
      const currentPath = pathKey(currentPlaybackPath)
      const byPath = activeQueueKeys.findIndex(key => {
        if (key === currentPath || pathKey(key) === currentPath) return true
        const video = videoIndex.get(key) || videoIndex.get(pathKey(key))
        return pathKey(video?.fullPath || video?.filePath) === currentPath
      })
      if (byPath >= 0) return byPath
    }
    const currentKey = getVideoKey(playingVideo)
    return activeQueueKeys.findIndex(key => key === currentKey || pathKey(key) === pathKey(currentKey))
  }, [activeQueueKeys, currentPlaybackPath, playingVideo, videoIndex])

  const queueLength = playingVideo && queueIndex < 0 ? 1 : activeQueueKeys.length

  const handlePlay = useCallback((video, options = {}) => {
    if (!video) return null
    const nextPlaybackMode = options.playbackMode ||
      (options.preserveQueueOrder ? playingVideo?.playOptions?.playbackMode : null) ||
      playbackMode
    if (Array.isArray(options.queueKeys)) {
      setSessionQueueKeys([...new Set(options.queueKeys.filter(Boolean))])
    } else if (Array.isArray(options.queueVideos)) {
      const nextQueueKeys = options.preserveQueueOrder
        ? getUniqueVideoKeys(options.queueVideos)
        : orderQueueKeysForMode(options.queueVideos, nextPlaybackMode)
      setSessionQueueKeys(nextQueueKeys)
      setSessionQueueVideos(options.queueVideos)
    } else if (options.queueVideos === null) {
      setSessionQueueKeys([getVideoKey(video)].filter(Boolean))
      setSessionQueueVideos([video])
    }

    const nextVideo = {
      ...video,
      playbackToken: makeToken(),
      playOptions: {
        resume: options.resume !== false,
        playbackMode: nextPlaybackMode
      }
    }
    setPlayerError('')
    setCurrentPlaybackPath(video.url || video.fullPath || video.filePath || '')
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

  const handlePlayNetworkResource = useCallback((resource, options = {}) => {
    if (!resource?.url || !isNetworkUrl(resource.url)) {
      setPlayerError('网络资源地址无效')
      return null
    }
    const resourceKind = resource?.kind === 'webpage' || resource?.parser ? 'webpage' : resource?.kind
    const episodeVideos = resourceKind === 'webpage'
      ? createNetworkEpisodeVideos(resource)
      : []
    const currentEpisodeIndex = episodeVideos.findIndex(video => pathKey(video.url) === pathKey(normalizeNetworkUrl(resource.url)))
    const playOptions = Object.hasOwn(options, 'queueVideos')
      ? options
      : episodeVideos.length > 1
        ? { ...options, queueVideos: episodeVideos, preserveQueueOrder: true }
        : { ...options, queueVideos: null }
    return handlePlay(
      currentEpisodeIndex >= 0 ? episodeVideos[currentEpisodeIndex] : createNetworkVideo(resource),
      playOptions
    )
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
    setCurrentPlaybackPath('')
    setSessionQueueKeys(null)
    setSessionQueueVideos([])
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
        window.electronAPI?.mpvGetState?.()
          ?.then(state => window.electronAPI?.mpvSetVolume?.(Math.min(100, (state?.volume ?? 100) + (value ?? 5))))
        break
      case 'volume-down':
        window.electronAPI?.mpvGetState?.()
          ?.then(state => window.electronAPI?.mpvSetVolume?.(Math.max(0, (state?.volume ?? 100) - (value ?? 5))))
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
    if (!queueLength || queueIndex < 0) return null
    const nextVideo = resolveQueueVideoAt(queueIndex + 1)
    if (!nextVideo) return null
    return handlePlay(nextVideo, { queueKeys: activeQueueKeys, preserveQueueOrder: true })
  }, [activeQueueKeys, handlePlay, queueIndex, queueLength, resolveQueueVideoAt])

  const handlePrev = useCallback(() => {
    if (!queueLength || queueIndex < 0) return null
    const prevVideo = resolveQueueVideoAt(queueIndex - 1)
    if (!prevVideo) return null
    return handlePlay(prevVideo, { queueKeys: activeQueueKeys, preserveQueueOrder: true })
  }, [activeQueueKeys, handlePlay, queueIndex, queueLength, resolveQueueVideoAt])

  const handleReplayCurrent = useCallback(() => {
    const currentVideo = queueIndex >= 0 ? resolveQueueVideoAt(queueIndex) : playingVideo
    if (!currentVideo) return null
    return handlePlay(currentVideo, {
      resume: false,
      queueKeys: queueIndex >= 0 ? activeQueueKeys : [getVideoKey(currentVideo)].filter(Boolean),
      preserveQueueOrder: true
    })
  }, [activeQueueKeys, handlePlay, playingVideo, queueIndex, resolveQueueVideoAt])

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
    const next = resolveQueueVideoAt(queueIndex + 1)
    if (!next) {
      handleClosePlayer()
      return null
    }
    return handlePlay(next, { queueKeys: activeQueueKeys, preserveQueueOrder: true })
  }, [activeQueueKeys, handleClosePlayer, handlePlay, handleReplayCurrent, playbackMode, playingVideo, queueIndex, resolveQueueVideoAt])

  useEffect(() => {
    const removeState = window.electronAPI?.onMpvState?.((state) => {
      const nextPath = state?.filePath || ''
      setCurrentPlaybackPath(current => current === nextPath ? current : nextPath)
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
    playerError,
    setPlayerError,
    queue: activeQueueKeys,
    queueItems,
    queueIndex,
    queueLength,
    handlePlay,
    handlePlayPath,
    handleOpenFile,
    handlePlayNetworkResource,
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
