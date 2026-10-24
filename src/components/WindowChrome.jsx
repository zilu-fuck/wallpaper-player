import { useCallback, useEffect, useState } from 'react'
import appIcon from '../assets/app-icon.svg'

const MAXIMIZED_EVENT = 'window-maximized-changed'

/**
 * 自绘标题栏。
 *
 * 原生标题栏已经通过 BrowserWindow({ frame: false }) 去掉，
 * 这里负责三件事：拖拽区域、窗口按钮、以及最大化状态下的圆角切换。
 * 只调用窗口管理 IPC，不触碰任何业务状态。
 */
export default function WindowChrome({ title = '视频画廊', meta = '' }) {
  const [maximized, setMaximized] = useState(false)
  const [platformReady, setPlatformReady] = useState(false)

  useEffect(() => {
    let alive = true
    const api = window.electronAPI
    if (!api?.windowGetState) return undefined
    api.windowGetState()
      .then(state => { if (alive) { setMaximized(Boolean(state?.maximized)); setPlatformReady(true) } })
      .catch(() => {})
    const remove = api.onWindowMaximizedChanged?.((state) => {
      if (alive) setMaximized(Boolean(state?.maximized))
    })
    return () => { alive = false; remove?.() }
  }, [])

  const minimize = useCallback(() => { window.electronAPI?.windowMinimize?.()?.catch?.(() => {}) }, [])
  const toggleMaximize = useCallback(() => {
    window.electronAPI?.windowToggleMaximize?.()?.then?.((state) => {
      if (typeof state?.maximized === 'boolean') setMaximized(state.maximized)
    })?.catch?.(() => {})
  }, [])
  const close = useCallback(() => { window.electronAPI?.windowClose?.()?.catch?.(() => {}) }, [])

  return (
    <div className={`window-chrome${maximized ? ' is-maximized' : ''}${platformReady ? '' : ' is-initializing'}`}>
      <div className="window-chrome-drag" onDoubleClick={toggleMaximize}>
        <span className="window-chrome-mark" aria-hidden="true">
          <img src={appIcon} width="20" height="20" alt="" draggable={false} />
        </span>
        <span className="window-chrome-title">{title}</span>
        {meta ? <span className="window-chrome-sep" aria-hidden="true" /> : null}
        {meta ? <span className="window-chrome-meta">{meta}</span> : null}
      </div>

      <div className="window-chrome-buttons">
        <button
          type="button"
          className="window-chrome-btn"
          onClick={minimize}
          title="最小化"
          aria-label="最小化窗口"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1 5h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>
        <button
          type="button"
          className="window-chrome-btn"
          onClick={toggleMaximize}
          title={maximized ? '还原' : '最大化'}
          aria-label={maximized ? '还原窗口' : '最大化窗口'}
        >
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="1.2" y="2.8" width="6" height="6" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
              <path d="M3.2 2.6V1.9a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-.7" fill="none" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="1.2" y="1.2" width="7.6" height="7.6" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="window-chrome-btn window-chrome-btn-close"
          onClick={close}
          title="关闭"
          aria-label="关闭窗口"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1.6 1.6l6.8 6.8M8.4 1.6L1.6 8.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  )
}
