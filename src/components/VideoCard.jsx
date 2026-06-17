import { useState, useRef, useEffect, useCallback } from 'react'

function formatFileSize(bytes) {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i]
}

export default function VideoCard({ video, thumbnail, viewMode, onPlay }) {
  const [imgLoaded, setImgLoaded] = useState(false)
  const [imgError, setImgError] = useState(false)
  const [visible, setVisible] = useState(false)
  const cardRef = useRef(null)

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

  // 获取缩略图 URL
  const thumbUrl = visible && thumbnail && !imgError
    ? `file:///${thumbnail.replace(/\\/g, '/')}`
    : null

  if (viewMode === 'list') {
    return (
      <div
        ref={cardRef}
        className="video-card-list"
        onClick={handleClick}
        onContextMenu={handleContextMenu}
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
          <span className="list-meta">
            {video.extension.toUpperCase().slice(1)} &middot; {formatFileSize(video.size)} &middot; {video.group}
          </span>
        </div>
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
      </div>

      <div className="card-info">
        <h3 className="card-title" title={video.name}>{video.name}</h3>
        <div className="card-meta">
          <span>{formatFileSize(video.size)}</span>
        </div>
      </div>
    </div>
  )
}
