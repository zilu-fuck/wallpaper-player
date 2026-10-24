export const isAnalysisTerminal = status => ['success', 'error', 'cancelled'].includes(status)

export function analysisEventPatch(task, payload) {
  if (!payload) return {}
  if (payload.status === 'started' || payload.status === 'running') return {
    status: 'running', jobId: payload.jobId, startedAt: task.startedAt || Date.now(),
    stage: payload.event?.stage || task.stage || '',
    message: task.interestReleased ? '其他设备或窗口仍在分析' : payload.event?.message || payload.event?.stage || payload.message || '正在分析', error: ''
  }
  if (payload.status === 'success') return { status: 'success', canCancel: false, source: '', jobId: payload.jobId,
    message: '分析完成', analysis: payload.analysis || task.analysis, savedResultPath: payload.savedResultPath || task.savedResultPath, finishedAt: Date.now() }
  if (payload.status === 'cancelled') return { status: 'cancelled', canCancel: false, message: '分析已取消', error: '', finishedAt: Date.now() }
  if (payload.status === 'error') return { status: 'error', canCancel: false, message: '分析失败', error: payload.error || '视频分析失败', finishedAt: Date.now() }
  return {}
}
