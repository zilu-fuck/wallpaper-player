import { useCallback, useEffect, useRef, useState } from 'react'

export function useMpvInstaller(setMpvStatus) {
  const current = useRef(null)
  const [downloading, setDownloading] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState(null)
  const [mpvDownloadError, setMpvDownloadError] = useState('')
  const release = useCallback(record => {
    if (record.released) return
    record.released = true
    record.removeListener?.()
    if (!record.finished) Promise.resolve(window.electronAPI.cancelMediaWork(record.requestId)).catch(() => {})
  }, [])
  const cancel = useCallback(() => {
    const record = current.current
    current.current = null
    if (record) release(record)
    setDownloading(false); setDownloadProgress(null)
  }, [release])
  useEffect(() => () => {
    const record = current.current; current.current = null
    if (record) release(record)
  }, [release])
  const download = useCallback(async () => {
    if (current.current) return
    const record = { requestId: 'mpv-' + crypto.randomUUID(), finished: false }
    current.current = record
    const active = () => current.current === record
    setDownloading(true); setDownloadProgress(null); setMpvDownloadError('')
    try {
      record.removeListener = window.electronAPI.onMpvDownloadProgress(progress => {
        if (active() && progress.requestId === record.requestId) setDownloadProgress(progress)
      })
      const result = await window.electronAPI.downloadMpv(record.requestId)
      record.finished = true
      if (!active()) return
      if (!result.success) throw new Error(result.error || 'mpv 安装失败')
      const status = await window.electronAPI.checkMpv()
      if (active()) setMpvStatus(status)
    } catch (error) {
      if (active()) setMpvDownloadError(error.message || 'mpv 安装失败')
    } finally {
      release(record)
      if (active()) { current.current = null; setDownloading(false) }
    }
  }, [release, setMpvStatus])
  return { downloading, downloadProgress, mpvDownloadError, download, cancel }
}
