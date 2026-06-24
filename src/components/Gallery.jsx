import { memo, useEffect, useMemo, useRef, useState } from 'react'
import VideoCard from './VideoCard'
import { useApp } from '../context/AppContext'

const PAGE_SIZE = 100

function clampPage(page, pageCount) {
  const numericPage = Number(page) || 1
  return Math.min(Math.max(Math.trunc(numericPage), 1), pageCount)
}

function Gallery({ videos }) {
  const {
    totalCount,
    trimmedSearchQuery,
    activeCategoryLabel,
    selectedVideoKeys,
    handleClearVideoSelection,
    handleOpenBulkTagEditor,
    analysisSidebarOpen,
    setAnalysisSidebarOpen,
    analysisTaskCounts,
    sortBy,
    hasCategoryFilter
  } = useApp()
  const [viewMode, setViewMode] = useState('grid') // grid | list
  const [currentPage, setCurrentPage] = useState(1)
  const galleryRef = useRef(null)
  const pendingPageScrollRef = useRef(false)
  const analysisTaskTotal = (
    Number(analysisTaskCounts?.running || 0) +
    Number(analysisTaskCounts?.queued || 0) +
    Number(analysisTaskCounts?.success || 0) +
    Number(analysisTaskCounts?.failed || 0)
  )
  const pageCount = Math.max(1, Math.ceil(videos.length / PAGE_SIZE))
  const safeCurrentPage = clampPage(currentPage, pageCount)
  const pageStart = (safeCurrentPage - 1) * PAGE_SIZE
  const pageEnd = Math.min(pageStart + PAGE_SIZE, videos.length)
  const pageVideos = useMemo(() => (
    videos.slice(pageStart, pageEnd)
  ), [pageEnd, pageStart, videos])
  const listIdentity = useMemo(() => {
    const first = videos[0]?.fullPath || videos[0]?.id || ''
    const last = videos[videos.length - 1]?.fullPath || videos[videos.length - 1]?.id || ''
    return `${videos.length}:${first}:${last}`
  }, [videos])

  const canGroup = hasCategoryFilter && sortBy === 'name'

  // 按分组归类视频
  const groups = useMemo(() => {
    if (!canGroup) return null
    const map = new Map()
    for (const video of videos) {
      const g = video.group || '未分组'
      if (!map.has(g)) map.set(g, [])
      map.get(g).push(video)
    }
    return map
  }, [canGroup, videos])

  const showGroups = Boolean(groups && groups.size > 1)
  const groupEntries = useMemo(() => {
    if (!showGroups) return []

    const pageGroups = new Map()
    for (let index = 0; index < pageVideos.length; index += 1) {
      const video = pageVideos[index]
      const groupName = video.group || '未分组'
      if (!pageGroups.has(groupName)) pageGroups.set(groupName, [])
      pageGroups.get(groupName).push({ video, index })
    }
    return Array.from(pageGroups.entries())
  }, [pageVideos, showGroups])

  useEffect(() => {
    galleryRef.current?.closest('.main-content')?.scrollTo({ top: 0 })
    setCurrentPage(1)
  }, [activeCategoryLabel, listIdentity, sortBy, trimmedSearchQuery])

  useEffect(() => {
    setCurrentPage(page => clampPage(page, pageCount))
  }, [pageCount])

  useEffect(() => {
    if (!pendingPageScrollRef.current) return
    pendingPageScrollRef.current = false
    galleryRef.current?.closest('.main-content')?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [safeCurrentPage])

  const goToPage = (page) => {
    const nextPage = clampPage(page, pageCount)
    setCurrentPage(current => {
      const safePage = clampPage(current, pageCount)
      if (safePage === nextPage) return current
      pendingPageScrollRef.current = true
      return nextPage
    })
  }

  const renderPagination = (placement = 'top') => {
    if (pageCount <= 1) return null

    return (
      <nav className={`gallery-pagination ${placement}`} aria-label="视频分页">
        <span className="gallery-page-range">
          {pageStart + 1}-{pageEnd} / {videos.length}
        </span>
        <button
          className="gallery-page-btn"
          type="button"
          onClick={() => goToPage(1)}
          disabled={safeCurrentPage <= 1}
          title="第一页"
          aria-label="第一页"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M11 6l-6 6 6 6" />
            <path d="M18 6l-6 6 6 6" />
          </svg>
        </button>
        <button
          className="gallery-page-btn"
          type="button"
          onClick={() => goToPage(safeCurrentPage - 1)}
          disabled={safeCurrentPage <= 1}
          title="上一页"
          aria-label="上一页"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <span className="gallery-page-status">
          第 {safeCurrentPage} / {pageCount} 页
        </span>
        <button
          className="gallery-page-btn"
          type="button"
          onClick={() => goToPage(safeCurrentPage + 1)}
          disabled={safeCurrentPage >= pageCount}
          title="下一页"
          aria-label="下一页"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
        <button
          className="gallery-page-btn"
          type="button"
          onClick={() => goToPage(pageCount)}
          disabled={safeCurrentPage >= pageCount}
          title="最后一页"
          aria-label="最后一页"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M6 6l6 6-6 6" />
            <path d="M13 6l6 6-6 6" />
          </svg>
        </button>
      </nav>
    )
  }

  if (videos.length === 0) return null

  return (
    <div className="gallery" ref={galleryRef}>
      <div className="gallery-summary">
        <span>
          {trimmedSearchQuery || activeCategoryLabel !== '全部'
            ? `${activeCategoryLabel} · ${videos.length} / ${totalCount}`
            : `${videos.length} 个视频`}
        </span>
        <span>{viewMode === 'grid' ? '网格视图' : '列表视图'} · 每页 {PAGE_SIZE}</span>
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

      {renderPagination('top')}

      {/* 视频网格 */}
      {showGroups ? (
        <div className="gallery-grouped">
          {groupEntries.map(([groupName, groupVideos]) => {
            const fullGroupVideos = groups?.get(groupName) || groupVideos.map(({ video }) => video)
            return (
              <section key={groupName} className="video-group">
                <h2 className="group-title">
                  {groupName}
                  <span className="group-count">{fullGroupVideos.length}</span>
                </h2>
                <div className={`video-${viewMode}`}>
                  {groupVideos.map(({ video, index }) => (
                    <VideoCard
                      key={video.id}
                      video={video}
                      viewMode={viewMode}
                      index={pageStart + index}
                      queueVideos={fullGroupVideos}
                    />
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      ) : (
        <div className={`video-${viewMode}`}>
          {pageVideos.map((video, idx) => (
            <VideoCard
              key={video.id}
              video={video}
              viewMode={viewMode}
              index={pageStart + idx}
              queueVideos={videos}
            />
          ))}
        </div>
      )}
      {renderPagination('bottom')}
    </div>
  )
}

export default memo(Gallery)
