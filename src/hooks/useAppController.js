import { useRef, useEffect, useCallback } from 'react'
import { useAppState } from './useAppState'
import { useScan } from './useScan'
import { useFavorites } from './useFavorites'
import { useVideoFilter } from './useVideoFilter'
import { useTagEditor } from './useTagEditor'
import { usePlayer } from './usePlayer'
import { useVideoAnalysisTasks } from './useVideoAnalysisTasks'

function getPublicDirectories(directories = [], privateDirectories = []) {
  const privateSet = new Set(privateDirectories)
  return directories.filter(dir => !privateSet.has(dir))
}

// 组合所有子 hook，编排 init 与跨 hook 操作
export function useAppController() {
  const appState = useAppState()
  const {
    settings,
    setSettings,
    setCurrentDir,
    setLoading,
    setShowSettings,
    refreshPlugins,
    saveSettings,
    handleDirectoriesChange
  } = appState

  const scan = useScan({ setCurrentDir, setLoading })

  const { favoriteKeys, handleToggleFavorite } = useFavorites({ settings, saveSettings })
  const customTags = settings?.customTags || {}

  const filter = useVideoFilter({ videos: scan.videos, customTags, favoriteKeys })
  const tagEditor = useTagEditor({ settings, saveSettings })
  const player = usePlayer({
    queueVideos: filter.filteredVideos,
    videoSource: filter.displayVideos,
    playbackMode: appState.playbackMode
  })
  const videoAnalysisTasks = useVideoAnalysisTasks({
    settings,
    videos: scan.videos,
    plugins: appState.plugins,
    pluginsLoaded: appState.pluginsLoaded
  })
  const { handlePlayPath } = player
  const totalCount = scan.videos.length

  // 初始化：加载设置、扫描默认目录（用 ref 防止 StrictMode 重复调用）
  const initRef = useRef(false)
  useEffect(() => {
    if (initRef.current) return
    initRef.current = true
    init()
  }, [])

  async function init() {
    setLoading(true)
    try {
      const s = await window.electronAPI.getSettings()
      setSettings({
        theme: 'dark',
        ...s
      })
      refreshPlugins()

      const publicDirectories = getPublicDirectories(s.directories || [], s.privateDirectories || [])
      const dir = s.defaultDirectory || publicDirectories[0]
      if (dir) {
        setCurrentDir(dir)
        await scan.scanAndLoad(dir)
      } else {
        setLoading(false)
      }

      // 检查 ffmpeg（后台执行，不阻塞UI）
      window.electronAPI.checkFfmpeg().then(ff => appState.setFfmpegStatus(ff))

      // 检查 mpv
      window.electronAPI.checkMpv().then(mpv => appState.setMpvStatus(mpv))
    } catch (err) {
      console.error('初始化失败:', err)
      setLoading(false)
    }
  }

  const addDirectory = useCallback(async (options = {}) => {
    const selection = window.electronAPI.selectVideoDirectory
      ? await window.electronAPI.selectVideoDirectory()
      : await window.electronAPI.selectDirectory()
    const dir = typeof selection === 'string' ? selection : selection?.path
    if (!dir) return null
    const privateDirectory = typeof selection === 'object' && Boolean(selection.privateDirectory)
    const currentDirectories = settings?.directories || []
    const currentPrivateDirectories = settings?.privateDirectories || []
    const alreadyPrivate = currentPrivateDirectories.includes(dir)
    const shouldBePrivate = privateDirectory || alreadyPrivate
    const needsPrivacyPassword = shouldBePrivate && !settings?.privacy?.passwordSet
    if (needsPrivacyPassword) {
      const payload = { dir, privateDirectory: true, needsPrivacyPassword: true }
      if (!options.returnPasswordRequired) {
        window.dispatchEvent(new CustomEvent('wallpaper-player-private-directory-password-required', { detail: payload }))
      }
      return payload
    }

    const directories = currentDirectories.includes(dir)
      ? currentDirectories
      : [...currentDirectories, dir]
    const privateDirectories = shouldBePrivate
      ? [...new Set([...currentPrivateDirectories, dir])]
      : currentPrivateDirectories.filter(item => item !== dir)
    const publicDirectories = getPublicDirectories(directories, privateDirectories)
    const defaultDirectory = publicDirectories.includes(settings?.defaultDirectory)
      ? settings.defaultDirectory
      : publicDirectories[0] || ''

    if (!currentDirectories.includes(dir) || privateDirectory !== currentPrivateDirectories.includes(dir)) {
      await handleDirectoriesChange({ directories, privateDirectories, defaultDirectory })
    }

    if (!shouldBePrivate) {
      scan.resetGallery()
      filter.setActiveCategory('all')
      await scan.scanAndLoad(dir, true)
    }
    return { dir, privateDirectory: shouldBePrivate, needsPrivacyPassword: false }
  }, [settings, handleDirectoriesChange, scan, filter])

  const handleSelectDirectory = useCallback(async () => {
    await addDirectory()
  }, [addDirectory])

  const handleAddDirectory = useCallback(async (options) => {
    return addDirectory(options)
  }, [addDirectory])

  const handleDirectoryChange = useCallback(async (dirPath) => {
    appState.setShowSettings(false)
    if (!dirPath) {
      scan.cancelScan()
      scan.resetGallery()
      setCurrentDir(null)
      scan.setScanning(false)
      scan.setThumbProgress(null)
      return
    }
    scan.resetGallery()
    filter.setActiveCategory('all')
    await scan.scanAndLoad(dirPath)
  }, [appState, scan, filter, setCurrentDir])

  const handleCheckUpdate = useCallback(() => {
    window.dispatchEvent(new Event('wallpaper-player-check-update'))
    appState.setShowSettings(false)
  }, [appState])

  const handleOpenInFolder = useCallback(async (video) => {
    if (!video?.fullPath) return
    try {
      await window.electronAPI?.showInFolder(video.fullPath)
    } catch (err) {
      console.error('打开文件位置失败:', err)
    }
  }, [])

  useEffect(() => {
    const removeRemotePlay = window.electronAPI?.onRemotePlayOnDesktop?.((payload) => {
      const filePath = payload?.filePath
      if (!filePath) return
      setShowSettings(false)
      handlePlayPath(filePath, { resume: true, queueVideos: null })
    })

    return () => removeRemotePlay?.()
  }, [handlePlayPath, setShowSettings])

  return {
    ...appState,
    ...scan,
    ...filter,
    ...tagEditor,
    ...player,
    ...videoAnalysisTasks,
    totalCount,
    customTags,
    favoriteKeys,
    handleToggleFavorite,
    handleOpenInFolder,
    handleSelectDirectory,
    handleAddDirectory,
    handleDirectoryChange,
    handleCheckUpdate
  }
}
