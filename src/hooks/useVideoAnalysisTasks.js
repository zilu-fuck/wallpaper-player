import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

function pathKey(filePath) {
  return String(filePath || '').replace(/\\/g, '/').toLowerCase()
}

function getVideoPath(video) {
  return video?.fullPath || video?.filePath || ''
}

function getVideoName(video) {
  return video?.name || String(getVideoPath(video)).split(/[/\\]/).pop() || '视频'
}

function createTask(video, status = 'queued') {
  const videoPath = getVideoPath(video)
  return {
    id: `analysis-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    video,
    videoPath,
    videoName: getVideoName(video),
    status,
    message: status === 'queued' ? '等待分析' : '正在启动分析',
    stage: '',
    jobId: '',
    analysis: null,
    savedResultPath: '',
    error: '',
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null
  }
}

function createTaskFromJob(job) {
  const videoPath = job?.videoPath || ''
  const videoName = String(videoPath).split(/[/\\]/).pop() || '视频'
  return {
    id: `analysis-job-${job?.jobId || Date.now()}`,
    video: { fullPath: videoPath, name: videoName },
    videoPath,
    videoName,
    status: 'running',
    message: job?.lastEvent?.message || job?.lastEvent?.stage || '正在分析',
    stage: job?.lastEvent?.stage || '',
    jobId: job?.jobId || '',
    analysis: null,
    savedResultPath: '',
    error: '',
    createdAt: job?.startedAt || Date.now(),
    startedAt: job?.startedAt || Date.now(),
    finishedAt: null
  }
}

function createTaskFromSavedResult(result) {
  return {
    id: result?.id || `saved-analysis-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    video: { fullPath: result?.videoPath || '', name: result?.videoName || '视频' },
    videoPath: result?.videoPath || '',
    videoName: result?.videoName || String(result?.videoPath || '').split(/[/\\]/).pop() || '视频',
    status: 'success',
    source: 'saved',
    message: '已读取已有分析结果',
    stage: '',
    jobId: '',
    analysis: result?.analysis || null,
    savedResultPath: result?.savedResultPath || result?.analysis?.savedResultPath || '',
    error: '',
    createdAt: result?.savedAt ? new Date(result.savedAt).getTime() : Date.now(),
    startedAt: null,
    finishedAt: result?.savedAt ? new Date(result.savedAt).getTime() : Date.now()
  }
}

function getStatusLabel(status) {
  switch (status) {
    case 'starting':
      return '启动中'
    case 'running':
      return '分析中'
    case 'success':
      return '已完成'
    case 'error':
      return '失败'
    case 'cancelled':
      return '已取消'
    default:
      return '排队中'
  }
}

