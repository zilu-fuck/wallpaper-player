import { useEffect, useMemo, useState } from 'react'
import VideoAnalysisPanel from './VideoAnalysisPanel'
import { useApp } from '../context/AppContext'

function formatTime(value) {
  if (!value) return ''
  return new Date(value).toLocaleString([], {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function TaskCard({
  task,
  statusLabel,
  onOpenResult,
  onRetry,
  onDeleteSaved,
  selecting,
  selected,
  onToggleSelect
}) {
  const isDone = task.status === 'success'
  const isFailed = task.status === 'error' || task.status === 'cancelled'
  const sourceLabel = task.source === 'saved' ? '已有结果' : statusLabel
  const canDeleteSaved = task.source === 'saved' && Boolean(task.savedResultPath)
  const canSelect = selecting && canDeleteSaved

  return (
    <div
      className={`analysis-task-card ${task.status}${task.source === 'saved' ? ' saved' : ''}${selected ? ' selected' : ''}`}
      role={isDone ? 'button' : undefined}
      tabIndex={isDone ? 0 : undefined}
      onClick={() => {
        if (canSelect) {
          onToggleSelect(task.id)
          return
        }
        if (isDone) onOpenResult(task.id)
      }}
      onKeyDown={(event) => {
        if (isDone && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault()
          if (canSelect) {
            onToggleSelect(task.id)
          } else {
            onOpenResult(task.id)
          }
        }
      }}
      title={canSelect ? '选择这个分析结果' : (isDone ? '查看分析结果' : task.message)}
    >
      <div className="analysis-task-head">
        <div className="analysis-task-title">
          {canSelect ? (
            <input
              type="checkbox"
              checked={selected}
              onChange={() => onToggleSelect(task.id)}
              onClick={(event) => event.stopPropagation()}
              aria-label={`选择 ${task.videoName}`}
            />
          ) : null}
          <span className="analysis-task-name">{task.videoName}</span>
        </div>
        <div className="analysis-task-actions">
          <span className="analysis-task-status">{sourceLabel}</span>
          {canDeleteSaved && !selecting ? (
            <button
              className="analysis-task-delete"
              type="button"
              title="删除这个分析结果文件"
              onClick={(event) => {
                event.stopPropagation()
                if (window.confirm('删除这个已有分析结果？原视频不会被删除。')) {
                  onDeleteSaved(task.id)
                }
              }}
            >
              删除
            </button>
          ) : null}
        </div>
      </div>
      <p>{task.error || task.message || '等待分析'}</p>
      {task.savedResultPath ? <small title={task.savedResultPath}>最新结果文件</small> : null}
      {task.finishedAt ? <small>{formatTime(task.finishedAt)}</small> : null}
      {isFailed ? (
        <button
          className="analysis-task-retry"
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onRetry(task.id)
          }}
        >
          重试
        </button>
      ) : null}
    </div>
  )
}

export default function VideoAnalysisSidebar({
  open,
  tasks,
  counts,
  getStatusLabel,
  onClose,
  onCancelRunning,
  onRetry,
  onHideFinished,
  onRefreshSaved,
  onDeleteSaved,
  onDeleteSavedBatch = async () => {},
  savedResultsLoading,
  savedResultsMessage,
  onOpenResult
}) {
  const [selectingSaved, setSelectingSaved] = useState(false)
  const [selectedSavedIds, setSelectedSavedIds] = useState([])

  const runningTasks = tasks.filter(task => ['starting', 'running'].includes(task.status))
  const queuedTasks = tasks.filter(task => task.status === 'queued')
  const savedTasks = tasks.filter(task => task.status === 'success' && task.source === 'saved')
  const finishedTasks = tasks.filter(task => ['success', 'error', 'cancelled'].includes(task.status) && task.source !== 'saved')
  const hasTasks = tasks.length > 0
  const savedIds = useMemo(() => savedTasks.map(task => task.id), [tasks])
  const selectedSavedCount = selectedSavedIds.length

  useEffect(() => {
    setSelectedSavedIds(prev => prev.filter(id => savedIds.includes(id)))
    if (!savedIds.length) setSelectingSaved(false)
  }, [savedIds])

  if (!open) return null

  const toggleSavedSelection = (taskId) => {
    setSelectedSavedIds(prev => (
      prev.includes(taskId)
        ? prev.filter(id => id !== taskId)
        : [...prev, taskId]
    ))
  }

  const selectAllSaved = () => {
    setSelectedSavedIds(savedIds)
  }

  const clearSavedSelection = () => {
    setSelectedSavedIds([])
    setSelectingSaved(false)
  }

  const deleteSelectedSaved = async () => {
    if (!selectedSavedIds.length) return
    if (!window.confirm(`删除选中的 ${selectedSavedIds.length} 个分析结果？原视频不会被删除。`)) return
    await onDeleteSavedBatch(selectedSavedIds)
    setSelectedSavedIds([])
    setSelectingSaved(false)
  }

  return (
    <aside className="analysis-sidebar" aria-label="视频分析队列">
      <div className="analysis-sidebar-header">
        <div>
          <p>视频分析</p>
          <h2>{counts.running ? '正在分析' : counts.queued ? '等待队列' : '任务队列'}</h2>
        </div>
        <button className="analysis-icon-btn" type="button" onClick={onClose} title="收起">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="analysis-sidebar-stats">
        <span>{counts.running} 运行</span>
        <span>{counts.queued} 排队</span>
        <span>{counts.success} 完成</span>
      </div>
      <div className="analysis-sidebar-note">
        <span>{savedResultsLoading ? '正在读取已有结果...' : (savedResultsMessage || '会自动读取当前目录下已有的分析结果')}</span>
        <button type="button" onClick={onRefreshSaved} disabled={savedResultsLoading}>
          刷新
        </button>
      </div>

      {!hasTasks ? (
        <div className="analysis-sidebar-empty">
          <p>没有可显示的分析结果</p>
          <span>从视频卡片的“...”菜单里选择“分析当前视频”，或把已有结果放到设置里的分析结果目录。</span>
        </div>
      ) : null}

      {runningTasks.length ? (
        <section className="analysis-task-section">
          <div className="analysis-task-section-head">
            <span>当前进度</span>
            <button type="button" onClick={onCancelRunning}>取消</button>
          </div>
          {runningTasks.map(task => (
            <TaskCard
              key={task.id}
              task={task}
              statusLabel={getStatusLabel(task.status)}
              onOpenResult={onOpenResult}
              onRetry={onRetry}
              onDeleteSaved={onDeleteSaved}
            />
          ))}
        </section>
      ) : null}

      {queuedTasks.length ? (
        <section className="analysis-task-section">
          <div className="analysis-task-section-head">
            <span>排队</span>
            <span>{queuedTasks.length} 个</span>
          </div>
          {queuedTasks.map(task => (
            <TaskCard
              key={task.id}
              task={task}
              statusLabel={getStatusLabel(task.status)}
              onOpenResult={onOpenResult}
              onRetry={onRetry}
              onDeleteSaved={onDeleteSaved}
            />
          ))}
        </section>
      ) : null}

      {finishedTasks.length ? (
        <section className="analysis-task-section">
          <div className="analysis-task-section-head">
            <span>本次记录</span>
            <button
              type="button"
              onClick={onHideFinished}
              title="仅从任务列表隐藏已完成、失败和已取消记录，不删除磁盘上的分析结果文件"
            >
              隐藏记录
            </button>
          </div>
          {finishedTasks.map(task => (
            <TaskCard
              key={task.id}
              task={task}
              statusLabel={getStatusLabel(task.status)}
              onOpenResult={onOpenResult}
              onRetry={onRetry}
              onDeleteSaved={onDeleteSaved}
            />
          ))}
        </section>
      ) : null}

      {savedTasks.length ? (
        <section className="analysis-task-section">
          <div className="analysis-task-section-head">
            <span>已有结果</span>
            {selectingSaved ? (
              <div className="analysis-selection-actions">
                <span>{selectedSavedCount} / {savedTasks.length}</span>
                <button type="button" onClick={selectAllSaved}>全选</button>
                <button type="button" onClick={deleteSelectedSaved} disabled={!selectedSavedCount}>删除选中</button>
                <button type="button" onClick={clearSavedSelection}>取消</button>
              </div>
            ) : (
              <div className="analysis-selection-actions">
                <span>{savedTasks.length} 个</span>
                <button type="button" onClick={() => setSelectingSaved(true)}>多选</button>
              </div>
            )}
          </div>
          {savedTasks.map(task => (
            <TaskCard
              key={task.id}
              task={task}
              statusLabel={getStatusLabel(task.status)}
              onOpenResult={onOpenResult}
              onRetry={onRetry}
              onDeleteSaved={onDeleteSaved}
              selecting={selectingSaved}
              selected={selectedSavedIds.includes(task.id)}
              onToggleSelect={toggleSavedSelection}
            />
          ))}
        </section>
      ) : null}
    </aside>
  )
}

export function VideoAnalysisResultModal({ task, onClose }) {
  const { handleAppendCustomTags } = useApp()
  if (!task) return null
  const analysis = task.analysis

  return (
    <div className="analysis-result-overlay" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className="analysis-result-modal">
        {analysis?.available ? (
          <VideoAnalysisPanel
            analysis={analysis}
            currentTime={0}
            onClose={onClose}
            bindVideo={task.video}
            onAddTags={(targetVideo, tags) => handleAppendCustomTags?.([targetVideo], tags)}
          />
        ) : (
          <div className="analysis-result-fallback">
            <div className="player-analysis-head">
              <div>
                <p className="player-analysis-kicker">视频理解</p>
                <h3>{task.videoName}</h3>
              </div>
              <button className="player-analysis-close" type="button" onClick={onClose} title="关闭" aria-label="关闭">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <p>{task.error || '没有可显示的分析结果。'}</p>
          </div>
        )}
      </div>
    </div>
  )
}
