import { forwardRef, useImperativeHandle, useState, useEffect, useCallback, useRef } from 'react'

const RELATIONSHIP_LABELS = {
  sequel: '续集',
  prequel: '前传',
  same_series: '同系列',
  spin_off: '衍生作品',
  uncertain: '不确定'
}

const STAGE_LABELS = {
  starting: '启动中',
  preparing: '准备中',
  cleaning: '清洗标题',
  searching: '搜索查询',
  browsing: '采集证据',
  reasoning: '推理分析',
  summarizing: '生成总结',
  done: '完成',
  error: '出错',
  cancelled: '已取消'
}

function formatDuration(d) {
  if (!d) return ''
  const total = Math.round(Number(d) || 0)
  if (total <= 0) return ''
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function getConfidenceLevel(confidence) {
  const pct = Number(confidence) || 0
  if (pct >= 70) return 'high'
  if (pct >= 40) return 'medium'
  return 'low'
}

function getRelationshipClass(relationship) {
  const r = (relationship || '').toLowerCase()
  if (RELATIONSHIP_LABELS[r]) return r
  return 'uncertain'
}

function getStageLabel(stage) {
  return STAGE_LABELS[stage] || stage || '过程'
}

function buildSummaryFromResults(candidates, evidenceList) {
  const count = Array.isArray(candidates) ? candidates.length : 0
  const evidenceCount = Array.isArray(evidenceList) ? evidenceList.length : 0
  if (!count) return `没有生成候选结论，参考了 ${evidenceCount} 条精选线索。`
  const top = candidates[0] || {}
  const pct = Math.round((Number(top.confidence) || 0) * 100)
  const videoCount = Number(top?.confidenceDetails?.videoEvidenceCount) || 0
  const missingTargets = Array.isArray(top?.confidenceDetails?.resultMissingTargets)
    ? top.confidenceDetails.resultMissingTargets
    : (Array.isArray(top?.confidenceDetails?.missingTargets) ? top.confidenceDetails.missingTargets : [])
  if (videoCount <= 0) {
    return `找到 ${count} 个候选结论。最可能是「${top.candidateTitle || '未知作品'}」，置信度 ${pct}%，但尚未找到真实视频/播放页。`
  }
  if (missingTargets.length > 0) {
    return `找到 ${count} 个候选结论。最可能是「${top.candidateTitle || '未知作品'}」，置信度 ${pct}%，但还缺少 ${missingTargets.join('、')} 的真实视频/播放页。`
  }
  return `找到 ${count} 个候选结论。最可能是「${top.candidateTitle || '未知作品'}」，置信度 ${pct}%，参考 ${evidenceCount} 条精选线索。`
}

function formatConfidencePercent(value) {
  return `${Math.round((Number(value) || 0) * 100)}%`
}

function buildConfidenceDetailItems(details) {
  if (!details || typeof details !== 'object') return []
  const items = [
    `标题 ${formatConfidencePercent(details.titleSimilarity)}`,
    `来源 ${details.supportingSourceCount || 0} 站`,
    `线索 ${details.matchedEvidenceCount || 0} 条`,
    `视频 ${details.videoEvidenceCount || 0} 条`,
    `质量 ${formatConfidencePercent(details.sourceQuality)}`,
    `关系 ${formatConfidencePercent(details.relationshipMatch)}`
  ]
  if (Number(details.conflictCount) > 0) items.push(`冲突 ${details.conflictCount} 条`)
  if (Array.isArray(details.matchedTargets) && details.matchedTargets.length > 0) {
    items.push(`命中 ${details.matchedTargets.join(' / ')}`)
  }
  if (Array.isArray(details.missingTargets) && details.missingTargets.length > 0) {
    items.push(`缺少 ${details.missingTargets.join(' / ')}`)
  }
  if (Array.isArray(details.resultMatchedTargets) && details.resultMatchedTargets.length > 0) {
    items.push(`整体命中 ${details.resultMatchedTargets.join(' / ')}`)
  }
  if (Array.isArray(details.resultMissingTargets) && details.resultMissingTargets.length > 0) {
    items.push(`整体缺少 ${details.resultMissingTargets.join(' / ')}`)
  }
  if (details.intentPenaltyReason) {
    items.push(`${details.intentPenaltyReason} -${formatConfidencePercent(details.intentPenalty)}`)
  }
  if (Array.isArray(details.supportingSources) && details.supportingSources.length > 0) {
    items.push(details.supportingSources.slice(0, 3).join(' / '))
  }
  return items
}

function formatProcessValue(value) {
  if (value === null || value === undefined || value === '') return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function formatProcessItem(item) {
  if (item === null || item === undefined || item === '') return ''
  if (typeof item === 'string') return item
  if (typeof item === 'number' || typeof item === 'boolean') return String(item)
  const title = item.title || item.name || item.label || item.url || ''
  const message = item.message || item.detail || item.text || item.value || ''
  if (title && message && title !== message) return `${title}: ${message}`
  return title || message || formatProcessValue(item)
}

function normalizeProcessLevel(level) {
  const value = String(level || '').toLowerCase()
  if (value === 'warn') return 'warning'
  if (['info', 'success', 'warning', 'error'].includes(value)) return value
  return 'info'
}

function createProcessItem(payload, fallback = {}) {
  const stage = payload?.stage || fallback.stage || ''
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    stage,
    title: payload?.title || fallback.title || getStageLabel(stage),
    message: payload?.message || fallback.message || '',
    detail: formatProcessValue(payload?.detail ?? fallback.detail),
    level: normalizeProcessLevel(payload?.level || fallback.level),
    items: Array.isArray(payload?.items) ? payload.items.map(formatProcessItem).filter(Boolean) : [],
    at: new Date().toLocaleTimeString()
  }
}

function deriveKeywords(videoInfo) {
  if (!videoInfo) return []
  const set = new Set()
  const title = (videoInfo.title || '')
  const tags = Array.isArray(videoInfo.tags) ? videoInfo.tags : []
  const name = (videoInfo.fileName || '')
  const group = (videoInfo.group || '')

  const cleanTitle = title
    .replace(/\.(mp4|mkv|avi|mov|wmv|flv|webm)$/i, '')
    .replace(/[_\-.]+/g, ' ')
  for (const word of cleanTitle.split(/\s+/)) {
    const trimmed = word.trim()
    if (trimmed && trimmed.length > 1) set.add(trimmed)
  }

  for (const tag of tags) {
    const t = String(tag).trim()
    if (t && !set.has(t)) set.add(t)
  }

  if (group && !set.has(group)) {
    for (const word of group.split(/[\s,;，；]+/)) {
      const trimmed = word.trim()
      if (trimmed && trimmed.length > 1) set.add(trimmed)
    }
  }

  const nameClean = name
    .replace(/\.(mp4|mkv|avi|mov|wmv|flv|webm)$/i, '')
    .replace(/[_\-.]+/g, ' ')
  for (const word of nameClean.split(/\s+/)) {
    const trimmed = word.trim()
    if (trimmed && trimmed.length > 1) set.add(trimmed)
  }

  return Array.from(set).slice(0, 12)
}

const AISearchPanel = forwardRef(function AISearchPanel({ pendingVideo, onPendingVideoConsumed }, ref) {
  const [videoInfo, setVideoInfo] = useState(null)
  const [keywords, setKeywords] = useState([])
  const [searchIntent, setSearchIntent] = useState('auto')
  const [searching, setSearching] = useState(false)
  const [taskId, setTaskId] = useState(null)
  const [progress, setProgress] = useState({ stage: '', message: '' })
  const [results, setResults] = useState([])
  const [evidence, setEvidence] = useState([])
  const [error, setError] = useState(null)
  const [processItems, setProcessItems] = useState([])
  const [summary, setSummary] = useState('')
  const [detailsCollapsed, setDetailsCollapsed] = useState(false)
  const [addKeywordInput, setAddKeywordInput] = useState('')
  const [feedbackState, setFeedbackState] = useState({})
  const cleanupRef = useRef(null)
  const taskIdRef = useRef(null)
  const pendingStartRef = useRef(false)
  const startVersionRef = useRef(0)

  const setCurrentTaskId = useCallback((nextTaskId) => {
    taskIdRef.current = nextTaskId || null
    setTaskId(nextTaskId || null)
  }, [])

  const cancelCurrentTask = useCallback((reason = 'replace') => {
    const currentTaskId = taskIdRef.current
    startVersionRef.current += 1
    pendingStartRef.current = false
    taskIdRef.current = null
    if (currentTaskId && window.electronAPI?.cancelAiSearch) {
      window.electronAPI.cancelAiSearch(currentTaskId).catch((err) => {
        console.error(`${reason} 时取消 AI 搜索失败:`, err)
      })
    }
  }, [])

  const appendProcessItem = useCallback((payload, fallback) => {
    setProcessItems(prev => {
      const next = [...prev, createProcessItem(payload, fallback)]
      return next.slice(-80)
    })
  }, [])

  // 内部复用：重置状态并应用新视频
  const applyVideo = useCallback((info) => {
    cancelCurrentTask('切换视频')
    setVideoInfo(info)
    setError(null)
    setResults([])
    setEvidence([])
    setProcessItems([])
    setFeedbackState({})
    setSummary('')
    setDetailsCollapsed(false)
    setProgress({ stage: '', message: '' })
    setSearching(false)
    setCurrentTaskId(null)
    setKeywords(deriveKeywords(info))
    setSearchIntent('auto')
  }, [cancelCurrentTask, setCurrentTaskId])

  useImperativeHandle(ref, () => ({
    setVideo(info) {
      applyVideo(info)
    }
  }), [applyVideo])

  // 处理来自外层 state 的 pending 视频（拖放 / 右键菜单），
  // 比 ref 命令式调用更稳健：Panel 刚挂载时也能在 effect 中拿到
  useEffect(() => {
    if (!pendingVideo) return
    applyVideo(pendingVideo)
    onPendingVideoConsumed?.()
  }, [pendingVideo, applyVideo, onPendingVideoConsumed])

  useEffect(() => {
    if (!window.electronAPI?.onAiSearchEvent) return

    const remove = window.electronAPI.onAiSearchEvent((payload) => {
      if (!payload || !payload.type) return
      const eventTaskId = typeof payload.taskId === 'string' ? payload.taskId : ''

      switch (payload.type) {
        case 'task-created':
          if (!pendingStartRef.current) return
          setCurrentTaskId(eventTaskId)
          setSearching(true)
          setError(null)
          setProgress({ stage: 'preparing', message: '准备中...' })
          appendProcessItem(payload, {
            stage: 'preparing',
            title: '任务已创建',
            message: '开始整理视频信息和搜索计划'
          })
          break
        case 'progress':
          if (!eventTaskId || taskIdRef.current !== eventTaskId) return
          setProgress({
            stage: payload.stage || '',
            message: payload.message || ''
          })
          appendProcessItem(payload, {
            title: getStageLabel(payload.stage),
            message: payload.message || ''
          })
          break
        case 'detail':
          if (!eventTaskId || taskIdRef.current !== eventTaskId) return
          appendProcessItem(payload)
          break
        case 'result':
          if (!eventTaskId || taskIdRef.current !== eventTaskId) return
          setSearching(false)
          setCurrentTaskId(null)
          setProgress({ stage: '', message: '' })
          if (payload.candidates) setResults(payload.candidates)
          if (payload.evidence) setEvidence(payload.evidence)
          {
            const nextSummary = buildSummaryFromResults(payload.candidates, payload.evidence)
            setSummary(nextSummary)
            appendProcessItem({
              stage: 'summarizing',
              title: '总结',
              message: nextSummary,
              level: 'success'
            })
            setDetailsCollapsed(true)
          }
          break
        case 'error':
          if (!eventTaskId || taskIdRef.current !== eventTaskId) return
          setSearching(false)
          setCurrentTaskId(null)
          setProgress({ stage: '', message: '' })
          setError(payload.message || payload.error || '搜索失败')
          setSummary(payload.message || payload.error || '搜索失败')
          appendProcessItem({
            stage: 'summarizing',
            title: '搜索失败',
            message: payload.message || payload.error || '搜索失败',
            level: 'error'
          })
          setDetailsCollapsed(false)
          break
        case 'cancelled':
          if (!eventTaskId || taskIdRef.current !== eventTaskId) return
          setSearching(false)
          setCurrentTaskId(null)
          setProgress({ stage: '', message: '' })
          setSummary('搜索已取消，已保留当前过程。')
          appendProcessItem({
            stage: 'cancelled',
            title: '已取消',
            message: '搜索已取消，已保留当前过程。',
            level: 'warning'
          })
          setDetailsCollapsed(false)
          break
        default:
          break
      }
    })

    cleanupRef.current = remove

    return () => {
      if (typeof cleanupRef.current === 'function') {
        cleanupRef.current()
      }
    }
  }, [appendProcessItem, setCurrentTaskId])

  const handleStartSearch = useCallback(async () => {
    if (!videoInfo || searching) return
    setError(null)
    setResults([])
    setEvidence([])
    setFeedbackState({})
    setProcessItems([
      createProcessItem({
        stage: 'starting',
        title: '开始搜索',
        message: videoInfo.title || videoInfo.fileName || '当前视频'
      })
    ])
    setSummary('')
    setDetailsCollapsed(false)
    setProgress({ stage: 'starting', message: '正在启动搜索...' })
    setSearching(true)
    const startVersion = startVersionRef.current + 1
    startVersionRef.current = startVersion
    pendingStartRef.current = true

    try {
      const result = await window.electronAPI.startAiSearch({
        title: videoInfo.title || '',
        filePath: videoInfo.filePath || '',
        fileName: videoInfo.fileName || '',
        tags: videoInfo.tags || [],
        group: videoInfo.group || '',
        description: videoInfo.description || '',
        duration: videoInfo.duration || '',
        resolution: videoInfo.resolution || '',
        keywords,
        searchIntent
      })
      if (startVersion !== startVersionRef.current) {
        if (result?.success && result.taskId) {
          window.electronAPI.cancelAiSearch?.(result.taskId).catch(() => {})
        }
        return
      }
      pendingStartRef.current = false
      if (result?.success) {
        setCurrentTaskId(result.taskId)
        setSearching(true)
      } else {
        setSearching(false)
        setProgress({ stage: '', message: '' })
        const message = result?.error || '启动搜索失败'
        setError(message)
        setSummary(message)
        appendProcessItem({
          stage: 'starting',
          title: '启动失败',
          message,
          level: 'error'
        })
      }
    } catch (err) {
      if (startVersion !== startVersionRef.current) return
      pendingStartRef.current = false
      setSearching(false)
      setProgress({ stage: '', message: '' })
      const message = err?.message || '启动搜索失败'
      setError(message)
      setSummary(message)
      appendProcessItem({
        stage: 'starting',
        title: '启动失败',
        message,
        level: 'error'
      })
    }
  }, [appendProcessItem, videoInfo, searching, keywords, searchIntent, setCurrentTaskId])

  const handleCancelSearch = useCallback(async () => {
    const currentTaskId = taskIdRef.current
    if (!currentTaskId) {
      startVersionRef.current += 1
      pendingStartRef.current = false
      setSearching(false)
      setProgress({ stage: '', message: '' })
      setSummary('搜索已取消，已保留当前过程。')
      appendProcessItem({
        stage: 'cancelled',
        title: '已取消',
        message: '搜索已取消，已保留当前过程。',
        level: 'warning'
      })
      setDetailsCollapsed(false)
      return
    }
    cancelCurrentTask('手动取消')
    setSearching(false)
    setCurrentTaskId(null)
    setProgress({ stage: '', message: '' })
    setSummary('搜索已取消，已保留当前过程。')
    appendProcessItem({
      stage: 'cancelled',
      title: '已取消',
      message: '搜索已取消，已保留当前过程。',
      level: 'warning'
    })
    setDetailsCollapsed(false)
  }, [appendProcessItem, cancelCurrentTask, setCurrentTaskId])

  const handleClearVideo = useCallback(() => {
    cancelCurrentTask('清除视频')
    setVideoInfo(null)
    setKeywords([])
    setResults([])
    setEvidence([])
    setFeedbackState({})
    setError(null)
    setProcessItems([])
    setSummary('')
    setDetailsCollapsed(false)
    setProgress({ stage: '', message: '' })
    setSearching(false)
    setCurrentTaskId(null)
  }, [cancelCurrentTask, setCurrentTaskId])

  const handleRemoveKeyword = useCallback((keyword) => {
    setKeywords(prev => prev.filter(k => k !== keyword))
  }, [])

  const handleAddKeyword = useCallback(() => {
    const trimmed = addKeywordInput.trim()
    if (!trimmed) return
    setKeywords(prev => prev.includes(trimmed) ? prev : [...prev, trimmed])
    setAddKeywordInput('')
  }, [addKeywordInput])

  const handleAddKeywordKeyDown = useCallback((e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleAddKeyword()
    }
  }, [handleAddKeyword])

  const handleRateResult = useCallback(async (item, rating, feedbackKey) => {
    const key = feedbackKey || item.id || item.candidateTitle || String(rating)
    setFeedbackState(prev => ({ ...prev, [key]: { rating, saving: true, message: '' } }))
    const videoEvidenceCount = Number(item?.confidenceDetails?.videoEvidenceCount) || 0
    const issue = rating >= 4
      ? '这次结果可用'
      : videoEvidenceCount <= 0
        ? '没有找到真实视频/播放页链接'
        : '结果不够准确或链接不满意'
    try {
      const result = await window.electronAPI?.submitAiSearchFeedback?.({
        rating,
        issue,
        videoTitle: videoInfo?.title || videoInfo?.fileName || '',
        searchIntent,
        candidateTitle: item?.candidateTitle || '',
        topSourceUrls: Array.isArray(item?.sourceUrls) ? item.sourceUrls : [],
        videoEvidenceCount
      })
      if (!result?.success) throw new Error(result?.error || '保存评分失败')
      setFeedbackState(prev => ({ ...prev, [key]: { rating, saving: false, message: '已记住' } }))
      appendProcessItem({
        stage: 'summarizing',
        title: '已记录评分',
        message: rating >= 4 ? '这次评分已保存。' : '下次会优先避免同类问题，继续补搜真实播放页。',
        level: rating >= 4 ? 'success' : 'warning'
      })
    } catch (err) {
      setFeedbackState(prev => ({ ...prev, [key]: { rating, saving: false, message: err?.message || '保存失败' } }))
    }
  }, [appendProcessItem, searchIntent, videoInfo])

  const intentButtons = [
    { id: 'auto', label: '自动判断' },
    { id: 'sequel', label: '找续集' },
    { id: 'same_series', label: '找同系列' },
    { id: 'watch_order', label: '找观看顺序' }
  ]
  const summaryTone = error ? 'error' : summary === '搜索已取消，已保留当前过程。' ? 'warning' : ''
  const summaryLabel = error ? '搜索异常' : summaryTone === 'warning' ? '搜索取消' : '搜索总结'

  return (
    <div className="ai-search-panel">
      {/* 1. 视频信息卡片 */}
      {!videoInfo ? (
        <div className="ai-search-drop-zone">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          <span>拖拽视频到此处</span>
          <span className="ai-search-drop-zone-sub">或从视频卡片右键菜单发送到 AI 搜索</span>
        </div>
      ) : (
        <div className="ai-search-video-card">
          <div className="ai-search-video-header">
            <h3 title={videoInfo.title || videoInfo.fileName}>
              {videoInfo.title || videoInfo.fileName || '未知视频'}
            </h3>
            <button type="button" onClick={handleClearVideo} title="清除">
              清除
            </button>
          </div>
          {videoInfo.fileName && videoInfo.fileName !== videoInfo.title ? (
            <div className="ai-search-filename">{videoInfo.fileName}</div>
          ) : null}
          <div className="ai-search-meta">
            {Array.isArray(videoInfo.tags) && videoInfo.tags.length > 0 ? (
              <div className="ai-search-meta-item">
                <span className="ai-search-meta-label">标签</span>
                <span className="ai-search-meta-value">{videoInfo.tags.join(', ')}</span>
              </div>
            ) : null}
            {videoInfo.group ? (
              <div className="ai-search-meta-item">
                <span className="ai-search-meta-label">分组</span>
                <span className="ai-search-meta-value">{videoInfo.group}</span>
              </div>
            ) : null}
            {videoInfo.description ? (
              <div className="ai-search-meta-item ai-search-description">
                <span className="ai-search-meta-label">描述</span>
                <span className="ai-search-meta-value">{videoInfo.description}</span>
              </div>
            ) : null}
            <div className="ai-search-meta-row">
              {videoInfo.duration ? (
                <div className="ai-search-meta-item">
                  <span className="ai-search-meta-label">时长</span>
                  <span className="ai-search-meta-value">{formatDuration(videoInfo.duration)}</span>
                </div>
              ) : null}
              {videoInfo.resolution ? (
                <div className="ai-search-meta-item">
                  <span className="ai-search-meta-label">分辨率</span>
                  <span className="ai-search-meta-value">{videoInfo.resolution}</span>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {/* 2. 关键词 */}
      {videoInfo ? (
        <div className="ai-search-keywords-section">
          <div className="ai-search-keywords-header">
            <span className="ai-search-section-title">搜索关键词</span>
            <span className="ai-search-keywords-count">{keywords.length} 个</span>
          </div>
          <div className="ai-search-keywords">
            {keywords.map(kw => (
              <span key={kw} className="ai-search-keyword">
                {kw}
                <button type="button" onClick={() => handleRemoveKeyword(kw)} title="移除" aria-label={`移除 ${kw}`}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </span>
            ))}
            <div className="ai-search-keyword-input-wrap">
              <input
                type="text"
                className="ai-search-keyword-input"
                value={addKeywordInput}
                onChange={e => setAddKeywordInput(e.target.value)}
                onKeyDown={handleAddKeywordKeyDown}
                placeholder="添加关键词..."
              />
              {addKeywordInput.trim() ? (
                <button type="button" className="ai-search-keyword-add" onClick={handleAddKeyword}>
                  添加
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {/* 3. 搜索意图 */}
      {videoInfo ? (
        <div className="ai-search-intent-section">
          <span className="ai-search-section-title">搜索意图</span>
          <div className="ai-search-intent-bar">
            {intentButtons.map(btn => (
              <button
                key={btn.id}
                type="button"
                className={`ai-search-intent-btn${searchIntent === btn.id ? ' active' : ''}`}
                onClick={() => setSearchIntent(btn.id)}
              >
                {btn.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* 4. 操作按钮 */}
      {videoInfo ? (
        <div className="ai-search-actions">
          <button
            type="button"
            className="ai-search-start-btn"
            onClick={handleStartSearch}
            disabled={!videoInfo || searching}
          >
            {searching ? (
              <>
                <span className="ai-search-spinner" />
                搜索中...
              </>
            ) : '开始搜索'}
          </button>
          {searching ? (
            <button type="button" className="ai-search-cancel-btn" onClick={handleCancelSearch}>
              取消搜索
            </button>
          ) : null}
        </div>
      ) : null}

      {/* 5. 过程对话 */}
      {(processItems.length > 0 || summary || (searching && progress.stage)) ? (
        <div className={`ai-search-conversation${detailsCollapsed ? ' collapsed' : ''}`}>
          {summary ? (
            <div className={`ai-search-summary${summaryTone ? ` ${summaryTone}` : ''}`}>
              <div>
                <span className="ai-search-summary-label">{summaryLabel}</span>
                <p>{summary}</p>
              </div>
              {processItems.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setDetailsCollapsed(prev => !prev)}
                >
                  {detailsCollapsed ? '展开过程' : '收起过程'}
                </button>
              ) : null}
            </div>
          ) : null}

          {!detailsCollapsed ? (
            <div className="ai-search-process-list">
              {searching && progress.stage ? (
                <div className="ai-search-process-current">
                  <span className="ai-search-spinner" />
                  <div>
                    <strong>{getStageLabel(progress.stage)}</strong>
                    <span>{progress.message || '正在处理...'}</span>
                  </div>
                </div>
              ) : null}
              {processItems.map(item => (
                <div key={item.id} className={`ai-search-process-item ${item.level || 'info'}`}>
                  <div className="ai-search-process-avatar">
                    {item.level === 'error' ? '!' : item.level === 'warning' ? '?' : item.level === 'success' ? 'OK' : 'AI'}
                  </div>
                  <div className="ai-search-process-bubble">
                    <div className="ai-search-process-head">
                      <span>{item.title || getStageLabel(item.stage)}</span>
                      <small>{getStageLabel(item.stage)} · {item.at}</small>
                    </div>
                    {item.message ? <p>{item.message}</p> : null}
                    {item.detail ? <code>{item.detail}</code> : null}
                    {item.items.length > 0 ? (
                      <ul>
                        {item.items.map((entry, idx) => <li key={idx}>{entry}</li>)}
                      </ul>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <button
              type="button"
              className="ai-search-process-collapsed"
              onClick={() => setDetailsCollapsed(false)}
            >
              已收起 {processItems.length} 条搜索过程
            </button>
          )}
        </div>
      ) : null}

      {/* 6. 错误 */}
      {error ? (
        <div className="ai-search-error">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          {error}
        </div>
      ) : null}

      {/* 7. 结果 */}
      {results.length > 0 ? (
        <div className="ai-search-results">
          <div className="ai-search-results-header">
            搜索结果 <span>{results.length}</span>
          </div>
          {results.map((item, idx) => {
            const pct = Math.round((Number(item.confidence) || 0) * 100)
            const level = getConfidenceLevel(pct)
            const relClass = getRelationshipClass(item.relationship)
            const confidenceDetailItems = buildConfidenceDetailItems(item.confidenceDetails)
            const feedbackKey = item.id || item.candidateTitle || String(idx)
            const feedback = feedbackState[feedbackKey]
            return (
              <div key={item.id || idx} className="ai-search-result-card">
                <div className="ai-search-result-head">
                  <h3 title={item.candidateTitle || '未知'}>{item.candidateTitle || '未知'}</h3>
                  <span className={`ai-search-relationship-badge ${relClass}`}>
                    {RELATIONSHIP_LABELS[relClass] || item.relationship || '不确定'}
                  </span>
                </div>

                <div className="ai-search-confidence">
                  <div className="ai-search-confidence-bar">
                    <div className={`ai-search-confidence-fill ${level}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                  </div>
                  <span>置信度 {pct}%</span>
                </div>

                {confidenceDetailItems.length > 0 ? (
                  <div className="ai-search-confidence-details">
                    {confidenceDetailItems.map(detail => (
                      <span key={detail}>{detail}</span>
                    ))}
                  </div>
                ) : null}

                {Array.isArray(item.evidence) && item.evidence.length > 0 ? (
                  <ul className="ai-search-evidence">
                    {item.evidence.map((ev, ei) => (
                      <li key={ei}>{ev}</li>
                    ))}
                  </ul>
                ) : null}

                {Array.isArray(item.conflicts) && item.conflicts.length > 0 ? (
                  <ul className="ai-search-conflicts">
                    {item.conflicts.map((cf, ci) => (
                      <li key={ci}>{cf}</li>
                    ))}
                  </ul>
                ) : null}

                {Array.isArray(item.sourceUrls) && item.sourceUrls.length > 0 ? (
                  <div className="ai-search-sources">
                    {item.sourceUrls.map((url, ui) => (
                      <a
                        key={ui}
                        className="ai-search-source-link"
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {url}
                      </a>
                    ))}
                  </div>
                ) : null}

                {item.reason ? (
                  <div className="ai-search-reason">{item.reason}</div>
                ) : null}

                <div className="ai-search-feedback">
                  <span>这次找得怎么样</span>
                  <div className="ai-search-rating">
                    {[1, 2, 3, 4, 5].map(score => (
                      <button
                        key={score}
                        type="button"
                        className={Number(feedback?.rating) >= score ? 'active' : ''}
                        onClick={() => handleRateResult(item, score, feedbackKey)}
                        disabled={feedback?.saving}
                        title={`${score} 分`}
                      >
                        {score}
                      </button>
                    ))}
                  </div>
                  {feedback?.message ? <small>{feedback.message}</small> : null}
                </div>
              </div>
            )
          })}
        </div>
      ) : null}

      {evidence.length > 0 && results.length === 0 ? (
        <div className="ai-search-evidence-section">
          <div className="ai-search-results-header">线索</div>
          {evidence.map((ev, idx) => (
            <div key={idx} className="ai-search-evidence-item">
              {ev.title || ev.url || String(ev)}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
})

export default AISearchPanel
