import { useState, useCallback, useEffect, useRef } from 'react'
import { WINDOW_EVENTS } from '../api/events'
import { useApp } from '../context/AppContext'
import SettingsHeader from './settings/SettingsHeader'
import SettingsFooter from './settings/SettingsFooter'
import { AppearanceSection, PlaybackModeSection, WindowCloseSection } from './settings/BasicSettingsSections'
import PluginManagementPage from './settings/PluginManagementPage'
import {
  AboutSection,
  DownloadStatusSection,
  FfmpegStatusSection,
  MpvStatusSection,
  ShortcutsSection,
  UpdateSection
} from './settings/StatusSettingsSections'
import VideoAnalysisPluginSettings from './settings/VideoAnalysisPluginSettings'
import RemoteAccessSection from './settings/RemoteAccessSection'

const DEFAULT_ANALYSIS_RUNTIME_CONFIG = {
  mode: 'balance',
  maxDurationSeconds: 1800,
  modelStorageDir: '',
  llmProvider: 'local',
  llmBaseUrl: 'http://127.0.0.1:11434/v1',
  llmName: 'qwen2.5:14b',
  llmApiKey: 'local-placeholder',
  vlmBaseUrl: 'http://127.0.0.1:5803',
  vlmName: 'Huihui-Qwen3.5-9B-Claude-4.6-Opus-abliterated.Q4_K_M.gguf',
  vlmApiKey: 'local-placeholder',
  vlmProvider: 'local',
  vlmModelPath: '',
  vlmModelDownloadUrl: '',
  vlmHfRepo: '',
  vlmHfRevision: 'main',
  vlmHfToken: '',
  vlmServerExecutable: 'vendor\\llama.cpp-cuda\\llama-server.exe',
  vlmServerArgs: '-m "{modelPath}" --host 127.0.0.1 --port {port}',
  vlmConcurrency: 4
}

const LOCAL_TEXT_MODEL_DEFAULTS = {
  llmBaseUrl: DEFAULT_ANALYSIS_RUNTIME_CONFIG.llmBaseUrl,
  llmName: DEFAULT_ANALYSIS_RUNTIME_CONFIG.llmName,
  llmApiKey: DEFAULT_ANALYSIS_RUNTIME_CONFIG.llmApiKey
}

const SETTINGS_PAGES = [
  { id: 'basic', label: '基础设置', desc: '外观与播放' },
  { id: 'remote', label: '手机访问', desc: '局域网与设备' },
  { id: 'plugins', label: '插件管理', desc: '官方与第三方' },
  { id: 'system', label: '系统状态', desc: '依赖与关于' }
]

