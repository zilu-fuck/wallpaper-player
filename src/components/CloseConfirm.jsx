import { useCallback, useEffect, useRef, useState } from 'react'
import { useOverlayFocus } from '../hooks/useOverlayFocus'

/**
 * 关闭应用询问框（替代系统原生 dialog）。
 *
 * 主进程提出询问 → 这里渲染 → 用户选择后回传 action，由主进程执行
 * 「最小化到后台」或「退出」。所有分支都在 main/index.js 里，
 * 这里只负责收集用户意图。
 */
export default function CloseConfirm({ payload, onDone }) {
  const [remember, setRemember] = useState(false)
  const [busy, setBusy] = useState(false)
  const panelRef = useRef(null)
  const open = Boolean(payload)

  const decide = useCallback((action = 'cancel') => {
    if (!payload || busy) return
    setBusy(true)
    window.electronAPI
      ?.windowCloseDecide?.({ id: payload.id, action, remember })
      ?.catch?.(() => {})
      ?.finally?.(() => { setBusy(false); onDone?.() })
  }, [busy, onDone, payload, remember])

  useOverlayFocus(panelRef, open, () => decide('cancel'))

  // 只接管 Escape（= 取消）；Enter 交给获得焦点的按钮自己处理，
  // 否则用户按 Enter 想退出时会被这里提前改成最小化。
  useEffect(() => {
    if (!open) return undefined
    const keydown = (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      decide('cancel')
    }
    window.addEventListener('keydown', keydown, true)
    return () => window.removeEventListener('keydown', keydown, true)
  }, [decide, open])

  if (!open) return null

  return (
    <div className="close-confirm-overlay" data-overlay-backdrop="true">
      <div
        ref={panelRef}
        className="close-confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="close-confirm-title"
        aria-describedby="close-confirm-detail"
        tabIndex={-1}
      >
        <div className="close-confirm-head">
          <span className="close-confirm-icon" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M12 3v9" />
              <path d="M6.6 6.6a8 8 0 1 0 10.8 0" />
            </svg>
          </span>
          <div className="close-confirm-copy">
            <h2 id="close-confirm-title">关闭应用</h2>
            <p id="close-confirm-detail">最小化会退到后台继续运行，退出会结束应用。</p>
          </div>
        </div>

        <label className="close-confirm-remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
          />
          <span>今日内不再提醒</span>
        </label>

        <div className="close-confirm-actions">
          <button type="button" className="btn btn-ghost close-confirm-cancel" onClick={() => decide('cancel')} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn btn-outline close-confirm-minimize" onClick={() => decide('minimize')} disabled={busy}>
            最小化到后台
          </button>
          <button type="button" className="btn btn-primary close-confirm-exit" onClick={() => decide('exit')} disabled={busy}>
            退出应用
          </button>
        </div>
      </div>
    </div>
  )
}
