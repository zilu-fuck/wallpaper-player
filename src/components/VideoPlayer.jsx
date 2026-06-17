import { useRef, useEffect, useState, useCallback } from 'react'

export default function VideoPlayer({ video, onClose, mpvAvailable }) {
  const videoRef = useRef(null)
  const containerRef = useRef(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [mode, setMode] = useState(mpvAvailable ? 'mpv' : 'html5')
  const [mpvStatus, setMpvStatus] = useState(mpvAvailable ? 'launching' : 'idle')
  const [mpvError, setMpvError] = useState(null)

  // ─── mpv 模式 ──────────────────────────────────────
  useEffect(() => {
    if (mode !== 'mpv') return

    let removeEnded, removeEvent, removeError

    async function launchMpv() {
      try {
        setMpvStatus('launching')
        const result = await window.electronAPI.mpvPlay(video.fullPath)
        if (result.success) {
          setMpvStatus('playing')
          setIsPlaying(true)
        } else {
          setMpvError(result.error)
          setMpvStatus('error')
        }
      } catch (err) {
        setMpvError(err.message)
        setMpvStatus('error')
      }
    }

    removeEnded = window.electronAPI?.onMpvEnded(() => {
      setMpvStatus('ended')
      setIsPlaying(false)
    })

    removeEvent = window.electronAPI?.onMpvEvent((evt) => {
      if (evt.event === 'end-file' && evt.reason === 'eof') {
        setMpvStatus('ended')
        setIsPlaying(false)
      }
      if (evt.event === 'pause') setIsPlaying(false)
      if (evt.event === 'unpause') setIsPlaying(true)
    })

    removeError = window.electronAPI?.onMpvError((data) => {
      setMpvError(data.message)
      setMpvStatus('error')
    })

    launchMpv()

    return () => {
      removeEnded?.()
      removeEvent?.()
      removeError?.()
      window.electronAPI?.mpvStop()
    }
  }, [mode, video.fullPath])

  // ─── HTML5 模式 ────────────────────────────────────
  const [videoUrl, setVideoUrl] = useState(null)
  useEffect(() => {
    if (mode !== 'html5') return
    async function getUrl() {
      const url = await window.electronAPI.getFileUrl(video.fullPath)
      setVideoUrl(url)
    }
    getUrl()
  }, [mode, video.fullPath])

  useEffect(() => {
    if (videoRef.current && videoUrl && mode === 'html5') {
      videoRef.current.play().catch(() => {})
    }
  }, [videoUrl, mode])

  // ─── 快捷键 ────────────────────────────────────────
  useEffect(() => {
    function handleKey(e) {
      if (e.key === 'Escape') {
        if (mode === 'mpv') window.electronAPI?.mpvStop()
        onClose()
      }
      if (mode === 'html5') {
        if (e.key === ' ' && videoRef.current) {
          e.preventDefault()
          videoRef.current.paused ? videoRef.current.play() : videoRef.current.pause()
        }
        if (e.key === 'f' || e.key === 'F') toggleFullscreen()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose, mode])

  // 禁止背景滚动
  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen()
      } else if (containerRef.current) {
        await containerRef.current.requestFullscreen()
      }
    } catch {}
  }, [])

  const handleStopMpv = useCallback(() => {
    window.electronAPI?.mpvStop()
    onClose()
  }, [onClose])

  const handleBackdropClick = useCallback((e) => {
    if (e.target === e.currentTarget) {
      if (mode === 'mpv') window.electronAPI?.mpvStop()
      onClose()
    }
  }, [onClose, mode])

  // ─── 渲染 ──────────────────────────────────────────

  // mpv 模式：显示状态监控面板
  if (mode === 'mpv') {
    return (
      <div className="player-overlay" ref={containerRef} onClick={handleBackdropClick}>
        <div className="player-container mpv-mode">
          <button className="player-close" onClick={handleStopMpv} title="关闭 (Esc)">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>

          <div className="player-title">{video.name}</div>

          <div className="mpv-status-panel">
            <div className="mpv-icon">
              <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
            </div>
            <div className="mpv-status-text">
              {mpvStatus === 'launching' && (
                <p>正在启动 mpv 播放器...</p>
              )}
              {mpvStatus === 'playing' && (
                <>
                  <p className="mpv-playing">mpv 正在播放</p>
                  <p className="mpv-hint">视频在 mpv 窗口中播放，可在此停止</p>
                </>
              )}
              {mpvStatus === 'ended' && (
                <p>播放已结束</p>
              )}
              {mpvStatus === 'error' && (
                <p className="mpv-error">播放出错: {mpvError}</p>
              )}
            </div>
          </div>

          <div className="player-actions">
            <button className="btn btn-primary" onClick={handleStopMpv}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="4" width="4" height="16" />
                <rect x="14" y="4" width="4" height="16" />
              </svg>
              停止播放
            </button>
            <button
              className="btn btn-sm"
              onClick={() => window.electronAPI?.showInFolder(video.fullPath)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
              </svg>
              打开文件夹
            </button>
            {(mpvAvailable || mpvStatus === 'error') && (
              <button className="btn btn-sm" onClick={() => setMode('html5')}>
                切换到内置播放器
              </button>
            )}
            <span className="player-meta">
              mpv &middot; {video.extension.toUpperCase().slice(1)} &middot; {video.group}
            </span>
          </div>
        </div>
      </div>
    )
  }

  // ─── HTML5 模式 ────────────────────────────────────
  return (
    <div className="player-overlay" ref={containerRef} onClick={handleBackdropClick}>
      <div className="player-container">
        <button className="player-close" onClick={onClose} title="关闭 (Esc)">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>

        <div className="player-title">{video.name}</div>

        {videoUrl ? (
          <video
            ref={videoRef}
            className="player-video"
            src={videoUrl}
            controls
            autoPlay
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
          >
            您的浏览器不支持此视频格式 ({video.extension})
          </video>
        ) : (
          <div className="player-loading">
            <div className="loading-spinner" />
            <p>加载中...</p>
          </div>
        )}

        <div className="player-actions">
          <button
            className="btn btn-sm"
            onClick={() => window.electronAPI?.showInFolder(video.fullPath)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
            </svg>
            打开文件夹
          </button>
          <button className="btn btn-sm" onClick={toggleFullscreen} title="全屏 (F)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3" />
            </svg>
            全屏
          </button>
          {mpvAvailable && (
            <button className="btn btn-sm" onClick={() => setMode('mpv')}>
              切换到 mpv
            </button>
          )}
          <span className="player-meta">
            内置播放器 &middot; {video.extension.toUpperCase().slice(1)} &middot; {video.group}
          </span>
        </div>
      </div>
    </div>
  )
}
