import { useMemo, useCallback } from 'react'

// 收藏夹
export function useFavorites({ settings, saveSettings }) {
  const favoriteKeys = useMemo(() => new Set(settings?.favorites || []), [settings?.favorites])

  const handleToggleFavorite = useCallback(async (video) => {
    const favoriteKey = video.favoriteKey || video.fullPath
    const currentFavorites = settings?.favorites || []
    const isFavorite = currentFavorites.includes(favoriteKey)
    const nextFavorites = isFavorite
      ? currentFavorites.filter(item => item !== favoriteKey)
      : [...currentFavorites, favoriteKey]
    await saveSettings({ favorites: nextFavorites })
  }, [settings, saveSettings])

  return { favoriteKeys, handleToggleFavorite }
}
