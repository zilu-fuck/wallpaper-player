import { useRef, useEffect, useCallback } from 'react'
import { WINDOW_EVENTS } from '../api/events'
import { useAppState } from './useAppState'
import { useScan } from './useScan'
import { useFavorites } from './useFavorites'
import { useVideoFilter } from './useVideoFilter'
import { useTagEditor } from './useTagEditor'
import { usePlayer } from './usePlayer'
import { useVideoAnalysisTasks } from './useVideoAnalysisTasks'
import { useAppInitialization } from './useAppInitialization'
import { getPublicDirectories, isPrivateDirectory } from '../utils/directories'


// 组合所有子 hook，编排 init 与跨 hook 操作
export function useAppController() {
  const appState = useAppState()
  const {
    settings,
    setCurrentDir,
    setLoading,
    setShowSettings,
    saveSettings,
    handleDirectoriesChange
  } = appState

  const scan = useScan({ setCurrentDir, setLoading })
  const initialization = useAppInitialization(appState, scan)

  const { favoriteKeys, handleToggleFavorite } = useFavorites({ settings, reconcileSettings: appState.reconcileSettings, setSettingsSaveError: appState.setSettingsSaveError })
  const customTags = settings?.customTags || {}
  const hiddenTags = settings?.hiddenTags || []

  const filter = useVideoFilter({ videos: scan.videos, customTags, favoriteKeys, hiddenTags })
  const tagEditor = useTagEditor({ settings, reconcileSettings: appState.reconcileSettings })
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
  const { handlePlayPath, handlePlayNetworkResource } = player
  const currentPlayerPathRef = useRef(null)
  currentPlayerPathRef.current = player.playingVideo?.fullPath
  const directoryPolicyRef = useRef(null)
  const directoryPolicyKey = JSON.stringify([settings?.directories, settings?.privateDirectories])
  useEffect(() => {
    if (!settings) return
    const changed = directoryPolicyRef.current !== null && directoryPolicyRef.current !== directoryPolicyKey
    directoryPolicyRef.current = directoryPolicyKey
    if (!changed) return
    const filePath = player.playingVideo?.fullPath
    if (filePath) {
      window.electronAPI.getFileUrl(filePath).catch(() => {
        if (currentPlayerPathRef.current === filePath) player.handleClosePlayer()
      })
    }
    if (appState.currentDir) {
      scan.resetGallery()
      scan.scanAndLoad(appState.currentDir)
    }
  }, [directoryPolicyKey, settings, appState.currentDir, player, scan])

  useEffect(() => window.electronAPI?.onPrivacyStateChanged?.(({ unlocked }) => {
    if (unlocked) return
    const privateDirectories = settings?.privateDirectories || []
    if (isPrivateDirectory(player.playingVideo?.fullPath, privateDirectories)) {
      player.handleClosePlayer()
    }
    if (isPrivateDirectory(appState.currentDir, privateDirectories)) {
      const directory = getPublicDirectories(settings?.directories, privateDirectories)[0]
      scan.cancelScan()
      scan.resetGallery()
      setCurrentDir(directory || null)
      if (directory) scan.scanAndLoad(directory)
    }
  }), [appState.currentDir, player, scan, settings, setCurrentDir])
  // 优先使用排除隐藏标签后的可见计数；扫描未完成时回退到扫描数量
  const totalCount = filter.visibleCount ?? scan.videos.length

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
        window.dispatchEvent(new CustomEvent(WINDOW_EVENTS.PRIVATE_DIRECTORY_PASSWORD_REQUIRED, { detail: payload }))
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
      return
    }
    scan.resetGallery()
    filter.setActiveCategory('all')
    await scan.scanAndLoad(dirPath)
  }, [appState, scan, filter, setCurrentDir])

  const handleCheckUpdate = useCallback(() => {
    window.dispatchEvent(new Event(WINDOW_EVENTS.CHECK_UPDATE))
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
      if (payload?.networkResource) {
        setShowSettings(false)
        handlePlayNetworkResource(payload.networkResource, { resume: true, queueVideos: null })
        return
      }
      const filePath = payload?.filePath
      if (!filePath) return
      setShowSettings(false)
      handlePlayPath(filePath, { resume: true, queueVideos: null })
    })

    return () => removeRemotePlay?.()
  }, [handlePlayNetworkResource, handlePlayPath, setShowSettings])

  return {
    ...appState,
    ...initialization,
    ...scan,
    ...filter,
    ...tagEditor,
    ...player,
    ...videoAnalysisTasks,
    totalCount,
    customTags,
    hiddenTags,
    favoriteKeys,
    handleToggleFavorite,
    handleOpenInFolder,
    handleSelectDirectory,
    handleAddDirectory,
    handleDirectoryChange,
    handleCheckUpdate
  }
}
