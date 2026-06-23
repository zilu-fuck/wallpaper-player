import { useCallback, useEffect, useMemo, useState } from 'react'

function formatBytes(bytes) {
  if (bytes === 0) return '0 B'
  if (!bytes) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index++
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

function getStatusCopy(status, updateInfo, message) {
  switch (status) {
    case 'checking':
      return { title: '正在检查更新', detail: '正在连接 GitHub Releases...' }
    case 'available':
      return {
        title: `发现新版本 ${updateInfo?.version || ''}`,
        detail: `当前版本 ${updateInfo?.currentVersion || 'unknown'}`
      }
    case 'downloading':
      return { title: '正在下载更新', detail: updateInfo?.version ? `Wallpaper Player ${updateInfo.version}` : '请保持应用打开' }
    case 'downloaded':
      return { title: '更新已准备好', detail: '重启后将自动安装新版本。' }
    case 'not-available':
      return { title: '已是最新版本', detail: `当前版本 ${updateInfo?.currentVersion || 'unknown'}` }
    case 'error':
      return { title: '更新检查失败', detail: '稍后可以重试。' }
    case 'disabled':
      return { title: '当前环境不支持自动更新', detail: message || '请前往 GitHub Releases 手动下载。' }
    default:
      return { title: '', detail: '' }
  }
}

function decodeHtmlEntities(value) {
  if (!value) return ''
  if (typeof document !== 'undefined') {
    const textarea = document.createElement('textarea')
    textarea.innerHTML = value
    return textarea.value
  }

  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function markdownToReleaseNoteLines(value) {
  const lines = value.split(/\r?\n/)
  const zhStart = lines.findIndex(line => /^##\s*更新内容/.test(line.trim()))
  const candidateLines = zhStart >= 0
    ? lines.slice(zhStart + 1)
    : lines
  const nextHeading = candidateLines.findIndex(line => /^##\s+/.test(line.trim()))
  const scopedLines = nextHeading >= 0
    ? candidateLines.slice(0, nextHeading)
    : candidateLines

  return scopedLines
}

function htmlToReleaseNoteLines(value) {
  const markdownLikeText = value
    .replace(/<h[1-6]\b[^>]*>/gi, '\n## ')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<(br|\/p|\/li|\/ul|\/ol)\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<[^>]*>/g, '')

  return markdownToReleaseNoteLines(decodeHtmlEntities(markdownLikeText))
}

function summarizeReleaseNotes(notes) {
  if (!notes) return []
  const value = String(notes)
  const lines = /<[a-z][\s\S]*>/i.test(value)
    ? htmlToReleaseNoteLines(value)
    : markdownToReleaseNoteLines(value)
  const seen = new Set()

  return lines
    .map(line => {
      const trimmed = line.trim()
      return {
        isHeading: /^#{1,6}\s+/.test(trimmed),
        text: trimmed
          .replace(/^[-*]\s*/, '')
          .replace(/`([^`]+)`/g, '$1')
          .replace(/\*\*([^*]+)\*\*/g, '$1')
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
          .trim()
      }
    })
    .filter(({ isHeading, text }) => {
      if (isHeading || !text || text.startsWith('>') || seen.has(text)) return false
      seen.add(text)
      return true
    })
    .map(({ text }) => text)
    .slice(0, 5)
}

export default function UpdateNotice() {
  const [updateState, setUpdateState] = useState(null)
  const [dismissedVersion, setDismissedVersion] = useState('')
  const [dismissedStatusKey, setDismissedStatusKey] = useState('')
  const [manualMessage, setManualMessage] = useState('')
  const updaterApi = window.electronAPI

  const handleCheck = useCallback(async () => {
    if (!updaterApi?.updaterCheck) return
    setDismissedVersion('')
    setDismissedStatusKey('')
    setManualMessage('正在手动检查更新...')
    try {
      const state = await updaterApi.updaterCheck()
      setUpdateState(state)
      if (state.status === 'not-available') {
        setManualMessage('当前已是最新版本。')
      } else if (state.status === 'disabled') {
        setManualMessage(state.message || '当前环境不支持自动更新。')
      }
    } catch (err) {
      setUpdateState(prev => ({ ...prev, status: 'error', error: err.message }))
    }
  }, [updaterApi])

  useEffect(() => {
    if (!updaterApi?.updaterGetStatus || !updaterApi?.onUpdaterStatus) return

    let mounted = true

    updaterApi.updaterGetStatus()
      .then(status => {
        if (!mounted) return
        if (status.status === 'disabled') return
        setUpdateState(status)
      })
      .catch(() => {})

    const cleanup = updaterApi.onUpdaterStatus((status) => {
      if (status.status === 'disabled') return
      setManualMessage('')
      setUpdateState(status)
    })

    window.addEventListener('wallpaper-player-check-update', handleCheck)

    return () => {
      mounted = false
      cleanup?.()
      window.removeEventListener('wallpaper-player-check-update', handleCheck)
    }
  }, [handleCheck, updaterApi])

  const status = updateState?.status || 'idle'
  const updateInfo = updateState?.updateInfo
  const statusKey = `${status}:${updateInfo?.version || updateInfo?.currentVersion || updateState?.message || updateState?.error || manualMessage || ''}`
  const visible = useMemo(() => {
    if (!updateState || status === 'idle') return false
    if (dismissedStatusKey === statusKey) return false
    if (status === 'disabled' && !manualMessage) return false
    if (status === 'not-available' && !manualMessage) return false
    if (status === 'available' && dismissedVersion === updateInfo?.version) return false
    return true
  }, [dismissedStatusKey, dismissedVersion, manualMessage, status, statusKey, updateInfo?.version, updateState])

  const copy = getStatusCopy(status, updateInfo, updateState?.message)
  const notes = summarizeReleaseNotes(updateInfo?.releaseNotes)
  const showNotes = notes.length > 0 && (status === 'available' || status === 'downloaded')
  const progress = updateState?.progress
  const percent = Math.max(0, Math.min(100, Math.round(progress?.percent || 0)))

  const handleDownload = useCallback(async () => {
    if (!updaterApi?.updaterDownload) return
    try {
      const state = await updaterApi.updaterDownload()
      setUpdateState(state)
    } catch (err) {
      setUpdateState(prev => ({ ...prev, status: 'error', error: err.message }))
    }
  }, [updaterApi])

  const handleInstall = useCallback(async () => {
    if (!updaterApi?.updaterInstall) return
    try {
      const result = await updaterApi.updaterInstall()
      if (result?.error) {
        setUpdateState(prev => ({ ...prev, status: 'error', error: result.error }))
      }
    } catch (err) {
      setUpdateState(prev => ({ ...prev, status: 'error', error: err.message }))
    }
  }, [updaterApi])

  const handleDismiss = useCallback(() => {
    if (updateInfo?.version) {
      setDismissedVersion(updateInfo.version)
    }
    setDismissedStatusKey(statusKey)
    setManualMessage('')
  }, [statusKey, updateInfo?.version])

  useEffect(() => {
    if (!visible) return undefined
    if (!['not-available', 'error', 'disabled'].includes(status)) return undefined

    const timer = window.setTimeout(() => {
      handleDismiss()
    }, 5000)
    return () => window.clearTimeout(timer)
  }, [handleDismiss, status, visible])

  if (!updaterApi?.updaterCheck) {
    return null
  }

  if (!visible) return null

  return (
    <div className="update-notice" role="status">
      <div className="update-notice-header">
        <div>
          <h2>{copy.title}</h2>
          <p>{manualMessage || copy.detail}</p>
        </div>
        <button className="update-close" onClick={handleDismiss} type="button" aria-label="关闭更新提示" title="关闭">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {showNotes && (
        <ul className="update-notes">
          {notes.map(note => <li key={note}>{note}</li>)}
        </ul>
      )}

      {status === 'downloading' && (
        <div className="update-progress">
          <div className="update-progress-track">
            <div className="update-progress-fill" style={{ width: `${percent}%` }} />
          </div>
          <div className="update-progress-meta">
            <span>{percent}%</span>
            <span>{formatBytes(progress?.transferred) || '0 B'} / {formatBytes(progress?.total) || '未知大小'}</span>
          </div>
        </div>
      )}

      {status === 'error' && updateState?.error && (
        <p className="update-error">{updateState.error}</p>
      )}

      <div className="update-actions">
        {status === 'available' && (
          <button className="btn btn-primary btn-sm" onClick={handleDownload} type="button">
            下载更新
          </button>
        )}
        {status === 'downloaded' && (
          <button className="btn btn-primary btn-sm" onClick={handleInstall} type="button">
            立即重启安装
          </button>
        )}
        {(status === 'error' || status === 'not-available') && (
          <button className="btn btn-sm" onClick={handleCheck} type="button">
            重新检查
          </button>
        )}
        {updateInfo?.releaseUrl && status !== 'checking' && status !== 'downloading' && (
          <a className="btn btn-sm" href={updateInfo.releaseUrl} target="_blank" rel="noreferrer">
            查看详情
          </a>
        )}
        {status === 'available' && (
          <button className="btn btn-sm" onClick={handleDismiss} type="button">
            稍后
          </button>
        )}
      </div>
    </div>
  )
}
