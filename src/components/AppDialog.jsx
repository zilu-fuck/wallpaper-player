import { useCallback, useEffect, useRef, useState } from 'react'
import { useOverlayFocus } from '../hooks/useOverlayFocus'

const TONE_ICONS = {
  question: <path d="M9.1 9a3 3 0 1 1 4.7 2.5c-.9.6-1.8 1.2-1.8 2.5M12 17.5h.01" />,
  warning: <><path d="M12 4.5 3 20h18L12 4.5z" /><path d="M12 10v4M12 17h.01" /></>,
  error: <><circle cx="12" cy="12" r="8.4" /><path d="M12 8v4.5M12 16h.01" /></>,
  info: <><circle cx="12" cy="12" r="8.4" /><path d="M12 11v5M12 8h.01" /></>
}

/**
 * 应用内询问框。
 *
 * 替代系统 showMessageBox 里的「确认类」弹窗——系统弹窗无法跟随主题，
 * 也没有办法融入设计系统。主进程在渲染层可用时走这里；
 * 渲染层不可用（重载/崩溃/超时）时主进程会自动回退到原生对话框。
 *
 * 文件选择器（showOpenDialog / showSaveDialog）仍保留原生：
 * 那是操作系统的能力，自绘反而更差。
 */
export default function AppDialog() {
  const [payload, setPayload] = useState(null)
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState(false)
  const panelRef = useRef(null)
  const open = Boolean(payload)

  useEffect(() => {
    const remove = window.electronAPI?.onAppAsk?.((next) => {
      if (!next) return
      setChecked(Boolean(next.checkboxChecked))
      setBusy(false)
      setPayload(next)
    })
    return () => remove?.()
  }, [])

  const reply = useCallback((response) => {
    if (!payload || busy) return
    setBusy(true)
    window.electronAPI
      ?.appAskReply?.({ id: payload.id, response, checkboxChecked: checked })
      ?.catch?.(() => {})
      ?.finally?.(() => { setBusy(false); setPayload(null) })
  }, [busy, checked, payload])

  // Esc = 取消按钮；没有取消按钮时等于「关闭」，由主进程按默认值处理。
  const cancel = useCallback(() => {
    if (!payload) return
    const index = payload.cancelId >= 0 && payload.cancelId < payload.buttons.length
      ? payload.cancelId
      : (payload.defaultId >= 0 && payload.defaultId < payload.buttons.length ? payload.defaultId : -1)
    reply(index)
  }, [payload, reply])

  useOverlayFocus(panelRef, open, cancel)

  useEffect(() => {
    if (!open) return undefined
    const keydown = (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      cancel()
    }
    window.addEventListener('keydown', keydown, true)
    return () => window.removeEventListener('keydown', keydown, true)
  }, [cancel, open])

  if (!open) return null

  const tone = TONE_ICONS[payload.tone] ? payload.tone : 'question'
  const dangerous = tone === 'error' || tone === 'warning'
  const heading = payload.message || payload.title

  return (
    <div className="app-dialog-overlay" data-overlay-backdrop="true">
      <div
        ref={panelRef}
        className="app-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-dialog-title"
        aria-describedby={payload.detail ? 'app-dialog-detail' : undefined}
        tabIndex={-1}
      >
        <div className="app-dialog-head">
          <span className={`app-dialog-icon app-dialog-icon-${tone}`} aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              {TONE_ICONS[tone]}
            </svg>
          </span>
          <div className="app-dialog-copy">
            {payload.title && payload.title !== heading ? (
              <span className="app-dialog-kicker">{payload.title}</span>
            ) : null}
            <h2 id="app-dialog-title">{heading}</h2>
            {payload.detail ? <p id="app-dialog-detail">{payload.detail}</p> : null}
          </div>
        </div>

        {payload.checkboxLabel ? (
          <label className="app-dialog-remember">
            <input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} />
            <span>{payload.checkboxLabel}</span>
          </label>
        ) : null}

        <div className="app-dialog-actions">
          {payload.buttons.map((label, index) => {
            const primary = index === payload.defaultId
            const isCancel = index === payload.cancelId
            return (
              <button
                key={label + index}
                type="button"
                className={`btn ${primary ? 'btn-primary' : isCancel ? 'btn-ghost' : 'btn-outline'} app-dialog-btn`}
                onClick={() => reply(index)}
                disabled={busy}
              >
                {label}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
