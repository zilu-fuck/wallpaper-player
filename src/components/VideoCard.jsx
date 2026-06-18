import { memo, useState, useRef, useEffect, useCallback, useMemo } from 'react'

function formatFileSize(bytes) {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i]
}

function getDisplayMeta(video) {
  const parts = [video.extension.toUpperCase().slice(1), formatFileSize(video.size)]
  if (video.tags?.length) {
    parts.push(video.tags.slice(0, 2).join(', '))
  } else if (video.group) {
    parts.push(video.group)
  }
  return parts.join(' · ')
}

function VideoCard({
  video,
  thumbnail,
  viewMode,
  onPlay,
  isFavorite,
  onToggleFavorite,
  onOpenInFolder,
  onEditCustomTags,
  index = 0
}) {
  const [imgLoaded, setImgLoaded] = useState(false)
  const [imgError, setImgError] = useState(false)
  const [visible, setVisible] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const cardRef = useRef(null)
  const displayMeta = useMemo(() => getDisplayMeta(video), [video])
  const animationDelay = useMemo(() => `${(index % 20) * 30}ms`, [index])

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
      { rootMargin: '200px' }
    )

    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const handleClick = useCallback(() => {
    onPlay(video)
  }, [video, onPlay])

  const handleContextMenu = useCallback(async (e) => {
    e.preventDefault()
    // 在文件管理器中显示
    await window.electronAPI?.showInFolder(video.fullPath)
  }, [video.fullPath])

  const handleFavoriteClick = useCallback((e) => {
    e.stopPropagation()
    onToggleFavorite?.(video)
  }, [video, onToggleFavorite])

  const handleMenuClick = useCallback((e) => {
    e.stopPropagation()
    setMenuOpen(open => !open)
  }, [])

  const handleOpenInFolder = useCallback(async (e) => {
    e.stopPropagation()
    setMenuOpen(false)
    await onOpenInFolder?.(video)
  }, [video, onOpenInFolder])

  const handleEditTags = useCallback((e) => {
    e.stopPropagation()
    setMenuOpen(false)
    onEditCustomTags?.(video)
  }, [video, onEditCustomTags])

  useEffect(() => {
    if (!menuOpen) return

    const closeMenu = () => setMenuOpen(false)
    window.addEventListener('click', closeMenu)
    return () => window.removeEventListener('click', closeMenu)
  }, [menuOpen])

  const actionsMenu = (
    <div className="card-actions" onClick={e => e.stopPropagation()}>
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
      {menuOpen && (
        <div className="card-menu" role="menu">
          <button type="button" onClick={handleOpenInFolder} role="menuitem">在资源管理器中打开视频所在位置</button>
          <button type="button" onClick={handleEditTags} role="menuitem">自定义标签</button>
        </div>
      )}
    </div>
  )

  // 获取缩略图 URL
  const thumbUrl = visible && thumbnail && !imgError
    ? `file:///${thumbnail.replace(/\\/g, '/')}`
    : null

  useEffect(() => {
    setImgLoaded(false)
    setImgError(false)
  }, [thumbnail])

  if (viewMode === 'list') {
    return (
      <div
        ref={cardRef}
        className="video-card-list"
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
      className="video-card"
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
