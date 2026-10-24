import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useWindowDimensions } from 'react-native'
import type { FlatList, LayoutChangeEvent, ListViewToken } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { VideoItem } from '../types'

type VideoViewToken = Omit<ListViewToken, 'item'> & { item: VideoItem }

export function videoGridLayout(width: number, fontScale = 1) {
  const available = Math.max(1, width - 20), gap = 10
  const columns = Math.max(1, Math.min(4, Math.floor((available + gap) / (160 * Math.max(1, fontScale) + gap))))
  return { columns, cardWidth: Math.max(1, Math.floor((available - gap * (columns - 1)) / columns)) }
}

export function useAdaptiveVideoGrid(items: VideoItem[], queryKey: string, active: boolean) {
  const dimensions = useWindowDimensions(), insets = useSafeAreaInsets()
  const fontScale = dimensions.fontScale || 1
  const [measured, setMeasured] = useState({ windowWidth: 0, width: 0 })
  const width = measured.windowWidth === dimensions.width ? measured.width : dimensions.width - insets.left - insets.right
  const layout = videoGridLayout(width, fontScale)
  const listRef = useRef<FlatList<VideoItem> | null>(null)
  const anchor = useRef<{ id: string } | null>(null)
  const pending = useRef<{ id: string; attempts: number } | null>(null)
  const current = useRef({ items, active, columns: layout.columns })
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const signature = `${layout.columns}:${layout.cardWidth}:${fontScale}`
  const previous = useRef(signature)
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 20 }).current
  const clearTimer = useCallback(() => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null }, [])
  const restore = useCallback(() => {
    const task = pending.current, state = current.current
    if (!task || !state.active || !listRef.current || task.attempts >= 6) return
    const index = state.items.findIndex(item => item.id === task.id)
    if (index < 0) { pending.current = null; return }
    task.attempts++
    // FlatList forwards this index to its row-based VirtualizedList for numColumns > 1.
    listRef.current.scrollToIndex({ index: Math.floor(index / state.columns), animated: false, viewPosition: 0 })
  }, [])
  useLayoutEffect(() => { current.current = { items, active, columns: layout.columns } }, [items, active, layout.columns])
  useLayoutEffect(() => { anchor.current = null; pending.current = null; clearTimer() }, [queryKey, clearTimer])
  useLayoutEffect(() => {
    if (previous.current !== signature) {
      previous.current = signature
      const saved = pending.current || anchor.current
      if (saved) pending.current = { id: saved.id, attempts: 0 }
      clearTimer()
    }
  }, [signature, clearTimer])
  useEffect(() => {
    if (active) { if (pending.current) pending.current.attempts = 0; restore() }
    else clearTimer()
  }, [signature, active, restore, clearTimer])
  useEffect(() => clearTimer, [clearTimer])
  const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: VideoViewToken[] }) => {
    if (!current.current.active) return
    if (pending.current) {
      if (!viewableItems.some(token => token.item.id === pending.current?.id)) return
      pending.current = null; clearTimer()
    }
    const first = viewableItems.filter(token => token.isViewable && token.index != null).sort((a, b) => a.index! - b.index!)[0]
    if (first) anchor.current = { id: first.item.id }
  }, [clearTimer])
  const onScrollToIndexFailed = useCallback(({ averageItemLength }: { averageItemLength: number }) => {
    const task = pending.current, state = current.current
    if (!task || !state.active) return
    const index = state.items.findIndex(item => item.id === task.id)
    if (index < 0) { pending.current = null; return }
    listRef.current?.scrollToOffset({ offset: Math.max(0, averageItemLength * Math.floor(index / state.columns)), animated: false })
    clearTimer()
    if (task.attempts < 6) timer.current = setTimeout(() => { timer.current = null; restore() }, 120)
  }, [clearTimer, restore])
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const measuredWidth = event.nativeEvent.layout.width
    if (measuredWidth > 0) setMeasured(before => before.windowWidth === dimensions.width && Math.abs(before.width - measuredWidth) < 1
      ? before : { windowWidth: dimensions.width, width: measuredWidth })
  }, [dimensions.width])
  const onScrollBeginDrag = useCallback(() => { pending.current = null; clearTimer() }, [clearTimer])
  return { ...layout, fontScale, listRef, onLayout, onViewableItemsChanged, viewabilityConfig, onScrollToIndexFailed,
    onContentSizeChange: restore, onScrollBeginDrag }
}