export default function Settings() {
  const {
    settings,
    plugins,
    setPlugins,
    pluginsLoaded,
    setPluginsLoaded,
    refreshPlugins,
    ffmpegStatus,
    mpvStatus,
    setMpvStatus,
    saveSettings,
    handleThemeChange,
    playbackMode,
    handlePlaybackModeChange,
    handleCheckUpdate,
    setShowSettings,
    availableTags
  } = useApp()

  const [theme, setTheme] = useState(settings?.theme || 'dark')
  const [downloading, setDownloading] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState(null)
  const [mpvDownloadError, setMpvDownloadError] = useState('')
  const [downloadState, setDownloadState] = useState(null)
  const [downloadStateLoading, setDownloadStateLoading] = useState(false)
  const [downloadStateMessage, setDownloadStateMessage] = useState('')
  const [appVersion, setAppVersion] = useState('')
  const [analysisOutputDir, setAnalysisOutputDir] = useState(settings?.videoAnalysis?.outputDir || '')
  const [analysisModelDir, setAnalysisModelDir] = useState(settings?.videoAnalysis?.modelDir || '')
  const [defaultAnalysisModelDir, setDefaultAnalysisModelDir] = useState('')
  const [analysisOutputMessage, setAnalysisOutputMessage] = useState('')
  const [analysisModelMessage, setAnalysisModelMessage] = useState('')
  const [analysisRuntimeConfig, setAnalysisRuntimeConfig] = useState(DEFAULT_ANALYSIS_RUNTIME_CONFIG)
  const [analysisRuntimeLoaded, setAnalysisRuntimeLoaded] = useState(false)
  const [analysisLlmProfiles, setAnalysisLlmProfiles] = useState({ local: LOCAL_TEXT_MODEL_DEFAULTS, api: { llmBaseUrl: '', llmName: '', llmApiKey: '' } })
  const [analysisConfigSaving, setAnalysisConfigSaving] = useState(false)
  const [analysisConfigMessage, setAnalysisConfigMessage] = useState('')
  const [vlmState, setVlmState] = useState(null)
  const [vlmSaving, setVlmSaving] = useState(false)
  const [vlmStarting, setVlmStarting] = useState(false)
  const [vlmMessage, setVlmMessage] = useState('')
  const [vlmModelOptions, setVlmModelOptions] = useState({ models: [], precisions: [], defaultModelId: '', defaultPrecision: 'Q4_K_M' })
  const [selectedVlmModelId, setSelectedVlmModelId] = useState('')
  const [selectedVlmPrecision, setSelectedVlmPrecision] = useState('Q4_K_M')
  const [localVlmFiles, setLocalVlmFiles] = useState([])
  const [localVlmLoading, setLocalVlmLoading] = useState(false)
  const [activePage, setActivePage] = useState('basic')
  const [activePluginId, setActivePluginId] = useState('video-analysis')
  const [pluginBusyId, setPluginBusyId] = useState('')
  const [pluginMessage, setPluginMessage] = useState('')
  const overlayRef = useRef(null)
  const panelRef = useRef(null)
  const restoreFocusRef = useRef(document.activeElement)
  const onClose = useCallback(() => {
    const activeElement = document.activeElement
    if (activeElement instanceof HTMLElement && overlayRef.current?.contains(activeElement)) {
      activeElement.blur()
    }
    setShowSettings(false)
  }, [setShowSettings])
  const windowCloseMode = settings?.windowClose?.mode || 'ask'
  const closeWithoutPrompt = windowCloseMode !== 'ask'
  const videoAnalysisPlugin = plugins.find(plugin => plugin.id === 'video-analysis')
  const videoAnalysisPluginEnabled = Boolean(pluginsLoaded && videoAnalysisPlugin?.enabled)

  useEffect(() => {
    const overlay = overlayRef.current
    const panel = panelRef.current
    if (!overlay || !panel) return undefined

    const siblings = Array.from(overlay.parentElement?.children || []).filter(node => node !== overlay)
    const previousInert = siblings.map(node => node.inert)
    siblings.forEach(node => { node.inert = true })

    const getFocusable = () => Array.from(panel.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    )).filter(node => !node.closest('[inert]'))

    getFocusable()[0]?.focus()
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = getFocusable()
      if (focusable.length === 0) {
        event.preventDefault()
        panel.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      siblings.forEach((node, index) => { node.inert = previousInert[index] })
      restoreFocusRef.current?.focus?.()
    }
  }, [onClose])

  useEffect(() => {
    setTheme(settings?.theme || 'dark')
    setAnalysisOutputDir(settings?.videoAnalysis?.outputDir || '')
    setAnalysisModelDir(settings?.videoAnalysis?.modelDir || '')
    setAnalysisLlmProfiles({
      local: {
        ...LOCAL_TEXT_MODEL_DEFAULTS,
        ...(settings?.videoAnalysis?.llmProfiles?.local || {})
      },
      api: {
        llmBaseUrl: '',
        llmName: '',
        llmApiKey: '',
        ...(settings?.videoAnalysis?.llmProfiles?.api || {})
      }
    })
  }, [settings])

  useEffect(() => {
    let mounted = true
    window.electronAPI.getAppVersion?.().then((version) => {
      if (mounted) setAppVersion(version || '')
    })
    window.electronAPI.downloadGetState?.({ start: false }).then((result) => {
      if (!mounted) return
      if (result?.success) {
        setDownloadState({ engine: result.engine, tasks: result.tasks || [] })
      } else if (result?.error) {
        setDownloadStateMessage(result.error)
      }
    })
    if (!videoAnalysisPluginEnabled) {
      setAnalysisRuntimeLoaded(false)
      return () => {
        mounted = false
      }
    }
    setAnalysisRuntimeLoaded(false)
    window.electronAPI.getVideoAnalysisOutputDir?.().then((dir) => {
      if (mounted && dir) setAnalysisOutputDir(dir)
    })
    window.electronAPI.getDefaultVideoAnalysisModelDir?.().then((dir) => {
      if (mounted && dir) setDefaultAnalysisModelDir(dir)
    })
    window.electronAPI.getVideoAnalysisModelDir?.().then((dir) => {
      if (mounted && dir) {
        setAnalysisModelDir(dir)
        setAnalysisRuntimeConfig(prev => ({
          ...prev,
          modelStorageDir: prev.modelStorageDir || dir
        }))
      }
    })
    window.electronAPI.getVideoAnalysisRuntimeConfig?.().then((result) => {
      if (mounted) setAnalysisRuntimeLoaded(true)
      if (mounted && result?.config) {
        setAnalysisRuntimeConfig({
          ...DEFAULT_ANALYSIS_RUNTIME_CONFIG,
          ...result.config
        })
        setAnalysisLlmProfiles(prev => ({
          ...prev,
          [result.config.llmProvider === 'api' ? 'api' : 'local']: {
            llmBaseUrl: result.config.llmBaseUrl || '',
            llmName: result.config.llmName || '',
            llmApiKey: result.config.llmApiKey || ''
          }
        }))
        if (result.config.unsupportedKeys?.length) {
          setAnalysisConfigMessage(`已忽略不支持的配置：${result.config.unsupportedKeys.join(', ')}`)
        }
      } else if (mounted && result?.error) {
        setAnalysisConfigMessage(result.error)
      }
    }).catch((error) => {
      if (!mounted) return
      setAnalysisRuntimeLoaded(true)
      setAnalysisConfigMessage(error?.message || '读取视频理解配置失败')
    })
    return () => {
      mounted = false
    }
  }, [videoAnalysisPluginEnabled])

  const refreshPluginList = useCallback(async () => {
    const nextPlugins = await refreshPlugins()
    setActivePluginId(prev => (
      nextPlugins.some(plugin => plugin.id === prev)
        ? prev
        : (nextPlugins.find(plugin => plugin.id === 'video-analysis')?.id || nextPlugins[0]?.id || 'video-analysis')
    ))
    return nextPlugins
  }, [refreshPlugins])

  useEffect(() => {
    let mounted = true
    window.electronAPI?.listPlugins?.().then((nextPlugins) => {
      if (!mounted || !Array.isArray(nextPlugins)) return
      setPlugins(nextPlugins)
      setPluginsLoaded(true)
      if (!nextPlugins.some(plugin => plugin.id === activePluginId)) {
        setActivePluginId(nextPlugins.find(plugin => plugin.id === 'video-analysis')?.id || nextPlugins[0]?.id || 'video-analysis')
      }
    })
    return () => {
      mounted = false
    }
  }, [activePluginId, setPlugins, setPluginsLoaded])

  useEffect(() => {
    if (!videoAnalysisPluginEnabled) return undefined
    let mounted = true
    window.electronAPI.getVideoAnalysisVlmModelOptions?.().then((result) => {
      if (!mounted || !result?.options) return
      setVlmModelOptions(result.options)
      setSelectedVlmModelId(prev => prev || result.options.defaultModelId || result.options.models?.[0]?.id || '')
      setSelectedVlmPrecision(prev => prev || result.options.defaultPrecision || 'Q4_K_M')
    })
    const refresh = () => {
      window.electronAPI.getVideoAnalysisVlmState?.().then((result) => {
        if (mounted && result?.state) setVlmState(result.state)
      })
    }
    refresh()
    const cleanup = window.electronAPI.onVideoAnalysisVlmEvent?.(() => refresh())
    const timer = setInterval(refresh, 3000)
    return () => {
      mounted = false
      cleanup?.()
      clearInterval(timer)
    }
  }, [videoAnalysisPluginEnabled])

  const handleChangeTheme = useCallback(async (nextTheme) => {
    setTheme(nextTheme)
    await handleThemeChange(nextTheme)
  }, [handleThemeChange])

  const handleWindowCloseModeChange = useCallback(async (mode) => {
    await saveSettings({
      windowClose: {
        ...(settings?.windowClose || {}),
        mode,
        rememberedAction: '',
        rememberedDate: ''
      }
    })
  }, [settings, saveSettings])

  const handleVideoAnalysisToggle = useCallback(async (enabled) => {
    await saveSettings({
      videoAnalysis: {
        ...(settings?.videoAnalysis || {}),
        enabled
      }
    })
  }, [settings, saveSettings])

  const handlePluginToggle = useCallback(async (pluginId, enabled) => {
    setPluginBusyId(pluginId)
    setPluginMessage('')
    try {
      const result = await window.electronAPI?.setPluginEnabled?.(pluginId, enabled)
      if (result?.success) {
        await refreshPluginList()
        setPluginMessage(enabled ? '插件已启用' : '插件已停用')
      } else {
        await refreshPluginList()
        setPluginMessage(result?.error || '插件状态更新失败')
      }
    } catch (err) {
      setPluginMessage(err?.message || '插件状态更新失败')
    } finally {
      setPluginBusyId('')
      setTimeout(() => setPluginMessage(''), 2400)
    }
  }, [refreshPluginList])

  const handleInstallPlugin = useCallback(async (sourceType = 'file') => {
    setPluginBusyId(sourceType === 'directory' ? 'install-directory' : 'install-file')
    setPluginMessage('')
    try {
      const result = await window.electronAPI?.installPlugin?.(sourceType)
      const nextPlugins = await refreshPluginList()
      if (result?.success) {
        setActivePluginId(result.plugin?.id || nextPlugins[0]?.id || 'video-analysis')
        setPluginMessage('插件已安装')
      } else if (!result?.canceled) {
        setPluginMessage(result?.error || '插件安装失败')
      }
    } catch (err) {
      setPluginMessage(err?.message || '插件安装失败')
    } finally {
      setPluginBusyId('')
      setTimeout(() => setPluginMessage(''), 2600)
    }
  }, [refreshPluginList])

  const handleUninstallPlugin = useCallback(async (pluginId) => {
    if (!pluginId) return
    const plugin = plugins.find(item => item.id === pluginId)
    if (!plugin?.uninstallable) return
    const confirmed = window.confirm(`卸载插件“${plugin.name || plugin.id}”？`)
    if (!confirmed) return
    setPluginBusyId(pluginId)
    setPluginMessage('')
    try {
      const result = await window.electronAPI?.uninstallPlugin?.(pluginId)
      const nextPlugins = await refreshPluginList()
      if (result?.success) {
        setActivePluginId(nextPlugins.find(item => item.id === 'video-analysis')?.id || nextPlugins[0]?.id || 'video-analysis')
        setPluginMessage('插件已卸载')
      } else {
        setPluginMessage(result?.error || '插件卸载失败')
      }
    } catch (err) {
      setPluginMessage(err?.message || '插件卸载失败')
    } finally {
      setPluginBusyId('')
      setTimeout(() => setPluginMessage(''), 2600)
    }
  }, [plugins, refreshPluginList])

  const handleOpenPluginsDirectory = useCallback(async () => {
    const result = await window.electronAPI?.openPluginsDirectory?.()
    setPluginMessage(result?.success ? '已打开插件目录' : (result?.error || '打开插件目录失败'))
    setTimeout(() => setPluginMessage(''), 2200)
  }, [])

  const handleSavePluginConfig = useCallback(async (pluginId, config) => {
    setPluginBusyId(pluginId)
    try {
      const result = await window.electronAPI?.savePluginConfig?.(pluginId, config)
      await refreshPluginList()
      if (!result?.success) {
        setPluginMessage(result?.error || '插件配置保存失败')
        setTimeout(() => setPluginMessage(''), 2200)
      }
    } catch (err) {
      setPluginMessage(err?.message || '插件配置保存失败')
      setTimeout(() => setPluginMessage(''), 2200)
    } finally {
      setPluginBusyId('')
    }
  }, [refreshPluginList])

  const handleSelectAnalysisOutputDir = useCallback(async () => {
    const dir = await window.electronAPI?.selectVideoAnalysisOutputDir?.()
    if (!dir) return
    setAnalysisOutputDir(dir)
    setAnalysisOutputMessage('保存目录已更新')
    setTimeout(() => setAnalysisOutputMessage(''), 1600)
  }, [])

  const handleOpenAnalysisOutputDir = useCallback(async () => {
    const result = await window.electronAPI?.openVideoAnalysisOutputDir?.()
    setAnalysisOutputMessage(result?.success ? '已打开保存目录' : (result?.error || '打开保存目录失败'))
    setTimeout(() => setAnalysisOutputMessage(''), 1600)
  }, [])

  const handleSelectAnalysisModelDir = useCallback(async () => {
    const dir = await window.electronAPI?.selectVideoAnalysisModelDir?.()
    if (!dir) return
    setAnalysisModelDir(dir)
    setAnalysisRuntimeConfig(prev => ({
      ...prev,
      modelStorageDir: dir
    }))
    const result = await window.electronAPI?.getVideoAnalysisRuntimeConfig?.()
    if (result?.config) {
      setAnalysisRuntimeConfig({
        ...DEFAULT_ANALYSIS_RUNTIME_CONFIG,
        ...result.config
      })
      setAnalysisModelMessage('模型目录已更新')
    } else {
      setAnalysisModelMessage(result?.error || '模型目录已更新')
    }
    setTimeout(() => setAnalysisModelMessage(''), 1600)
  }, [])

  const handleOpenAnalysisModelDir = useCallback(async () => {
    const result = await window.electronAPI?.openVideoAnalysisModelDir?.()
    setAnalysisModelMessage(result?.success ? '已打开模型目录' : (result?.error || '打开模型目录失败'))
    setTimeout(() => setAnalysisModelMessage(''), 1600)
  }, [])

  const handleAnalysisRuntimeChange = useCallback((key, value) => {
    setAnalysisRuntimeConfig(prev => ({
      ...prev,
      [key]: value
    }))
    if (['llmBaseUrl', 'llmName', 'llmApiKey'].includes(key)) {
      setAnalysisLlmProfiles(prev => {
        const provider = analysisRuntimeConfig.llmProvider === 'api' ? 'api' : 'local'
        return {
          ...prev,
          [provider]: {
            ...(prev[provider] || {}),
            [key]: value
          }
        }
      })
    }
  }, [analysisRuntimeConfig.llmProvider])

  const handleLlmProviderChange = useCallback((llmProvider) => {
    setAnalysisRuntimeConfig(prev => {
      const currentProvider = prev.llmProvider === 'api' ? 'api' : 'local'
      const nextProfiles = {
        ...analysisLlmProfiles,
        [currentProvider]: {
          llmBaseUrl: prev.llmBaseUrl || '',
          llmName: prev.llmName || '',
          llmApiKey: prev.llmApiKey || ''
        }
      }
      setAnalysisLlmProfiles(nextProfiles)
      return {
        ...prev,
        ...(nextProfiles[llmProvider] || (llmProvider === 'local' ? LOCAL_TEXT_MODEL_DEFAULTS : {})),
        llmProvider
      }
    })
  }, [analysisLlmProfiles])

  const handleVlmRuntimeChange = useCallback((key, value) => {
    setAnalysisRuntimeConfig(prev => ({
      ...prev,
      [key]: value
    }))
  }, [])

  const handleSelectedVlmModelChange = useCallback((modelId) => {
    setSelectedVlmModelId(modelId)
    const model = vlmModelOptions.models?.find(item => item.id === modelId)
    if (model?.precisions?.length && !model.precisions.includes(selectedVlmPrecision)) {
      setSelectedVlmPrecision(model.precisions.includes('Q4_K_M') ? 'Q4_K_M' : model.precisions[0])
    }
  }, [selectedVlmPrecision, vlmModelOptions.models])

  const handleSaveVlmConfig = useCallback(async (patch = {}, options = {}) => {
    if (!analysisRuntimeLoaded && !options.allowBeforeLoaded) {
      const error = '视频理解配置还在读取中，请稍后再试'
      if (!options.quiet) {
        setVlmMessage(error)
        setTimeout(() => setVlmMessage(''), 2200)
      }
      return { success: false, error }
    }
    const nextConfig = {
      vlmProvider: analysisRuntimeConfig.vlmProvider,
      vlmBaseUrl: analysisRuntimeConfig.vlmBaseUrl,
      vlmName: analysisRuntimeConfig.vlmName,
      vlmApiKey: analysisRuntimeConfig.vlmApiKey,
      vlmModelPath: analysisRuntimeConfig.vlmModelPath,
      vlmModelDownloadUrl: analysisRuntimeConfig.vlmModelDownloadUrl,
      vlmHfRepo: analysisRuntimeConfig.vlmHfRepo,
      vlmHfRevision: analysisRuntimeConfig.vlmHfRevision,
      vlmHfToken: analysisRuntimeConfig.vlmHfToken,
      vlmServerExecutable: analysisRuntimeConfig.vlmServerExecutable,
      vlmServerArgs: analysisRuntimeConfig.vlmServerArgs,
      ...patch
    }
    setVlmSaving(true)
    try {
      const result = await window.electronAPI?.saveVideoAnalysisVlmConfig?.(nextConfig)
      if (result?.success) {
        setAnalysisRuntimeConfig(prev => ({
          ...prev,
          ...result.config
        }))
        if (result.state) setVlmState(result.state)
        if (!options.quiet) setVlmMessage('视觉模型配置已保存')
      } else {
        setVlmMessage(result?.error || '保存视觉模型配置失败')
      }
      if (!options.quiet || !result?.success) {
        setTimeout(() => setVlmMessage(''), 2200)
      }
      return result
    } catch (err) {
      const error = err?.message || '保存视觉模型配置失败'
      setVlmMessage(error)
      setTimeout(() => setVlmMessage(''), 2600)
      return { success: false, error }
    } finally {
      setVlmSaving(false)
    }
  }, [analysisRuntimeConfig, analysisRuntimeLoaded])

  const handleDownloadVlmModel = useCallback(async () => {
    const saved = await handleSaveVlmConfig({
      vlmProvider: 'local',
      modelStorageDir: analysisRuntimeConfig.modelStorageDir || analysisModelDir
    })
    if (!saved?.success) return
    setVlmMessage('开始下载视觉模型')
    try {
      const result = await window.electronAPI?.downloadVideoAnalysisVlmModel?.({
        modelId: selectedVlmModelId,
        precision: selectedVlmPrecision
      })
      if (result?.state) setVlmState(result.state)
      if (result?.config) {
        setAnalysisRuntimeConfig(prev => ({
          ...prev,
          ...result.config
        }))
      } else {
        const runtime = await window.electronAPI?.getVideoAnalysisRuntimeConfig?.()
        if (runtime?.config) {
          setAnalysisRuntimeConfig(prev => ({
            ...prev,
            ...runtime.config
          }))
        }
      }
      setVlmMessage(result?.success ? '视觉模型下载完成' : (result?.error || '视觉模型下载失败'))
    } catch (err) {
      setVlmMessage(err?.message || '视觉模型下载失败')
    }
    setTimeout(() => setVlmMessage(''), 2600)
  }, [analysisModelDir, analysisRuntimeConfig.modelStorageDir, handleSaveVlmConfig, selectedVlmModelId, selectedVlmPrecision])

  const handleStartVlmService = useCallback(async () => {
    if (vlmStarting) return
    if (!analysisRuntimeLoaded) {
      setVlmMessage('视频理解配置还在读取中，请稍后再试')
      setTimeout(() => setVlmMessage(''), 2200)
      return
    }
    setVlmStarting(true)
    setVlmMessage('正在启动 VLM 服务，模型加载可能需要一两分钟...')
    try {
      const saved = await handleSaveVlmConfig({}, { quiet: true })
      if (!saved?.success) return
      setVlmMessage('正在等待 VLM 服务就绪...')
      const result = await window.electronAPI?.startVideoAnalysisVlmService?.()
      if (result?.state) setVlmState(result.state)
      setVlmMessage(result?.success ? 'VLM 服务已启动并连接' : (result?.error || 'VLM 服务启动失败'))
    } catch (err) {
      setVlmMessage(err?.message || 'VLM 服务启动失败')
    } finally {
      setVlmStarting(false)
      setTimeout(() => setVlmMessage(''), 5000)
    }
  }, [analysisRuntimeLoaded, handleSaveVlmConfig, vlmStarting])

  const handleStopVlmService = useCallback(async () => {
    try {
      const result = await window.electronAPI?.stopVideoAnalysisVlmService?.()
      if (result?.state) setVlmState(result.state)
      setVlmMessage(result?.success ? 'VLM 服务已停止' : (result?.error || 'VLM 服务停止失败'))
    } catch (err) {
      setVlmMessage(err?.message || 'VLM 服务停止失败')
    }
    setTimeout(() => setVlmMessage(''), 2200)
  }, [])

  const handleRefreshVlmState = useCallback(async () => {
    try {
      const result = await window.electronAPI?.getVideoAnalysisVlmState?.()
      if (result?.state) {
        setVlmState(result.state)
        setVlmMessage(result.state.connected ? 'VLM 连接可用' : 'VLM 暂未连接')
      } else {
        setVlmMessage(result?.error || '检测 VLM 状态失败')
      }
    } catch (err) {
      setVlmMessage(err?.message || '检测 VLM 状态失败')
    }
    setTimeout(() => setVlmMessage(''), 2200)
  }, [])

  const handleSelectVlmModelFile = useCallback(async () => {
    const result = await window.electronAPI?.selectVideoAnalysisVlmModelFile?.()
    if (!result) return
    if (result.success) {
      setAnalysisRuntimeConfig(prev => ({
        ...prev,
        ...result.config
      }))
      if (result.state) setVlmState(result.state)
      setVlmMessage('已选择 VLM 模型文件')
    } else {
      setVlmMessage(result.error || '选择 VLM 模型文件失败')
    }
    setTimeout(() => setVlmMessage(''), 2200)
  }, [])

  const handleListLocalVlmFiles = useCallback(async () => {
    setLocalVlmLoading(true)
    const result = await window.electronAPI?.listVideoAnalysisLocalVlmFiles?.()
    setLocalVlmLoading(false)
    if (result?.success) {
      setLocalVlmFiles(result.files || [])
      if (result.state) setVlmState(result.state)
      setVlmMessage(result.files?.length ? `检测到 ${result.files.length} 个本地模型` : '当前模型目录没有检测到 VLM 模型')
    } else {
      setLocalVlmFiles([])
      setVlmMessage(result?.error || '检测本地模型失败')
    }
    setTimeout(() => setVlmMessage(''), 2600)
  }, [])

  const handleSelectLocalVlmFile = useCallback(async (filePath) => {
    const result = await window.electronAPI?.selectVideoAnalysisLocalVlmFile?.(filePath)
    if (result?.success) {
      setAnalysisRuntimeConfig(prev => ({
        ...prev,
        ...result.config
      }))
      if (result.state) setVlmState(result.state)
      setVlmMessage('已使用本地 VLM 模型')
    } else {
      setVlmMessage(result?.error || '使用本地模型失败')
    }
    setTimeout(() => setVlmMessage(''), 2200)
  }, [])

  const handleSelectVlmServerExecutable = useCallback(async () => {
    const result = await window.electronAPI?.selectVideoAnalysisVlmServerExecutable?.()
    if (!result) return
    if (result.success) {
      setAnalysisRuntimeConfig(prev => ({
        ...prev,
        ...result.config
      }))
      if (result.state) setVlmState(result.state)
      setVlmMessage('已选择 VLM 服务程序')
    } else {
      setVlmMessage(result.error || '选择 VLM 服务程序失败')
    }
    setTimeout(() => setVlmMessage(''), 2200)
  }, [])

  const handleSaveAnalysisRuntimeConfig = useCallback(async () => {
    setAnalysisConfigSaving(true)
    const result = await window.electronAPI?.saveVideoAnalysisRuntimeConfig?.({
      ...analysisRuntimeConfig,
      modelStorageDir: analysisRuntimeConfig.modelStorageDir || analysisModelDir
    })
    setAnalysisConfigSaving(false)
    if (result?.success) {
      setAnalysisRuntimeConfig({
        ...DEFAULT_ANALYSIS_RUNTIME_CONFIG,
        ...result.config
      })
      setAnalysisLlmProfiles(prev => ({
        ...prev,
        [result.config.llmProvider === 'api' ? 'api' : 'local']: {
          llmBaseUrl: result.config.llmBaseUrl || '',
          llmName: result.config.llmName || '',
          llmApiKey: result.config.llmApiKey || ''
        }
      }))
      setAnalysisConfigMessage('分析参数已保存')
    } else {
      setAnalysisConfigMessage(result?.error || '保存分析参数失败')
    }
    setTimeout(() => setAnalysisConfigMessage(''), 2200)
  }, [analysisRuntimeConfig, analysisModelDir])

  const handleResetAnalysisRuntimeConfig = useCallback(async () => {
    setAnalysisConfigSaving(true)
    const result = await window.electronAPI?.resetVideoAnalysisRuntimeConfig?.()
    setAnalysisConfigSaving(false)
    if (result?.success) {
      setAnalysisRuntimeConfig({
        ...DEFAULT_ANALYSIS_RUNTIME_CONFIG,
        ...result.config
      })
      if (result.config?.modelStorageDir) setAnalysisModelDir(result.config.modelStorageDir)
      setAnalysisConfigMessage('已恢复本地默认参数')
    } else {
      setAnalysisConfigMessage(result?.error || '恢复默认参数失败')
    }
    setTimeout(() => setAnalysisConfigMessage(''), 2200)
  }, [])

  const handleDownloadMpv = useCallback(async () => {
    setDownloading(true)
    setDownloadProgress(null)
    setMpvDownloadError('')

    const removeListener = window.electronAPI.onMpvDownloadProgress((progress) => {
      setDownloadProgress(progress)
    })

    const result = await window.electronAPI.downloadMpv()
    removeListener?.()
    setDownloading(false)

    if (result.success) {
      const status = await window.electronAPI.checkMpv()
      setMpvStatus(status)
    } else {
      setMpvDownloadError(result.error || '未知错误')
    }
  }, [setMpvStatus])

  const handleSelectMpvPath = useCallback(async () => {
    const mpvPath = await window.electronAPI.selectMpvPath()
    if (mpvPath) {
      await saveSettings({ mpvPath })
      const status = await window.electronAPI.checkMpv()
      setMpvStatus(status)
    }
  }, [saveSettings, setMpvStatus])

  const handleRefreshDownloadState = useCallback(async () => {
    setDownloadStateLoading(true)
    setDownloadStateMessage('')
    try {
      const result = await window.electronAPI.downloadGetState?.({ start: true, refresh: true })
      if (result?.success) {
        setDownloadState({ engine: result.engine, tasks: result.tasks || [] })
        setDownloadStateMessage('下载引擎状态已刷新')
      } else {
        setDownloadStateMessage(result?.error || '读取下载中心状态失败')
      }
    } catch (err) {
      setDownloadStateMessage(err?.message || '读取下载中心状态失败')
    } finally {
      setDownloadStateLoading(false)
      setTimeout(() => setDownloadStateMessage(''), 2200)
    }
  }, [])

  const handleOpenDownloadCenter = useCallback(() => {
    window.dispatchEvent(new CustomEvent(WINDOW_EVENTS.OPEN_DOWNLOAD_CENTER, {
      detail: { type: 'open' }
    }))
    onClose()
  }, [onClose])

  const videoAnalysisEnabled = Boolean(settings?.videoAnalysis?.enabled)
  const videoAnalysisSettings = (
    <VideoAnalysisPluginSettings
      enabled={videoAnalysisEnabled}
      pluginEnabled={videoAnalysisPluginEnabled}
      analysisOutputDir={analysisOutputDir}
      analysisModelDir={analysisModelDir}
      defaultAnalysisModelDir={defaultAnalysisModelDir}
      analysisOutputMessage={analysisOutputMessage}
      analysisModelMessage={analysisModelMessage}
      analysisRuntimeConfig={analysisRuntimeConfig}
      analysisRuntimeLoaded={analysisRuntimeLoaded}
      analysisConfigSaving={analysisConfigSaving}
      analysisConfigMessage={analysisConfigMessage}
      vlmState={vlmState}
      vlmSaving={vlmSaving}
      vlmStarting={vlmStarting}
      vlmMessage={vlmMessage}
      vlmModelOptions={vlmModelOptions}
      selectedVlmModelId={selectedVlmModelId}
      selectedVlmPrecision={selectedVlmPrecision}
      localVlmFiles={localVlmFiles}
      localVlmLoading={localVlmLoading}
      onToggle={handleVideoAnalysisToggle}
      onSelectAnalysisOutputDir={handleSelectAnalysisOutputDir}
      onOpenAnalysisOutputDir={handleOpenAnalysisOutputDir}
      onSelectAnalysisModelDir={handleSelectAnalysisModelDir}
      onOpenAnalysisModelDir={handleOpenAnalysisModelDir}
      onVlmRuntimeChange={handleVlmRuntimeChange}
      onSelectedVlmModelChange={handleSelectedVlmModelChange}
      onSelectedVlmPrecisionChange={setSelectedVlmPrecision}
      onSaveVlmConfig={handleSaveVlmConfig}
      onDownloadVlmModel={handleDownloadVlmModel}
      onStartVlmService={handleStartVlmService}
      onStopVlmService={handleStopVlmService}
      onRefreshVlmState={handleRefreshVlmState}
      onSelectVlmModelFile={handleSelectVlmModelFile}
      onListLocalVlmFiles={handleListLocalVlmFiles}
      onSelectLocalVlmFile={handleSelectLocalVlmFile}
      onSelectVlmServerExecutable={handleSelectVlmServerExecutable}
      onAnalysisRuntimeChange={handleAnalysisRuntimeChange}
      onLlmProviderChange={handleLlmProviderChange}
      onSaveAnalysisRuntimeConfig={handleSaveAnalysisRuntimeConfig}
      onResetAnalysisRuntimeConfig={handleResetAnalysisRuntimeConfig}
    />
  )

  return (
    <div ref={overlayRef} className="settings-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panelRef}
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        tabIndex={-1}
      >
        <SettingsHeader onClose={onClose} />

        <div className="settings-body settings-layout">
          <aside className="settings-sidebar" aria-label="设置分页">
            {SETTINGS_PAGES.map((page) => (
              <button
                key={page.id}
                className={`settings-nav-item${activePage === page.id ? ' active' : ''}`}
                type="button"
                onClick={() => setActivePage(page.id)}
              >
                <span>{page.label}</span>
                <small>{page.desc}</small>
              </button>
            ))}
          </aside>

          <div className="settings-page">
            {activePage === 'basic' ? (
              <>
                <AppearanceSection theme={theme} onThemeChange={handleChangeTheme} />
                <PlaybackModeSection playbackMode={playbackMode} onPlaybackModeChange={handlePlaybackModeChange} />
                <WindowCloseSection
                  windowCloseMode={windowCloseMode}
                  closeWithoutPrompt={closeWithoutPrompt}
                  onModeChange={handleWindowCloseModeChange}
                />
              </>
            ) : null}

            {activePage === 'remote' ? (
              <RemoteAccessSection settings={settings} saveSettings={saveSettings} />
            ) : null}

            {activePage === 'plugins' ? (
              <PluginManagementPage
                plugins={plugins}
                activePluginId={activePluginId}
                onSelectPlugin={setActivePluginId}
                onTogglePlugin={handlePluginToggle}
                onInstallPluginFile={() => handleInstallPlugin('file')}
                onInstallPluginDirectory={() => handleInstallPlugin('directory')}
                onUninstallPlugin={handleUninstallPlugin}
                onOpenPluginsDirectory={handleOpenPluginsDirectory}
                onSavePluginConfig={handleSavePluginConfig}
                busyPluginId={pluginBusyId}
                message={pluginMessage}
                availableTags={availableTags}
                videoAnalysisSettings={videoAnalysisSettings}
              />
            ) : null}

            {activePage === 'system' ? (
              <>
                <UpdateSection onCheckUpdate={handleCheckUpdate} />
                <DownloadStatusSection
                  downloadState={downloadState}
                  downloadLoading={downloadStateLoading}
                  downloadMessage={downloadStateMessage}
                  onRefreshDownloadState={handleRefreshDownloadState}
                  onOpenDownloadCenter={handleOpenDownloadCenter}
                />
                <MpvStatusSection
                  mpvStatus={mpvStatus}
                  downloading={downloading}
                  downloadProgress={downloadProgress}
                  mpvDownloadError={mpvDownloadError}
                  onDownloadMpv={handleDownloadMpv}
                  onSelectMpvPath={handleSelectMpvPath}
                />
                <FfmpegStatusSection ffmpegStatus={ffmpegStatus} />
                <AboutSection />
                <ShortcutsSection />
              </>
            ) : null}
          </div>
        </div>

        <SettingsFooter appVersion={appVersion} onClose={onClose} />
      </div>
    </div>
  )
}
