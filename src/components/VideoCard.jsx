import { memo, useState, useRef, useEffect, useCallback, useMemo, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { useApp } from '../context/AppContext'

const THUMBNAIL_LOAD_DELAY_MS = 160
const METADATA_LOAD_DELAY_MS = 240
const CARD_MENU_MARGIN = 8
const CARD_MENU_OFFSET = 8
const CARD_MENU_FALLBACK_WIDTH = 230
const CARD_MENU_FALLBACK_HEIGHT = 190
const metadataRequestStates = new Map()
const pendingMetadataUpdates = new Map()
let metadataUpdateTimer = null
const METADATA_REQUEST_STATE_LIMIT = 2000

function rememberMetadataState(filePath, state) {
  metadataRequestStates.set(filePath, state)
  if (metadataRequestStates.size <= METADATA_REQUEST_STATE_LIMIT) return
  for (const key of metadataRequestStates.keys()) {
    if (metadataRequestStates.get(key) === 'pending') continue
    metadataRequestStates.delete(key)
    if (metadataRequestStates.size <= METADATA_REQUEST_STATE_LIMIT) break
  }
}

function scheduleMetadataUpdate(setVideos, filePath, media) {
  pendingMetadataUpdates.set(filePath, media)
  if (metadataUpdateTimer) return

  metadataUpdateTimer = window.setTimeout(() => {
    const updates = new Map(pendingMetadataUpdates)
    pendingMetadataUpdates.clear()
    metadataUpdateTimer = null

    setVideos(current => current.map(item => {
      const nextMedia = updates.get(item.fullPath)
      return nextMedia ? { ...item, media: nextMedia } : item
    }))
  }, 120)
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i]
}