export function useVideoAnalysisTasks({ settings, videos = [], plugins = [], pluginsLoaded = false } = {}) {
  const [tasks, setTasks] = useState([])
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [selectedResultTaskId, setSelectedResultTaskId] = useState('')
  const [savedResultsLoading, setSavedResultsLoading] = useState(false)
  const [savedResultsMessage, setSavedResultsMessage] = useState('')
  const runningTaskIdRef = useRef('')
  const startingRef = useRef(false)
  const videoAnalysisPlugin = plugins.find?.(plugin => plugin.id === 'video-analysis')
  const enabled = Boolean(pluginsLoaded && videoAnalysisPlugin?.enabled && settings?.videoAnalysis?.enabled)

  const updateTask = useCallback((taskId, patch) => {
    setTasks(prev => prev.map(task => (
      task.id === taskId ? { ...task, ...patch } : task
    )))
  }, [])

  const startTask = useCallback(async (task) => {
    if (!task?.videoPath || startingRef.current || runningTaskIdRef.current) return
    startingRef.current = true
    runningTaskIdRef.current = task.id
    updateTask(task.id, {
      status: 'starting',
      message: '正在启动分析',
      startedAt: Date.now(),
      error: ''
    })

    try {
      const result = await window.electronAPI?.startVideoAnalysis?.(task.videoPath)
      if (!result?.accepted) {
        runningTaskIdRef.current = ''
        updateTask(task.id, {
          status: 'error',
          message: '启动失败',
          error: result?.error || (result?.reason === 'already_running' ? '已有分析任务正在运行' : '无法启动视频分析'),
          finishedAt: Date.now()
        })
        return
      }

      updateTask(task.id, {
        status: 'running',
        jobId: result.job?.jobId || '',
        message: result.job?.lastEvent?.message || '正在分析',
        stage: result.job?.lastEvent?.stage || ''
      })
    } catch (err) {
      runningTaskIdRef.current = ''
      updateTask(task.id, {
        status: 'error',
        message: '启动失败',
        error: err?.message || '无法启动视频分析',
        finishedAt: Date.now()
      })
    } finally {
      startingRef.current = false
    }
  }, [updateTask])

  const startNextQueuedTask = useCallback(() => {
    if (!enabled || runningTaskIdRef.current || startingRef.current) return
    setTasks(prev => {
      const nextTask = prev.find(task => task.status === 'queued')
      if (!nextTask) return prev
      setTimeout(() => startTask(nextTask), 0)
      return prev
    })
  }, [enabled, startTask])

  useEffect(() => {
    startNextQueuedTask()
  }, [tasks, startNextQueuedTask])

  useEffect(() => {
    if (!enabled || !window.electronAPI?.getVideoAnalysisJob) return undefined

    let canceled = false
    window.electronAPI.getVideoAnalysisJob()
      .then((job) => {
        if (canceled || !job?.running || !job.videoPath || !job.jobId) return
        const task = createTaskFromJob(job)
        runningTaskIdRef.current = task.id
        setSidebarOpen(true)
        setTasks(prev => {
          const existing = prev.find(item => (
            item.jobId === job.jobId ||
            (['queued', 'starting', 'running'].includes(item.status) && pathKey(item.videoPath) === pathKey(job.videoPath))
          ))
          if (existing) {
            return prev.map(item => (
              item === existing
                ? {
                    ...item,
                    status: 'running',
                    jobId: job.jobId,
                    message: job.lastEvent?.message || job.lastEvent?.stage || item.message || '正在分析',
                    stage: job.lastEvent?.stage || item.stage,
                    startedAt: item.startedAt || job.startedAt || Date.now()
                  }
                : item
            ))
          }
          return [...prev, task]
        })
      })
      .catch(() => {})

    return () => {
      canceled = true
    }
  }, [enabled])

  const refreshSavedAnalysisResults = useCallback(async () => {
    if (!enabled || !window.electronAPI?.listSavedVideoAnalysis) return
    const requestVideos = (Array.isArray(videos) ? videos : [])
      .map(video => ({
        videoPath: getVideoPath(video),
        videoName: getVideoName(video),
        fileSizeBytes: Number(video?.size) || 0
      }))
      .filter(video => video.videoPath)

    if (!requestVideos.length) {
      setTasks(prev => prev.filter(task => task.source !== 'saved'))
      setSavedResultsMessage('')
      return
    }

    setSavedResultsLoading(true)
    try {
      const result = await window.electronAPI.listSavedVideoAnalysis(requestVideos)
      if (!result?.success) {
        setSavedResultsMessage(result?.error || '读取已有分析结果失败')
        return
      }
      const savedTasks = (result.results || []).map(createTaskFromSavedResult)
      const savedResultPaths = new Set(savedTasks.map(task => pathKey(task.savedResultPath)))
      setTasks(prev => {
        const activeOrManualTasks = prev.filter(task => (
          task.source !== 'saved' &&
          !(task.status === 'success' && task.savedResultPath && savedResultPaths.has(pathKey(task.savedResultPath)))
        ))
        return [...activeOrManualTasks, ...savedTasks]
          .sort((a, b) => (b.finishedAt || b.createdAt || 0) - (a.finishedAt || a.createdAt || 0))
          .slice(0, 80)
      })
      setSavedResultsMessage(savedTasks.length ? `已读取 ${savedTasks.length} 个已有分析结果` : '当前目录没有匹配的已有分析结果')
    } catch (err) {
      setSavedResultsMessage(err?.message || '读取已有分析结果失败')
    } finally {
      setSavedResultsLoading(false)
    }
  }, [enabled, videos])

  useEffect(() => {
    if (!sidebarOpen) return
    refreshSavedAnalysisResults()
  }, [sidebarOpen, refreshSavedAnalysisResults])

  useEffect(() => {
    if (!enabled || !window.electronAPI?.onVideoAnalysisEvent) return undefined

    const remove = window.electronAPI.onVideoAnalysisEvent((payload) => {
      if (!payload?.videoPath) return
      const payloadKey = pathKey(payload.videoPath)

      setTasks(prev => prev.map(task => {
        if (pathKey(task.videoPath) !== payloadKey) return task
        if (!['queued', 'starting', 'running'].includes(task.status) && task.jobId !== payload.jobId) return task

        if (payload.status === 'started') {
          runningTaskIdRef.current = task.id
          return {
            ...task,
            status: 'running',
            jobId: payload.jobId || task.jobId,
            message: payload.message || '开始分析当前视频',
            startedAt: task.startedAt || Date.now(),
            error: ''
          }
        }

        if (payload.status === 'running') {
          return {
            ...task,
            status: 'running',
            jobId: payload.jobId || task.jobId,
            stage: payload.event?.stage || task.stage,
            message: payload.event?.message || payload.event?.stage || '正在分析'
          }
        }

        if (payload.status === 'success') {
          if (runningTaskIdRef.current === task.id) runningTaskIdRef.current = ''
          return {
            ...task,
            status: 'success',
            source: '',
            jobId: payload.jobId || task.jobId,
            message: '分析完成',
            analysis: payload.analysis || task.analysis,
            savedResultPath: payload.savedResultPath || task.savedResultPath,
            finishedAt: Date.now()
          }
        }

        if (payload.status === 'cancelled') {
          if (runningTaskIdRef.current === task.id) runningTaskIdRef.current = ''
          return {
            ...task,
            status: 'cancelled',
            message: '分析已取消',
            error: '',
            finishedAt: Date.now()
          }
        }

        if (payload.status === 'error') {
          if (runningTaskIdRef.current === task.id) runningTaskIdRef.current = ''
          return {
            ...task,
            status: 'error',
            message: '分析失败',
            error: payload.error || '视频分析失败',
            finishedAt: Date.now()
          }
        }

        return task
      }))
    })

    return () => remove?.()
  }, [enabled])

  const queueVideoAnalysis = useCallback((video) => {
    if (!enabled || !getVideoPath(video)) return { queued: false, reason: 'disabled' }
    const videoPath = getVideoPath(video)
    let queuedTask = null
    setSidebarOpen(true)
    setTasks(prev => {
      const existing = prev.find(task => (
        ['queued', 'starting', 'running'].includes(task.status) &&
        pathKey(task.videoPath) === pathKey(videoPath)
      ))
      if (existing) {
        queuedTask = existing
        return prev
      }
      queuedTask = createTask(video, 'queued')
      return prev.length >= 60 ? [...prev.slice(1), queuedTask] : [...prev, queuedTask]
    })
    return { queued: true, task: queuedTask }
  }, [enabled])

  const cancelRunningTask = useCallback(async () => {
    const task = tasks.find(item => item.id === runningTaskIdRef.current)
    await window.electronAPI?.cancelVideoAnalysis?.(task?.jobId)
  }, [tasks])

  const retryTask = useCallback((taskId) => {
    setSidebarOpen(true)
    setTasks(prev => prev.map(task => (
      task.id === taskId
        ? { ...task, status: 'queued', message: '等待分析', error: '', jobId: '', startedAt: null, finishedAt: null }
        : task
    )))
  }, [])

  const hideFinishedTasks = useCallback(() => {
    setTasks(prev => prev.filter(task => ['queued', 'starting', 'running'].includes(task.status)))
  }, [])

  const deleteSavedAnalysisTask = useCallback(async (taskId) => {
    const task = tasks.find(item => item.id === taskId)
    if (!task?.savedResultPath || task.source !== 'saved') return
    const result = await window.electronAPI?.deleteSavedVideoAnalysis?.(task.savedResultPath)
    if (result?.success) {
      setTasks(prev => prev.filter(item => item.id !== taskId))
      setSavedResultsMessage('已删除分析结果')
      if (selectedResultTaskId === taskId) setSelectedResultTaskId('')
    } else {
      setSavedResultsMessage(result?.error || '删除分析结果失败')
    }
  }, [selectedResultTaskId, tasks])

  const deleteSavedAnalysisTasks = useCallback(async (taskIds) => {
    const idSet = new Set(Array.isArray(taskIds) ? taskIds : [])
    const targets = tasks.filter(task => (
      idSet.has(task.id) &&
      task.source === 'saved' &&
      task.savedResultPath
    ))
    if (!targets.length) return

    const deletedIds = []
    let failedCount = 0
    for (const task of targets) {
      const result = await window.electronAPI?.deleteSavedVideoAnalysis?.(task.savedResultPath)
      if (result?.success) {
        deletedIds.push(task.id)
      } else {
        failedCount += 1
      }
    }

    if (deletedIds.length) {
      setTasks(prev => prev.filter(item => !deletedIds.includes(item.id)))
      if (deletedIds.includes(selectedResultTaskId)) setSelectedResultTaskId('')
    }
    setSavedResultsMessage(failedCount
      ? `已删除 ${deletedIds.length} 个，${failedCount} 个删除失败`
      : `已删除 ${deletedIds.length} 个分析结果`)
  }, [selectedResultTaskId, tasks])

  const selectedResultTask = useMemo(
    () => tasks.find(task => task.id === selectedResultTaskId) || null,
    [selectedResultTaskId, tasks]
  )

  const counts = useMemo(() => ({
    running: tasks.filter(task => ['starting', 'running'].includes(task.status)).length,
    queued: tasks.filter(task => task.status === 'queued').length,
    success: tasks.filter(task => task.status === 'success').length,
    failed: tasks.filter(task => ['error', 'cancelled'].includes(task.status)).length
  }), [tasks])

  return {
    analysisTasks: tasks,
    analysisSidebarOpen: sidebarOpen,
    setAnalysisSidebarOpen: setSidebarOpen,
    queueVideoAnalysis,
    cancelRunningAnalysisTask: cancelRunningTask,
    retryAnalysisTask: retryTask,
    hideFinishedAnalysisTasks: hideFinishedTasks,
    deleteSavedAnalysisTask,
    deleteSavedAnalysisTasks,
    refreshSavedAnalysisResults,
    savedAnalysisResultsLoading: savedResultsLoading,
    savedAnalysisResultsMessage: savedResultsMessage,
    selectedAnalysisResultTask: selectedResultTask,
    openAnalysisResultTask: setSelectedResultTaskId,
    closeAnalysisResultTask: () => setSelectedResultTaskId(''),
    analysisTaskCounts: counts,
    getAnalysisTaskStatusLabel: getStatusLabel
  }
}
