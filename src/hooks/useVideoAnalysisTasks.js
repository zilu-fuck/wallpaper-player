import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { analysisEventPatch, isAnalysisTerminal } from '../services/analysis-task-events'

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
  const id = `analysis-${Date.now()}-${Math.random().toString(36).slice(2)}`
  return {
    id,
    interestId: id,
    canCancel: true,
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
    interestId: job?.interestId,
    canCancel: Boolean(job?.canCancel),
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
  const retiredInterestsRef = useRef(new Set())
  const latestEventsRef = useRef(new Map())
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
      const result = await window.electronAPI?.startVideoAnalysis?.(task.videoPath, task.interestId)
      if (retiredInterestsRef.current.has(task.interestId)) {
        const latest = latestEventsRef.current.get(result?.job?.jobId)
        if (!result?.accepted) {
          if (runningTaskIdRef.current === task.id) runningTaskIdRef.current = ''
          updateTask(task.id, { status: 'cancelled', canCancel: false, message: '分析已取消', finishedAt: Date.now() })
        } else {
          if (isAnalysisTerminal(latest?.status) && runningTaskIdRef.current === task.id) runningTaskIdRef.current = ''
          updateTask(task.id, { status: 'running', jobId: result.job.jobId, canCancel: false, interestReleased: true,
            message: '正在取消分析', ...analysisEventPatch({ ...task, interestReleased: true }, latest) })
        }
        return
      }
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

      const latest = latestEventsRef.current.get(result.job?.jobId)
      if (isAnalysisTerminal(latest?.status) && runningTaskIdRef.current === task.id) runningTaskIdRef.current = ''
      updateTask(task.id, {
        status: 'running',
        jobId: result.job?.jobId || '',
        canCancel: result.job?.canCancel !== false,
        interestId: result.job?.interestId || task.interestId,
        message: result.job?.lastEvent?.message || '正在分析',
        stage: result.job?.lastEvent?.stage || '',
        ...analysisEventPatch(task, latest)
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
        const latest = latestEventsRef.current.get(job.jobId)
        const task = { ...createTaskFromJob(job), ...analysisEventPatch({}, latest) }
        if (!isAnalysisTerminal(task.status)) runningTaskIdRef.current = task.id
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
                    canCancel: Boolean(job.canCancel),
                    interestId: job.interestId || item.interestId,
                    message: job.lastEvent?.message || job.lastEvent?.stage || item.message || '正在分析',
                    stage: job.lastEvent?.stage || item.stage,
                    startedAt: item.startedAt || job.startedAt || Date.now(),
                    ...analysisEventPatch(item, latest)
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
      if (!payload?.videoPath || !payload.jobId) return
      const remembered = latestEventsRef.current.get(payload.jobId)
      if (isAnalysisTerminal(remembered?.status) && !isAnalysisTerminal(payload.status)) return
      latestEventsRef.current.set(payload.jobId, payload)
      while (latestEventsRef.current.size > 128) latestEventsRef.current.delete(latestEventsRef.current.keys().next().value)
      const payloadKey = pathKey(payload.videoPath)

      setTasks(prev => prev.map(task => {
        if (pathKey(task.videoPath) !== payloadKey) return task
        if (!task.jobId || task.jobId !== payload.jobId || isAnalysisTerminal(task.status)) return task
        if (isAnalysisTerminal(payload.status) && runningTaskIdRef.current === task.id) runningTaskIdRef.current = ''
        return { ...task, ...analysisEventPatch(task, payload) }
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
    if (!task || task.canCancel === false || !task.interestId) return
    retiredInterestsRef.current.add(task.interestId)
    while (retiredInterestsRef.current.size > 1024) retiredInterestsRef.current.delete(retiredInterestsRef.current.values().next().value)
    try {
      const result = await window.electronAPI?.cancelVideoAnalysis?.(task.jobId, task.interestId)
      if (!result?.success) { retiredInterestsRef.current.delete(task.interestId); updateTask(task.id, { message: '取消未确认，请重试' }); return }
      updateTask(task.id, { canCancel: false, interestReleased: true,
        message: result.shared ? '已取消本次分析，其他设备或窗口仍在分析' : '正在取消分析' })
      if (!result.shared && !result.taskCancelled) {
        if (runningTaskIdRef.current === task.id) runningTaskIdRef.current = ''
        updateTask(task.id, { status: 'cancelled', message: '分析已取消', finishedAt: Date.now() })
      }
    } catch { retiredInterestsRef.current.delete(task.interestId); updateTask(task.id, { message: '取消未确认，请重试' }) }
  }, [tasks, updateTask])

  const retryTask = useCallback((taskId) => {
    setSidebarOpen(true)
    setTasks(prev => prev.map(task => (
      task.id === taskId
        ? { ...task, interestId: `${task.id}-${Date.now().toString(36)}`, canCancel: true, interestReleased: false,
            status: 'queued', message: '等待分析', error: '', jobId: '', startedAt: null, finishedAt: null }
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
