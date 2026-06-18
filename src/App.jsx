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
  const [activeCategory, setActiveCategory] = useState('all')
  const [tagEditorVideo, setTagEditorVideo] = useState(null)
  const [tagEditorValue, setTagEditorValue] = useState('')
  const [ffmpegStatus, setFmpegStatus] = useState(null)
  const [mpvStatus, setMpvStatus] = useState(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const initRef = useRef(false)
  const scanRequestRef = useRef(0)
  const theme = settings?.theme || 'dark'

  const getCategoryKey = (type, name) => `${type}:${name}`
  const parseCategoryKey = (key) => {
    if (key.startsWith('custom:')) return { type: 'custom', name: key.slice(7) }
    if (key.startsWith('system:')) return { type: 'system', name: key.slice(7) }
    return { type: key, name: key }
  }

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

  async function scanAndLoad(dirPath, force = false) {
    const requestId = scanRequestRef.current + 1
    scanRequestRef.current = requestId
    setScanning(true)
    setThumbProgress(null)
    try {
      const result = await window.electronAPI.scanDirectory(dirPath, force)
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
      const currentDirectories = settings?.directories || []
      if (!currentDirectories.includes(dir)) {
        await handleDirectoriesChange({
          directories: [...currentDirectories, dir],
          defaultDirectory: dir
        })
      }
      setVideos([])
      setThumbnails({})
      setActiveCategory('all')
      await scanAndLoad(dir, true)
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
    setActiveCategory('all')
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

  const favoriteKeys = useMemo(() => new Set(settings?.favorites || []), [settings?.favorites])
  const customTags = settings?.customTags || {}

  const displayVideos = useMemo(() => (
    videos.map(video => {
      const tagKey = video.favoriteKey || video.fullPath
      const systemTags = video.tags || []
      const userTags = customTags[tagKey] || []
      const tags = [...new Set([...systemTags, ...userTags])]
      return {
        ...video,
        tags,
        systemTags,
        customTags: userTags,
        group: tags[0] || video.group
      }
    })
  ), [videos, customTags])

  const handleToggleFavorite = useCallback(async (video) => {
    const favoriteKey = video.favoriteKey || video.fullPath
    const currentFavorites = settings?.favorites || []
    const isFavorite = currentFavorites.includes(favoriteKey)
    const nextFavorites = isFavorite
      ? currentFavorites.filter(item => item !== favoriteKey)
      : [...currentFavorites, favoriteKey]
    const merged = {
      ...settings,
      favorites: nextFavorites
    }

    setSettings(merged)
    await window.electronAPI.saveSettings(merged)
  }, [settings])

  const handleSetCustomTags = useCallback(async (video, tags) => {
    const tagKey = video.favoriteKey || video.fullPath
    const nextCustomTags = {
      ...(settings?.customTags || {})
    }

    if (tags.length > 0) {
      nextCustomTags[tagKey] = tags
    } else {
      delete nextCustomTags[tagKey]
    }

    const merged = {
      ...settings,
      customTags: nextCustomTags
    }

    setSettings(merged)
    await window.electronAPI.saveSettings(merged)
  }, [settings])

  const handleOpenInFolder = useCallback(async (video) => {
    await window.electronAPI?.showInFolder(video.fullPath)
  }, [])

  const handleOpenTagEditor = useCallback((video) => {
    setTagEditorVideo(video)
    setTagEditorValue((video.customTags || []).join(', '))
  }, [])

  const handleCloseTagEditor = useCallback(() => {
    setTagEditorVideo(null)
    setTagEditorValue('')
  }, [])

  const handleSaveTagEditor = useCallback(async () => {
    if (!tagEditorVideo) return
    const tags = [...new Set(tagEditorValue.split(/[,，\s]+/).map(tag => tag.trim()).filter(Boolean))]
    await handleSetCustomTags(tagEditorVideo, tags)
    handleCloseTagEditor()
  }, [tagEditorVideo, tagEditorValue, handleSetCustomTags, handleCloseTagEditor])

  const handleClearFilters = useCallback(() => {
    setSearchQuery('')
    setActiveCategory('all')
  }, [])

  const deferredSearchQuery = useDeferredValue(searchQuery)
  const normalizedSearchQuery = useMemo(() => (
    deferredSearchQuery.trim().toLowerCase()
  ), [deferredSearchQuery])
  const trimmedSearchQuery = searchQuery.trim()

  const sortedVideos = useMemo(() => {
    return [...displayVideos].sort((a, b) => {
      switch (sortBy) {
        case 'name': return a.name.localeCompare(b.name, 'zh')
        case 'size': return b.size - a.size
        case 'date': return b.modified - a.modified
        case 'type': return a.extension.localeCompare(b.extension) || a.name.localeCompare(b.name, 'zh')
        default: return 0
      }
    })
  }, [displayVideos, sortBy])

  const categoryGroups = useMemo(() => {
    const customCounts = new Map()
    const systemCounts = new Map()
    for (const video of displayVideos) {
      for (const tag of video.customTags || []) {
        customCounts.set(tag, (customCounts.get(tag) || 0) + 1)
      }
      for (const tag of video.systemTags || []) {
        systemCounts.set(tag, (systemCounts.get(tag) || 0) + 1)
      }
    }

    const toCategories = (counts, type) => Array.from(counts.entries())
      .map(([name, count]) => ({ name, count, type, key: getCategoryKey(type, name) }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'))

    return {
      custom: toCategories(customCounts, 'custom'),
      system: toCategories(systemCounts, 'system')
    }
  }, [displayVideos])

  const favoriteCount = useMemo(() => (
    displayVideos.filter(video => favoriteKeys.has(video.favoriteKey || video.fullPath)).length
  ), [displayVideos, favoriteKeys])

  useEffect(() => {
    if (activeCategory === 'all' || activeCategory === 'favorites') return
    const category = parseCategoryKey(activeCategory)
    const exists = category.type === 'custom'
      ? categoryGroups.custom.some(item => item.name === category.name)
      : category.type === 'system'
        ? categoryGroups.system.some(item => item.name === category.name)
        : [...categoryGroups.custom, ...categoryGroups.system].some(item => item.name === activeCategory)
    if (!exists) {
      setActiveCategory('all')
    }
  }, [activeCategory, categoryGroups])

  // 过滤和排序
  const filteredVideos = useMemo(() => {
    const category = parseCategoryKey(activeCategory)
    return sortedVideos.filter(v => (
      (activeCategory === 'all' ||
        (activeCategory === 'favorites'
          ? favoriteKeys.has(v.favoriteKey || v.fullPath)
          : category.type === 'custom'
            ? (v.customTags || []).includes(category.name)
            : category.type === 'system'
              ? (v.systemTags || []).includes(category.name)
              : (v.tags || []).includes(activeCategory))) &&
      (!normalizedSearchQuery ||
        v.name.toLowerCase().includes(normalizedSearchQuery) ||
        v.fileName?.toLowerCase().includes(normalizedSearchQuery) ||
        v.group.toLowerCase().includes(normalizedSearchQuery) ||
        (v.tags || []).some(tag => tag.toLowerCase().includes(normalizedSearchQuery)))
    ))
  }, [sortedVideos, normalizedSearchQuery, activeCategory, favoriteKeys])

  const hasSearch = trimmedSearchQuery.length > 0
  const hasFilter = hasSearch || activeCategory !== 'all'
  const activeCategoryInfo = parseCategoryKey(activeCategory)
  const activeCategoryLabel = activeCategory === 'favorites'
    ? '我喜欢'
    : activeCategory === 'all'
      ? '全部'
      : activeCategoryInfo.name
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
            {hasFilter ? `${filteredVideos.length} / ${videos.length}` : videos.length} 个视频
          </span>
          <button
            className="btn btn-icon"
            title="刷新"
            onClick={() => currentDir && scanAndLoad(currentDir, true)}
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
          categoryGroups={categoryGroups}
          activeCategory={activeCategory}
          onCategoryChange={setActiveCategory}
          favoriteCount={favoriteCount}
          totalCount={videos.length}
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
            <button className="btn btn-primary" onClick={handleClearFilters}>
              {hasSearch ? '清空搜索' : '显示全部'}
            </button>
          </div>
        ) : (
          <Gallery
            videos={filteredVideos}
            totalCount={videos.length}
            searchQuery={trimmedSearchQuery}
            activeCategoryLabel={activeCategoryLabel}
            thumbnails={thumbnails}
            onPlay={handlePlay}
            favoriteKeys={favoriteKeys}
            onToggleFavorite={handleToggleFavorite}
            onOpenInFolder={handleOpenInFolder}
            onEditCustomTags={handleOpenTagEditor}
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

      {tagEditorVideo && (
        <div className="tag-editor-overlay" onClick={handleCloseTagEditor}>
          <div className="tag-editor-panel" onClick={e => e.stopPropagation()}>
            <div className="tag-editor-header">
              <h2>自定义标签</h2>
              <button className="btn btn-icon" onClick={handleCloseTagEditor} title="关闭" aria-label="关闭">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="tag-editor-body">
              <div className="tag-editor-title" title={tagEditorVideo.name}>{tagEditorVideo.name}</div>
              <label className="tag-editor-label" htmlFor="custom-tags-input">标签</label>
              <input
                id="custom-tags-input"
                className="tag-editor-input"
                value={tagEditorValue}
                onChange={e => setTagEditorValue(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleSaveTagEditor()
                  if (e.key === 'Escape') handleCloseTagEditor()
                }}
                placeholder="用逗号或空格分隔，例如 精选 横屏 角色"
                autoFocus
              />
              <p className="tag-editor-hint">留空保存会清除该视频的自定义标签。</p>
            </div>
            <div className="tag-editor-footer">
              <button className="btn btn-outline" onClick={handleCloseTagEditor}>取消</button>
              <button className="btn btn-primary" onClick={handleSaveTagEditor}>保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
