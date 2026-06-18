import { useState, useEffect, useMemo, useRef, useCallback, useDeferredValue } from 'react'
import Gallery from './components/Gallery'
import VideoPlayer from './components/VideoPlayer'
import Settings from './components/Settings'
import Sidebar from './components/Sidebar'

export default function App() {
  const [videos, setVideos] = useState([])
  const [thumbnails, setThumbnails] = useState({})
  const [settings, setSettings] = useState(null)
  const [currentDir, setCurrentDir] = useState(null)
  const [playingVideo, setPlayingVideo] = useState(null)
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [thumbProgress, setThumbProgress] = useState(null)
  const [showSettings, setShowSettings] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [sortBy, setSortBy] = useState('name')
  const [ffmpegStatus, setFmpegStatus] = useState(null)
  const [mpvStatus, setMpvStatus] = useState(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const initRef = useRef(false)
  const scanRequestRef = useRef(0)
  const theme = settings?.theme || 'dark'

  // 初始化：加载设置、扫描默认目录（用 ref 防止 StrictMode 重复调用）
  useEffect(() => {
    if (initRef.current) return
    initRef.current = true
    init()
  }, [])

  // 监听缩略图生成进度（注册一次，带清理）
  useEffect(() => {
    const cleanup = window.electronAPI?.onThumbnailProgress((data) => {
      if (data?.requestId !== scanRequestRef.current) return
      setThumbProgress(data)
    })
    return cleanup
  }, [])

  async function init() {
    setLoading(true)
    try {
      const s = await window.electronAPI.getSettings()
      setSettings({
        theme: 'dark',
        ...s
      })

      const dir = s.defaultDirectory || s.directories?.[0]
      if (dir) {
        setCurrentDir(dir)
        await scanAndLoad(dir)
      } else {
        setLoading(false)
      }

      // 检查 ffmpeg（后台执行，不阻塞UI）
      window.electronAPI.checkFfmpeg().then(ff => setFmpegStatus(ff))

      // 检查 mpv
      window.electronAPI.checkMpv().then(mpv => setMpvStatus(mpv))
    } catch (err) {
      console.error('初始化失败:', err)
      setLoading(false)
    }
  }

  async function scanAndLoad(dirPath) {
    const requestId = scanRequestRef.current + 1
    scanRequestRef.current = requestId
    setScanning(true)
    setThumbProgress(null)
    try {
      const result = await window.electronAPI.scanDirectory(dirPath)
      if (requestId !== scanRequestRef.current) return
      if (result.error) {
        console.error('扫描失败:', result.error)
        setScanning(false)
        setLoading(false)
        setThumbProgress(null)
        return
      }

      setVideos(result.videos)
      setCurrentDir(dirPath)
      setLoading(false) // 扫描完成后立即显示画廊

      // 缩略图在后台异步生成，不阻塞UI
      if (result.videos.length > 0) {
        const paths = result.videos.map(v => v.fullPath)
        const thumbResults = await window.electronAPI.generateThumbnails({ paths, requestId })
        if (requestId !== scanRequestRef.current) return
        setThumbnails(thumbResults)
      }
    } catch (err) {
      if (requestId !== scanRequestRef.current) return
      console.error('扫描失败:', err)
      setLoading(false)
    }
    if (requestId !== scanRequestRef.current) return
    setScanning(false)
    setThumbProgress(null)
  }

  async function handleSelectDirectory() {
    const dir = await window.electronAPI.selectDirectory()
    if (dir) {
      setVideos([])
      setThumbnails({})
      await scanAndLoad(dir)
    }
  }

  async function handleDirectoryChange(dirPath) {
    setShowSettings(false)
    if (!dirPath) {
      scanRequestRef.current += 1
      setVideos([])
      setThumbnails({})
      setCurrentDir(null)
      setScanning(false)
      setThumbProgress(null)
      return
    }
    setVideos([])
    setThumbnails({})
    await scanAndLoad(dirPath)
  }

  const handlePlay = useCallback((video) => {
    setPlayingVideo(video)
  }, [])

  const handleClosePlayer = useCallback(() => {
    setPlayingVideo(null)
  }, [])

  async function handleSaveSettings(newSettings) {
    const merged = {
      ...settings,
      ...newSettings
    }
    await window.electronAPI.saveSettings(merged)
    setSettings(merged)
  }

  async function handleDirectoriesChange({ directories, defaultDirectory }) {
    const merged = {
      ...settings,
      directories,
      defaultDirectory
    }
    await window.electronAPI.saveSettings(merged)
    setSettings(merged)
  }

  async function handleThemeChange(nextTheme) {
    const merged = {
      ...settings,
      theme: nextTheme
    }
    await window.electronAPI.saveSettings(merged)
    setSettings(merged)
  }

  const deferredSearchQuery = useDeferredValue(searchQuery)
  const normalizedSearchQuery = useMemo(() => (
    deferredSearchQuery.trim().toLowerCase()
  ), [deferredSearchQuery])
  const trimmedSearchQuery = searchQuery.trim()

  const sortedVideos = useMemo(() => {
    return [...videos].sort((a, b) => {
      switch (sortBy) {
        case 'name': return a.name.localeCompare(b.name, 'zh')
        case 'size': return b.size - a.size
        case 'date': return b.modified - a.modified
        case 'type': return a.extension.localeCompare(b.extension) || a.name.localeCompare(b.name, 'zh')
        default: return 0
      }
    })
  }, [videos, sortBy])

  // 过滤和排序
  const filteredVideos = useMemo(() => {
    if (!normalizedSearchQuery) return sortedVideos

    return sortedVideos.filter(v => (
      v.name.toLowerCase().includes(normalizedSearchQuery) ||
      v.group.toLowerCase().includes(normalizedSearchQuery)
    ))
  }, [sortedVideos, normalizedSearchQuery])

  const hasSearch = trimmedSearchQuery.length > 0
  const activeDirName = currentDir ? currentDir.split(/[/\\]/).pop() : '未选择目录'

  if (loading) {
    return (
      <div className="app-loading">
        <div className="loading-spinner" />
        <p>正在加载...</p>
      </div>
    )
  }

  return (
    <div className={`app theme-${theme}`}>
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
              onChange={e => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button className="search-clear" onClick={() => setSearchQuery('')} title="清空搜索">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>

        <div className="header-right">
          <select
            className="sort-select"
            value={sortBy}
            onChange={e => setSortBy(e.target.value)}
          >
            <option value="name">按名称</option>
            <option value="date">按日期</option>
            <option value="size">按大小</option>
            <option value="type">按类型</option>
          </select>
          <span className="video-count" title={`当前目录: ${currentDir || '未选择'}`}>
            {hasSearch ? `${filteredVideos.length} / ${videos.length}` : videos.length} 个视频
          </span>
          <button
            className="btn btn-icon"
            title="刷新"
            onClick={() => currentDir && scanAndLoad(currentDir)}
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
        <Sidebar
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
          directories={settings?.directories || []}
          currentDir={currentDir}
          onDirectoryChange={handleDirectoryChange}
          onDirectoriesChange={handleDirectoriesChange}
          onOpenSettings={() => setShowSettings(true)}
        />

        <div className="content-body">
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
        ) : filteredVideos.length === 0 && hasSearch ? (
          <div className="empty-state compact">
            <svg width="58" height="58" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
              <path d="M8.5 8.5l5 5M13.5 8.5l-5 5" />
            </svg>
            <h2>没有匹配的视频</h2>
            <p>没有在“{activeDirName}”中找到包含“{trimmedSearchQuery}”的视频或分组。</p>
            <button className="btn btn-primary" onClick={() => setSearchQuery('')}>
              清空搜索
            </button>
          </div>
        ) : (
          <Gallery
            videos={filteredVideos}
            totalCount={videos.length}
            searchQuery={trimmedSearchQuery}
            thumbnails={thumbnails}
            onPlay={handlePlay}
          />
        )}
          </main>
        </div>
      </div>

      {/* 视频播放器 */}
      {playingVideo && (
        <VideoPlayer
          video={playingVideo}
          onClose={handleClosePlayer}
          mpvAvailable={mpvStatus?.available || false}
        />
      )}

      {/* 设置面板 */}
      {showSettings && (
        <Settings
          settings={settings}
          ffmpegStatus={ffmpegStatus}
          mpvStatus={mpvStatus}
          onMpvStatusChange={setMpvStatus}
          onSave={handleSaveSettings}
          onThemeChange={handleThemeChange}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  )
}
