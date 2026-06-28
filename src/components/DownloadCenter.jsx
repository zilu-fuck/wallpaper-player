import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mkv',
  '.webm',
  '.mov',
  '.avi',
  '.wmv',
  '.flv',
  '.m4v',
  '.mpg',
  '.mpeg',
  '.ts',
  '.m2ts',
  '.mts',
  '.vob',
  '.rmvb',
  '.rm',
  '.asf',
  '.divx',
  '.f4v',
  '.3gp',
  '.ogv'
])

const SUBTITLE_EXTENSIONS = new Set([
  '.srt',
  '.ass',
  '.ssa',
  '.vtt',
  '.sub'
])

function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  return `${(value / (1024 ** index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

function formatSpeed(bytesPerSecond) {
  return `${formatBytes(bytesPerSecond)}/s`
}

function extensionOf(filePath = '') {
  const clean = String(filePath).split(/[?#]/)[0]
  const index = clean.lastIndexOf('.')
  return index >= 0 ? clean.slice(index).toLowerCase() : ''
}

function fileNameOf(filePath = '') {
  return String(filePath).split(/[/\\]/).filter(Boolean).pop() || '等待文件名'
}

function isVideoFile(file) {
  return VIDEO_EXTENSIONS.has(extensionOf(file?.path))
}

function isSubtitleFile(file) {
  return SUBTITLE_EXTENSIONS.has(extensionOf(file?.path))
}

function shouldSelectByDefault(file) {
  return isVideoFile(file) || isSubtitleFile(file)
}

function getDefaultSelectedFileIndexes(task) {
  return (task?.files || [])
    .filter(file => shouldSelectByDefault(file))
    .map(file => file.index)
}

function statusLabel(status) {
  return ({
    active: '下载中',
    waiting: '等待中',
    paused: '已暂停',
    complete: '已完成',
    error: '出错',
    removed: '已移除',
    external: '外部接管'
  })[status] || '未知'
}

function getProgress(task) {
  if (task?.status === 'complete') return 100
  const total = getTaskTotalLength(task)
  const completed = getTaskCompletedLength(task)
  return total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0
}

function getTaskTotalLength(task) {
  const total = Number(task?.totalLength) || 0
  if (total > 0) return total
  return (task?.files || [])
    .filter(file => file?.selected !== false)
    .reduce((sum, file) => sum + (Number(file.length) || 0), 0)
}

function getTaskCompletedLength(task) {
  if (task?.status === 'complete') {
    const total = getTaskTotalLength(task)
    if (total > 0) return total
  }
  const completed = Number(task?.completedLength) || 0
  const filesCompleted = (task?.files || [])
    .filter(file => file?.selected !== false)
    .reduce((sum, file) => sum + (Number(file.completedLength) || 0), 0)
  return Math.max(completed, filesCompleted)
}

function formatDuration(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0))
  if (value < 60) return `${value} 秒`
  if (value < 3600) {
    const minutes = Math.floor(value / 60)
    const rest = value % 60
    return rest > 0 ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`
  }
  const hours = Math.floor(value / 3600)
  const minutes = Math.floor((value % 3600) / 60)
  return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`
}

function getTaskPhase(task) {
  const progress = getProgress(task)
  const speed = Number(task?.downloadSpeed) || 0
  const completed = getTaskCompletedLength(task)
  const total = getTaskTotalLength(task)
  const remaining = Math.max(0, total - completed)
  const eta = speed > 0 && remaining > 0 ? `约 ${formatDuration(remaining / speed)}` : '未知'
  const health = task?.sourceHealth

  if (task?.engine === 'xunlei' || task?.status === 'external') {
    return {
      className: 'external',
      label: '迅雷接管',
      detail: task?.message || '详细速度和进度请在迅雷查看',
      eta: '外部任务'
    }
  }
  if (task?.status === 'error') {
    return {
      className: 'error',
      label: '下载失败',
      detail: task.errorMessage || '任务出错',
      eta: '无法估算'
    }
  }
  if (task?.status === 'complete' || progress >= 100) {
    return {
      className: 'complete',
      label: '已完成',
      detail: '文件已下载完成',
      eta: '已完成'
    }
  }
  if (task?.status === 'paused') {
    return {
      className: 'paused',
      label: '已暂停',
      detail: completed > 0 ? '已暂停，可继续下载' : '任务已暂停',
      eta: '已暂停'
    }
  }
  if (task?.status === 'waiting') {
    return {
      className: 'waiting',
      label: health?.label || '等待中',
      detail: health?.detail || '等待 aria2 调度',
      eta: '等待中'
    }
  }
  if (speed > 0) {
    return {
      className: 'active',
      label: '下载中',
      detail: health?.detail || `速度 ${formatSpeed(speed)}，剩余 ${eta}`,
      eta
    }
  }
  return {
    className: completed > 0 ? 'connecting' : 'waiting',
    label: health?.label || (completed > 0 ? '连接资源中' : '寻找资源'),
    detail: health?.detail || (completed > 0 ? '已下载部分内容，正在等待资源响应' : '正在连接资源'),
    eta: '未知'
  }
}

function isMetadataTask(task) {
  const name = String(task?.name || '')
  const firstPath = String(task?.files?.[0]?.path || '')
  return Boolean(
    task?.followedBy?.length ||
    name.startsWith('[METADATA]') ||
    firstPath.startsWith('[METADATA]')
  )
}

function getMetadataTasks(tasks) {
  return tasks.filter(isMetadataTask)
}

function getTaskKindLabel(task) {
  if (task?.engine === 'xunlei') return 'XL'
  if (task?.bittorrent || task?.followedBy?.length) return 'BT'
  return 'URL'
}

function getBtPortLabel(engine) {
  const status = engine?.btPortStatus
  if (!status) return '检测中'
  if (status.ports?.some(port => port.listening)) return `${status.usablePort || status.range} 已监听`
  return status.available ? `${status.usablePort} 可用` : '需检查'
}

function getFileTypeLabel(file) {
  if (isVideoFile(file)) return '视频'
  if (isSubtitleFile(file)) return '字幕'
  const ext = extensionOf(file?.path)
  return ext ? ext.slice(1).toUpperCase() : '其他'
}

function getMagnetDisplayName(magnet = '') {
  try {
    const queryIndex = magnet.indexOf('?')
    const params = new URLSearchParams(queryIndex >= 0 ? magnet.slice(queryIndex + 1) : '')
    const name = params.get('dn')
    if (name) return name
  } catch {}
  return '磁链任务'
}

function normalizeDir(value = '') {
  return String(value || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
}

function isSameOrInsideDir(parentDir, targetDir) {
  const parent = normalizeDir(parentDir)
  const target = normalizeDir(targetDir)
  return Boolean(parent && target && (target === parent || target.startsWith(`${parent}/`)))
}

function findPendingMagnetTask(rawTasks, pendingTask) {
  if (!pendingTask) return null
  const metadataTask = rawTasks.find(task => task.gid === pendingTask.metadataGid)
  const followedIds = new Set(metadataTask?.followedBy || [])
  const knownIds = new Set(pendingTask.knownTaskGids || [])
  const directTask = rawTasks.find(task => (
    task.gid === pendingTask.metadataGid &&
    !isMetadataTask(task) &&
    task.files?.some(file => file.path)
  ))
  if (directTask) return directTask

  const followedTask = rawTasks.find(task => (
    followedIds.has(task.gid) ||
    task.following === pendingTask.metadataGid
  ) && !isMetadataTask(task))
  if (followedTask) return followedTask

  const targetDir = normalizeDir(pendingTask.dir)
  const expectedName = getMagnetDisplayName(pendingTask.magnet).toLowerCase()
  const sameDirTasks = rawTasks.filter(task => {
    if (isMetadataTask(task) || !task.bittorrent || !task.files?.length) return false
    return targetDir && normalizeDir(task.dir) === targetDir
  })
  return sameDirTasks.find(task => {
    const nameMatches = expectedName && String(task.name || '').toLowerCase().includes(expectedName)
    return nameMatches
  }) || sameDirTasks.find(task => !knownIds.has(task.gid)) || null
}

export default function DownloadCenter({
  pendingRequest,
  onPendingRequestConsumed,
  onRefreshLibraryDirectory,
  onSettingsChanged,
  libraryDirectories = []
}) {
  const [state, setState] = useState({ engine: null, tasks: [] })
  const [message, setMessage] = useState('')
  const [saveDir, setSaveDir] = useState('')
  const [saveDirInLibrary, setSaveDirInLibrary] = useState(false)
  const [downloadInput, setDownloadInput] = useState('')
  const [downloadSourceResource, setDownloadSourceResource] = useState(null)
  const [downloadEngine, setDownloadEngine] = useState('aria2')
  const [downloadDialogOpen, setDownloadDialogOpen] = useState(false)
  const [pendingMagnetTask, setPendingMagnetTask] = useState(null)
  const [fileDialogTaskGid, setFileDialogTaskGid] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [fileSelections, setFileSelections] = useState({})
  const [completedGids, setCompletedGids] = useState(() => new Set())
  const [selectedTaskGid, setSelectedTaskGid] = useState('')
  const pendingHandledRef = useRef(null)

  const rawTasks = state.tasks || []
  const tasks = useMemo(() => rawTasks.filter(task => !isMetadataTask(task)), [rawTasks])
  const engine = state.engine
  const xunlei = engine?.xunlei
  const metadataTasks = useMemo(() => getMetadataTasks(rawTasks), [rawTasks])
  const pendingFileTask = useMemo(() => findPendingMagnetTask(rawTasks, pendingMagnetTask), [pendingMagnetTask, rawTasks])
  const runningCount = tasks.filter(task => ['active', 'waiting'].includes(task.status)).length
  const pausedCount = tasks.filter(task => task.status === 'paused').length
  const completedCount = tasks.filter(task => task.status === 'complete').length
  const totalSpeed = tasks.reduce((sum, task) => sum + (Number(task.downloadSpeed) || 0), 0)
  const isDirInLibrary = useCallback((dir) => (
    libraryDirectories.some(libraryDir => isSameOrInsideDir(libraryDir, dir))
  ), [libraryDirectories])

  const openDownloadDialog = useCallback((presetInput = '', sourceResource = null) => {
    setDownloadInput(presetInput)
    setDownloadSourceResource(sourceResource)
    setDownloadEngine('aria2')
    setPendingMagnetTask(null)
    setFileDialogTaskGid('')
    setMessage('')
    setDownloadDialogOpen(true)
  }, [])

  const closeDownloadDialog = useCallback(() => {
    if (pendingMagnetTask?.metadataGid) {
      window.electronAPI?.downloadRemove?.(pendingMagnetTask.metadataGid)
        .then((result) => {
          if (result?.success) {
            setState({ engine: result.engine, tasks: result.tasks || [] })
          }
        })
        .catch(() => {})
    }
    setDownloadDialogOpen(false)
    setDownloadSourceResource(null)
    setPendingMagnetTask(null)
    setFileDialogTaskGid('')
  }, [pendingMagnetTask])

  const refreshState = useCallback(async (options = {}) => {
    const result = await window.electronAPI?.downloadGetState?.(options)
    if (!result?.success) {
      setMessage(result?.error || '读取下载中心状态失败')
      return null
    }
    setState({ engine: result.engine, tasks: result.tasks || [] })
    return result
  }, [])

  useEffect(() => {
    refreshState({ start: true })
    const timer = window.setInterval(() => {
      refreshState({ start: false }).catch(() => {})
    }, 1000)
    return () => window.clearInterval(timer)
  }, [refreshState])

  useEffect(() => {
    setSelectedTaskGid(prev => {
      if (prev && tasks.some(task => task.gid === prev)) return prev
      return tasks[0]?.gid || ''
    })
  }, [tasks])

  useEffect(() => {
    if (saveDir && isDirInLibrary(saveDir)) {
      setSaveDirInLibrary(true)
    }
  }, [isDirInLibrary, saveDir])

  useEffect(() => {
    if (!pendingMagnetTask) return
    if (pendingMagnetTask.fileTaskGid) return
    if (!pendingFileTask) {
      const waitedMs = Date.now() - pendingMagnetTask.createdAt
      if (waitedMs > 120000) {
        setMessage('还在等待磁链元数据。可能缺少 tracker，或 DHT 连接较慢，可以继续等、关闭弹窗后稍后查看，或取消任务。')
      }
      return
    }
    const defaults = getDefaultSelectedFileIndexes(pendingFileTask)
    setFileSelections(prev => {
      if (Object.hasOwn(prev, pendingFileTask.gid)) return prev
      return {
        ...prev,
        [pendingFileTask.gid]: defaults
      }
    })
    setPendingMagnetTask(prev => ({
      ...(prev || pendingMagnetTask),
      fileTaskGid: pendingFileTask.gid
    }))
    setSelectedTaskGid(pendingFileTask.gid)
    setFileDialogTaskGid(pendingFileTask.gid)
    setDownloadDialogOpen(false)
    setMessage('')
  }, [pendingFileTask, pendingMagnetTask])

  useEffect(() => {
    if (!fileDialogTaskGid) return
    if (!tasks.some(task => task.gid === fileDialogTaskGid)) {
      setFileDialogTaskGid('')
    }
  }, [fileDialogTaskGid, tasks])

  useEffect(() => {
    const nextSelections = {}
    let changed = false
    for (const task of tasks) {
      if (!task.gid || !task.files?.length) continue
      const current = fileSelections[task.gid]
      if (current) {
        nextSelections[task.gid] = current
        continue
      }
      const defaults = getDefaultSelectedFileIndexes(task)
      if (defaults.length > 0) {
        nextSelections[task.gid] = defaults
        changed = true
      }
    }
    const currentKeys = Object.keys(fileSelections)
    const nextKeys = Object.keys(nextSelections)
    if (changed || currentKeys.length !== nextKeys.length || currentKeys.some(key => !Object.hasOwn(nextSelections, key))) {
      setFileSelections(nextSelections)
    }
  }, [fileSelections, tasks])

  useEffect(() => {
    const nextCompleted = new Set(completedGids)
    let changed = false
    for (const task of tasks) {
      if (task.status !== 'complete' || !task.gid || completedGids.has(task.gid)) continue
      nextCompleted.add(task.gid)
      changed = true
      if (task.dir) {
        onRefreshLibraryDirectory?.(task.dir)
        const taskDirInLibrary = isDirInLibrary(task.dir) || (saveDirInLibrary && isSameOrInsideDir(saveDir, task.dir))
        if (!taskDirInLibrary) {
          setMessage('下载已完成。保存目录尚未加入视频库，加入后即可在画廊中扫描到视频。')
        }
      }
    }
    if (changed) setCompletedGids(nextCompleted)
  }, [completedGids, isDirInLibrary, onRefreshLibraryDirectory, saveDir, saveDirInLibrary, tasks])

  useEffect(() => {
    const handler = (event) => {
      const addedDir = event.detail?.dir
      if (saveDir && addedDir && isSameOrInsideDir(addedDir, saveDir)) {
        setSaveDirInLibrary(true)
      }
      setMessage(event.detail?.alreadyAdded
        ? '保存目录已在视频库中，已触发刷新。'
        : '保存目录已加入视频库，下载完成后会刷新该目录。')
    }
    window.addEventListener('wallpaper-player-library-directory-added', handler)
    return () => window.removeEventListener('wallpaper-player-library-directory-added', handler)
  }, [saveDir])

  const chooseSaveDir = useCallback(async () => {
    const result = await window.electronAPI?.downloadSelectDirectory?.()
    if (!result?.success) {
      if (!result?.canceled) setMessage(result?.error || '选择保存目录失败')
      return null
    }
    setSaveDir(result.path)
    setSaveDirInLibrary(Boolean(result.libraryDirectory))
    if (result.settings) {
      onSettingsChanged?.(result.settings)
    }
    setMessage(result.libraryDirectory
      ? '保存目录已在视频库中，下载完成后会自动刷新。'
      : '保存目录已允许用于下载；下载完成后可选择加入视频库。')
    return result.path
  }, [onSettingsChanged])

  const ensureSaveDir = useCallback(async () => {
    if (saveDir) return saveDir
    return chooseSaveDir()
  }, [chooseSaveDir, saveDir])

  useEffect(() => {
    if (!pendingRequest) return
    const key = JSON.stringify(pendingRequest)
    if (pendingHandledRef.current === key) return
    pendingHandledRef.current = key
    onPendingRequestConsumed?.()
    if (pendingRequest.type === 'network' && pendingRequest.resource) {
      openDownloadDialog(pendingRequest.resource.url || '', pendingRequest.resource)
      return
    }
    if (pendingRequest.type === 'magnet') {
      openDownloadDialog(pendingRequest.magnet || '')
    }
  }, [onPendingRequestConsumed, openDownloadDialog, pendingRequest])

  const submitDownload = useCallback(async (event) => {
    event.preventDefault()
    const input = downloadInput.trim()
    if (!input) {
      setMessage('请输入链接或磁链')
      return
    }
    const lowerInput = input.toLowerCase()
    const isMagnet = lowerInput.startsWith('magnet:?')
    const isUrl = /^https?:\/\//i.test(input)
    if (!isMagnet && !isUrl) {
      setMessage('请输入 magnet 磁链或 http/https 链接')
      return
    }
    const dir = await ensureSaveDir()
    if (!dir) return
    setSubmitting(true)
    setMessage('')
    try {
      if (downloadEngine === 'xunlei') {
        const result = await window.electronAPI?.downloadAddXunlei?.({
          url: input,
          magnet: isMagnet ? input : '',
          dir
        })
        if (!result?.success) {
          setMessage(result?.error || '未能拉起迅雷')
          if (result?.state) setState({ engine: result.state.engine, tasks: result.state.tasks || [] })
          return
        }
        if (result.state) {
          setState({ engine: result.state.engine, tasks: result.state.tasks || [] })
        } else {
          await refreshState({ start: true })
        }
        setSelectedTaskGid(result.task?.gid || '')
        setSaveDirInLibrary(Boolean(result.libraryDirectory))
        setDownloadInput('')
        setDownloadDialogOpen(false)
        setMessage('任务已交给迅雷，详细速度和进度请在迅雷查看；请确认迅雷保存目录与这里一致。')
        return
      }
      const knownTaskGids = isMagnet ? (state.tasks || []).map(task => task.gid).filter(Boolean) : []
      const result = isMagnet
        ? await window.electronAPI?.downloadAddMagnet?.({
            magnet: input,
            dir
          })
        : (downloadSourceResource && input === String(downloadSourceResource.url || '').trim()
            ? await window.electronAPI?.downloadAddNetworkResource?.({
                resource: downloadSourceResource,
                dir
              })
            : await window.electronAPI?.downloadAddUrl?.({
                url: input,
                dir
              }))
      if (!result?.success) {
        setMessage(result?.error || '创建下载任务失败')
        return
      }
      setState({ engine: result.state?.engine, tasks: result.state?.tasks || [] })
      setSelectedTaskGid(result.gid || result.state?.tasks?.[0]?.gid || '')
      setSaveDirInLibrary(Boolean(result.libraryDirectory))
      if (isMagnet) {
        setPendingMagnetTask({
          metadataGid: result.gid,
          magnet: input,
          dir,
          knownTaskGids,
          createdAt: Date.now()
        })
        setMessage('正在获取磁链元数据，解析出文件列表后会进入文件选择。')
        return
      }
      setDownloadInput('')
      setDownloadSourceResource(null)
      setDownloadDialogOpen(false)
      setMessage('下载任务已加入队列。')
    } finally {
      setSubmitting(false)
    }
  }, [downloadEngine, downloadInput, downloadSourceResource, ensureSaveDir, refreshState, state.tasks])

  const toggleFile = useCallback((gid, fileIndex) => {
    setFileSelections(prev => {
      const current = new Set(prev[gid] || [])
      if (current.has(fileIndex)) {
        current.delete(fileIndex)
      } else {
        current.add(fileIndex)
      }
      return {
        ...prev,
        [gid]: [...current].sort((a, b) => a - b)
      }
    })
  }, [])

  const applyFileSelection = useCallback(async (task) => {
    const selected = fileSelections[task.gid] || []
    setSubmitting(true)
    setMessage('')
    try {
      const result = await window.electronAPI?.downloadSelectFiles?.(task.gid, selected)
      if (!result?.success) {
        setMessage(result?.error || '应用文件选择失败')
        return
      }
      setState({ engine: result.engine, tasks: result.tasks || [] })
      setSelectedTaskGid(task.gid)
      setFileDialogTaskGid('')
      setPendingMagnetTask(null)
      setMessage('下载任务已加入队列。')
    } finally {
      setSubmitting(false)
    }
  }, [fileSelections])

  const cancelFileDialogTask = useCallback(async () => {
    if (!fileDialogTaskGid) return
    const gid = fileDialogTaskGid
    const metadataGid = pendingMagnetTask?.metadataGid
    setFileDialogTaskGid('')
    setPendingMagnetTask(null)
    setMessage('')
    try {
      let result = await window.electronAPI?.downloadRemove?.(gid)
      if (metadataGid && metadataGid !== gid) {
        result = await window.electronAPI?.downloadRemove?.(metadataGid)
      }
      if (result?.success) {
        setState({ engine: result.engine, tasks: result.tasks || [] })
      }
    } catch {}
  }, [fileDialogTaskGid, pendingMagnetTask])

  useEffect(() => {
    if (!downloadDialogOpen && !fileDialogTaskGid) return undefined
    document.body.classList.add('download-dialog-open')
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        if (fileDialogTaskGid) {
          cancelFileDialogTask()
          return
        }
        closeDownloadDialog()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      document.body.classList.remove('download-dialog-open')
    }
  }, [cancelFileDialogTask, closeDownloadDialog, downloadDialogOpen, fileDialogTaskGid])

  useEffect(() => {
    const handler = () => {
      if (fileDialogTaskGid) {
        cancelFileDialogTask()
        return
      }
      if (downloadDialogOpen) {
        closeDownloadDialog()
      }
    }
    window.addEventListener('wallpaper-player-close-download-dialogs', handler)
    return () => window.removeEventListener('wallpaper-player-close-download-dialogs', handler)
  }, [cancelFileDialogTask, closeDownloadDialog, downloadDialogOpen, fileDialogTaskGid])

  const controlTask = useCallback(async (task, action) => {
    setSubmitting(true)
    setMessage('')
    try {
      const api = {
        pause: window.electronAPI?.downloadPause,
        resume: window.electronAPI?.downloadResume,
        remove: window.electronAPI?.downloadRemove
      }[action]
      const result = await api?.(task.gid)
      if (!result?.success) {
        setMessage(result?.error || '操作下载任务失败')
        return
      }
      setState({ engine: result.engine, tasks: result.tasks || [] })
    } finally {
      setSubmitting(false)
    }
  }, [])

  const addDirectoryToLibrary = useCallback((dir) => {
    if (!dir) return
    window.dispatchEvent(new CustomEvent('wallpaper-player-download-add-library-directory', {
      detail: { dir }
    }))
  }, [])

  const addSaveDirToLibrary = useCallback(() => {
    addDirectoryToLibrary(saveDir)
  }, [addDirectoryToLibrary, saveDir])

  const openDownloadDirectory = useCallback(async (dir) => {
    if (!dir) return
    const result = await window.electronAPI?.downloadOpenDirectory?.(dir)
    if (!result?.success) setMessage(result?.error || '打开保存目录失败')
  }, [])

  const openSaveDir = useCallback(() => {
    openDownloadDirectory(saveDir)
  }, [openDownloadDirectory, saveDir])

  const scanDownloadDirectory = useCallback((dir) => {
    if (!dir) return
    if (!isDirInLibrary(dir)) {
      setMessage('保存目录尚未加入视频库，请先加入库后再扫描。')
      return
    }
    onRefreshLibraryDirectory?.(dir)
    setMessage('已触发扫描保存目录。')
  }, [isDirInLibrary, onRefreshLibraryDirectory])

  const selectedTask = tasks.find(task => task.gid === selectedTaskGid) || tasks[0] || null
  const fileDialogTask = tasks.find(task => task.gid === fileDialogTaskGid) || null
  const selectedTaskDir = selectedTask?.dir || saveDir
  const selectedTaskDirInLibrary = Boolean(
    selectedTaskDir &&
    (isDirInLibrary(selectedTaskDir) || (saveDirInLibrary && isSameOrInsideDir(saveDir, selectedTaskDir)))
  )
  const selectedTaskProgress = selectedTask ? getProgress(selectedTask) : 0
  const selectedTaskPhase = selectedTask ? getTaskPhase(selectedTask) : null
  const selectedTaskIsExternal = selectedTask?.engine === 'xunlei' || selectedTask?.status === 'external'
  const selectedTaskCanChooseFiles = Boolean(
    selectedTask &&
    !selectedTaskIsExternal &&
    selectedTask.status !== 'complete' &&
    selectedTask.files?.length > 1
  )
  const selectedTaskCompletedLength = selectedTask ? getTaskCompletedLength(selectedTask) : 0
  const selectedTaskTotalLength = selectedTask ? getTaskTotalLength(selectedTask) : 0
  const selectedTaskHealth = selectedTask?.sourceHealth || null
  const fileDialogIndexes = new Set(fileDialogTask ? fileSelections[fileDialogTask.gid] || [] : [])
  const fileDialogSelectedFiles = fileDialogTask?.files?.filter(file => fileDialogIndexes.has(file.index)) || []
  const fileDialogSelectedSize = fileDialogSelectedFiles.reduce((sum, file) => sum + (Number(file.length) || 0), 0)
  const fileDialogVideoCount = fileDialogSelectedFiles.filter(isVideoFile).length
  const fileDialogSubtitleCount = fileDialogSelectedFiles.filter(isSubtitleFile).length
  const fileDialogOtherCount = fileDialogSelectedFiles.length - fileDialogVideoCount - fileDialogSubtitleCount
  const dialogTarget = typeof document !== 'undefined'
    ? document.querySelector('.main-content') || document.body
    : null

  return (
    <>
      <div className="download-center">
        <section className="download-center-summary">
          <div className="download-summary-primary">
            <div className="download-speed-card">
              <strong>{formatSpeed(totalSpeed)}</strong>
              <span>当前速度</span>
            </div>
            <button type="button" className="btn btn-primary btn-sm download-new-task-btn" onClick={() => openDownloadDialog('')}>
              新建
            </button>
          </div>
          <div className="download-summary-secondary">
            <div className="download-summary-meta">
              <span>{runningCount} 个进行中</span>
              {pausedCount > 0 && <span>{pausedCount} 个已暂停</span>}
              <span>{completedCount} 个已完成</span>
            </div>
            <span className={`download-engine-badge${!engine ? ' loading' : ''}${engine?.running ? ' running' : ''}${engine && !engine.available ? ' missing' : ''}`}>
              {!engine ? '检测中' : engine.running ? 'aria2 在线' : engine.available ? 'aria2 就绪' : '未检测到 aria2c'}
            </span>
            <button type="button" className="download-icon-btn" onClick={() => refreshState({ refresh: true })} disabled={submitting} title="刷新状态" aria-label="刷新状态">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
              </svg>
            </button>
          </div>
        </section>

        {message && !downloadDialogOpen && <p className="download-center-message">{message}</p>}

        {engine && (
          <section className="download-network-status">
            <div>
              <span>BT 端口</span>
              <strong>{getBtPortLabel(engine)}</strong>
            </div>
            <div>
              <span>找源</span>
              <strong>{engine.trackerCount || 0} tracker · DHT/PEX/LSD</strong>
            </div>
            <div>
              <span>迅雷</span>
              <strong>{xunlei?.available ? '已检测到' : '未检测到'}</strong>
            </div>
          </section>
        )}

        {engine && !engine.available && (
          <section className="download-engine-card">
            <span className="download-engine-icon" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 9v4" />
                <path d="M12 17h.01" />
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              </svg>
            </span>
            <div>
              <strong>未检测到 aria2c</strong>
              <span>{engine?.error || '请重新执行 npm run prepare-vendor，或将 aria2c 加入 PATH。'}</span>
            </div>
          </section>
        )}

        <section className="download-task-board">
          <div className="download-section-head">
            <div>
              <strong>下载任务</strong>
              <span>{tasks.length > 0 ? `${tasks.length} 个任务` : '暂无任务'}</span>
            </div>
          </div>

          {tasks.length === 0 ? (
            <div className="download-center-empty">
              <strong>暂无下载任务</strong>
              <span>点击新建，粘贴磁链或视频直链。</span>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => openDownloadDialog('')}>
                新建下载
              </button>
            </div>
          ) : (
            <div className="download-task-list">
              {tasks.map(task => {
                const progress = getProgress(task)
                const isSelected = selectedTask?.gid === task.gid
                const completedLength = getTaskCompletedLength(task)
                const totalLength = getTaskTotalLength(task)
                const phase = getTaskPhase(task)
                const isExternalTask = task.engine === 'xunlei' || task.status === 'external'
                const canPauseTask = !isExternalTask && ['active', 'waiting'].includes(task.status)
                const canResumeTask = !isExternalTask && task.status === 'paused'
                return (
                  <div
                    className={`download-center-task ${phase.className}${isSelected ? ' selected' : ''}`}
                    key={task.gid}
                    onClick={() => setSelectedTaskGid(task.gid)}
                  >
                    <div className="download-task-main">
                      <span className="download-task-kind">{getTaskKindLabel(task)}</span>
                      <div className="download-task-copy">
                        <div className="download-task-title-line">
                          <strong>{task.name}</strong>
                          <em className={`download-task-state ${phase.className}`}>{phase.label}</em>
                        </div>
                        <div className="download-task-inline">
                          <span>{formatBytes(completedLength)} / {formatBytes(totalLength)}</span>
                          <span>{phase.detail}</span>
                          {task.files?.length > 0 && <span>{task.files.length} 个文件</span>}
                        </div>
                        <div className="download-progress" aria-label={`下载进度 ${progress}%`}>
                          <span style={{ width: `${progress}%` }} />
                        </div>
                      </div>
                      <div className="download-task-actions" onClick={(event) => event.stopPropagation()}>
                        {canResumeTask && (
                          <button type="button" className="download-icon-btn" onClick={() => controlTask(task, 'resume')} disabled={submitting} title="继续" aria-label="继续">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                              <path d="M8 5v14l11-7z" />
                            </svg>
                          </button>
                        )}
                        {canPauseTask && (
                          <button type="button" className="download-icon-btn" onClick={() => controlTask(task, 'pause')} disabled={submitting} title="暂停" aria-label="暂停">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                              <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
                            </svg>
                          </button>
                        )}
                        <button type="button" className="download-icon-btn" onClick={() => controlTask(task, 'remove')} disabled={submitting} title="移除" aria-label="移除">
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M18 6L6 18M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    </div>
                    <div className="download-task-meta">
                      <span>{progress}%</span>
                      <span>剩余 {phase.eta}</span>
                      {isExternalTask ? (
                        <span>迅雷中查看详情</span>
                      ) : (
                        <span>资源数 {task.numSeeders || task.followedBy?.length || 0}</span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {selectedTask && (
          <section className="download-task-detail">
            <div className="download-section-head">
              <div>
                <strong>任务详情</strong>
                <span>{selectedTask.name}</span>
              </div>
              <em className={`download-status-${selectedTaskPhase?.className || selectedTask.status}`}>{selectedTaskPhase?.label || statusLabel(selectedTask.status)}</em>
            </div>
            <div className="download-detail-grid">
              <div>
                <span>进度</span>
                <strong>{selectedTaskIsExternal ? '外部查看' : `${selectedTaskProgress}%`}</strong>
              </div>
              <div>
                <span>速度</span>
                <strong>{selectedTaskIsExternal ? '迅雷中查看' : formatSpeed(selectedTask.downloadSpeed)}</strong>
              </div>
              <div>
                <span>已下载</span>
                <strong>{selectedTaskIsExternal ? '外部任务' : formatBytes(selectedTaskCompletedLength)}</strong>
              </div>
              <div>
                <span>总大小</span>
                <strong>{selectedTaskIsExternal ? '未知' : formatBytes(selectedTaskTotalLength)}</strong>
              </div>
              <div>
                <span>连接</span>
                <strong>{selectedTaskIsExternal ? '外部客户端' : selectedTask.connections || 0}</strong>
              </div>
              <div>
                <span>{selectedTaskIsExternal ? '引擎' : '资源数'}</span>
                <strong>{selectedTaskIsExternal ? '迅雷' : selectedTask.numSeeders || selectedTask.followedBy?.length || 0}</strong>
              </div>
              <div>
                <span>剩余时间</span>
                <strong>{selectedTaskPhase?.eta || '未知'}</strong>
              </div>
              <div>
                <span>状态</span>
                <strong>{selectedTaskPhase?.detail || statusLabel(selectedTask.status)}</strong>
              </div>
            </div>
            {selectedTaskHealth && (
              <div className="download-health-card">
                <div>
                  <span>资源状态</span>
                  <strong>{selectedTaskHealth.label}</strong>
                  <p>{selectedTaskHealth.detail}</p>
                </div>
                {!selectedTaskIsExternal && (
                  <div>
                    <span>tracker / DHT</span>
                    <strong>{selectedTaskHealth.trackerStatus}</strong>
                    <p>{engine?.features?.dht ? 'DHT、PEX、LSD 已启用' : '等待引擎状态'}</p>
                  </div>
                )}
              </div>
            )}
            <div className="download-detail-row">
              <span>保存目录</span>
              <strong>{selectedTaskDir || '未选择'}</strong>
              {selectedTaskDir && (
                <div className="download-detail-actions">
                  {selectedTaskCanChooseFiles && (
                    <button type="button" className="btn btn-sm" onClick={() => setFileDialogTaskGid(selectedTask.gid)}>
                      选择文件
                    </button>
                  )}
                  <button type="button" className="btn btn-sm" onClick={() => openDownloadDirectory(selectedTaskDir)}>
                    打开目录
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => scanDownloadDirectory(selectedTaskDir)}>
                    扫描目录
                  </button>
                  {!selectedTaskDirInLibrary && (
                    <button type="button" className="btn btn-sm btn-primary" onClick={() => addDirectoryToLibrary(selectedTaskDir)}>
                      加入库
                    </button>
                  )}
                </div>
              )}
            </div>
            {selectedTaskDir && !selectedTaskDirInLibrary && (
              <p className="download-task-warning">该保存目录尚未加入视频库，加入后下载内容会出现在画廊里。</p>
            )}
            {selectedTask.errorMessage && <p className="download-task-error">{selectedTask.errorMessage}</p>}
          </section>
        )}

        {metadataTasks.length > 0 && (
          <section className="download-center-notes">
            <h4>磁链元数据</h4>
            <p>部分磁链会依赖 DHT 才能拿到元数据；当前默认完成后停止做种。</p>
          </section>
        )}
      </div>

      {downloadDialogOpen && dialogTarget && createPortal((
        <div className="download-dialog-overlay" onClick={closeDownloadDialog}>
          <form
            className="download-dialog"
            onSubmit={submitDownload}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="download-dialog-header">
              <div>
                <span>新建任务</span>
                <h2>添加链接或磁链</h2>
              </div>
              <button type="button" className="btn btn-icon" onClick={closeDownloadDialog} aria-label="关闭">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="download-dialog-body">
              <div className="download-engine-picker" role="tablist" aria-label="下载方式">
                <button
                  type="button"
                  className={downloadEngine === 'aria2' ? 'active' : ''}
                  onClick={() => setDownloadEngine('aria2')}
                  disabled={submitting || Boolean(pendingMagnetTask)}
                >
                  <strong>aria2 下载</strong>
                  <span>内置引擎，显示进度和文件选择</span>
                </button>
                <button
                  type="button"
                  className={downloadEngine === 'xunlei' ? 'active' : ''}
                  onClick={() => setDownloadEngine('xunlei')}
                  disabled={submitting || Boolean(pendingMagnetTask)}
                >
                  <strong>迅雷接管</strong>
                  <span>{xunlei?.available ? '拉起本机迅雷，速度在迅雷中查看' : '未检测到时会提示安装迅雷'}</span>
                </button>
              </div>
              <textarea
                value={downloadInput}
                onChange={(event) => setDownloadInput(event.target.value)}
                placeholder="magnet:?xt=urn:btih:... 或 https://..."
                rows={6}
                disabled={Boolean(pendingMagnetTask) || submitting}
                autoFocus
              />
              <div className="download-destination">
                <span className="download-destination-check" aria-hidden="true">✓</span>
                <div>
                  <strong>{saveDir ? '下载到' : '先选择保存目录'}</strong>
                  <span>{saveDir || '网络下载和磁链下载都会写入这个目录'}</span>
                </div>
                {saveDir && (
                  <button type="button" className="btn btn-icon" onClick={openSaveDir} title="打开目录" aria-label="打开目录">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M3 7h5l2 3h11v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                      <path d="M3 7V5a2 2 0 0 1 2-2h4l2 3" />
                    </svg>
                  </button>
                )}
                <button type="button" className="btn btn-sm" onClick={chooseSaveDir} disabled={submitting}>
                  {saveDir ? '更换' : '选择'}
                </button>
              </div>

              {pendingMagnetTask && (
                <div className="download-resolving-card">
                  <span className="download-resolving-spinner" aria-hidden="true" />
                  <div>
                    <strong>正在解析文件列表</strong>
                    <span>{getMagnetDisplayName(pendingMagnetTask.magnet)}</span>
                  </div>
                </div>
              )}

              {saveDir && !saveDirInLibrary && (
                <div className="download-library-tip">
                  <span>保存目录尚未加入视频库。</span>
                  <button type="button" className="btn btn-sm btn-primary" onClick={addSaveDirToLibrary}>
                    加入库
                  </button>
                </div>
              )}

              {downloadEngine === 'xunlei' && (
                <div className="download-external-tip">
                  <strong>{xunlei?.available ? '将使用本机迅雷接管' : '未检测到本机迅雷'}</strong>
                  <span>{xunlei?.available ? '本应用会记录保存目录用于扫描；实际保存位置请在迅雷中确认。' : '请先安装迅雷；安装后可点击刷新状态重新检测。'}</span>
                </div>
              )}

              {message && <p className="download-center-message">{message}</p>}
            </div>
            <div className="download-dialog-footer">
              <button type="button" className="btn btn-sm" onClick={closeDownloadDialog}>
                取消
              </button>
              <button type="submit" className="btn btn-primary download-submit-btn" disabled={submitting || Boolean(pendingMagnetTask)}>
                {pendingMagnetTask ? '解析中...' : submitting ? '处理中...' : downloadEngine === 'xunlei' ? '交给迅雷' : '立即下载'}
              </button>
            </div>
          </form>
        </div>
      ), dialogTarget)}

      {fileDialogTask && dialogTarget && createPortal((
        <div className="download-dialog-overlay" onClick={cancelFileDialogTask}>
          <form
            className="download-dialog download-file-dialog"
            onSubmit={(event) => {
              event.preventDefault()
              applyFileSelection(fileDialogTask)
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="download-dialog-header">
              <div className="download-file-dialog-title">
                <span className="download-task-kind">BT</span>
                <div>
                  <span>新建下载任务</span>
                  <h2>{fileDialogTask.name}</h2>
                  <p>已选 {fileDialogSelectedFiles.length} / {fileDialogTask.files.length} 个文件，{formatBytes(fileDialogSelectedSize)}</p>
                </div>
              </div>
              <button type="button" className="btn btn-icon" onClick={cancelFileDialogTask} aria-label="关闭">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="download-dialog-body">
              <div className="download-file-toolbar">
                <label>
                  <input
                    type="checkbox"
                    checked={fileDialogTask.files.length > 0 && fileDialogIndexes.size === fileDialogTask.files.length}
                    ref={(node) => {
                      if (node) node.indeterminate = fileDialogIndexes.size > 0 && fileDialogIndexes.size < fileDialogTask.files.length
                    }}
                    onChange={(event) => {
                      setFileSelections(prev => ({
                        ...prev,
                        [fileDialogTask.gid]: event.target.checked
                          ? fileDialogTask.files.map(file => file.index)
                          : []
                      }))
                    }}
                  />
                  全选
                </label>
                <div>
                  <span>视频 {fileDialogVideoCount}</span>
                  <span>字幕 {fileDialogSubtitleCount}</span>
                  <span>其他 {fileDialogOtherCount}</span>
                </div>
              </div>

              <div className="download-file-table" role="table" aria-label="文件选择">
                <div className="download-file-table-head" role="row">
                  <span>文件名称</span>
                  <span>类型</span>
                  <span>大小</span>
                </div>
                <div className="download-file-table-body">
                  {fileDialogTask.files.map(file => (
                    <label className="download-file-row" key={`${fileDialogTask.gid}-${file.index}`}>
                      <input
                        type="checkbox"
                        checked={fileDialogIndexes.has(file.index)}
                        onChange={() => toggleFile(fileDialogTask.gid, file.index)}
                      />
                      <span className="download-file-name">
                        <span className={`download-file-type-icon ${isVideoFile(file) ? 'video' : isSubtitleFile(file) ? 'subtitle' : 'other'}`} aria-hidden="true">
                          {isVideoFile(file) ? '▶' : isSubtitleFile(file) ? 'S' : '·'}
                        </span>
                        {fileNameOf(file.path)}
                      </span>
                      <em>{getFileTypeLabel(file)}</em>
                      <em>{formatBytes(file.length)}</em>
                    </label>
                  ))}
                </div>
              </div>

              <div className="download-destination">
                <span className="download-destination-check" aria-hidden="true">✓</span>
                <div>
                  <strong>下载到</strong>
                  <span>{fileDialogTask.dir || saveDir || '未选择'}</span>
                </div>
              </div>

              {saveDir && !saveDirInLibrary && (
                <div className="download-library-tip">
                  <span>保存目录尚未加入视频库，下载完成后可加入库并刷新。</span>
                  <button type="button" className="btn btn-sm btn-primary" onClick={addSaveDirToLibrary}>
                    加入库
                  </button>
                </div>
              )}

              {message && <p className="download-center-message">{message}</p>}
            </div>
            <div className="download-dialog-footer">
              <button type="button" className="btn btn-sm" onClick={cancelFileDialogTask}>
                取消
              </button>
              <button type="submit" className="btn btn-primary download-submit-btn" disabled={submitting || fileDialogIndexes.size === 0}>
                {submitting ? '处理中...' : '立即下载'}
              </button>
            </div>
          </form>
        </div>
      ), dialogTarget)}
    </>
  )
}
