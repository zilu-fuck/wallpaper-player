import { useState, useRef, useCallback } from 'react'

// 扫描目录
export function useScan({ setCurrentDir, setLoading }) {
  const [videos, setVideos] = useState([])
  const [thumbnails, setThumbnails] = useState({})
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState('')
  const [scanErrorDir, setScanErrorDir] = useState('')
  const scanRequestRef = useRef(0)

  // 取消正在进行的扫描（让旧任务的回调失效）
  const cancelScan = useCallback(() => {
    scanRequestRef.current += 1
  }, [])

  const resetGallery = useCallback(() => {
    setVideos([])
    setThumbnails({})
  }, [])

  async function scanAndLoad(dirPath, force = false) {
    const requestId = scanRequestRef.current + 1
    scanRequestRef.current = requestId
    setScanning(true)
    setScanError('')
    setScanErrorDir('')
    try {
      const result = await window.electronAPI.scanDirectory(dirPath, force)
      if (requestId !== scanRequestRef.current) return
      if (result.error) {
        console.error('扫描失败:', result.error)
        setScanError(result.error?.message || String(result.error))
        setScanErrorDir(dirPath)
        setScanning(false)
        setLoading(false)
        return
      }

      setVideos(result.videos)
      setCurrentDir(dirPath)
      setScanning(false)
      setLoading(false) // 扫描完成后立即显示画廊

      if (result.refreshing) {
        setTimeout(() => {
          if (requestId === scanRequestRef.current) {
            scanAndLoad(dirPath, false)
          }
        }, result.indexed ? 1200 : 600)
      }

      setThumbnails({})
    } catch (err) {
      if (requestId !== scanRequestRef.current) return
      console.error('扫描失败:', err)
      setScanError(err?.message || '扫描目录失败')
      setScanErrorDir(dirPath)
      setLoading(false)
    }
    if (requestId !== scanRequestRef.current) return
    setScanning(false)
  }

  return {
    videos,
    setVideos,
    thumbnails,
    setThumbnails,
    scanning,
    setScanning,
    scanError,
    setScanError,
    scanErrorDir,
    setScanErrorDir,
    scanRequestRef,
    cancelScan,
    resetGallery,
    scanAndLoad
  }
}
