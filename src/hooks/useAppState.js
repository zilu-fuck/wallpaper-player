import { useEffect, useState, useCallback, useRef } from 'react'

// 应用级基础状态：settings / 当前目录 / loading / UI 开关 / 系统状态
export function useAppState() {
  const [settings, setSettings] = useState(null)
  const [currentDir, setCurrentDir] = useState(null)
  const [loading, setLoading] = useState(true)
  const [showSettings, setShowSettings] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [ffmpegStatus, setFfmpegStatus] = useState(null)
  const [mpvStatus, setMpvStatus] = useState(null)
  const [plugins, setPlugins] = useState([])
  const [pluginsLoaded, setPluginsLoaded] = useState(false)
  const [settingsSaveError, setSettingsSaveError] = useState('')
  const settingsSaveSequenceRef = useRef(0)

  const theme = settings?.theme || 'dark'
  const playbackMode = settings?.playbackMode || 'order'

  useEffect(() => {
    return window.electronAPI?.onSettingsChanged?.((nextSettings) => {
      if (nextSettings && typeof nextSettings === 'object') {
        setSettings(nextSettings)
      }
    })
  }, [])

  // 合并写入并持久化设置（乐观更新）
  const saveSettings = useCallback(async (partial) => {
    const requestId = settingsSaveSequenceRef.current + 1
    settingsSaveSequenceRef.current = requestId
    let previous
    let merged
    setSettings(prev => {
      previous = prev
      merged = { ...prev, ...partial }
      return merged
    })
    setSettingsSaveError('')
    try {
      const result = await window.electronAPI.saveSettings(partial)
      if (result?.settings) {
        setSettings(result.settings)
        return result.settings
      }
      return merged
    } catch (error) {
      if (settingsSaveSequenceRef.current === requestId) {
        setSettings(previous)
      }
      setSettingsSaveError(error?.message || '设置保存失败')
      throw error
    }
  }, [])

  const handleThemeChange = useCallback(async (nextTheme) => {
    return saveSettings({ theme: nextTheme })
  }, [saveSettings])

  const handleDirectoriesChange = useCallback(async ({ directories, privateDirectories, defaultDirectory }) => {
    const patch = { directories, defaultDirectory }
    if (Array.isArray(privateDirectories)) {
      patch.privateDirectories = privateDirectories
    }
    return saveSettings(patch)
  }, [saveSettings])

  const handlePlaybackModeChange = useCallback(async (nextMode) => {
    return saveSettings({ playbackMode: nextMode })
  }, [saveSettings])

  const refreshPlugins = useCallback(async () => {
    const nextPlugins = await window.electronAPI?.listPlugins?.()
    if (Array.isArray(nextPlugins)) {
      setPlugins(nextPlugins)
      setPluginsLoaded(true)
      return nextPlugins
    }
    return []
  }, [])

  return {
    settings,
    setSettings,
    plugins,
    setPlugins,
    pluginsLoaded,
    setPluginsLoaded,
    settingsSaveError,
    setSettingsSaveError,
    refreshPlugins,
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
