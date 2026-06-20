import { useRef, useEffect, useCallback } from 'react'
import { useAppState } from './useAppState'
import { useScan } from './useScan'
import { useFavorites } from './useFavorites'
import { useVideoFilter } from './useVideoFilter'
import { useTagEditor } from './useTagEditor'
import { usePlayer } from './usePlayer'

// 组合所有子 hook，编排 init 与跨 hook 操作
export function useAppController() {
  const appState = useAppState()
  const {
    settings,
    setSettings,
    setCurrentDir,
    setLoading,
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
    playbackMode: appState.playbackMode
  })
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

      const dir = s.defaultDirectory || s.directories?.[0]
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

  const handleSelectDirectory = useCallback(async () => {
    const dir = await window.electronAPI.selectDirectory()
    if (!dir) return
    const currentDirectories = settings?.directories || []
    if (!currentDirectories.includes(dir)) {
      await handleDirectoriesChange({
        directories: [...currentDirectories, dir],
        defaultDirectory: dir
      })
    }
    scan.resetGallery()
    filter.setActiveCategory('all')
    await scan.scanAndLoad(dir, true)
  }, [settings, handleDirectoriesChange, scan, filter])

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

  return {
    ...appState,
    ...scan,
    ...filter,
    ...tagEditor,
    ...player,
    totalCount,
    customTags,
    favoriteKeys,
    handleToggleFavorite,
    handleOpenInFolder,
    handleSelectDirectory,
    handleDirectoryChange,
    handleCheckUpdate
  }
}
