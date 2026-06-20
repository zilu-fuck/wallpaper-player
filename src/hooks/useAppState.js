import { useState, useCallback } from 'react'

// 应用级基础状态：settings / 当前目录 / loading / UI 开关 / 系统状态
export function useAppState() {
  const [settings, setSettings] = useState(null)
  const [currentDir, setCurrentDir] = useState(null)
  const [loading, setLoading] = useState(true)
  const [showSettings, setShowSettings] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [ffmpegStatus, setFfmpegStatus] = useState(null)
  const [mpvStatus, setMpvStatus] = useState(null)

  const theme = settings?.theme || 'dark'
  const playbackMode = settings?.playbackMode || 'order'

  // 合并写入并持久化设置（乐观更新）
  const saveSettings = useCallback(async (partial) => {
    let merged
    setSettings(prev => {
      merged = { ...prev, ...partial }
      return merged
    })
    await window.electronAPI.saveSettings(merged)
    return merged
  }, [])

  const handleThemeChange = useCallback(async (nextTheme) => {
    return saveSettings({ theme: nextTheme })
  }, [saveSettings])

  const handleDirectoriesChange = useCallback(async ({ directories, defaultDirectory }) => {
    return saveSettings({ directories, defaultDirectory })
  }, [saveSettings])

  const handlePlaybackModeChange = useCallback(async (nextMode) => {
    return saveSettings({ playbackMode: nextMode })
  }, [saveSettings])

  return {
    settings,
    setSettings,
    currentDir,
    setCurrentDir,
    loading,
    setLoading,
    showSettings,
    setShowSettings,
    sidebarCollapsed,
    setSidebarCollapsed,
    ffmpegStatus,
    setFfmpegStatus,
    mpvStatus,
    setMpvStatus,
    theme,
    playbackMode,
    saveSettings,
    handleThemeChange,
    handleDirectoriesChange,
    handlePlaybackModeChange
  }
}
