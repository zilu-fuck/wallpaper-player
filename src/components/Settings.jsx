import { useState, useCallback, useEffect } from 'react'
import { useApp } from '../context/AppContext'

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

function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '大小未知'
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${Math.round(value / 1024)} KB`
}

export default function Settings() {
  const {
    settings,
    ffmpegStatus,
    mpvStatus,
    setMpvStatus,
    saveSettings,
    handleThemeChange,
    playbackMode,
    handlePlaybackModeChange,
    handleCheckUpdate,
    setShowSettings
  } = useApp()

  const [theme, setTheme] = useState(settings?.theme || 'dark')
  const [saving, setSaving] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState(null)
  const [mpvDownloadError, setMpvDownloadError] = useState('')
  const [remoteState, setRemoteState] = useState(null)
  const [remoteSaving, setRemoteSaving] = useState(false)
  const [remotePort, setRemotePort] = useState(String(settings?.remoteAccess?.port || 38127))
  const [remoteCopied, setRemoteCopied] = useState('')
  const [pairingCode, setPairingCode] = useState(null)
  const [pairingLoading, setPairingLoading] = useState(false)
  const [pairingError, setPairingError] = useState('')
  const [pairingTick, setPairingTick] = useState(Date.now())
  const [appVersion, setAppVersion] = useState('')
  const [analysisOutputDir, setAnalysisOutputDir] = useState(settings?.videoAnalysis?.outputDir || '')
  const [analysisModelDir, setAnalysisModelDir] = useState(settings?.videoAnalysis?.modelDir || '')
  const [defaultAnalysisModelDir, setDefaultAnalysisModelDir] = useState('')
  const [analysisOutputMessage, setAnalysisOutputMessage] = useState('')
  const [analysisModelMessage, setAnalysisModelMessage] = useState('')
  const [analysisRuntimeConfig, setAnalysisRuntimeConfig] = useState(DEFAULT_ANALYSIS_RUNTIME_CONFIG)
  const [analysisLlmProfiles, setAnalysisLlmProfiles] = useState({ local: LOCAL_TEXT_MODEL_DEFAULTS, api: { llmBaseUrl: '', llmName: '', llmApiKey: '' } })
  const [analysisConfigSaving, setAnalysisConfigSaving] = useState(false)
  const [analysisConfigMessage, setAnalysisConfigMessage] = useState('')
  const [vlmState, setVlmState] = useState(null)
  const [vlmSaving, setVlmSaving] = useState(false)
  const [vlmMessage, setVlmMessage] = useState('')
  const [vlmModelOptions, setVlmModelOptions] = useState({ models: [], precisions: [], defaultModelId: '', defaultPrecision: 'Q4_K_M' })
  const [selectedVlmModelId, setSelectedVlmModelId] = useState('')
  const [selectedVlmPrecision, setSelectedVlmPrecision] = useState('Q4_K_M')
  const [localVlmFiles, setLocalVlmFiles] = useState([])
  const [localVlmLoading, setLocalVlmLoading] = useState(false)
  const onClose = useCallback(() => setShowSettings(false), [setShowSettings])
  const windowCloseMode = settings?.windowClose?.mode || 'ask'
  const closeWithoutPrompt = windowCloseMode !== 'ask'

  useEffect(() => {
    setTheme(settings?.theme || 'dark')
    setRemotePort(String(settings?.remoteAccess?.port || 38127))
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
    })
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
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
  }, [])

  useEffect(() => {
    let mounted = true
    window.electronAPI.remoteGetState?.().then((state) => {
      if (mounted) setRemoteState(state)
    })
    const cleanup = window.electronAPI.onRemoteAccessState?.((state) => {
      setRemoteState(state)
      setRemotePort(String(state?.settings?.port || 38127))
    })
    return () => {
      mounted = false
      cleanup?.()
    }
  }, [])

  useEffect(() => {
    if (!pairingCode) return undefined
    const timer = setInterval(() => {
      setPairingTick(Date.now())
      window.electronAPI.remoteGetState?.().then(setRemoteState)
    }, 1000)
    return () => clearInterval(timer)
  }, [pairingCode])

  const handleChangeTheme = useCallback(async (nextTheme) => {
    setTheme(nextTheme)
    await handleThemeChange(nextTheme)
  }, [handleThemeChange])

  const handleSave = useCallback(async () => {
    setSaving(true)
    await saveSettings({ theme })
    setSaving(false)
    onClose()
  }, [theme, saveSettings, onClose])

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

  const handleSaveVlmConfig = useCallback(async (patch = {}) => {
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
    const result = await window.electronAPI?.saveVideoAnalysisVlmConfig?.(nextConfig)
    setVlmSaving(false)
    if (result?.success) {
      setAnalysisRuntimeConfig(prev => ({
        ...prev,
        ...result.config
      }))
      if (result.state) setVlmState(result.state)
      setVlmMessage('视觉模型配置已保存')
    } else {
      setVlmMessage(result?.error || '保存视觉模型配置失败')
    }
    setTimeout(() => setVlmMessage(''), 2200)
    return result
  }, [analysisRuntimeConfig])

  const handleDownloadVlmModel = useCallback(async () => {
    const saved = await handleSaveVlmConfig({
      vlmProvider: 'local',
      modelStorageDir: analysisRuntimeConfig.modelStorageDir || analysisModelDir
    })
    if (!saved?.success) return
    setVlmMessage('开始下载视觉模型')
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
    setTimeout(() => setVlmMessage(''), 2600)
  }, [analysisModelDir, analysisRuntimeConfig.modelStorageDir, handleSaveVlmConfig, selectedVlmModelId, selectedVlmPrecision])

  const handleStartVlmService = useCallback(async () => {
    const saved = await handleSaveVlmConfig()
    if (!saved?.success) return
    const result = await window.electronAPI?.startVideoAnalysisVlmService?.()
    if (result?.state) setVlmState(result.state)
    setVlmMessage(result?.success ? 'VLM 服务已启动并连接' : (result?.error || 'VLM 服务启动失败'))
    setTimeout(() => setVlmMessage(''), 2600)
  }, [handleSaveVlmConfig])

  const handleStopVlmService = useCallback(async () => {
    const result = await window.electronAPI?.stopVideoAnalysisVlmService?.()
    if (result?.state) setVlmState(result.state)
    setVlmMessage(result?.success ? 'VLM 服务已停止' : (result?.error || 'VLM 服务停止失败'))
    setTimeout(() => setVlmMessage(''), 2200)
  }, [])

  const handleRefreshVlmState = useCallback(async () => {
    const result = await window.electronAPI?.getVideoAnalysisVlmState?.()
    if (result?.state) {
      setVlmState(result.state)
      setVlmMessage(result.state.connected ? 'VLM 连接可用' : 'VLM 暂未连接')
    } else {
      setVlmMessage(result?.error || '检测 VLM 状态失败')
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

  const handleRemoteSave = useCallback(async (patch = {}) => {
    const current = remoteState?.settings || settings?.remoteAccess || {}
    const port = Number(remotePort)
    const next = {
      enabled: Boolean(current.enabled),
      keepRunningInTray: current.keepRunningInTray == null ? true : Boolean(current.keepRunningInTray),
      port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 38127,
      ...patch
    }

    setRemoteSaving(true)
    const state = await window.electronAPI.remoteSaveSettings(next)
    setRemoteState(state)
    await saveSettings({ remoteAccess: state.settings })
    setRemoteSaving(false)
  }, [remoteState, settings, remotePort, saveSettings])

  const handleCopyEndpoint = useCallback(async () => {
    const result = await window.electronAPI.remoteCopyEndpoint()
    setRemoteCopied(result?.text ? '地址已复制' : '已复制')
    setTimeout(() => setRemoteCopied(''), 1600)
  }, [])

  const handleCopyToken = useCallback(async () => {
    try {
      await window.electronAPI.remoteCopyToken()
      setRemoteCopied('Token 已复制')
    } catch (err) {
      setRemoteCopied(err?.message || '请先开启兼容模式')
    }
    setTimeout(() => setRemoteCopied(''), 1600)
  }, [])

  const handleRotateToken = useCallback(async () => {
    const state = await window.electronAPI.remoteRotateToken()
    setRemoteState(state)
    setRemoteCopied('Token 已更新')
    setTimeout(() => setRemoteCopied(''), 1600)
  }, [])

  const handleCreatePairingCode = useCallback(async () => {
    setPairingLoading(true)
    setPairingError('')
    try {
      const result = await window.electronAPI.remoteCreatePairingCode()
      setPairingCode(result)
      setPairingTick(Date.now())
    } catch (err) {
      setPairingError(err?.message || '生成二维码失败')
    } finally {
      setPairingLoading(false)
    }
  }, [])

  const handleCopyPairingCode = useCallback(async () => {
    if (!pairingCode?.pairingCode) return
    await window.electronAPI.remoteCopyPairingCode(pairingCode.pairingCode)
    setRemoteCopied('绑定码已复制')
    setTimeout(() => setRemoteCopied(''), 1600)
  }, [pairingCode])

  const handleRemovePairedDevice = useCallback(async (deviceId) => {
    const result = await window.electronAPI.remoteRemovePairedDevice(deviceId)
    if (result?.state) setRemoteState(result.state)
  }, [])

  const handleApprovePairingRequest = useCallback(async (requestId) => {
    const result = await window.electronAPI.remoteApprovePairingRequest(requestId)
    if (result?.state) setRemoteState(result.state)
  }, [])

  const handleRejectPairingRequest = useCallback(async (requestId) => {
    const result = await window.electronAPI.remoteRejectPairingRequest(requestId)
    if (result?.state) setRemoteState(result.state)
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

  const pairingExpiresIn = pairingCode?.expiresAt
    ? Math.max(0, Math.ceil((pairingCode.expiresAt - pairingTick) / 1000))
    : 0
  const pairedDevices = remoteState?.pairedDevices || []
  const pendingPairingRequests = remoteState?.pendingPairingRequests || []
  const videoAnalysisEnabled = Boolean(settings?.videoAnalysis?.enabled)
  const currentVlmModelOption = vlmModelOptions.models?.find(item => item.id === selectedVlmModelId)
  const availableVlmPrecisions = currentVlmModelOption?.precisions?.length
    ? currentVlmModelOption.precisions
    : (vlmModelOptions.precisions || []).map(item => item.id)
  const visibleVlmPrecisions = (vlmModelOptions.precisions || [])
    .filter(item => availableVlmPrecisions.includes(item.id))
  const vlmDownloadProgress = vlmState?.download
  const vlmDownloadPercent = Math.max(0, Math.min(100, Number(vlmDownloadProgress?.percent) || 0))
  const vlmDownloadInfo = vlmDownloadProgress
    ? `${vlmDownloadPercent}% · ${formatBytes(vlmDownloadProgress.transferred)} / ${formatBytes(vlmDownloadProgress.total)}`
    : ''
  const vlmProviderIsApi = analysisRuntimeConfig.vlmProvider === 'api'
  const vlmStatusText = vlmState?.connected ? '已连接' : (vlmState?.running ? '服务运行中' : '未连接')
  const vlmModelFileName = analysisRuntimeConfig.vlmModelPath
    ? analysisRuntimeConfig.vlmModelPath.split(/[\\/]/).filter(Boolean).pop()
    : analysisRuntimeConfig.vlmName
  const vlmModelDirectory = `${analysisModelDir || defaultAnalysisModelDir || '当前模型目录'}\\vlm`
  const vlmModelStateText = vlmProviderIsApi
    ? '外接 API'
    : (vlmState?.downloading ? '下载中' : (vlmState?.modelExists ? '已找到' : '未找到'))

  return (
    <div className="settings-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings-panel">
        {/* 标题栏 */}
        <div className="settings-header">
          <h2>设置</h2>
          <button className="btn btn-icon" onClick={onClose} title="关闭">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="settings-body">
          <section className="settings-section">
            <h3 className="section-title">外观</h3>
            <p className="section-desc">切换深色或亮色主题。</p>
            <div className="theme-toggle" role="group" aria-label="主题切换">
              <button
                className={`theme-option ${theme === 'dark' ? 'active' : ''}`}
                onClick={() => handleChangeTheme('dark')}
                type="button"
              >
                <span className="theme-swatch dark" />
                深色
              </button>
              <button
                className={`theme-option ${theme === 'light' ? 'active' : ''}`}
                onClick={() => handleChangeTheme('light')}
                type="button"
              >
                <span className="theme-swatch light" />
                亮色
              </button>
            </div>
          </section>

          <section className="settings-section">
            <h3 className="section-title">播放模式</h3>
            <p className="section-desc">控制上一首、下一首和结束后的连播方式。</p>
            <div className="playback-mode-toggle" role="group" aria-label="播放模式切换">
              <button
                className={`playback-mode-option ${playbackMode === 'order' ? 'active' : ''}`}
                onClick={() => handlePlaybackModeChange('order')}
                type="button"
              >
                顺序
              </button>
              <button
                className={`playback-mode-option ${playbackMode === 'shuffle' ? 'active' : ''}`}
                onClick={() => handlePlaybackModeChange('shuffle')}
                type="button"
              >
                随机
              </button>
              <button
                className={`playback-mode-option ${playbackMode === 'single' ? 'active' : ''}`}
                onClick={() => handlePlaybackModeChange('single')}
                type="button"
              >
                单曲
              </button>
            </div>
          </section>

          <section className="settings-section">
            <h3 className="section-title">关闭窗口</h3>
            <p className="section-desc">设置点击电脑端窗口关闭按钮时的默认行为。</p>
            <label className="remote-toggle close-behavior-toggle">
              <input
                type="checkbox"
                checked={closeWithoutPrompt}
                onChange={(event) => handleWindowCloseModeChange(event.target.checked ? 'minimize' : 'ask')}
              />
              <span>永久不弹出关闭确认</span>
            </label>
            <div className="close-behavior-options" role="group" aria-label="关闭窗口行为">
              <label className="remote-toggle">
                <input
                  type="checkbox"
                  checked={windowCloseMode === 'minimize'}
                  disabled={!closeWithoutPrompt}
                  onChange={(event) => handleWindowCloseModeChange(event.target.checked ? 'minimize' : 'ask')}
                />
                <span>关闭时最小化/隐藏到后台</span>
              </label>
              <label className="remote-toggle">
                <input
                  type="checkbox"
                  checked={windowCloseMode === 'exit'}
                  disabled={!closeWithoutPrompt}
                  onChange={(event) => handleWindowCloseModeChange(event.target.checked ? 'exit' : 'ask')}
                />
                <span>关闭时直接退出应用</span>
              </label>
            </div>
            <p className="hint close-behavior-hint">
              未勾选“永久不弹出关闭确认”时，关闭窗口仍会显示确认弹窗；勾选后会直接执行下方选择的操作。
            </p>
          </section>

          <section className="settings-section">
            <h3 className="section-title">视频理解</h3>
            <p className="section-desc">在播放器里显示已保存的视频理解结果。开启后不会自动启动长任务。</p>
            <label className="remote-toggle">
              <input
                type="checkbox"
                checked={videoAnalysisEnabled}
                onChange={(event) => handleVideoAnalysisToggle(event.target.checked)}
              />
              <span>启用视频理解结果面板</span>
            </label>
            <p className="hint video-analysis-settings-hint">
              {videoAnalysisEnabled
                ? '结果来自下方分析结果保存目录；没有匹配结果的视频会保持原播放界面。'
                : '开启后可从视频卡片菜单发起分析，并在播放器里查看已生成结果。'}
            </p>
            {videoAnalysisEnabled ? (
              <div className="analysis-settings-expanded">
                <div className="analysis-settings-group">
                  <div className="analysis-settings-group-header">
                    <strong>目录</strong>
                    <span>分析结果、本地模型和下载位置</span>
                  </div>
                  <div className="analysis-output-settings">
                    <span title={analysisOutputDir}>{analysisOutputDir || '使用默认保存目录'}</span>
                    <button className="btn btn-sm" type="button" onClick={handleSelectAnalysisOutputDir}>
                      选择目录
                    </button>
                    <button className="btn btn-sm" type="button" onClick={handleOpenAnalysisOutputDir}>
                      打开目录
                    </button>
                  </div>
                  <p className="hint video-analysis-settings-hint">
                    新完成的分析会保存为“视频名分析结果-识别码.json”，同一个视频会覆盖自己的旧结果。{analysisOutputMessage ? ` ${analysisOutputMessage}` : ''}
                  </p>
                  <div className="analysis-output-settings">
                    <span title={analysisModelDir}>{analysisModelDir || '使用默认模型目录'}</span>
                    <button className="btn btn-sm" type="button" onClick={handleSelectAnalysisModelDir}>
                      选择目录
                    </button>
                    <button className="btn btn-sm" type="button" onClick={handleOpenAnalysisModelDir}>
                      打开目录
                    </button>
                  </div>
                  <p className="hint video-analysis-settings-hint">
                    推荐模型目录：{defaultAnalysisModelDir || '正在读取默认目录'}。当前使用目录：{analysisModelDir || defaultAnalysisModelDir || '正在读取模型目录'}。下载的 VLM 会保存到当前目录下的 vlm 子文件夹；从别处下载的模型也建议放到这个 vlm 子文件夹里，点击“检测目录模型”即可识别。{analysisModelMessage ? ` ${analysisModelMessage}` : ''}
                  </p>
                </div>
                <div className="analysis-vlm-panel">
                  <div className="analysis-vlm-header">
                    <div>
                      <strong>视觉模型</strong>
                      <p>选择模型后点击“启动模型”，会先保存配置再启动本地服务。</p>
                    </div>
                    <span className={`analysis-vlm-status${vlmState?.connected ? ' connected' : ''}`}>
                      {vlmStatusText}
                    </span>
                  </div>
                  <div className="analysis-vlm-quick-card">
                    <div className="analysis-vlm-quick-grid">
                      <div>
                        <span>当前模型</span>
                        <strong title={analysisRuntimeConfig.vlmModelPath || analysisRuntimeConfig.vlmName}>
                          {vlmProviderIsApi ? (analysisRuntimeConfig.vlmName || '未填写模型名称') : (vlmModelFileName || '未选择模型文件')}
                        </strong>
                      </div>
                      <div>
                        <span>模型状态</span>
                        <strong>{vlmModelStateText}</strong>
                      </div>
                      <div>
                        <span>连接地址</span>
                        <strong title={analysisRuntimeConfig.vlmBaseUrl}>{analysisRuntimeConfig.vlmBaseUrl || '未填写'}</strong>
                      </div>
                    </div>
                    <div className="analysis-vlm-quick-actions">
                      {vlmProviderIsApi ? (
                        <button className="btn btn-sm btn-primary" type="button" onClick={handleRefreshVlmState}>
                          检测连接
                        </button>
                      ) : (
                        <>
                          <button
                            className="btn btn-sm btn-primary analysis-vlm-start-button"
                            type="button"
                            onClick={handleStartVlmService}
                            disabled={vlmState?.downloading || vlmSaving}
                          >
                            启动模型
                          </button>
                          <button className="btn btn-sm" type="button" onClick={handleStopVlmService}>
                            停止服务
                          </button>
                          <button className="btn btn-sm" type="button" onClick={handleRefreshVlmState}>
                            检测连接
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="analysis-provider-toggle" role="group" aria-label="视觉模型来源">
                    <button
                      className={`analysis-provider-option${analysisRuntimeConfig.vlmProvider !== 'api' ? ' active' : ''}`}
                      type="button"
                      onClick={() => handleVlmRuntimeChange('vlmProvider', 'local')}
                    >
                      本地 VLM
                    </button>
                    <button
                      className={`analysis-provider-option${analysisRuntimeConfig.vlmProvider === 'api' ? ' active' : ''}`}
                      type="button"
                      onClick={() => handleVlmRuntimeChange('vlmProvider', 'api')}
                    >
                      外接 VLM API
                    </button>
                  </div>
                  {vlmProviderIsApi ? (
                    <div className="analysis-runtime-settings analysis-runtime-settings-clean">
                      <label className="analysis-runtime-field wide">
                        <span>VLM API 地址</span>
                        <input
                          value={analysisRuntimeConfig.vlmBaseUrl}
                          onChange={(event) => handleVlmRuntimeChange('vlmBaseUrl', event.target.value)}
                        />
                      </label>
                      <label className="analysis-runtime-field">
                        <span>VLM 模型名称</span>
                        <input
                          value={analysisRuntimeConfig.vlmName}
                          onChange={(event) => handleVlmRuntimeChange('vlmName', event.target.value)}
                        />
                      </label>
                      <label className="analysis-runtime-field">
                        <span>VLM API Key</span>
                        <input
                          type="password"
                          value={analysisRuntimeConfig.vlmApiKey}
                          onChange={(event) => handleVlmRuntimeChange('vlmApiKey', event.target.value)}
                        />
                      </label>
                    </div>
                  ) : (
                    <>
                      <div className="analysis-runtime-settings analysis-runtime-settings-clean">
                        <label className="analysis-runtime-field wide">
                          <span>本地 VLM 服务地址</span>
                          <input
                            value={analysisRuntimeConfig.vlmBaseUrl}
                            onChange={(event) => handleVlmRuntimeChange('vlmBaseUrl', event.target.value)}
                          />
                        </label>
                      </div>
                      <div className="analysis-vlm-download-box">
                        <label className="analysis-runtime-field">
                          <span>下载模型</span>
                          <select
                            value={selectedVlmModelId}
                            onChange={(event) => handleSelectedVlmModelChange(event.target.value)}
                          >
                            {(vlmModelOptions.models || []).map((model) => (
                              <option value={model.id} key={model.id}>{model.name}</option>
                            ))}
                          </select>
                        </label>
                        <label className="analysis-runtime-field compact">
                          <span>精度</span>
                          <select
                            value={selectedVlmPrecision}
                            onChange={(event) => setSelectedVlmPrecision(event.target.value)}
                          >
                            {visibleVlmPrecisions.map((precision) => (
                              <option value={precision.id} key={precision.id}>{precision.name}</option>
                            ))}
                          </select>
                        </label>
                        <button
                          className="btn btn-sm"
                          type="button"
                          onClick={handleDownloadVlmModel}
                          disabled={vlmState?.downloading || !selectedVlmModelId}
                        >
                          {vlmState?.downloading ? '下载中...' : '下载并配置'}
                        </button>
                        <div className="analysis-vlm-download-meta">
                          <span title={currentVlmModelOption?.repo || ''}>
                            {currentVlmModelOption?.repo || '请选择模型'}
                          </span>
                          {vlmDownloadProgress ? <strong>{vlmDownloadInfo}</strong> : null}
                        </div>
                        <p className="analysis-vlm-download-note">
                          下载位置：{vlmModelDirectory}。手动下载的 VLM 模型也可以放到这里再检测。
                        </p>
                        {vlmDownloadProgress ? (
                          <div className="analysis-vlm-progress" aria-label="VLM 模型下载进度">
                            <span style={{ width: `${vlmDownloadPercent}%` }} />
                          </div>
                        ) : null}
                      </div>
                      <div className="analysis-selected-model-card">
                        <div className="analysis-selected-model-info">
                          <span>本地模型文件</span>
                          <strong title={analysisRuntimeConfig.vlmModelPath || ''}>
                            {vlmModelFileName || '未选择模型文件'}
                          </strong>
                          <small title={analysisRuntimeConfig.vlmModelPath || vlmModelDirectory}>
                            {analysisRuntimeConfig.vlmModelPath || `推荐放在：${vlmModelDirectory}`}
                          </small>
                        </div>
                        <div className="analysis-selected-model-actions">
                          <button className="btn btn-sm" type="button" onClick={handleSelectVlmModelFile}>
                            选择文件
                          </button>
                          <button className="btn btn-sm" type="button" onClick={handleListLocalVlmFiles} disabled={localVlmLoading}>
                            {localVlmLoading ? '检测中...' : '检测目录模型'}
                          </button>
                        </div>
                      </div>
                      {localVlmFiles.length ? (
                        <div className="analysis-local-model-list">
                          <p className="analysis-local-model-summary">显示 {Math.min(localVlmFiles.length, 12)} / {localVlmFiles.length} 个本地模型</p>
                          {localVlmFiles.slice(0, 12).map((file) => (
                            <button
                              key={file.path}
                              className={`analysis-local-model-file${analysisRuntimeConfig.vlmModelPath === file.path ? ' active' : ''}`}
                              type="button"
                              onClick={() => handleSelectLocalVlmFile(file.path)}
                              title={file.path}
                            >
                              <span>{file.name}</span>
                              <small>{formatBytes(file.size)}</small>
                            </button>
                          ))}
                        </div>
                      ) : null}
                      <details className="analysis-detail-config">
                        <summary>更多配置</summary>
                        <div className="analysis-detail-body">
                          <label className="analysis-runtime-field wide">
                            <span>模型文件完整路径</span>
                            <div className="analysis-path-row">
                              <input
                                value={analysisRuntimeConfig.vlmModelPath}
                                onChange={(event) => handleVlmRuntimeChange('vlmModelPath', event.target.value)}
                              />
                              <button className="btn btn-sm" type="button" onClick={handleSelectVlmModelFile}>
                                选择
                              </button>
                            </div>
                          </label>
                          <label className="analysis-runtime-field">
                            <span>VLM 模型名称</span>
                            <input
                              value={analysisRuntimeConfig.vlmName}
                              onChange={(event) => handleVlmRuntimeChange('vlmName', event.target.value)}
                            />
                          </label>
                          <label className="analysis-runtime-field">
                            <span>本地占位 API Key</span>
                            <input
                              type="password"
                              value={analysisRuntimeConfig.vlmApiKey}
                              onChange={(event) => handleVlmRuntimeChange('vlmApiKey', event.target.value)}
                            />
                          </label>
                          <label className="analysis-runtime-field">
                            <span>HF Token（可选）</span>
                            <input
                              type="password"
                              value={analysisRuntimeConfig.vlmHfToken}
                              onChange={(event) => handleVlmRuntimeChange('vlmHfToken', event.target.value)}
                            />
                          </label>
                          <label className="analysis-runtime-field wide">
                            <span>服务程序路径</span>
                            <div className="analysis-path-row">
                              <input
                                value={analysisRuntimeConfig.vlmServerExecutable}
                                onChange={(event) => handleVlmRuntimeChange('vlmServerExecutable', event.target.value)}
                                placeholder="例如 C:\\llama.cpp\\llama-server.exe"
                              />
                              <button className="btn btn-sm" type="button" onClick={handleSelectVlmServerExecutable}>
                                选择
                              </button>
                            </div>
                          </label>
                          <label className="analysis-runtime-field wide">
                            <span>启动参数</span>
                            <input
                              value={analysisRuntimeConfig.vlmServerArgs}
                              onChange={(event) => handleVlmRuntimeChange('vlmServerArgs', event.target.value)}
                            />
                          </label>
                        </div>
                      </details>
                    </>
                  )}
                  <div className="analysis-vlm-footer">
                    <button className="btn btn-sm" type="button" onClick={() => handleSaveVlmConfig()} disabled={vlmSaving}>
                      {vlmSaving ? '保存中...' : '保存设置'}
                    </button>
                    <p className="hint video-analysis-settings-hint">
                      {vlmProviderIsApi
                        ? '外接 VLM API 保存后可直接检测连接。'
                        : '本地 VLM 使用项目自带的 llama.cpp 服务程序；启动参数可在“更多配置”中调整。'}
                      {vlmMessage ? ` ${vlmMessage}` : ''}
                    </p>
                  </div>
                </div>
                <div className="analysis-settings-group">
                  <div className="analysis-settings-group-header">
                    <strong>分析参数</strong>
                    <span>文本模型和运行策略</span>
                  </div>
                  <div className="analysis-provider-toggle" role="group" aria-label="文本模型来源">
                    <button
                      className={`analysis-provider-option${analysisRuntimeConfig.llmProvider !== 'api' ? ' active' : ''}`}
                      type="button"
                      onClick={() => handleLlmProviderChange('local')}
                    >
                      本地文本模型
                    </button>
                    <button
                      className={`analysis-provider-option${analysisRuntimeConfig.llmProvider === 'api' ? ' active' : ''}`}
                      type="button"
                      onClick={() => handleLlmProviderChange('api')}
                    >
                      外接大模型 API
                    </button>
                  </div>
                  <p className="hint video-analysis-settings-hint">
                    {analysisRuntimeConfig.llmProvider === 'api'
                      ? '文本理解会调用下方外部 OpenAI 兼容 API；视觉模型仍需要单独配置 VLM 服务。'
                      : '默认使用子项目本地文本模型配置；请先启动本机 OpenAI 兼容文本模型服务。'}
                  </p>
                  <div className="analysis-runtime-settings">
                    <label className="analysis-runtime-field compact">
                      <span>分析质量</span>
                      <select
                        value={analysisRuntimeConfig.mode}
                        onChange={(event) => handleAnalysisRuntimeChange('mode', event.target.value)}
                      >
                        <option value="fast">快速</option>
                        <option value="balance">平衡</option>
                        <option value="quantity">质量</option>
                      </select>
                    </label>
                    <label className="analysis-runtime-field compact">
                      <span>最大分析时长（秒）</span>
                      <input
                        value={analysisRuntimeConfig.maxDurationSeconds}
                        onChange={(event) => handleAnalysisRuntimeChange('maxDurationSeconds', event.target.value.replace(/[^\d]/g, ''))}
                        inputMode="numeric"
                      />
                    </label>
                    <label className="analysis-runtime-field compact">
                      <span>视觉分析并发数</span>
                      <input
                        value={analysisRuntimeConfig.vlmConcurrency}
                        onChange={(event) => handleAnalysisRuntimeChange('vlmConcurrency', event.target.value.replace(/[^\d]/g, ''))}
                        inputMode="numeric"
                      />
                    </label>
                    <label className="analysis-runtime-field wide">
                      <span>{analysisRuntimeConfig.llmProvider === 'api' ? '文本模型 API 地址' : '本地文本模型服务地址'}</span>
                      <input
                        value={analysisRuntimeConfig.llmBaseUrl}
                        onChange={(event) => handleAnalysisRuntimeChange('llmBaseUrl', event.target.value)}
                      />
                    </label>
                    <label className="analysis-runtime-field">
                      <span>{analysisRuntimeConfig.llmProvider === 'api' ? '外接文本模型名称' : '本地文本模型名称'}</span>
                      <input
                        value={analysisRuntimeConfig.llmName}
                        onChange={(event) => handleAnalysisRuntimeChange('llmName', event.target.value)}
                      />
                    </label>
                    <label className="analysis-runtime-field">
                      <span>文本模型 API Key</span>
                      <input
                        type="password"
                        value={analysisRuntimeConfig.llmApiKey}
                        onChange={(event) => handleAnalysisRuntimeChange('llmApiKey', event.target.value)}
                      />
                    </label>
                  </div>
                </div>
                <div className="mpv-actions">
                  <button
                    className="btn btn-sm btn-primary"
                    type="button"
                    onClick={handleSaveAnalysisRuntimeConfig}
                    disabled={analysisConfigSaving}
                  >
                    {analysisConfigSaving ? '保存中...' : '保存分析参数'}
                  </button>
                  <button
                    className="btn btn-sm"
                    type="button"
                    onClick={handleResetAnalysisRuntimeConfig}
                    disabled={analysisConfigSaving}
                  >
                    恢复本地默认
                  </button>
                </div>
                {analysisConfigMessage ? (
                  <p className="hint video-analysis-settings-hint">{analysisConfigMessage}</p>
                ) : null}
              </div>
            ) : null}
          </section>

          <section className="settings-section">
            <h3 className="section-title">手机访问</h3>
            <p className="section-desc">在同一局域网内用手机浏览和播放这台电脑的视频库。</p>
            <div className={`ffmpeg-status ${remoteState?.running ? 'ok' : 'warn'}`}>
              <span className={`status-dot ${remoteState?.running ? 'green' : 'yellow'}`} />
              <div className="status-content">
                <p>{remoteState?.running ? '手机访问正在运行' : '手机访问已关闭'}</p>
                <p className="hint">
                  {remoteState?.error
                    ? `启动失败: ${remoteState.error}`
                    : (remoteState?.endpoint || '开启后会显示局域网访问地址')
                  }
                </p>
              </div>
            </div>

            <div className="remote-settings-grid">
              <label className="remote-toggle">
                <input
                  type="checkbox"
                  checked={Boolean(remoteState?.settings?.enabled)}
                  onChange={(event) => handleRemoteSave({ enabled: event.target.checked })}
                  disabled={remoteSaving}
                />
                <span>开启手机访问</span>
              </label>
              <label className="remote-toggle">
                <input
                  type="checkbox"
                  checked={remoteState?.settings?.keepRunningInTray !== false}
                  onChange={(event) => handleRemoteSave({ keepRunningInTray: event.target.checked })}
                  disabled={remoteSaving}
                />
                <span>关闭窗口后保持运行</span>
              </label>
              <label className="remote-toggle">
                <input
                  type="checkbox"
                  checked={Boolean(remoteState?.settings?.allowLegacyToken)}
                  onChange={(event) => handleRemoteSave({ allowLegacyToken: event.target.checked })}
                  disabled={remoteSaving}
                />
                <span>兼容旧版手动 Token</span>
              </label>
              <label className="remote-port-field">
                <span>端口</span>
                <input
                  value={remotePort}
                  onChange={(event) => setRemotePort(event.target.value.replace(/[^\d]/g, ''))}
                  onBlur={() => handleRemoteSave()}
                  inputMode="numeric"
                  disabled={remoteSaving}
                />
              </label>
            </div>

            <div className="remote-address-box">
              <span>{remoteState?.endpoint || 'http://电脑IP:38127'}</span>
              <button className="btn btn-sm" type="button" onClick={handleCopyEndpoint} disabled={!remoteState?.endpoint}>
                复制地址
              </button>
            </div>

            <div className="mpv-actions">
              <button
                className="btn btn-sm btn-primary"
                type="button"
                onClick={handleCreatePairingCode}
                disabled={!remoteState?.running || pairingLoading}
              >
                {pairingLoading ? '生成中...' : '生成扫码绑定二维码'}
              </button>
              <button className="btn btn-sm" type="button" onClick={handleCopyToken}>
                复制临时 Token
              </button>
              <button className="btn btn-sm btn-danger" type="button" onClick={handleRotateToken}>
                重新生成 Token
              </button>
            </div>
            <p className="hint remote-hint">
              推荐使用扫码绑定，每台手机会获得独立访问凭证；临时 Token 仅在开启兼容模式后可用于旧版本手动连接，且不能按设备单独管理。
              {remoteCopied && <span className="remote-copied"> {remoteCopied}</span>}
            </p>
            {pairingError ? <p className="hint error">{pairingError}</p> : null}
            {pairingCode ? (
              <div className="remote-pairing-box">
                <div className="remote-qr-wrap">
                  <img src={pairingCode.qrDataUrl} alt="手机扫码绑定二维码" />
                </div>
                <div className="remote-pairing-content">
                  <p className="remote-pairing-title">用手机端“扫描二维码”绑定</p>
                  <p className="hint">
                    {pairingExpiresIn > 0
                      ? `二维码 ${pairingExpiresIn} 秒后过期，扫码后会自动换取独立 Token。`
                      : '二维码已过期，请重新生成。'}
                  </p>
                  <div className="mpv-actions">
                    <button className="btn btn-sm" type="button" onClick={handleCopyPairingCode}>
                      复制绑定码
                    </button>
                    <button className="btn btn-sm" type="button" onClick={handleCreatePairingCode}>
                      重新生成
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {pendingPairingRequests.length ? (
              <div className="remote-device-list">
                <div className="remote-device-list-header">
                  <strong>待确认绑定</strong>
                  <span>{pendingPairingRequests.length} 个请求</span>
                </div>
                {pendingPairingRequests.map((request) => (
                  <div className="remote-device-row remote-pending-device-row" key={request.id}>
                    <div>
                      <p>{request.clientName || '手机端'}</p>
                      <span>
                        {request.platform ? `${request.platform} · ` : ''}
                        {request.expiresAt ? `二维码 ${Math.max(0, Math.ceil((request.expiresAt - Date.now()) / 1000))} 秒后过期` : '等待确认'}
                      </span>
                    </div>
                    <div className="remote-device-actions">
                      <button
                        className="btn btn-sm btn-primary"
                        type="button"
                        onClick={() => handleApprovePairingRequest(request.id)}
                      >
                        允许
                      </button>
                      <button
                        className="btn btn-sm btn-danger"
                        type="button"
                        onClick={() => handleRejectPairingRequest(request.id)}
                      >
                        拒绝
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="remote-device-list">
              <div className="remote-device-list-header">
                <strong>已绑定设备</strong>
                <span>{pairedDevices.length} 台</span>
              </div>
              {pairedDevices.length ? pairedDevices.map((device) => (
                <div className="remote-device-row" key={device.id}>
                  <div>
                    <p>{device.name || '手机端'}</p>
                    <span>
                      {device.lastSeenAt
                        ? `上次连接 ${new Date(device.lastSeenAt).toLocaleString()}`
                        : `绑定于 ${new Date(device.createdAt).toLocaleString()}`}
                    </span>
                  </div>
                  <button
                    className="btn btn-sm btn-danger"
                    type="button"
                    onClick={() => handleRemovePairedDevice(device.id)}
                  >
                    移除
                  </button>
                </div>
              )) : (
                <p className="hint">还没有通过二维码绑定的手机。</p>
              )}
            </div>
          </section>

          {/* 应用更新 */}
          <section className="settings-section">
            <h3 className="section-title">应用更新</h3>
            <p className="section-desc">检查 GitHub Releases 上是否有新版本。</p>
            <div className="ffmpeg-status">
              <span className="status-dot green" />
              <div className="status-content">
                <p>安装版会在后台定期检查更新，也可以手动检查。</p>
                <p className="hint">便携版不支持自动更新，需要手动下载新版。</p>
                <div className="mpv-actions">
                  <button className="btn btn-sm btn-primary" onClick={handleCheckUpdate} type="button">
                    检查更新
                  </button>
                </div>
              </div>
            </div>
          </section>

          {/* mpv 播放器 */}
          <section className="settings-section">
            <h3 className="section-title">mpv 播放器</h3>
            {mpvStatus?.available ? (
              <div className="ffmpeg-status ok">
                <span className="status-dot green" />
                <div>
                  <span>已检测到 mpv — 播放功能正常</span>
                  <p className="hint" style={{ marginTop: 4 }}>
                    路径: {mpvStatus.path}
                    {mpvStatus.version && <><br />{mpvStatus.version}</>}
                  </p>
                </div>
              </div>
            ) : (
              <div className="ffmpeg-status warn">
                <span className="status-dot yellow" />
                <div className="status-content">
                  <p>未检测到标准 mpv — 将使用内置 HTML5 播放器（格式支持有限）</p>
                  <p className="hint">
                    mpv 支持几乎所有视频格式，推荐安装以获得最佳体验。
                  </p>
                  <div className="mpv-actions">
                    <button
                      className="btn btn-sm btn-primary"
                      onClick={handleDownloadMpv}
                      disabled={downloading}
                    >
                      {downloading
                        ? `下载中... ${downloadProgress ? downloadProgress.percent + '%' : ''}`
                        : '自动下载 mpv'
                      }
                    </button>
                    <button
                      className="btn btn-sm"
                      onClick={handleSelectMpvPath}
                    >
                      手动选择 mpv.exe
                    </button>
                  </div>
                  {mpvDownloadError && (
                    <p className="hint error">mpv 下载失败: {mpvDownloadError}</p>
                  )}
                </div>
              </div>
            )}
          </section>

          {/* FFmpeg 状态 */}
          <section className="settings-section">
            <h3 className="section-title">FFmpeg 状态</h3>
            {ffmpegStatus?.available ? (
              <div className="ffmpeg-status ok">
                <span className="status-dot green" />
                <span>已检测到 FFmpeg — 缩略图功能正常</span>
              </div>
            ) : (
              <div className="ffmpeg-status warn">
                <span className="status-dot yellow" />
                <div>
                  <p>未检测到 FFmpeg — 将无法生成视频缩略图</p>
                  <p className="hint">
                    请安装 FFmpeg 并确保其在系统 PATH 中。
                    可从 <a href="https://ffmpeg.org/download.html" target="_blank" rel="noopener">ffmpeg.org</a> 下载。
                  </p>
                </div>
              </div>
            )}
          </section>

          <section className="settings-section">
            <h3 className="section-title">About</h3>
            <div className="about-info">
              <span>Wallpaper Player</span>
              <span>License: Apache-2.0</span>
            </div>
          </section>

          {/* 快捷键说明 */}
          <section className="settings-section">
            <h3 className="section-title">快捷键</h3>
            <div className="shortcut-list">
              <div className="shortcut-item">
                <kbd>Space</kbd>
                <span>播放 / 暂停</span>
              </div>
              <div className="shortcut-item">
                <kbd>Esc</kbd>
                <span>关闭播放器</span>
              </div>
              <div className="shortcut-item">
                <kbd>F</kbd>
                <span>全屏切换</span>
              </div>
              <div className="shortcut-item">
                <kbd>右键</kbd>
                <span>在文件管理器中显示</span>
              </div>
            </div>
          </section>
        </div>

        {/* 操作按钮 */}
        <div className="settings-footer">
          <span className="settings-version">当前版本 v{appVersion || 'unknown'}</span>
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? '保存中...' : '保存设置'}
          </button>
        </div>
      </div>
    </div>
  )
}
