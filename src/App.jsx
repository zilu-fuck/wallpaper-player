import { useCallback } from 'react'
import AppProvider from './components/AppProvider'
import Gallery from './components/Gallery'
import VideoPlayer from './components/VideoPlayer'
import Settings from './components/Settings'
import Sidebar from './components/Sidebar'
import TagEditor from './components/TagEditor'
import UpdateNotice from './components/UpdateNotice'
import VideoAnalysisSidebar, { VideoAnalysisResultModal } from './components/VideoAnalysisSidebar'
import { useApp } from './context/AppContext'

function AppInner() {
  const {
    loading,
    theme,
    videos,
    scanning,
    thumbProgress,
    currentDir,
    searchQuery,
    setSearchQuery,
    sortBy,
    setSortBy,
    activeCategory,
    activeCategoryLabel,
    setActiveCategory,
    filteredVideos,
    trimmedSearchQuery,
    hasFilter,
    handleSelectDirectory,
    handleOpenFile,
    handleDropFiles,
    scanAndLoad,
    playingVideo,
    showSettings,
    analysisTasks,
    analysisSidebarOpen,
    setAnalysisSidebarOpen,
    analysisTaskCounts,
    getAnalysisTaskStatusLabel,
    cancelRunningAnalysisTask,
    retryAnalysisTask,
    hideFinishedAnalysisTasks,
    deleteSavedAnalysisTask,
    deleteSavedAnalysisTasks,
    refreshSavedAnalysisResults,
    savedAnalysisResultsLoading,
    savedAnalysisResultsMessage,
    selectedAnalysisResultTask,
    openAnalysisResultTask,
    closeAnalysisResultTask
  } = useApp()

  const activeDirName = currentDir ? currentDir.split(/[/\\]/).pop() : '未选择目录'

  const onSearchChange = useCallback((e) => setSearchQuery(e.target.value), [setSearchQuery])
  const onClearSearch = useCallback(() => setSearchQuery(''), [setSearchQuery])
  const onSortChange = useCallback((e) => setSortBy(e.target.value), [setSortBy])
  const onRefresh = useCallback(() => {
    if (currentDir) scanAndLoad(currentDir, true)
  }, [currentDir, scanAndLoad])
  const onClearFilters = useCallback(() => {
    setSearchQuery('')
    setActiveCategory('all')
  }, [setSearchQuery, setActiveCategory])
  const onRootDragOver = useCallback((event) => {
    event.preventDefault()
  }, [])
  const onRootDrop = useCallback((event) => {
    event.preventDefault()
    handleDropFiles?.(Array.from(event.dataTransfer?.files || []))
  }, [handleDropFiles])

  if (loading) {
    return (
      <div className="app-loading">
        <div className="loading-spinner" />
        <p>正在加载...</p>
      </div>
    )
  }

  return (
    <div className={`app theme-${theme}`} onDragOver={onRootDragOver} onDrop={onRootDrop}>
      {/* 顶部导航栏 */}
      <header className="header">
        <div className="header-left">
          {currentDir && (
            <span className="header-dir" title={currentDir}>
              {activeDirName}
            </span>
          )}
        </div>

        <div className="header-center">
          <div className="search-box">
            <svg className="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
            <input
              type="text"
              className="search-input"
              placeholder="搜索名称或分组..."
              value={searchQuery}
              onChange={onSearchChange}
            />
            {searchQuery && (
              <button className="search-clear" onClick={onClearSearch} title="清空搜索">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>

        <div className="header-right">
          <button className="btn btn-icon" title="打开文件" onClick={handleOpenFile}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 6a2 2 0 012-2h5l2 3h7a2 2 0 012 2v9a2 2 0 01-2 2H6a2 2 0 01-2-2V6z" />
            </svg>
          </button>
          <select
            className="sort-select"
            value={sortBy}
            onChange={onSortChange}
          >
            <option value="name">按名称</option>
            <option value="date">按日期</option>
            <option value="size">按大小</option>
            <option value="type">按类型</option>
          </select>
          <span className="video-count" title={`当前目录: ${currentDir || '未选择'}`}>
            {hasFilter ? `${filteredVideos.length} / ${videos.length}` : videos.length} 个视频
          </span>
          <button
            className="btn btn-icon"
            title="刷新"
            onClick={onRefresh}
            disabled={scanning}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
            </svg>
          </button>
        </div>
      </header>

      <div className="content-row">
        <Sidebar />

        <div className={`content-body${analysisSidebarOpen ? ' analysis-sidebar-open' : ''}`}>
          {/* 缩略图生成进度条 */}
          {scanning && (
            <div className={`progress-bar${!thumbProgress ? ' scanning' : ''}`}>
              {thumbProgress && (
                <div className="progress-fill" style={{
                  width: `${(thumbProgress.completed / thumbProgress.total) * 100}%`
                }} />
              )}
              <span className="progress-text">
                {thumbProgress
                  ? `生成缩略图: ${thumbProgress.completed} / ${thumbProgress.total}`
                  : '扫描文件中...'}
              </span>
            </div>
          )}

          {/* 主内容区 */}
          <div className="main-workspace">
            <main className="main-content">
              {videos.length === 0 && !scanning ? (
                <div className="empty-state">
                  <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" />
                    <line x1="7" y1="2" x2="7" y2="22" />
                    <line x1="17" y1="2" x2="17" y2="22" />
                    <line x1="2" y1="12" x2="22" y2="12" />
                    <line x1="2" y1="7" x2="7" y2="7" />
                    <line x1="2" y1="17" x2="7" y2="17" />
                    <line x1="17" y1="7" x2="22" y2="7" />
                    <line x1="17" y1="17" x2="22" y2="17" />
                  </svg>
                  <h2>未找到视频文件</h2>
                  <p>当前目录中没有发现视频文件，请选择一个包含视频的目录。</p>
                  <button className="btn btn-primary" onClick={handleSelectDirectory}>
                    选择目录
                  </button>
                </div>
              ) : filteredVideos.length === 0 && hasFilter ? (
                <div className="empty-state compact">
                  <svg width="58" height="58" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <circle cx="11" cy="11" r="8" />
                    <path d="M21 21l-4.35-4.35" />
                    <path d="M8.5 8.5l5 5M13.5 8.5l-5 5" />
                  </svg>
                  <h2>没有匹配的视频</h2>
                  <p>
                    没有在“{activeDirName}”中找到
                    {activeCategory !== 'all' ? `“${activeCategoryLabel}”分类下` : ''}
                    {trimmedSearchQuery ? `包含“${trimmedSearchQuery}”的` : ''}
                    视频。
                  </p>
                  <button className="btn btn-primary" onClick={onClearFilters}>
                    {trimmedSearchQuery ? '清空搜索' : '显示全部'}
                  </button>
                </div>
              ) : (
                <Gallery videos={filteredVideos} />
              )}
            </main>
            <VideoAnalysisSidebar
              open={analysisSidebarOpen}
              tasks={analysisTasks}
              counts={analysisTaskCounts}
              getStatusLabel={getAnalysisTaskStatusLabel}
              onClose={() => setAnalysisSidebarOpen(false)}
              onCancelRunning={cancelRunningAnalysisTask}
              onRetry={retryAnalysisTask}
              onHideFinished={hideFinishedAnalysisTasks}
              onRefreshSaved={refreshSavedAnalysisResults}
              onDeleteSaved={deleteSavedAnalysisTask}
              onDeleteSavedBatch={deleteSavedAnalysisTasks}
              savedResultsLoading={savedAnalysisResultsLoading}
              savedResultsMessage={savedAnalysisResultsMessage}
              onOpenResult={openAnalysisResultTask}
            />
          </div>
        </div>
      </div>

      {/* 视频播放器 */}
      {playingVideo && (
        <VideoPlayer video={playingVideo} />
      )}

      {/* 设置面板 */}
      {showSettings && <Settings />}

      {/* 标签编辑器 */}
      <TagEditor />

      <VideoAnalysisResultModal
        task={selectedAnalysisResultTask}
        onClose={closeAnalysisResultTask}
      />

      <UpdateNotice />
    </div>
  )
}

export default function App() {
  return (
    <AppProvider>
      <AppInner />
    </AppProvider>
  )
}
