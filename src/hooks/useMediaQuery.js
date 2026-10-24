import { useCallback, useMemo, useSyncExternalStore } from 'react'

export function useMediaQuery(query) {
  const media = useMemo(() => window.matchMedia?.(query), [query])
  const snapshot = useCallback(() => Boolean(media?.matches), [media])
  const subscribe = useCallback(update => {
    media?.addEventListener('change', update)
    window.addEventListener('resize', update)
    return () => { media?.removeEventListener('change', update); window.removeEventListener('resize', update) }
  }, [media])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
