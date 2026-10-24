import { useEffect, useState, useCallback, useRef } from 'react'
import { SettingsClient } from '../services/settings-client'

// 应用级基础状态：settings / 当前目录 / loading / UI 开关 / 系统状态
export function useAppState() {
  const [settings, setSettingsValue] = useState(null)
  const [currentDir, setCurrentDir] = useState(null)
  const [loading, setLoading] = useState(true)
  const [showSettings, setShowSettings] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [ffmpegStatus, setFfmpegStatusValue] = useState(null)
  const [mpvStatus, setMpvStatusValue] = useState(null)
  const statusRevisions = useRef({ ffmpeg: 0, mpv: 0 })
  const getStatusRevision = useCallback(key => statusRevisions.current[key], [])
  const setFfmpegStatus = useCallback(value => { statusRevisions.current.ffmpeg++; setFfmpegStatusValue(value) }, [])
  const setMpvStatus = useCallback(value => { statusRevisions.current.mpv++; setMpvStatusValue(value) }, [])
  const [plugins, setPluginsValue] = useState([])
  const pluginValues = useRef([])
  const setPlugins = useCallback(value => {
    if (!Array.isArray(value)) return
    pluginValues.current = value; setPluginsValue(value)
  }, [])
  const [pluginsLoaded, setPluginsLoaded] = useState(false)
  const [settingsSaveError, setSettingsSaveError] = useState('')
  const pluginReadSequence = useRef(0)
  const clientRef = useRef(null)
  if (!clientRef.current) clientRef.current = new SettingsClient(window.electronAPI, setSettingsValue, setSettingsSaveError)
  // All callers deliver authoritative snapshots, not local React state patches.
  const setSettings = useCallback(snapshot => clientRef.current.receive(snapshot), [])
  const readSettings = useCallback(() => clientRef.current.read(), [])
  const saveSettings = useCallback(partial => clientRef.current.save(partial), [])
  const reconcileSettings = useCallback(result => clientRef.current.reconcileMutation(result), [])

  const theme = settings?.theme || 'dark'
  const playbackMode = settings?.playbackMode || 'order'

  useEffect(() => {
    const client = clientRef.current
    client.resume()
    const remove = client.incremental
      ? window.electronAPI.onSettingsPatched(event => client.receivePatch(event))
      : window.electronAPI?.onSettingsChanged?.(snapshot => client.receive(snapshot))
    return () => { remove?.(); client.dispose() }
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
    const client = clientRef.current, generation = client.generation, request = ++pluginReadSequence.current
    const nextPlugins = await window.electronAPI?.listPlugins?.()
    if (!client.current(generation)) return []
    if (request !== pluginReadSequence.current) return pluginValues.current
    if (Array.isArray(nextPlugins)) {
      setPlugins(nextPlugins)
      setPluginsLoaded(true)
      return nextPlugins
    }
    throw new Error('插件列表响应无效，请重新读取')
  }, [])

  return {
    settings,
    setSettings,
    readSettings,
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
    getStatusRevision,
    setFfmpegStatus,
    mpvStatus,
    setMpvStatus,
    theme,
    playbackMode,
    saveSettings,
    reconcileSettings,
    handleThemeChange,
    handleDirectoriesChange,
    handlePlaybackModeChange
  }
}
