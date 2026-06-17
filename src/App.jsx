import { useState, useEffect, useCallback, useRef } from 'react'
import Gallery from './components/Gallery'
import VideoPlayer from './components/VideoPlayer'
import Settings from './components/Settings'

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
  const initRef = useRef(false)

  // 初始化：加载设置、扫描默认目录（用 ref 防止 StrictMode 重复调用）
  useEffect(() => {
    if (initRef.current) return
    initRef.current = true
    init()
  }, [])

  // 监听缩略图生成进度（注册一次，带清理）
  useEffect(() => {
    const cleanup = window.electronAPI?.onThumbnailProgress((data) => {
      setThumbProgress(data)
    })
    return cleanup
  }, [])

  async function init() {
    setLoading(true)
    try {
      const s = await window.electronAPI.getSettings()
      setSettings(s)

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
    setScanning(true)
    try {
      const result = await window.electronAPI.scanDirectory(dirPath)
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
        const thumbResults = await window.electronAPI.generateThumbnails(paths)
        setThumbnails(thumbResults)
      }
    } catch (err) {
      console.error('扫描失败:', err)
      setLoading(false)
    }
    setScanning(false)
    setThumbProgress(null)
  }

  function handleSelectDirectory() {
    setShowSettings(true)
  }

  async function handleDirectoryChange(dirPath) {
    setShowSettings(false)
    setVideos([])
    setThumbnails({})
    await scanAndLoad(dirPath)
  }

  function handlePlay(video) {
    setPlayingVideo(video)
  }

  function handleClosePlayer() {
    setPlayingVideo(null)
  }

  async function handleSaveSettings(newSettings) {
    await window.electronAPI.saveSettings(newSettings)
    setSettings(newSettings)
  }

  // 过滤和排序
  const filteredVideos = videos
    .filter(v => {
      if (!searchQuery) return true
      const q = searchQuery.toLowerCase()
      return v.name.toLowerCase().includes(q) || v.group.toLowerCase().includes(q)
    })
    .sort((a, b) => {
      switch (sortBy) {
        case 'name': return a.name.localeCompare(b.name, 'zh')
        case 'size': return b.size - a.size
        case 'date': return b.modified - a.modified
        case 'type': return a.extension.localeCompare(b.extension) || a.name.localeCompare(b.name, 'zh')
        default: return 0
      }
    })

  if (loading) {
    return (
      <div className="app-loading">
        <div className="loading-spinner" />
        <p>正在加载...</p>
      </div>
    )
  }

  return (
    <div className="app">
      {/* 顶部导航栏 */}
      <header className="header">
        <div className="header-left">
          <h1 className="header-title">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
            视频画廊
          </h1>
          {currentDir && (
            <span className="header-dir" title={currentDir}>
              {currentDir.split(/[/\\]/).pop()}
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
              placeholder="搜索视频..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button className="search-clear" onClick={() => setSearchQuery('')}>
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
          <span className="video-count">
            {filteredVideos.length} 个视频
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
          <button
            className="btn btn-icon"
            title="设置"
            onClick={() => setShowSettings(true)}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.32 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
            </svg>
          </button>
        </div>
      </header>

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
        ) : (
          <Gallery
            videos={filteredVideos}
            thumbnails={thumbnails}
            onPlay={handlePlay}
          />
        )}
      </main>

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
          onDirectoryChange={handleDirectoryChange}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  )
}
