import { memo, useState, useMemo } from 'react'
import VideoCard from './VideoCard'
import { useApp } from '../context/AppContext'

function Gallery({ videos }) {
  const {
    totalCount,
    searchQuery,
    trimmedSearchQuery,
    activeCategoryLabel,
    selectedVideoKeys,
    handleClearVideoSelection,
    handleOpenBulkTagEditor,
    analysisSidebarOpen,
    setAnalysisSidebarOpen,
    analysisTaskCounts
  } = useApp()
  const [viewMode, setViewMode] = useState('grid') // grid | list
  const analysisTaskTotal = (
    Number(analysisTaskCounts?.running || 0) +
    Number(analysisTaskCounts?.queued || 0) +
    Number(analysisTaskCounts?.success || 0) +
    Number(analysisTaskCounts?.failed || 0)
  )

  // 按分组归类视频
  const groups = useMemo(() => {
    const map = new Map()
    for (const video of videos) {
      const g = video.group || '未分组'
      if (!map.has(g)) map.set(g, [])
      map.get(g).push(video)
    }
    return map
  }, [videos])

  const showGroups = groups.size > 1
  const groupEntries = useMemo(() => Array.from(groups.entries()), [groups])

  if (videos.length === 0) return null

  return (
    <div className="gallery">
      <div className="gallery-summary">
        <span>
          {trimmedSearchQuery || activeCategoryLabel !== '全部'
            ? `${activeCategoryLabel} · ${videos.length} / ${totalCount}`
            : `${videos.length} 个视频`}
        </span>
        <span>{viewMode === 'grid' ? '网格视图' : '列表视图'}</span>
      </div>

      <div className="gallery-toolbar">
        {(selectedVideoKeys?.length || 0) > 0 ? (
          <div className="bulk-selection-bar">
            <span>已选择 {selectedVideoKeys.length} 个视频</span>
            <button
              className="btn btn-sm btn-primary"
              type="button"
              onClick={() => handleOpenBulkTagEditor?.()}
            >
              批量添加标签
            </button>
            <button className="btn btn-sm" type="button" onClick={handleClearVideoSelection}>
              清空选择
            </button>
          </div>
        ) : null}
        <button
          className={`analysis-sidebar-open-btn${analysisSidebarOpen ? ' active' : ''}`}
          type="button"
          onClick={() => setAnalysisSidebarOpen?.(true)}
          title="打开视频分析队列"
          aria-label="打开视频分析队列"
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="4" y="4" width="16" height="16" rx="2" />
            <path d="M15 4v16" />
            <path d="M8 8h4M8 12h4M8 16h4" />
          </svg>
          {analysisTaskTotal > 0 ? <span>{analysisTaskTotal > 99 ? '99+' : analysisTaskTotal}</span> : null}
        </button>
        <div className="view-toggle">
          <button
            className={`view-btn ${viewMode === 'grid' ? 'active' : ''}`}
            onClick={() => setViewMode('grid')}
            title="网格视图"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
          </button>
          <button
            className={`view-btn ${viewMode === 'list' ? 'active' : ''}`}
            onClick={() => setViewMode('list')}
            title="列表视图"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <rect x="3" y="4" width="18" height="3" rx="1" />
              <rect x="3" y="10.5" width="18" height="3" rx="1" />
              <rect x="3" y="17" width="18" height="3" rx="1" />
            </svg>
          </button>
        </div>
      </div>

      {/* 视频网格 */}
      {showGroups ? (
        <div className="gallery-grouped">
          {groupEntries.map(([groupName, groupVideos]) => (
            <section key={groupName} className="video-group">
              <h2 className="group-title">
                {groupName}
                <span className="group-count">{groupVideos.length}</span>
              </h2>
              <div className={`video-${viewMode}`}>
                {groupVideos.map((video, idx) => (
                  <VideoCard
                    key={video.id}
                    video={video}
                    viewMode={viewMode}
                    index={idx}
                    queueVideos={groupVideos}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className={`video-${viewMode}`}>
          {videos.map((video, idx) => (
            <VideoCard
              key={video.id}
              video={video}
              viewMode={viewMode}
              index={idx}
              queueVideos={videos}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default memo(Gallery)