function formatDuration(seconds) {
  const total = Math.round(Number(seconds) || 0)
  if (total <= 0) return ''
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`
}

function getDisplayMeta(video) {
  const media = video.media || {}
  const resolution = media.width && media.height ? `${media.width}×${media.height}` : ''
  const duration = formatDuration(media.durationSeconds)
  const codec = media.videoCodec ? media.videoCodec.toUpperCase() : ''
  const parts = [
    video.extension.toUpperCase().slice(1),
    duration,
    resolution,
    codec,
    formatFileSize(video.size)
  ].filter(Boolean)
  if (video.tags?.length) {
    parts.push(video.tags.slice(0, 2).join(', '))
  } else if (video.group) {
    parts.push(video.group)
  }
  return parts.join(' · ')
}

function VideoCard({
  video,
  viewMode,
  index = 0,
  queueVideos
}) {
  const {
    settings,
    plugins,
    pluginsLoaded,
    thumbnails,
    favoriteKeys,
    handlePlay,
    handleToggleFavorite,
    handleOpenInFolder,
    handleOpenTagEditor,
    queueVideoAnalysis,
    setVideos,
    selectedVideoKeys,
    selectedVideoKeySet,
    handleToggleVideoSelection,
    handleSelectOnlyVideo
  } = useApp()

  const [imgLoaded, setImgLoaded] = useState(false)
  const [imgError, setImgError] = useState(false)
  const [visible, setVisible] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPosition, setMenuPosition] = useState(null)
  const [thumbUrl, setThumbUrl] = useState(null)
  const cardRef = useRef(null)
  const actionsRef = useRef(null)
  const menuRef = useRef(null)
  const displayMeta = useMemo(() => getDisplayMeta(video), [video])
  const animationDelay = useMemo(() => `${(index % 20) * 30}ms`, [index])
  const thumbnail = thumbnails[video.fullPath]
  const isFavorite = favoriteKeys.has(video.favoriteKey || video.fullPath)
  const videoKey = video.favoriteKey || video.fullPath
  const isSelected = selectedVideoKeySet?.has(videoKey)
  const selectionActive = (selectedVideoKeys?.length || 0) > 0
  const videoAnalysisPlugin = plugins?.find?.(plugin => plugin.id === 'video-analysis')
  const videoAnalysisEnabled = Boolean(pluginsLoaded && videoAnalysisPlugin?.enabled && settings?.videoAnalysis?.enabled)
  const mediaMissing = !video.media?.available

  // 懒加载：只有卡片进入视口时才加载缩略图
  useEffect(() => {
    const el = cardRef.current
    if (!el) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true)
          observer.unobserve(el)
        }
      },
      { rootMargin: '32px' }
    )

    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const handleClick = useCallback(() => {
    if (selectionActive) {
      handleToggleVideoSelection?.(video)
      return
    }
    handlePlay(video, { queueVideos })
  }, [selectionActive, video, handleToggleVideoSelection, handlePlay, queueVideos])

  const handleContextMenu = useCallback((e) => {
    e.preventDefault()
    setMenuOpen(true)
  }, [])

  const handleFavoriteClick = useCallback((e) => {
    e.stopPropagation()
    handleToggleFavorite?.(video)
  }, [video, handleToggleFavorite])

  const handleMenuClick = useCallback((e) => {
    e.stopPropagation()
    setMenuOpen(open => !open)
  }, [])

  const handleOpenInFolderClick = useCallback(async (e) => {
    e.stopPropagation()
    setMenuOpen(false)
    await handleOpenInFolder?.(video)
  }, [video, handleOpenInFolder])

  const handleEditTags = useCallback((e) => {
    e.stopPropagation()
    setMenuOpen(false)
    handleOpenTagEditor?.(video)
  }, [video, handleOpenTagEditor])

  const handleAnalyzeVideo = useCallback((e) => {
    e.stopPropagation()
    setMenuOpen(false)
    queueVideoAnalysis?.(video)
  }, [video, queueVideoAnalysis])

  const handleToggleSelectionClick = useCallback((e) => {
    e.stopPropagation()
    setMenuOpen(false)
    handleToggleVideoSelection?.(video)
  }, [video, handleToggleVideoSelection])

  const handleSelectOnlyClick = useCallback((e) => {
    e.stopPropagation()
    setMenuOpen(false)
    handleSelectOnlyVideo?.(video)
  }, [video, handleSelectOnlyVideo])

  const updateMenuPosition = useCallback(() => {
    const anchor = actionsRef.current
    if (!anchor) return

    const rect = anchor.getBoundingClientRect()
    const menu = menuRef.current
    const width = menu?.offsetWidth || CARD_MENU_FALLBACK_WIDTH
    const height = menu?.offsetHeight || CARD_MENU_FALLBACK_HEIGHT
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight
    const maxLeft = Math.max(CARD_MENU_MARGIN, viewportWidth - width - CARD_MENU_MARGIN)
    const left = Math.round(Math.min(Math.max(CARD_MENU_MARGIN, rect.right - width), maxLeft))
    const belowTop = rect.bottom + CARD_MENU_OFFSET
    const aboveTop = rect.top - height - CARD_MENU_OFFSET
    const top = Math.round(
      belowTop + height <= viewportHeight - CARD_MENU_MARGIN
        ? belowTop
        : Math.max(CARD_MENU_MARGIN, aboveTop)
    )

    setMenuPosition(current => (
      current?.left === left && current?.top === top ? current : { left, top }
    ))
  }, [])

  useLayoutEffect(() => {
    if (!menuOpen) {
      setMenuPosition(null)
      return
    }
    updateMenuPosition()
  }, [menuOpen, updateMenuPosition])

  useEffect(() => {
    if (!menuOpen) return

    const closeMenu = () => setMenuOpen(false)
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') closeMenu()
    }
    window.addEventListener('click', closeMenu)
    window.addEventListener('resize', closeMenu)
    window.addEventListener('scroll', closeMenu, true)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('click', closeMenu)
      window.removeEventListener('resize', closeMenu)
      window.removeEventListener('scroll', closeMenu, true)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [menuOpen])

  const cardMenu = menuOpen ? createPortal(
    <div
      ref={menuRef}
      className="card-menu"
      role="menu"
      style={menuPosition ? { left: menuPosition.left, top: menuPosition.top } : undefined}
      onClick={e => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={handleAnalyzeVideo}
        role="menuitem"
        disabled={!videoAnalysisEnabled}
        title={videoAnalysisEnabled ? '分析当前视频' : '请先在设置中启用视频理解'}
      >
        分析当前视频
      </button>
      <button type="button" onClick={handleOpenInFolderClick} role="menuitem">在资源管理器中打开视频所在位置</button>
      <button type="button" onClick={handleEditTags} role="menuitem">自定义标签</button>
      <button type="button" onClick={handleToggleSelectionClick} role="menuitem">
        {isSelected ? '取消选择' : '加入多选'}
      </button>
      <button type="button" onClick={handleSelectOnlyClick} role="menuitem">从这个视频开始多选</button>
    </div>,
    document.querySelector('.app') || document.body
  ) : null

  const actionsMenu = (
    <div ref={actionsRef} className="card-actions" onClick={e => e.stopPropagation()}>
      <button
        className={`card-menu-btn${menuOpen ? ' active' : ''}`}
        onClick={handleMenuClick}
        title="更多"
        aria-label={`更多操作 ${video.name}`}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
      </button>
      {cardMenu}
    </div>
  )

  useEffect(() => {
    let canceled = false
    setImgLoaded(false)
    setImgError(false)
    setThumbUrl(null)

    if (!visible || !video.fullPath) return () => { canceled = true }

    async function loadThumbnail() {
      try {
        const thumbnailPath = thumbnail || (await window.electronAPI?.generateThumbnail?.(video.fullPath))?.thumbPath
        if (!thumbnailPath) throw new Error('thumbnail unavailable')
        const url = await window.electronAPI?.getThumbnailUrl(thumbnailPath)
        if (!canceled) setThumbUrl(url)
      } catch {
        if (!canceled) setImgError(true)
      }
    }

    const loadTimer = window.setTimeout(loadThumbnail, THUMBNAIL_LOAD_DELAY_MS)

    return () => {
      canceled = true
      window.clearTimeout(loadTimer)
    }
  }, [thumbnail, video.fullPath, visible])

  useEffect(() => {
    if (!visible || !mediaMissing || !video.fullPath || !window.electronAPI?.getVideoMetadata || !setVideos) return undefined
    if (metadataRequestStates.has(video.fullPath)) return undefined

    let requestStarted = false
    rememberMetadataState(video.fullPath, 'pending')
    async function loadMetadata() {
      requestStarted = true
      try {
        const result = await window.electronAPI.getVideoMetadata(video.fullPath)
        if (result?.success && result.media?.available) {
          rememberMetadataState(video.fullPath, 'resolved')
          scheduleMetadataUpdate(setVideos, video.fullPath, result.media)
          return
        }
        metadataRequestStates.delete(video.fullPath)
      } catch {}
      finally {
        if (metadataRequestStates.get(video.fullPath) === 'pending') {
          metadataRequestStates.delete(video.fullPath)
        }
      }
    }

    const loadTimer = window.setTimeout(loadMetadata, METADATA_LOAD_DELAY_MS + (index % 12) * 40)
    return () => {
      window.clearTimeout(loadTimer)
      if (!requestStarted && metadataRequestStates.get(video.fullPath) === 'pending') {
        metadataRequestStates.delete(video.fullPath)
      }
    }
  }, [index, mediaMissing, setVideos, video.fullPath, visible])

  if (viewMode === 'list') {
    return (
      <div
        ref={cardRef}
        className={`video-card-list${isSelected ? ' selected' : ''}`}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        title={video.name}
        style={{ animationDelay }}
      >
        <div className="list-thumb">
          {thumbUrl ? (
            <img
              src={thumbUrl}
              alt={video.name}
              onLoad={() => setImgLoaded(true)}
              onError={() => setImgError(true)}
              style={{ opacity: imgLoaded ? 1 : 0 }}
            />
          ) : null}
          {!thumbUrl || imgError ? (
            <div className="thumb-placeholder-small">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
            </div>
          ) : null}
        </div>
        <div className="list-info">
          <span className="list-name">{video.name}</span>
          <span className="list-meta">{displayMeta}</span>
        </div>
        <button
          className={`favorite-btn list-favorite-btn${isFavorite ? ' active' : ''}`}
          onClick={handleFavoriteClick}
          title={isFavorite ? '取消喜欢' : '我喜欢'}
          aria-label={isFavorite ? `取消喜欢 ${video.name}` : `喜欢 ${video.name}`}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill={isFavorite ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
            <path d="M20.8 4.6a5.5 5.5 0 00-7.8 0L12 5.6l-1-1a5.5 5.5 0 00-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 000-7.8z" />
          </svg>
        </button>
        {actionsMenu}
        {isSelected ? (
          <div className="selection-check" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
              <path d="M20 6L9 17l-5-5" />
            </svg>
          </div>
        ) : null}
        <div className="list-play-btn">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
        </div>
      </div>
    )
  }

  // 网格视图
  return (
    <div
      ref={cardRef}
      className={`video-card${isSelected ? ' selected' : ''}${menuOpen ? ' menu-open' : ''}`}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      title={video.name}
      style={{ animationDelay }}
    >
      <div className="card-thumb">
        {thumbUrl ? (
          <img
            src={thumbUrl}
            alt={video.name}
            onLoad={() => setImgLoaded(true)}
            onError={() => setImgError(true)}
            style={{ opacity: imgLoaded ? 1 : 0 }}
          />
        ) : null}

        {(!thumbUrl || imgError) && (
          <div className="thumb-placeholder">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
          </div>
        )}

        {/* 悬停播放图标 */}
        <div className="card-overlay">
          <div className="play-circle">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="6 3 20 12 6 21 6 3" />
            </svg>
          </div>
        </div>

        {/* 格式标签 */}
        <span className="card-format">{video.extension.toUpperCase().slice(1)}</span>
        <button
          className={`favorite-btn card-favorite-btn${isFavorite ? ' active' : ''}`}
          onClick={handleFavoriteClick}
          title={isFavorite ? '取消喜欢' : '我喜欢'}
          aria-label={isFavorite ? `取消喜欢 ${video.name}` : `喜欢 ${video.name}`}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill={isFavorite ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
            <path d="M20.8 4.6a5.5 5.5 0 00-7.8 0L12 5.6l-1-1a5.5 5.5 0 00-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 000-7.8z" />
          </svg>
        </button>
        {isSelected ? (
          <div className="selection-check" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
              <path d="M20 6L9 17l-5-5" />
            </svg>
          </div>
        ) : null}
      </div>

      <div className="card-info">
        <h3 className="card-title" title={video.name}>{video.name}</h3>
        <div className="card-meta">
          <span>{displayMeta}</span>
        </div>
        {actionsMenu}
        {video.tags?.length ? (
          <div className="card-tags">
            {video.tags.slice(0, 3).map(tag => (
              <span key={tag} className="card-tag">{tag}</span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export default memo(VideoCard)
