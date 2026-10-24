import { useMemo, useCallback, useRef } from 'react'
import { setVideoFavorite } from '../api/media'

// 收藏夹
export function useFavorites({ settings, reconcileSettings, setSettingsSaveError }) {
  const favoriteKeys = useMemo(() => new Set(settings?.favorites || []), [settings?.favorites])
  const pendingRef = useRef(new Map())

  const handleToggleFavorite = useCallback(async (video) => {
    const favoriteKey = video.favoriteKey || video.fullPath
    if (pendingRef.current.has(favoriteKey)) return pendingRef.current.get(favoriteKey)
    const isFavorite = favoriteKeys.has(favoriteKey) || favoriteKeys.has(video.fullPath)
    setSettingsSaveError?.('')
    const task = setVideoFavorite(video, !isFavorite)
      .then(async result => { await reconcileSettings?.(result); return result })
      .catch(error => {
        setSettingsSaveError?.(error.message || '收藏保存失败')
        throw error
      })
      .finally(() => pendingRef.current.delete(favoriteKey))
    pendingRef.current.set(favoriteKey, task)
    return task
  }, [favoriteKeys, reconcileSettings, setSettingsSaveError])

  return { favoriteKeys, handleToggleFavorite }
}
