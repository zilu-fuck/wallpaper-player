import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { WINDOW_EVENTS } from './api/events'
import AppProvider from './components/AppProvider'
import Gallery from './components/Gallery'
import VideoPlayer from './components/VideoPlayer'
import Sidebar from './components/Sidebar'
import TagEditor from './components/TagEditor'
import UpdateNotice from './components/UpdateNotice'
import RightDock from './components/RightDock'
import { useApp } from './context/AppContext'

const Settings = lazy(() => import('./components/Settings'))
const VideoAnalysisSidebar = lazy(() => import('./components/VideoAnalysisSidebar'))
const VideoAnalysisResultModal = lazy(() => import('./components/VideoAnalysisSidebar')
  .then(module => ({ default: module.VideoAnalysisResultModal })))
const AISearchPanel = lazy(() => import('./components/AISearchPanel'))
const DownloadCenter = lazy(() => import('./components/DownloadCenter'))
const NetworkResourceLibrary = lazy(() => import('./components/NetworkResourceLibrary'))

function PanelFallback({ className = '' }) {
  return (
    <div className={`lazy-panel-fallback ${className}`.trim()} role="status" aria-label="Loading">
      <div className="loading-spinner" />
    </div>
  )
}

function AppInner() {
  const {
    loading,
    theme,
    videos,
    scanning,
    scanError,
    scanErrorDir,
    currentDir,
    searchQuery,
    setSearchQuery,
    sortBy,
    setSortBy,
    activeCategory,
    activeCategoryLabel,
    hasCategoryFilter,
    setActiveCategory,
    filteredVideos,
    trimmedSearchQuery,
    hasFilter,
    settings,
    setSettings,
    settingsSaveError,
    setSettingsSaveError,
    handleDirectoriesChange,
    handleSelectDirectory,
    handleOpenFile,
    handleDropFiles,
    handlePlayNetworkResource,
    runPlayerCommand,
    scanAndLoad,
    playingVideo,
    showSettings,
    setShowSettings,
    plugins,
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
    closeAnalysisResultTask,
    queueVideoAnalysis
  } = useApp()

  const aiSearchRef = useRef(null)
  const [rightDockTab, setRightDockTab] = useState('video-analysis')
  const [unreadTabs, setUnreadTabs] = useState(() => new Set())
  const [pendingAiSearchVideo, setPendingAiSearchVideo] = useState(null)
  const [pendingDownloadRequest, setPendingDownloadRequest] = useState(null)
  const [settingsInitialPage, setSettingsInitialPage] = useState('')
  const [mainView, setMainView] = useState('local')
  const networkResources = settings?.networkResources || []
  const isNetworkView = mainView === 'network'
  // 同步镜像 rightDockTab，供事件订阅回调在 setRightDockTab updater 外同步读取，
  // 避免 onAiSearchEvent 订阅随 tab 切换频繁重建造成的事件空窗
  const rightDockTabRef = useRef(rightDockTab)
  useEffect(() => { rightDockTabRef.current = rightDockTab }, [rightDockTab])

  const isSameOrInsidePath = useCallback((parentPath, targetPath) => {
    const normalize = (value) => String(value || '')
      .replace(/[\\/]+/g, '/')
      .replace(/\/+$/, '')
      .toLowerCase()
    const parent = normalize(parentPath)
    const target = normalize(targetPath)
    return Boolean(parent && target && (target === parent || target.startsWith(`${parent}/`)))
  }, [])

  const markTabRead = useCallback((tabId) => {
    setUnreadTabs(prev => {
      if (!prev.has(tabId)) return prev
      const next = new Set(prev)
      next.delete(tabId)
      return next
    })
  }, [])

  const handleTabChange = useCallback((tabId) => {
    setRightDockTab(tabId)
    markTabRead(tabId)
    setAnalysisSidebarOpen(true)
  }, [markTabRead, setAnalysisSidebarOpen])

  const handleCloseDock = useCallback(() => {
    setAnalysisSidebarOpen(false)
  }, [setAnalysisSidebarOpen])

  // 设置关闭后重置初始页，避免下次从其他入口打开时仍停留在上次定位的页面
  useEffect(() => {
    if (!showSettings) {
      setSettingsInitialPage('')
    }
  }, [showSettings])

  const handleOpenPluginManager = useCallback(() => {
    setSettingsInitialPage('plugins')
    setShowSettings(true)
  }, [setShowSettings])

  useEffect(() => {
    const handler = (event) => {
      setPendingDownloadRequest({
        ...(event.detail || {}),
        requestId: `${Date.now()}-${Math.random().toString(36).slice(2)}`
      })
      handleTabChange('downloads')
    }
    window.addEventListener(WINDOW_EVENTS.OPEN_DOWNLOAD_CENTER, handler)
    return () => window.removeEventListener(WINDOW_EVENTS.OPEN_DOWNLOAD_CENTER, handler)
  }, [handleTabChange])

  useEffect(() => {
    const openNetworkLibrary = () => setMainView('network')
    const openLocalLibrary = () => setMainView('local')
    window.addEventListener(WINDOW_EVENTS.OPEN_NETWORK_LIBRARY, openNetworkLibrary)
    window.addEventListener(WINDOW_EVENTS.OPEN_LOCAL_LIBRARY, openLocalLibrary)
    return () => {
      window.removeEventListener(WINDOW_EVENTS.OPEN_NETWORK_LIBRARY, openNetworkLibrary)
      window.removeEventListener(WINDOW_EVENTS.OPEN_LOCAL_LIBRARY, openLocalLibrary)
    }
  }, [])

  const refreshLibraryDirectory = useCallback((dirPath) => {
    if (!dirPath) return
    const directories = settings?.directories || []
    const targetDir = currentDir && isSameOrInsidePath(currentDir, dirPath)
      ? currentDir
      : directories.find(dir => isSameOrInsidePath(dir, dirPath))
    if (targetDir) {
      scanAndLoad(targetDir, true)
    }
  }, [currentDir, isSameOrInsidePath, scanAndLoad, settings])

  useEffect(() => {
    const handler = async (event) => {
      const dir = event.detail?.dir
      if (!dir) return
      const directories = settings?.directories || []
      if (directories.some(item => isSameOrInsidePath(item, dir))) {
        window.dispatchEvent(new CustomEvent(WINDOW_EVENTS.LIBRARY_DIRECTORY_ADDED, {
          detail: { dir, alreadyAdded: true }
        }))
        refreshLibraryDirectory(dir)
        return
      }
      const privateDirectories = settings?.privateDirectories || []
      const nextDirectories = [...directories, dir]
      const defaultDirectory = settings?.defaultDirectory || dir
      await handleDirectoriesChange?.({
        directories: nextDirectories,
        privateDirectories,
        defaultDirectory
      })
      scanAndLoad(dir, true)
      window.dispatchEvent(new CustomEvent(WINDOW_EVENTS.LIBRARY_DIRECTORY_ADDED, {
        detail: { dir, alreadyAdded: false }
      }))
    }
    window.addEventListener(WINDOW_EVENTS.DOWNLOAD_ADD_LIBRARY_DIRECTORY, handler)
    return () => window.removeEventListener(WINDOW_EVENTS.DOWNLOAD_ADD_LIBRARY_DIRECTORY, handler)
  }, [handleDirectoriesChange, isSameOrInsidePath, refreshLibraryDirectory, scanAndLoad, settings])

  // 处理视频拖放到右侧
  const handleDropVideo = useCallback((video, targetTab) => {
    if (targetTab) {
      handleTabChange(targetTab)
    } else {
      setAnalysisSidebarOpen(true)
    }
    // 将视频传递给对应插件
    if (targetTab === 'ai-search') {
      // 用 state 传递，避免 Panel 刚切换挂载时 ref 未就绪导致丢失
      setPendingAiSearchVideo(video)
    } else if (targetTab === 'video-analysis') {
      queueVideoAnalysis?.(video)
    }
  }, [handleTabChange, queueVideoAnalysis, setAnalysisSidebarOpen])

  // Build right dock tabs based on enabled plugins
  const rightDockTabs = [
    {
      id: 'downloads',
      label: '下载中心',
      content: (
        <Suspense fallback={<PanelFallback className="dock" />}>
          <DownloadCenter
            pendingRequest={pendingDownloadRequest}
            onPendingRequestConsumed={() => setPendingDownloadRequest(null)}
            onRefreshLibraryDirectory={refreshLibraryDirectory}
            onSettingsChanged={setSettings}
            libraryDirectories={settings?.directories || []}
          />
        </Suspense>
      )
    }
  ]
  const aiSearchPlugin = plugins?.find(p => p.id === 'ai-search')
  const videoAnalysisPlugin = plugins?.find(p => p.id === 'video-analysis')
  if (videoAnalysisPlugin?.enabled) {
    rightDockTabs.push({
      id: 'video-analysis',
      label: '视频理解',
      content: (
        <Suspense fallback={<PanelFallback className="dock" />}>
          <VideoAnalysisSidebar
            open
            tasks={analysisTasks}
            counts={analysisTaskCounts}
            getStatusLabel={getAnalysisTaskStatusLabel}
            onClose={handleCloseDock}
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
        </Suspense>
      )
    })
  }
  if (aiSearchPlugin?.enabled) {
    rightDockTabs.push({
      id: 'ai-search',
      label: 'AI 搜索',
      content: (
        <Suspense fallback={<PanelFallback className="dock" />}>
          <AISearchPanel
            ref={aiSearchRef}
            pendingVideo={pendingAiSearchVideo}
            onPendingVideoConsumed={() => setPendingAiSearchVideo(null)}
          />
        </Suspense>
      )
    })
  }
  const rightDockTabIds = rightDockTabs.map(tab => tab.id).join('|')

  useEffect(() => {
    if (rightDockTabs.some(tab => tab.id === rightDockTab)) return
    setRightDockTab(rightDockTabs[0]?.id || 'downloads')
  }, [rightDockTab, rightDockTabIds])

  // Listen for custom event from VideoCard to open AI search
  useEffect(() => {
    const handler = (e) => {
      handleTabChange('ai-search')
      setPendingAiSearchVideo(e.detail)
    }
    window.addEventListener(WINDOW_EVENTS.AI_SEARCH, handler)
    return () => window.removeEventListener(WINDOW_EVENTS.AI_SEARCH, handler)
  }, [handleTabChange])

  // 当有新分析任务时显示未读提示
  useEffect(() => {
    const runningCount = analysisTaskCounts?.running || 0
    const queuedCount = analysisTaskCounts?.queued || 0
    if (rightDockTab !== 'video-analysis' && (runningCount > 0 || queuedCount > 0)) {
      setUnreadTabs(prev => {
        if (prev.has('video-analysis')) return prev
        const next = new Set(prev)
        next.add('video-analysis')
        return next
      })
    }
  }, [analysisTaskCounts, rightDockTab])

  // 当 AI 搜索有任务或结果时显示未读提示
  // 订阅只注册一次，通过 ref 同步读取当前 tab，避免随 tab 切换频繁取消/重订阅造成的事件空窗
  useEffect(() => {
    if (!window.electronAPI?.onAiSearchEvent) return
    const remove = window.electronAPI.onAiSearchEvent((payload) => {
      if (!payload) return
      if (['task-created', 'result', 'error'].includes(payload.type) && rightDockTabRef.current !== 'ai-search') {
        setUnreadTabs(prev => {
          if (prev.has('ai-search')) return prev
          const next = new Set(prev)
          next.add('ai-search')
          return next
        })
      }
    })
    return remove
  }, [])

  const activeDirName = currentDir ? currentDir.split(/[/\\]/).pop() : '未选择目录'

  const onSearchChange = useCallback((e) => setSearchQuery(e.target.value), [setSearchQuery])
  const onClearSearch = useCallback(() => setSearchQuery(''), [setSearchQuery])
  const onSortChange = useCallback((e) => setSortBy(e.target.value), [setSortBy])
  const onRefresh = useCallback(() => {
    if (currentDir) scanAndLoad(currentDir, true)
  }, [currentDir, scanAndLoad])
  const onRetryScan = useCallback(() => {
    if (scanErrorDir) scanAndLoad(scanErrorDir, true)
  }, [scanErrorDir, scanAndLoad])
  const onSelectDirectory = useCallback(() => {
    setMainView('local')
    handleSelectDirectory?.()
  }, [handleSelectDirectory])
  const onOpenNetworkResourceDialog = useCallback(() => {
    window.dispatchEvent(new CustomEvent(WINDOW_EVENTS.OPEN_RESOURCE_DIALOG, {
      detail: { mode: 'network' }
    }))
  }, [])
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

  useEffect(() => {
    const handleWindowShortcut = (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return
      if (showSettings || selectedAnalysisResultTask) return
      const target = event.target
      const tagName = target?.tagName?.toLowerCase?.()
      if (target?.isContentEditable || ['input', 'textarea', 'select'].includes(tagName)) return

      const key = event.key.toLowerCase()
      if (key === 'o') {
        event.preventDefault()
        handleOpenFile?.()
        return
      }
      if (!playingVideo) return

      const playerShortcuts = {
        arrowleft: ['seek-backward', 5],
        arrowright: ['seek-forward', 5],
        arrowup: ['volume-up', 5],
        arrowdown: ['volume-down', 5]
      }
      const command = playerShortcuts[key]
      if (!command) return
      event.preventDefault()
      runPlayerCommand?.(command[0], command[1])
    }

    window.addEventListener('keydown', handleWindowShortcut)
    return () => window.removeEventListener('keydown', handleWindowShortcut)
  }, [handleOpenFile, playingVideo, runPlayerCommand, selectedAnalysisResultTask, showSettings])

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
          {isNetworkView ? (
            <span className="header-dir" title="网络资源库">
              网络资源库
            </span>
          ) : currentDir && (
            <span className="header-dir" title={currentDir}>
              {activeDirName}
            </span>
          )}
        </div>

        <div className="header-center">
          {isNetworkView ? (
            <div className="header-view-chip">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M10 13a5 5 0 0 0 7.07 0l2.12-2.12a5 5 0 0 0-7.07-7.07L11 4.93" />
                <path d="M14 11a5 5 0 0 0-7.07 0L4.81 13.12a5 5 0 0 0 7.07 7.07L13 19.07" />
              </svg>
              <span>集中管理网络视频、NAS 链接和下载入口</span>
            </div>
          ) : (
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
          )}
        </div>

        <div className="header-right">
          {isNetworkView ? (
            <>
              <span className="video-count" title="网络资源数量">
                {networkResources.length} 个网络资源
              </span>
              <button className="btn btn-icon" title="添加网络资源" onClick={onOpenNetworkResourceDialog}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
            </>
          ) : (
            <>
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
            </>
          )}
        </div>
      </header>

      {settingsSaveError ? (
        <div className="settings-save-error" role="alert">
          <span>设置保存失败：{settingsSaveError}</span>
          <button type="button" onClick={() => setSettingsSaveError('')} aria-label="关闭设置保存错误">关闭</button>
        </div>
      ) : null}

      <div className="content-row">
        <Sidebar />

        <div className="content-body">
          {/* 扫描进度提示 */}
          {scanning && (
            <div className="progress-bar scanning">
              <span className="progress-text">扫描文件中...</span>
            </div>
          )}

          {/* 主内容区 */}
          <div className="main-workspace">
            <main className="main-content">
              {isNetworkView ? (
                <Suspense fallback={<PanelFallback className="main" />}>
                  <NetworkResourceLibrary
                    resources={networkResources}
                    onPlay={handlePlayNetworkResource}
                    onSettingsChanged={setSettings}
                  />
                </Suspense>
              ) : scanError && !scanning ? (
                <div className="empty-state" role="alert">
                  <h2>无法读取当前目录</h2>
                  <p>{scanError}</p>
                  <button className="btn btn-primary" onClick={onRetryScan} disabled={!scanErrorDir}>
                    重试扫描
                  </button>
                </div>
              ) : videos.length === 0 && !scanning ? (
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
                  <button className="btn btn-primary" onClick={onSelectDirectory}>
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
                    {hasCategoryFilter ? `“${activeCategoryLabel}”分类下` : ''}
                    {trimmedSearchQuery ? `包含“${trimmedSearchQuery}”的` : ''}
                    视频。
                  </p>
                  <button className="btn btn-primary" onClick={onClearFilters}>
                    {trimmedSearchQuery || hasCategoryFilter ? '清空筛选' : '显示全部'}
                  </button>
                </div>
              ) : (
                <Gallery videos={filteredVideos} />
              )}
            </main>
            <RightDock
              open={analysisSidebarOpen}
              tabs={rightDockTabs}
              activeTab={rightDockTab}
              unreadTabs={unreadTabs}
              onClose={handleCloseDock}
              onTabChange={handleTabChange}
              onDropVideo={handleDropVideo}
              onAddPlugin={handleOpenPluginManager}
            />
          </div>
        </div>
      </div>

      {/* 视频播放器 */}
      {playingVideo && (
        <VideoPlayer video={playingVideo} />
      )}

      {/* 设置面板 */}
      {showSettings && (
        <Suspense fallback={<PanelFallback className="overlay" />}>
          <Settings initialPage={settingsInitialPage} />
        </Suspense>
      )}

      {/* 标签编辑器 */}
      <TagEditor />

      {selectedAnalysisResultTask && (
        <Suspense fallback={<PanelFallback className="overlay" />}>
          <VideoAnalysisResultModal
            task={selectedAnalysisResultTask}
            onClose={closeAnalysisResultTask}
          />
        </Suspense>
      )}

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
