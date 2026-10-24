import {
  ArrowLeft,
  Calendar,
  EyeOff,
  Folder,
  FolderOpen,
  Grid2x2,
  HardDrive,
  Heart,
  Menu,
  Monitor,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  Tag,
  Tags,
  X
} from 'lucide-react-native'
import type { ReactNode } from 'react'
import type { LayoutChangeEvent } from 'react-native'
import { useCallback, useEffect, useMemo, useRef, useState, startTransition } from 'react'
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import type { NavigationContext } from '../../App'
import mobilePackage from '../../package.json'
import { ConnectionStatus } from '../components/ConnectionStatus'
import { MobileUpdateCard } from '../components/MobileUpdateCard'
import { PrimaryButton } from '../components/PrimaryButton'
import { AccessibleModal } from '../components/AccessibleModal'
import { VideoCard } from '../components/VideoCard'
import { addTagsToVideos, ApiError, restoreHiddenTags, toggleFavorite } from '../services/api'
import { testConnection } from '../services/connection-manager'
import { subscribeToVideoLibraryUpdates } from '../services/library-events'
import { LibraryRepository } from '../services/library-repository'
import { usePageActivity } from '../hooks/usePageActivity'
import { useAdaptiveVideoGrid } from '../hooks/useAdaptiveVideoGrid'
import type { LibraryQuery } from '../../../packages/contracts'
import { useTheme } from '../theme-context'
import type { ThemeMode } from '../theme'
import type { CategorySummary, DirectorySummary, LibraryResponse, StoredDevice, VideoItem } from '../types'
import { uniqueTags } from '../utils/url'
import { getTagKey, type TagFilter } from '../services/library-query'

type Props = {
  navigation: NavigationContext
  device: StoredDevice
  focused?: boolean
}

type LibraryMode = 'all' | 'favorites' | 'directory' | 'custom' | 'system' | 'settings'
type SortKey = 'name' | 'date' | 'size' | 'type'

type ConnectionGateState = {
  progress: number
  title: string
  detail: string
  error?: string
}

type Selection = {
  mode: LibraryMode
  id?: string
  label: string
}

const GRID_GAP = 10
const EMPTY_GROUPS = { custom: [], system: [] }
const APP_VERSION = mobilePackage.version
const RECONNECT_BASE_DELAY_MS = 2000
const RECONNECT_MAX_DELAY_MS = 30000
const zhCollator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })

function inferDirectories(items: VideoItem[]): DirectorySummary[] {
  const counts = new Map<string, DirectorySummary>()
  for (const item of items) {
    if (!item.directoryId || !item.directoryName) continue
    const current = counts.get(item.directoryId)
    counts.set(item.directoryId, {
      id: item.directoryId,
      name: item.directoryName,
      count: (current?.count || 0) + 1
    })
  }
  return [...counts.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

function inferCategoryGroups(items: VideoItem[]): LibraryResponse['categoryGroups'] {
  const customCounts = new Map<string, number>()
  const systemCounts = new Map<string, number>()

  for (const item of items) {
    for (const tag of item.customTags || []) {
      customCounts.set(tag, (customCounts.get(tag) || 0) + 1)
    }
    const systemTags = item.systemTags ?? item.tags ?? []
    for (const tag of systemTags) {
      tag && systemCounts.set(tag, (systemCounts.get(tag) || 0) + 1)
    }
  }

  const toCategories = (counts: Map<string, number>, type: CategorySummary['type']) => [...counts.entries()]
    .map(([name, count]) => ({ key: `${type}:${name}`, name, count, type }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN'))

  return {
    custom: toCategories(customCounts, 'custom'),
    system: toCategories(systemCounts, 'system')
  }
}

function favoriteCount(items: VideoItem[]) {
  return items.filter(item => item.favorite).length
}

function normalizeTagText(value: string) {
  return uniqueTags(value.split(/[,，\s]+/))
}

export function LibraryScreen({ navigation, device, focused = true }: Props) {
  const pageActive = usePageActivity(focused)
  const pageActiveRef = useRef(pageActive)
  pageActiveRef.current = pageActive
  const connectionControllerRef = useRef<AbortController | null>(null)
  const connectionCheckedRef = useRef(false)
  const { colors, themeMode, setThemeMode } = useTheme()
  const [activeDevice, setActiveDevice] = useState(device)
  const activeDeviceRef = useRef(device)
  const readyRef = useRef(false)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const libraryRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const libraryRequestRef = useRef(0)
  const reconnectAttemptRef = useRef(0)
  const loadRef = useRef<((useCache?: boolean) => Promise<void>) | null>(null)
  const pendingSortTaskRef = useRef<number | null>(null)
  const [library, setLibrary] = useState<LibraryResponse>({
    items: [],
    count: 0,
    directories: [],
    categoryGroups: EMPTY_GROUPS,
    favoriteCount: 0
  })
  const [loading, setLoading] = useState(true)
  const [ready, setReady] = useState(false)
  const [connectionGate, setConnectionGate] = useState<ConnectionGateState>({
    progress: 0.08,
    title: '正在连接电脑',
    detail: '正在准备局域网连接...'
  })
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [reconnectHint, setReconnectHint] = useState('')
  const [online, setOnline] = useState(false)
  const [connectionChecked, setConnectionChecked] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [visibleSortBy, setVisibleSortBy] = useState<SortKey>('name')
  const [sortBy, setSortBy] = useState<SortKey>('name')
  const [selection, setSelection] = useState<Selection>({ mode: 'all', label: device.name })
  const [tagFilters, setTagFilters] = useState<TagFilter[]>([])
  const [selectedVideoIds, setSelectedVideoIds] = useState<string[]>([])
  const [selectionBarHeight, setSelectionBarHeight] = useState(0)
  const [bulkTagOpen, setBulkTagOpen] = useState(false)
  const [bulkTagText, setBulkTagText] = useState('')
  const [bulkTagQuery, setBulkTagQuery] = useState('')
  const [bulkSelectedTags, setBulkSelectedTags] = useState<string[]>([])
  const [bulkSaving, setBulkSaving] = useState(false)
  const [restoreHiddenOpen, setRestoreHiddenOpen] = useState(false)
  const [restorePassword, setRestorePassword] = useState('')
  const [restoreSubmitting, setRestoreSubmitting] = useState(false)
  const [restoreError, setRestoreError] = useState('')
  const repository = useMemo(() => new LibraryRepository(device), [device.id, device.bindingId, device.token])
  const [loadingMore, setLoadingMore] = useState(false)
  const [categoryLoading, setCategoryLoading] = useState<'custom' | 'system' | null>(null)
  const libraryQuery = useMemo<LibraryQuery>(() => ({
    directoryId: selection.mode === 'directory' ? selection.id : undefined,
    favorite: selection.mode === 'favorites' ? true : undefined,
    includeTags: tagFilters.filter(tag => tag.state === 'include').map(({ type, name }) => ({ type, name })),
    excludeTags: tagFilters.filter(tag => tag.state === 'exclude').map(({ type, name }) => ({ type, name })),
    query, sort: sortBy
  }), [selection.mode, selection.id, tagFilters, query, sortBy])
  const libraryQueryRef = useRef(libraryQuery)
  libraryQueryRef.current = libraryQuery

  useEffect(() => {
    activeDeviceRef.current = activeDevice
  }, [activeDevice])

  useEffect(() => {
    readyRef.current = ready
  }, [ready])

  const applyLibrary = useCallback((response: LibraryResponse) => {
    setLibrary({
      ...response,
      directories: response.directories?.length ? response.directories : inferDirectories(response.items),
      categoryGroups: response.categoryGroups || inferCategoryGroups(response.items),
      favoriteCount: typeof response.favoriteCount === 'number' ? response.favoriteCount : favoriteCount(response.items)
    })
  }, [])

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    setReconnectHint('')
  }, [])

  const clearLibraryRefreshTimer = useCallback(() => {
    if (libraryRefreshTimerRef.current) {
      clearTimeout(libraryRefreshTimerRef.current)
      libraryRefreshTimerRef.current = null
    }
  }, [])

  const scheduleReconnect = useCallback((message: string) => {
    if (!pageActiveRef.current) return
    if (reconnectTimerRef.current) return
    const attempt = reconnectAttemptRef.current
    const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * (2 ** attempt))
    reconnectAttemptRef.current = attempt + 1
    setReconnectHint(`${Math.round(delay / 1000)} 秒后自动重连`)
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null
      setReconnectHint('')
      setError(message)
      loadRef.current?.(false)
    }, delay)
  }, [])

  useEffect(() => repository.subscribe(state => {
    applyLibrary(state.library)
    setLoading(state.loading)
    setLoadingMore(state.loadingMore)
    setCategoryLoading(state.categoryLoading)
    setError(state.error)
    if (state.error) {
      setOnline(false)
      if (state.retryable && readyRef.current) scheduleReconnect(state.error)
      else clearReconnectTimer()
    } else if (!state.loading && !state.offline && (state.library.revision || state.library.items.length)) {
      setOnline(true); clearReconnectTimer()
    }
    if (state.library.revision || state.library.items.length) { setReady(true); readyRef.current = true }
  }), [applyLibrary, repository, clearReconnectTimer, scheduleReconnect])

  useEffect(() => () => { libraryRequestRef.current++; repository.dispose() }, [repository])

  useEffect(() => {
    if (pageActive && ready && connectionChecked) void repository.select(libraryQuery)
  }, [libraryQuery, ready, connectionChecked, repository, pageActive])

  const load = useCallback(async (useCache = true) => {
    if (!pageActiveRef.current) return
    connectionControllerRef.current?.abort()
    const controller = new AbortController()
    connectionControllerRef.current = controller
    const isInitialLoad = !readyRef.current
    let usingCachedLibrary = false
    const requestId = libraryRequestRef.current + 1
    libraryRequestRef.current = requestId
    clearLibraryRefreshTimer()
    clearReconnectTimer()
    setError('')
    if (isInitialLoad) {
      setReady(false)
      setLoading(true)
      setConnectionGate({
        progress: 0.12,
        title: '正在连接电脑',
        detail: '正在检查局域网地址...'
      })
    }

    if (useCache) {
      usingCachedLibrary = await repository.hydrate(libraryQueryRef.current).catch(() => false)
      if (requestId !== libraryRequestRef.current) return
      if (usingCachedLibrary) { setReady(true); readyRef.current = true }
    }

    const showConnectionGate = isInitialLoad && !usingCachedLibrary

    try {
      const connectedDevice = await testConnection(activeDeviceRef.current, showConnectionGate ? progress => {
        if (pageActiveRef.current && requestId === libraryRequestRef.current) setConnectionGate(progress)
      } : undefined, controller.signal)
      if (requestId !== libraryRequestRef.current || controller.signal.aborted || !pageActiveRef.current) return
      activeDeviceRef.current = connectedDevice
      repository.updateDevice(connectedDevice)
      setConnectionChecked(true)
      connectionCheckedRef.current = true
      setActiveDevice(connectedDevice)
      setOnline(true)
      if (showConnectionGate) {
        setConnectionGate({
          progress: 0.76,
          title: '正在同步视频库',
          detail: '正在读取电脑端目录和分类...'
        })
      }
      if (!useCache && readyRef.current) await repository.refresh()
      else await repository.select(libraryQueryRef.current, true)
      if (repository.state.error) throw new ApiError(repository.state.error, 0, 'library_load_failed', repository.state.retryable)
      const response = repository.state.library
      if (requestId !== libraryRequestRef.current) return
      if (showConnectionGate) {
        setConnectionGate({
          progress: 0.92,
          title: '正在准备界面',
          detail: `已找到 ${response.count || response.items.length} 个视频`
        })
      }
      applyLibrary(response)
      if (response.refreshing && !repository.paginated) {
        libraryRefreshTimerRef.current = setTimeout(() => {
          libraryRefreshTimerRef.current = null
          loadRef.current?.(false)
        }, response.indexed ? 1200 : 600)
      }
      reconnectAttemptRef.current = 0
      if (isInitialLoad) {
        setConnectionGate({
          progress: 1,
          title: '连接完成',
          detail: '正在打开视频库...'
        })
        setReady(true)
      }
    } catch (err) {
      if (requestId !== libraryRequestRef.current || controller.signal.aborted || !pageActiveRef.current) return
      setOnline(false)
      const message = err instanceof Error ? err.message : '无法连接电脑'
      setError(message)
      const shouldReconnect = !(err instanceof ApiError && (
        !err.retryable ||
        err.status === 401 ||
        err.status === 403 ||
        err.code === 'unauthorized' ||
        err.code === 'device_mismatch' ||
        err.code === 'legacy_token_disabled'
      ))
      if (shouldReconnect && (!isInitialLoad || usingCachedLibrary)) {
        scheduleReconnect(message)
      }
      if (showConnectionGate) {
        setConnectionGate({
          progress: 1,
          title: '连接失败',
          detail: message,
          error: message
        })
      }
    } finally {
      if (requestId === libraryRequestRef.current) {
        setConnectionChecked(true)
        connectionCheckedRef.current = true
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [applyLibrary, clearLibraryRefreshTimer, clearReconnectTimer, scheduleReconnect, repository])

  useEffect(() => {
    loadRef.current = load
  }, [load])

  useEffect(() => {
    repository.setActive(pageActive)
    if (!pageActive) {
      libraryRequestRef.current++; connectionControllerRef.current?.abort()
      clearReconnectTimer(); clearLibraryRefreshTimer(); setRefreshing(false)
    } else if (!connectionCheckedRef.current) void loadRef.current?.(true)
    else void repository.refresh()
    return () => { connectionControllerRef.current?.abort(); repository.setActive(false) }
  }, [pageActive, repository, clearReconnectTimer, clearLibraryRefreshTimer])

  useEffect(() => () => {
    clearReconnectTimer()
    clearLibraryRefreshTimer()
  }, [clearLibraryRefreshTimer, clearReconnectTimer])

  useEffect(() => subscribeToVideoLibraryUpdates((update) => {
    if (update.deviceId !== activeDevice.id || update.bindingId !== activeDevice.bindingId) return
    setLibrary(current => {
      let changed = false
      const items = current.items.map(item => {
        if (item.id !== update.videoId) return item
        changed = true
        return { ...item, ...update.patch }
      })
      if (!changed) return current
      return {
        ...current,
        items,
        favoriteCount: repository.paginated ? current.favoriteCount : favoriteCount(items),
        categoryGroups: repository.paginated ? current.categoryGroups : inferCategoryGroups(items)
      }
    })
    void repository.refresh()
  }), [activeDevice.id, activeDevice.bindingId, repository])

  const videos = library.items
  const directories = library.directories || []
  const categoryGroups = library.categoryGroups || EMPTY_GROUPS
  const totalCount = library.count || videos.length
  const currentFavoriteCount = library.favoriteCount ?? favoriteCount(videos)
  const filteredVideos = videos

  const subtitle = useMemo(() => {
    if (loading) return '正在读取视频库'
    if (selection.mode === 'settings') return '手机访问与远程播放'
    if (!filteredVideos.length && library.scanState === 'refreshing') return '电脑正在同步视频库，结果将继续补齐'
    if (filteredVideos.length === 0) return repository.state.offline ? '此查询没有离线缓存，请连接电脑' : query.trim() ? '没有匹配的视频' : '没有可显示的视频'
    const matched = library.matchedCount ?? filteredVideos.length
    return repository.paginated ? `已加载 ${filteredVideos.length} / ${matched} 个视频` : `${filteredVideos.length} / ${totalCount} 个视频`
  }, [filteredVideos.length, library.matchedCount, library.scanState, loading, query, selection.mode, totalCount, repository, error])

  const grid = useAdaptiveVideoGrid(filteredVideos, JSON.stringify(libraryQuery), pageActive)
  const styles = useMemo(() => createStyles(colors, grid.fontScale), [colors, grid.fontScale])
  const title = useMemo(() => {
    if (tagFilters.length === 0) {
      return selection.mode === 'all' ? activeDevice.name : selection.label
    }
    const includeNames = tagFilters.filter(f => f.state === 'include').map(f => f.name)
    const excludeNames = tagFilters.filter(f => f.state === 'exclude').map(f => f.name)
    const parts: string[] = []
    if (includeNames.length) parts.push(includeNames.join(' + '))
    if (excludeNames.length) parts.push('排除 ' + excludeNames.join(' / '))
    return parts.join('，')
  }, [activeDevice.name, selection.label, selection.mode, tagFilters])
  const selectedVideoIdSet = useMemo(() => new Set(selectedVideoIds), [selectedVideoIds])
  const selectionModeActive = selectedVideoIds.length > 0
  const includedTagKeySet = useMemo(() => new Set(tagFilters.filter(f => f.state === 'include').map(f => f.key)), [tagFilters])
  const excludedTagKeySet = useMemo(() => new Set(tagFilters.filter(f => f.state === 'exclude').map(f => f.key)), [tagFilters])
  const availableBulkTags = useMemo(() => {
    const tags: string[] = []

    for (const category of categoryGroups.custom) tags.push(category.name)
    for (const category of categoryGroups.system) tags.push(category.name)
    for (const video of videos) {
      tags.push(...(video.customTags || []))
      tags.push(...(video.systemTags || []))
      tags.push(...(video.tags || []))
    }

    return uniqueTags(tags).sort(zhCollator.compare)
  }, [categoryGroups, videos])
  const pendingBulkTags = useMemo(() => uniqueTags([
    ...normalizeTagText(bulkTagText),
    ...bulkSelectedTags
  ]), [bulkSelectedTags, bulkTagText])
  const pendingBulkTagKeySet = useMemo(() => new Set(pendingBulkTags.map(getTagKey)), [pendingBulkTags])
  const filteredBulkTagOptions = useMemo(() => {
    const keyword = bulkTagQuery.trim().toLocaleLowerCase()
    const matched = keyword
      ? availableBulkTags.filter(tag => getTagKey(tag).includes(keyword))
      : availableBulkTags

    return matched.slice(0, 36)
  }, [availableBulkTags, bulkTagQuery])

  const closeDrawer = useCallback(() => setDrawerOpen(false), [])

  const select = useCallback((next: Selection) => {
    setSelection(next)
    setDrawerOpen(false)
  }, [])

  const selectAll = useCallback(() => {
    select({ mode: 'all', label: activeDevice.name })
  }, [activeDevice.name, select])

  const openSearch = useCallback(() => {
    setDrawerOpen(false)
    setSearchOpen(true)
  }, [])

  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    setQuery('')
  }, [])

  const openDeviceList = useCallback(() => {
    setDrawerOpen(false)
    navigation.refreshDevices()
  }, [navigation])

  const openSettings = useCallback(() => {
    select({ mode: 'settings', label: '设置' })
  }, [select])

  const toggleTagFilter = useCallback((filter: Omit<TagFilter, 'state'>) => {
    setTagFilters(current => {
      const existing = current.find(item => item.key === filter.key)
      // 三态循环：未选 → 包含 → 排除 → 未选
      let next: TagFilter[]
      if (!existing) {
        next = [...current, { ...filter, state: 'include' }]
      } else if (existing.state === 'include') {
        next = current.map(item => item.key === filter.key ? { ...item, state: 'exclude' as const } : item)
      } else {
        // exclude → 移除
        next = current.filter(item => item.key !== filter.key)
      }
      setSelection(current => current.mode === 'favorites' || current.mode === 'directory' ? current : next.length
        ? { mode: filter.type, id: filter.key, label: filter.name }
        : { mode: 'all', label: activeDevice.name })
      return next
    })
  }, [activeDevice.name])

  const clearTagFilters = useCallback(() => {
    setTagFilters([])
    if (selection.mode === 'custom' || selection.mode === 'system') {
      setSelection({ mode: 'all', label: activeDevice.name })
    }
  }, [activeDevice.name, selection.mode])

  const submitRestoreHiddenTags = useCallback(async () => {
    if (!restorePassword) {
      setRestoreError('请输入隐私密码')
      return
    }
    setRestoreSubmitting(true)
    setRestoreError('')
    try {
      await restoreHiddenTags(activeDevice, restorePassword)
      setRestoreHiddenOpen(false)
      setRestorePassword('')
      // 重新拉取库以反映还原后的列表
      setRefreshing(true)
      load(false)
    } catch (err) {
      setRestoreError(err instanceof ApiError ? err.message : '还原失败，请重试')
    } finally {
      setRestoreSubmitting(false)
    }
  }, [activeDevice, load, restorePassword])

  const handleSortSelect = useCallback((key: SortKey) => {
    setVisibleSortBy(key)
    if (pendingSortTaskRef.current !== null) cancelIdleCallback(pendingSortTaskRef.current)
    pendingSortTaskRef.current = requestIdleCallback(() => {
      pendingSortTaskRef.current = null
      startTransition(() => {
        setSortBy(key)
      })
    }, { timeout: 250 })
  }, [])

  const clearVideoSelection = useCallback(() => {
    setSelectedVideoIds([])
    setBulkTagOpen(false)
    setBulkTagText('')
    setBulkTagQuery('')
    setBulkSelectedTags([])
  }, [])

  const toggleVideoSelection = useCallback((video: VideoItem) => {
    setSelectedVideoIds(current => current.includes(video.id)
      ? current.filter(id => id !== video.id)
      : [...current, video.id])
  }, [])

  const startVideoSelection = useCallback((video: VideoItem) => {
    setSelectedVideoIds(current => current.includes(video.id) ? current : [...current, video.id])
  }, [])

  const openBulkTagSheet = useCallback(() => {
    if (!selectedVideoIds.length) return
    setBulkTagText('')
    setBulkTagQuery('')
    setBulkSelectedTags([])
    setBulkTagOpen(true)
  }, [selectedVideoIds.length])

  const closeBulkTagSheet = useCallback(() => {
    setBulkTagOpen(false)
    setBulkTagText('')
    setBulkTagQuery('')
    setBulkSelectedTags([])
  }, [])

  const removePendingBulkTag = useCallback((tag: string) => {
    const key = getTagKey(tag)
    setBulkSelectedTags(current => current.filter(item => getTagKey(item) !== key))
    setBulkTagText(current => normalizeTagText(current)
      .filter(item => getTagKey(item) !== key)
      .join(', '))
  }, [])

  const toggleBulkTagOption = useCallback((tag: string) => {
    const key = getTagKey(tag)
    if (pendingBulkTagKeySet.has(key)) {
      removePendingBulkTag(tag)
      return
    }

    setBulkSelectedTags(current => {
      const exists = current.some(item => getTagKey(item) === key)
      return exists ? current.filter(item => getTagKey(item) !== key) : [...current, tag]
    })
  }, [pendingBulkTagKeySet, removePendingBulkTag])

  const saveBulkTags = useCallback(async () => {
    const tags = pendingBulkTags
    if (!selectedVideoIds.length || !tags.length) return
    setBulkSaving(true)
    try {
      const result = await addTagsToVideos(activeDevice, selectedVideoIds, tags)
      const updatedIds = new Set(result.updated?.map(item => item.id) || selectedVideoIds)
      const savedTags = new Map(result.updated?.map(item => [item.id, item.customTags]) || [])
      const savedRevisions = new Map(result.updated?.map(item => [item.id, item.customTagsRevision]) || [])
      setLibrary(current => {
        const items = current.items.map(item => {
          if (!updatedIds.has(item.id)) return item
          const customTags = savedTags.get(item.id) || [...new Set([...(item.customTags || []), ...tags])]
          const allTags = [...new Set([...(item.systemTags || []), ...customTags])]
          return { ...item, customTags, customTagsRevision: savedRevisions.get(item.id) ?? item.customTagsRevision, tags: allTags }
        })
        return {
          ...current,
          items,
          categoryGroups: repository.paginated ? current.categoryGroups : inferCategoryGroups(items)
        }
      })
      void repository.refresh()
      if (result.failed?.length) {
        setSelectedVideoIds(result.failed.map(item => item.id))
        setError('已更新 ' + result.updatedCount + ' 项，' + result.failed.length + ' 项失败，请检查后重试')
      } else {
        clearVideoSelection()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '批量添加标签失败')
    } finally {
      setBulkSaving(false)
    }
  }, [activeDevice, pendingBulkTags, selectedVideoIds, clearVideoSelection, repository])

  useEffect(() => () => {
    if (pendingSortTaskRef.current !== null) cancelIdleCallback(pendingSortTaskRef.current)
    pendingSortTaskRef.current = null
  }, [])

  const handleThemeSelect = useCallback((mode: ThemeMode) => {
    setThemeMode(mode).catch(() => {})
  }, [setThemeMode])

  const updateFavorite = useCallback(async (video: VideoItem) => {
    const nextFavorite = !video.favorite
    setLibrary(current => {
      const items = current.items.map(item => item.id === video.id ? { ...item, favorite: nextFavorite } : item)
      return {
        ...current,
        items,
        favoriteCount: repository.paginated ? (current.favoriteCount || 0) + items.reduce((delta, item, index) =>
          delta + Number(Boolean(item.favorite)) - Number(Boolean(current.items[index].favorite)), 0) : favoriteCount(items)
      }
    })

    try {
      const result = await toggleFavorite(activeDevice, video.id, !Boolean(video.favorite))
      setLibrary(current => {
        const items = current.items.map(item => item.id === video.id ? { ...item, favorite: result.favorite } : item)
        return {
          ...current,
          items,
          favoriteCount: repository.paginated ? (current.favoriteCount || 0) + items.reduce((delta, item, index) =>
            delta + Number(Boolean(item.favorite)) - Number(Boolean(current.items[index].favorite)), 0) : favoriteCount(items)
        }
      })
      void repository.refresh()
    } catch (err) {
      setLibrary(current => {
        const items = current.items.map(item => item.id === video.id ? { ...item, favorite: video.favorite } : item)
        return {
          ...current,
          items,
          favoriteCount: repository.paginated ? (current.favoriteCount || 0) + items.reduce((delta, item, index) =>
            delta + Number(Boolean(item.favorite)) - Number(Boolean(current.items[index].favorite)), 0) : favoriteCount(items)
        }
      })
      setError(err instanceof Error ? err.message : '收藏同步失败')
    }
  }, [activeDevice, repository])

  const handleVideoPress = useCallback((video: VideoItem) => {
    if (selectionModeActive) {
      toggleVideoSelection(video)
      return
    }
    navigation.navigate({ name: 'player', device: activeDevice, video, videos: filteredVideos })
  }, [activeDevice, filteredVideos, navigation, selectionModeActive, toggleVideoSelection])

  const handleVideoLongPress = useCallback((video: VideoItem) => {
    startVideoSelection(video)
  }, [startVideoSelection])

  const handleVideoFavorite = useCallback((video: VideoItem) => {
    updateFavorite(video)
  }, [updateFavorite])

  const sortOptions: Array<{ key: SortKey, label: string, icon: ReactNode }> = [
    { key: 'name', label: '名称', icon: <Tags color={visibleSortBy === 'name' ? colors.text : colors.muted} size={16} /> },
    { key: 'date', label: '时间', icon: <Calendar color={visibleSortBy === 'date' ? colors.text : colors.muted} size={16} /> },
    { key: 'size', label: '大小', icon: <HardDrive color={visibleSortBy === 'size' ? colors.text : colors.muted} size={16} /> },
    { key: 'type', label: '类型', icon: <SlidersHorizontal color={visibleSortBy === 'type' ? colors.text : colors.muted} size={16} /> }
  ]

  if (!ready) {
    return (
      <View style={styles.shell}>
        <ScrollView contentContainerStyle={styles.gate}>
          <View style={styles.gateIcon}>
            <Monitor color={colors.accent} size={34} />
          </View>
          <Text style={styles.gateTitle}>{connectionGate.title}</Text>
          <Text style={styles.gateDetail}>{connectionGate.detail}</Text>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${Math.max(5, Math.min(100, connectionGate.progress * 100))}%` }]} />
          </View>
          <Text style={styles.progressText}>{Math.round(Math.min(1, connectionGate.progress) * 100)}%</Text>
          {connectionGate.error ? (
            <View style={styles.gateActions}>
              <PrimaryButton
                label="重新连接"
                icon={<RefreshCw color={colors.onAccent} size={20} />}
                onPress={() => load(false)}
              />
              <PrimaryButton
                label="返回设备"
                variant="secondary"
                icon={<Monitor color={colors.text} size={20} />}
                onPress={navigation.refreshDevices}
              />
              <MobileUpdateCard focused={pageActive} />
            </View>
          ) : (
            <ActivityIndicator color={colors.accent} />
          )}
        </ScrollView>
      </View>
    )
  }

  return (
    <View style={styles.shell} onLayout={grid.onLayout}>
      <View style={styles.header}>
        {searchOpen ? (
          <View style={styles.searchHeader}>
            <Pressable style={styles.iconButton} onPress={closeSearch} accessibilityRole="button" accessibilityLabel="关闭搜索">
              <ArrowLeft color={colors.text} size={22} />
            </Pressable>
            <View style={styles.searchBox}>
              <Search color={colors.muted} size={20} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                autoFocus
                placeholder="搜索视频、目录、分类、标签"
                placeholderTextColor={colors.subtle}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.searchInput}
                accessibilityLabel="搜索视频、目录、分类和标签"
              />
              {query ? (
                <Pressable style={styles.clearButton} onPress={() => setQuery('')} accessibilityRole="button" accessibilityLabel="清空搜索">
                  <X color={colors.muted} size={18} />
                </Pressable>
              ) : null}
            </View>
          </View>
        ) : (
          <View style={styles.titleRow}>
            <Pressable style={styles.iconButton} onPress={() => setDrawerOpen(true)} accessibilityRole="button" accessibilityLabel="打开导航" accessibilityState={{ expanded: drawerOpen }}>
              <Menu color={colors.text} size={22} />
            </Pressable>
            <View style={styles.titleBlock}>
              <Text style={styles.title} numberOfLines={grid.fontScale > 1.3 ? 2 : 1} accessibilityRole="header" accessibilityLabel={title}>{title}</Text>
              <Text style={styles.subtitle} numberOfLines={2} accessibilityLiveRegion="polite">{subtitle}</Text>
            </View>
            <Pressable style={styles.iconButton} onPress={openSearch} accessibilityRole="button" accessibilityLabel="搜索视频">
              <Search color={colors.text} size={22} />
            </Pressable>
          </View>
        )}
        {!searchOpen ? (
          <ConnectionStatus
            online={online}
            text={online
              ? `已连接 · ${activeDevice.endpoint.replace(/^https?:\/\//, '')}`
              : reconnectHint || activeDevice.endpoint}
          />
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>

      {selection.mode === 'settings' ? (
        <ScrollView style={styles.settingsScroll} contentContainerStyle={styles.settingsPanel}>
          <Text style={styles.settingsTitle}>手机访问设置</Text>
          <View style={styles.settingGroup}>
            <Text style={styles.settingLabel}>外观主题</Text>
            <View style={styles.themeToggle}>
              {(['dark', 'light'] as const).map(mode => (
                <Pressable
                  key={mode}
                  style={[styles.themeOption, themeMode === mode && styles.themeOptionActive]}
                  onPress={() => handleThemeSelect(mode)}
                  accessibilityRole="button"
                  accessibilityLabel={mode === 'dark' ? '深色主题' : '亮色主题'}
                  accessibilityState={{ selected: themeMode === mode }}
                >
                  <Text style={[styles.themeOptionText, themeMode === mode && styles.themeOptionTextActive]}>
                    {mode === 'dark' ? '深色' : '亮色'}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
          <Text style={styles.settingsText}>{activeDevice.endpoint}</Text>
          <View style={styles.settingGroup}>
            <Text style={styles.settingLabel}>检查更新</Text>
            <MobileUpdateCard focused={pageActive && !drawerOpen} />
          </View>
          <Text style={styles.settingsText}>目录 {directories.length} 个 · 视频 {totalCount} 个 · 我喜欢 {currentFavoriteCount} 个</Text>
          <PrimaryButton
            label="返回视频库"
            icon={<Grid2x2 color={colors.onAccent} size={20} />}
            onPress={selectAll}
          />
        </ScrollView>
      ) : loading && videos.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.centerText}>正在加载视频库...</Text>
        </View>
      ) : (
        <>
          <SortFilterBar
            styles={styles}
            sortOptions={sortOptions}
            visibleSortBy={visibleSortBy}
            tagFilters={tagFilters}
            onSortSelect={handleSortSelect}
            onClearTagFilters={clearTagFilters}
          />
          <FlatList
            key={`library-grid-${grid.columns}`}
            ref={grid.listRef}
            data={filteredVideos}
            keyExtractor={item => item.id}
            onEndReached={() => { void repository.loadMore() }}
            onEndReachedThreshold={0.6}
            ListFooterComponent={loadingMore ? <ActivityIndicator color={colors.accent} /> : library.nextCursor ? (
              <PrimaryButton label={error ? '重试加载下一页' : '加载下一页'} onPress={() => { void repository.loadMore() }} />
            ) : undefined}
            numColumns={grid.columns}
            columnWrapperStyle={grid.columns > 1 ? styles.gridRow : undefined}
            onViewableItemsChanged={grid.onViewableItemsChanged}
            viewabilityConfig={grid.viewabilityConfig}
            onScrollToIndexFailed={grid.onScrollToIndexFailed}
            onContentSizeChange={grid.onContentSizeChange}
            onScrollBeginDrag={grid.onScrollBeginDrag}
            contentContainerStyle={[styles.list, selectionModeActive && { paddingBottom: selectionBarHeight + 24 }]}
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true)
              load(false)
            }}
            renderItem={({ item }) => (
              <VideoCard
                width={grid.cardWidth}
                device={activeDevice}
                video={item}
                selected={selectedVideoIdSet.has(item.id)}
                selectionMode={selectionModeActive}
                onToggleFavorite={selectionModeActive ? undefined : handleVideoFavorite}
                onLongPress={handleVideoLongPress}
                onPress={handleVideoPress}
              />
            )}
            ListEmptyComponent={(
              <View style={styles.center}>
                <Text style={styles.centerText}>{error ? '此查询暂时无法读取，请重试' : library.scanState === 'refreshing' ? '电脑正在同步视频库，结果将继续补齐' : query.trim() ? '没有匹配的视频' : '还没有视频'}</Text>
                <PrimaryButton
                  label="重新加载"
                  icon={<RefreshCw color={colors.onAccent} size={20} />}
                  onPress={() => load(false)}
                />
              </View>
            )}
          />
        </>
      )}

      {selectionModeActive ? (
        <BulkSelectionBar
          styles={styles}
          colors={colors}
          selectedCount={selectedVideoIds.length}
          onOpenBulkTagSheet={openBulkTagSheet}
          onClearVideoSelection={clearVideoSelection}
          onLayout={event => setSelectionBarHeight(event.nativeEvent.layout.height)}
        />
      ) : null}

      {focused && (bulkTagOpen || restoreHiddenOpen || drawerOpen) ? (
        <AccessibleModal label={restoreHiddenOpen ? '还原隐藏标签' : bulkTagOpen ? '批量添加标签' : '视频库导航'}
          onClose={restoreHiddenOpen ? () => setRestoreHiddenOpen(false) : bulkTagOpen ? closeBulkTagSheet : closeDrawer}>
      {bulkTagOpen ? (
        <KeyboardAvoidingView
          style={styles.bulkSheetAvoider}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          pointerEvents="box-none"
        >
          <Pressable style={styles.bulkSheetScrim} onPress={closeBulkTagSheet} accessible={false} importantForAccessibility="no" />
          <View style={styles.bulkSheet}>
            <View style={styles.bulkSheetHeader}>
              <Text style={styles.bulkSheetTitle}>批量添加标签</Text>
              <Pressable style={styles.drawerClose} onPress={closeBulkTagSheet} accessibilityRole="button" accessibilityLabel="关闭批量标签编辑">
                <X color={colors.text} size={20} />
              </Pressable>
            </View>
            <ScrollView
              style={styles.bulkSheetScroll}
              contentContainerStyle={styles.bulkSheetScrollContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              <Text style={styles.bulkSheetHint}>会追加到已选择的 {selectedVideoIds.length} 个视频，不会清除原有标签。</Text>
              <Text style={styles.bulkSectionLabel}>新增标签</Text>
              <TextInput
                value={bulkTagText}
                onChangeText={setBulkTagText}
                placeholder="输入标签，用逗号或空格分隔"
                placeholderTextColor={colors.subtle}
                style={styles.bulkInput}
                returnKeyType="done"
                onSubmitEditing={saveBulkTags}
                accessibilityLabel="要添加的标签"
              />
              {pendingBulkTags.length ? (
                <View style={styles.bulkPendingTags}>
                  {pendingBulkTags.map(tag => (
                    <Pressable key={tag} style={styles.bulkPendingTag} onPress={() => removePendingBulkTag(tag)} accessibilityRole="button" accessibilityLabel={`移除待添加标签 ${tag}`}>
                      <Text style={styles.bulkPendingTagText} numberOfLines={1}>{tag}</Text>
                      <X color={colors.onAccent} size={13} />
                    </Pressable>
                  ))}
                </View>
              ) : null}

              <View style={styles.bulkTagSearchHeader}>
                <Text style={styles.bulkSectionLabel}>已有标签</Text>
                <Text style={styles.bulkTagCount}>{availableBulkTags.length} 个</Text>
              </View>
              <View style={styles.bulkSearchBox}>
                <Search color={colors.muted} size={16} />
                <TextInput
                  value={bulkTagQuery}
                  onChangeText={setBulkTagQuery}
                  placeholder="搜索已有标签"
                  placeholderTextColor={colors.subtle}
                  style={styles.bulkSearchInput}
                  returnKeyType="search"
                  accessibilityLabel="搜索已有标签"
                />
                {bulkTagQuery ? (
                  <Pressable style={styles.bulkSearchClear} onPress={() => setBulkTagQuery('')} accessibilityRole="button" accessibilityLabel="清空标签搜索">
                    <X color={colors.muted} size={15} />
                  </Pressable>
                ) : null}
              </View>
              <View style={styles.bulkTagOptions}>
                {filteredBulkTagOptions.length ? filteredBulkTagOptions.map(tag => {
                  const selected = pendingBulkTagKeySet.has(getTagKey(tag))
                  return (
                    <Pressable
                      key={tag}
                      style={[styles.bulkTagOption, selected && styles.bulkTagOptionSelected]}
                      onPress={() => toggleBulkTagOption(tag)}
                      accessibilityRole="checkbox"
                      accessibilityLabel={tag}
                      accessibilityState={{ checked: selected }}
                    >
                      <Text
                        style={[styles.bulkTagOptionText, selected && styles.bulkTagOptionTextSelected]}
                        numberOfLines={1}
                      >
                        {tag}
                      </Text>
                    </Pressable>
                  )
                }) : (
                  <Text style={styles.bulkTagEmpty}>
                    {availableBulkTags.length ? '没有匹配的标签' : '还没有已有标签，可以先输入新标签'}
                  </Text>
                )}
              </View>
            </ScrollView>
            <Pressable
              style={[styles.bulkSaveButton, (!pendingBulkTags.length || bulkSaving) && styles.updateButtonDisabled]}
              onPress={saveBulkTags}
              disabled={!pendingBulkTags.length || bulkSaving}
              accessibilityRole="button"
              accessibilityState={{ disabled: !pendingBulkTags.length || bulkSaving, busy: bulkSaving }}
            >
              {bulkSaving ? <ActivityIndicator color={colors.onAccent} size="small" /> : null}
              <Text style={styles.bulkSaveButtonText}>{bulkSaving ? '保存中...' : '添加到已选视频'}</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      ) : null}

      {restoreHiddenOpen ? (
        <RestoreHiddenSheet
          styles={styles}
          colors={colors}
          password={restorePassword}
          submitting={restoreSubmitting}
          error={restoreError}
          onPasswordChange={setRestorePassword}
          onClose={() => setRestoreHiddenOpen(false)}
          onSubmit={submitRestoreHiddenTags}
        />
      ) : null}

      {drawerOpen && !restoreHiddenOpen && !bulkTagOpen ? (
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          <Pressable style={styles.drawerScrim} onPress={closeDrawer} accessible={false} importantForAccessibility="no" />
          <View style={styles.drawer}>
            <View style={styles.drawerHeader}>
              <Text style={styles.drawerTitle} numberOfLines={1}>{activeDevice.name}</Text>
              <Pressable style={styles.drawerClose} onPress={closeDrawer} accessibilityRole="button" accessibilityLabel="关闭导航">
                <X color={colors.text} size={20} />
              </Pressable>
            </View>

            <ScrollView contentContainerStyle={styles.drawerScroll} showsVerticalScrollIndicator={false}>
              <DrawerItem
                label="全部视频"
                count={totalCount}
                active={selection.mode === 'all'}
                icon={<Grid2x2 color={selection.mode === 'all' ? colors.text : colors.muted} size={20} />}
                onPress={selectAll}
              />
              <DrawerItem
                label="我喜欢"
                count={currentFavoriteCount}
                active={selection.mode === 'favorites'}
                icon={<Heart color={selection.mode === 'favorites' ? colors.text : colors.muted} fill={selection.mode === 'favorites' ? colors.danger : 'none'} size={20} />}
                onPress={() => select({ mode: 'favorites', label: '我喜欢' })}
              />

              <DrawerSection title="目录">
                {directories.length ? directories.map(directory => (
                  <DrawerItem
                    key={directory.id}
                    label={directory.name}
                    count={directory.count}
                    active={selection.mode === 'directory' && selection.id === directory.id}
                    icon={<FolderOpen color={selection.mode === 'directory' && selection.id === directory.id ? colors.text : colors.muted} size={20} />}
                    onPress={() => select({ mode: 'directory', id: directory.id, label: directory.name })}
                  />
                )) : (
                  <Text style={styles.drawerEmpty}>暂无目录</Text>
                )}
              </DrawerSection>

              <DrawerSection
                title="自定义分类"
                headerAction={library.hiddenTagCount && library.hiddenTagCount > 0 ? (
                  <Pressable
                    style={styles.drawerClose}
                    accessibilityRole="button"
                    onPress={() => {
                      setDrawerOpen(false)
                      setRestoreError('')
                      setRestorePassword('')
                      setRestoreHiddenOpen(true)
                    }}
                    accessibilityLabel="还原隐藏的标签"
                  >
                    <EyeOff color={colors.muted} size={16} />
                  </Pressable>
                ) : undefined}
              >
                {categoryGroups.custom.length ? categoryGroups.custom.map(category => {
                  const isIncluded = includedTagKeySet.has(category.key)
                  const isExcluded = excludedTagKeySet.has(category.key)
                  return (
                    <DrawerItem
                      key={category.key}
                      label={category.name}
                      count={category.count}
                      active={isIncluded}
                      excluded={isExcluded}
                      icon={<Tag color={isIncluded ? colors.text : isExcluded ? colors.danger : colors.muted} size={20} />}
                      onPress={() => toggleTagFilter({ key: category.key, type: 'custom', name: category.name })}
                    />
                  )
                }) : (
                  <Text style={styles.drawerEmpty}>暂无自定义分类</Text>
                )}
                {library.categoryPagination?.customNextCursor ? (
                  <DrawerItem label={categoryLoading === 'custom' ? '正在加载分类…' : '更多分类'}
                    icon={<Tags color={colors.muted} size={20} />} onPress={() => { void repository.loadCategories('custom') }} />
                ) : null}
              </DrawerSection>

              <DrawerSection title="系统分类">
                {categoryGroups.system.length ? categoryGroups.system.map(category => {
                  const isIncluded = includedTagKeySet.has(category.key)
                  const isExcluded = excludedTagKeySet.has(category.key)
                  return (
                    <DrawerItem
                      key={category.key}
                      label={category.name}
                      count={category.count}
                      active={isIncluded}
                      excluded={isExcluded}
                      icon={<Folder color={isIncluded ? colors.text : isExcluded ? colors.danger : colors.muted} size={20} />}
                      onPress={() => toggleTagFilter({ key: category.key, type: 'system', name: category.name })}
                    />
                  )
                }) : (
                  <Text style={styles.drawerEmpty}>暂无系统分类</Text>
                )}
                {library.categoryPagination?.systemNextCursor ? (
                  <DrawerItem label={categoryLoading === 'system' ? '正在加载分类…' : '更多分类'}
                    icon={<Tags color={colors.muted} size={20} />} onPress={() => { void repository.loadCategories('system') }} />
                ) : null}
              </DrawerSection>
            </ScrollView>

            <View style={styles.drawerBottom}>
              <DrawerItem
                label="设备"
                icon={<Monitor color={colors.muted} size={20} />}
                onPress={openDeviceList}
              />
              <DrawerItem
                label="设置"
                active={selection.mode === 'settings'}
                icon={<Settings color={selection.mode === 'settings' ? colors.text : colors.muted} size={20} />}
                onPress={openSettings}
              />
              <Text style={styles.drawerVersion}>v{APP_VERSION}</Text>
            </View>
          </View>
        </View>
      ) : null}
        </AccessibleModal>
      ) : null}
    </View>
  )
}

type DrawerSectionProps = {
  title: string
  headerAction?: ReactNode
  children: ReactNode
}

type SortOption = { key: SortKey, label: string, icon: ReactNode }

type SortFilterBarProps = {
  styles: ReturnType<typeof createStyles>
  sortOptions: SortOption[]
  visibleSortBy: SortKey
  tagFilters: TagFilter[]
  onSortSelect: (key: SortKey) => void
  onClearTagFilters: () => void
}

type BulkSelectionBarProps = {
  onLayout: (event: LayoutChangeEvent) => void
  styles: ReturnType<typeof createStyles>
  colors: ReturnType<typeof useTheme>['colors']
  selectedCount: number
  onOpenBulkTagSheet: () => void
  onClearVideoSelection: () => void
}

type RestoreHiddenSheetProps = {
  styles: ReturnType<typeof createStyles>
  colors: ReturnType<typeof useTheme>['colors']
  password: string
  submitting: boolean
  error: string
  onPasswordChange: (value: string) => void
  onClose: () => void
  onSubmit: () => void
}

function getTagFilterSummary(tagFilters: TagFilter[]) {
  const included = tagFilters.filter(filter => filter.state === 'include').length
  const excluded = tagFilters.filter(filter => filter.state === 'exclude').length
  return [
    included ? `包含 ${included}` : '',
    excluded ? `排除 ${excluded}` : ''
  ].filter(Boolean).join('，')
}

function SortFilterBar({
  styles,
  sortOptions,
  visibleSortBy,
  tagFilters,
  onSortSelect,
  onClearTagFilters
}: SortFilterBarProps) {
  return (
    <>
      <View style={styles.sortBar}>
        {sortOptions.map(option => (
          <Pressable
            key={option.key}
            style={[styles.sortChip, visibleSortBy === option.key && styles.sortChipActive]}
            onPress={() => onSortSelect(option.key)}
            accessibilityRole="button"
            accessibilityLabel={`按${option.label}排序`}
            accessibilityState={{ selected: visibleSortBy === option.key }}
          >
            {option.icon}
            <Text style={[styles.sortChipText, visibleSortBy === option.key && styles.sortChipTextActive]}>
              {option.label}
            </Text>
          </Pressable>
        ))}
      </View>
      {tagFilters.length ? (
        <View style={styles.filterBar}>
          <Text style={styles.filterBarText}>{getTagFilterSummary(tagFilters)}</Text>
          <Pressable style={styles.filterClearButton} onPress={onClearTagFilters} accessibilityRole="button" accessibilityLabel="清空标签筛选">
            <Text style={styles.filterClearText}>清空</Text>
          </Pressable>
        </View>
      ) : null}
    </>
  )
}

function BulkSelectionBar({
  styles,
  colors,
  selectedCount,
  onOpenBulkTagSheet,
  onClearVideoSelection,
  onLayout
}: BulkSelectionBarProps) {
  return (
    <View style={styles.bulkBar} onLayout={onLayout}>
      <Text style={styles.bulkText}>已选择 {selectedCount} 个视频</Text>
      <Pressable style={styles.bulkButton} onPress={onOpenBulkTagSheet} accessibilityRole="button" accessibilityLabel="为已选视频添加标签">
        <Tag color={colors.onAccent} size={17} />
        <Text style={styles.bulkButtonText}>添加标签</Text>
      </Pressable>
      <Pressable style={[styles.bulkButton, styles.bulkButtonSecondary]} onPress={onClearVideoSelection} accessibilityRole="button" accessibilityLabel="取消视频选择">
        <Text style={[styles.bulkButtonText, styles.bulkButtonSecondaryText]}>取消</Text>
      </Pressable>
    </View>
  )
}

function RestoreHiddenSheet({
  styles,
  colors,
  password,
  submitting,
  error,
  onPasswordChange,
  onClose,
  onSubmit
}: RestoreHiddenSheetProps) {
  return (
    <KeyboardAvoidingView
      style={styles.bulkSheetAvoider}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      pointerEvents="box-none"
    >
      <Pressable style={styles.bulkSheetScrim} onPress={onClose} accessible={false} importantForAccessibility="no" />
      <View style={styles.bulkSheet}>
        <View style={styles.bulkSheetHeader}>
          <Text style={styles.bulkSheetTitle}>还原隐藏标签</Text>
          <Pressable style={styles.drawerClose} onPress={onClose} accessibilityRole="button" accessibilityLabel="关闭还原隐藏标签">
            <X color={colors.text} size={20} />
          </Pressable>
        </View>
        <ScrollView style={styles.bulkSheetScroll} contentContainerStyle={styles.bulkSheetScrollContent} keyboardShouldPersistTaps="handled">
          <Text style={styles.bulkSheetHint}>
            验证隐私密码后，将还原电脑端所有被隐藏的标签。
          </Text>
          <TextInput
            value={password}
            onChangeText={onPasswordChange}
            placeholder="请输入隐私密码"
            placeholderTextColor={colors.subtle}
            style={styles.bulkInput}
            secureTextEntry
            returnKeyType="done"
            onSubmitEditing={onSubmit}
            accessibilityLabel="隐私密码"
          />
          {error ? <Text style={styles.restoreErrorText}>{error}</Text> : null}
        </ScrollView>
        <Pressable
          style={[styles.bulkSaveButton, (!password || submitting) && styles.updateButtonDisabled]}
          onPress={onSubmit}
          disabled={!password || submitting}
          accessibilityRole="button"
          accessibilityState={{ disabled: !password || submitting, busy: submitting }}
        >
          {submitting ? <ActivityIndicator color={colors.onAccent} size="small" /> : null}
          <Text style={styles.bulkSaveButtonText}>{submitting ? '还原中...' : '还原隐藏标签'}</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  )
}

function DrawerSection({ title, headerAction, children }: DrawerSectionProps) {
  const { colors } = useTheme()
  const styles = createStyles(colors)

  return (
    <View style={styles.drawerSection}>
      <View style={styles.drawerSectionHeader}>
        <Text style={styles.drawerSectionTitle}>{title}</Text>
        {headerAction}
      </View>
      {children}
    </View>
  )
}

type DrawerItemProps = {
  label: string
  count?: number
  active?: boolean
  excluded?: boolean
  icon: ReactNode
  onPress: () => void
}

function DrawerItem({ label, count, active, excluded, icon, onPress }: DrawerItemProps) {
  const { colors } = useTheme()
  const styles = createStyles(colors)

  return (
    <Pressable style={[styles.drawerItem, active && styles.drawerItemActive, excluded && styles.drawerItemExcluded]} onPress={onPress}
      accessibilityRole="button" accessibilityLabel={`${label}${typeof count === 'number' ? `，${count} 项` : ''}${excluded ? '，已排除' : ''}`} accessibilityState={{ selected: active || excluded }}>
      {icon}
      <Text style={[styles.drawerItemText, active && styles.drawerItemTextActive, excluded && styles.drawerItemTextExcluded]}>{label}</Text>
      {typeof count === 'number' ? <Text style={[styles.drawerItemCount, excluded && styles.drawerItemCountExcluded]}>{count}</Text> : null}
    </Pressable>
  )
}

const createStyles = (colors: ReturnType<typeof useTheme>['colors'], fontScale = 1) => StyleSheet.create({
  shell: {
    flex: 1,
    backgroundColor: colors.background
  },
  header: {
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 9,
    gap: 7,
    borderBottomWidth: 1,
    borderBottomColor: colors.border
  },
  titleRow: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9
  },
  titleBlock: {
    flex: 1,
    minWidth: 0
  },
  title: {
    color: colors.text,
    fontSize: 19,
    fontWeight: '800'
  },
  subtitle: {
    color: colors.muted,
    fontSize: 12,
    marginTop: 2
  },
  iconButton: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center'
  },
  searchHeader: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10
  },
  searchBox: {
    flex: 1,
    minHeight: 48,
    borderRadius: 14,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    gap: 8
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    color: colors.text,
    fontSize: 16,
    paddingVertical: 8
  },
  clearButton: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center'
  },
  error: {
    color: colors.warning,
    fontSize: 13
  },
  sortBar: {
    minHeight: 44,
    paddingHorizontal: 10,
    paddingVertical: 7,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border
  },
  sortChip: {
    flex: 1,
    flexBasis: fontScale > 1.3 ? '40%' : '20%',
    minHeight: 48,
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5
  },
  sortChipActive: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.accentStrong
  },
  sortChipText: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '700'
  },
  sortChipTextActive: {
    color: colors.text
  },
  filterBar: {
    minHeight: 40,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  filterBarText: {
    flex: 1,
    color: colors.text,
    fontSize: 12,
    fontWeight: '800'
  },
  filterClearButton: {
    minHeight: 48,
    minWidth: 48,
    borderRadius: 12,
    paddingHorizontal: 10,
    backgroundColor: colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center'
  },
  filterClearText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '800'
  },
  list: {
    padding: 10,
    gap: GRID_GAP
  },
  gridRow: {
    gap: GRID_GAP,
    marginBottom: GRID_GAP
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 12
  },
  centerText: {
    color: colors.muted,
    fontSize: 15,
    textAlign: 'center'
  },
  gate: {
    flexGrow: 1,
    padding: 28,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14
  },
  gateIcon: {
    width: 72,
    height: 72,
    borderRadius: 20,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2
  },
  gateTitle: {
    color: colors.text,
    fontSize: 23,
    fontWeight: '800',
    textAlign: 'center'
  },
  gateDetail: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center'
  },
  progressTrack: {
    width: '100%',
    maxWidth: 320,
    height: 6,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    marginTop: 4
  },
  progressFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: colors.accent
  },
  progressText: {
    color: colors.subtle,
    fontSize: 12,
    fontWeight: '700'
  },
  gateActions: {
    width: '100%',
    maxWidth: 320,
    gap: 10,
    marginTop: 6
  },
  drawerScrim: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.scrim
  },
  drawer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: 304,
    maxWidth: '100%',
    backgroundColor: colors.background,
    borderRightWidth: 1,
    borderRightColor: colors.border,
    padding: 14,
    gap: 8
  },
  drawerHeader: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 4
  },
  drawerTitle: {
    flex: 1,
    color: colors.text,
    fontSize: 18,
    fontWeight: '800'
  },
  drawerClose: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center'
  },
  drawerScroll: {
    gap: 6,
    paddingBottom: 8
  },
  drawerItem: {
    minHeight: 48,
    paddingVertical: 8,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    gap: 10
  },
  drawerItemActive: {
    backgroundColor: colors.surfaceElevated
  },
  drawerItemText: {
    flex: 1,
    color: colors.muted,
    fontSize: 15,
    fontWeight: '700'
  },
  drawerItemTextActive: {
    color: colors.text
  },
  drawerItemCount: {
    color: colors.subtle,
    fontSize: 12
  },
  drawerItemExcluded: {
    backgroundColor: 'rgba(255, 107, 107, 0.12)'
  },
  restoreErrorText: {
    color: colors.danger,
    fontSize: 13,
    marginTop: 8
  },
  drawerItemTextExcluded: {
    color: colors.danger,
    textDecorationLine: 'line-through'
  },
  drawerItemCountExcluded: {
    color: colors.danger
  },
  drawerSection: {
    paddingTop: 10,
    gap: 4
  },
  drawerSectionTitle: {
    color: colors.subtle,
    fontSize: 12,
    fontWeight: '800',
    paddingHorizontal: 10,
    paddingBottom: 2,
    flex: 1
  },
  drawerSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: 6
  },
  drawerEmpty: {
    color: colors.subtle,
    padding: 10
  },
  drawerBottom: {
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: colors.border
  },
  drawerVersion: {
    color: colors.subtle,
    fontSize: 12,
    textAlign: 'center',
    paddingTop: 6
  },
  settingsScroll: {
    flex: 1,
  },
  settingsPanel: {
    flexGrow: 1,
    padding: 20,
    paddingBottom: 28,
    gap: 12
  },
  settingGroup: {
    gap: 8
  },
  settingLabel: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '800'
  },
  themeToggle: {
    flexDirection: 'row',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: 4,
    gap: 4
  },
  themeOption: {
    flex: 1,
    minHeight: 48,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center'
  },
  themeOptionActive: {
    backgroundColor: colors.accentStrong
  },
  themeOptionText: {
    color: colors.muted,
    fontSize: 14,
    fontWeight: '800'
  },
  themeOptionTextActive: {
    color: colors.onAccent
  },
  updateButtonDisabled: {
    opacity: 0.62
  },
  settingsTitle: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '800'
  },
  settingsText: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20
  },
  bulkBar: {
    position: 'absolute',
    left: 10,
    right: 10,
    bottom: 12,
    minHeight: 54,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceElevated,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8
  },
  bulkText: {
    flex: 1,
    minWidth: '40%',
    color: colors.text,
    fontSize: 14,
    fontWeight: '800'
  },
  bulkButton: {
    minHeight: 48,
    borderRadius: 8,
    paddingHorizontal: 11,
    backgroundColor: colors.accentStrong,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5
  },
  bulkButtonSecondary: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border
  },
  bulkButtonText: {
    color: colors.onAccent,
    fontSize: 13,
    fontWeight: '800'
  },
  bulkButtonSecondaryText: {
    color: colors.text
  },
  bulkSheetScrim: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(0,0,0,0.42)'
  },
  bulkSheetAvoider: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    justifyContent: 'flex-end'
  },
  bulkSheet: {
    marginHorizontal: 10,
    marginBottom: 10,
    maxHeight: '92%',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    padding: 16,
    gap: 12
  },
  bulkSheetScroll: {
    flexShrink: 1
  },
  bulkSheetScrollContent: {
    gap: 10,
    paddingBottom: 2
  },
  bulkSheetHeader: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10
  },
  bulkSheetTitle: {
    flex: 1,
    color: colors.text,
    fontSize: 20,
    fontWeight: '900'
  },
  bulkSheetHint: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 19
  },
  bulkSectionLabel: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '900'
  },
  bulkInput: {
    minHeight: 48,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.text,
    paddingHorizontal: 12,
    fontSize: 15
  },
  bulkPendingTags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8
  },
  bulkPendingTag: {
    maxWidth: '100%',
    minHeight: 48,
    paddingVertical: 8,
    borderRadius: 999,
    paddingLeft: 11,
    paddingRight: 9,
    backgroundColor: colors.accentStrong,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5
  },
  bulkPendingTagText: {
    color: colors.onAccent,
    fontSize: 12,
    fontWeight: '800',
    maxWidth: 180
  },
  bulkTagSearchHeader: {
    marginTop: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  bulkTagCount: {
    color: colors.subtle,
    fontSize: 12,
    fontWeight: '700'
  },
  bulkSearchBox: {
    minHeight: 48,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingLeft: 11,
    paddingRight: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7
  },
  bulkSearchInput: {
    flex: 1,
    minHeight: 40,
    color: colors.text,
    fontSize: 14,
    paddingVertical: 8
  },
  bulkSearchClear: {
    width: 48,
    height: 48,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center'
  },
  bulkTagOptions: {
    minHeight: 38,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8
  },
  bulkTagOption: {
    maxWidth: '100%',
    minHeight: 48,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: 11,
    alignItems: 'center',
    justifyContent: 'center'
  },
  bulkTagOptionSelected: {
    borderColor: colors.accentStrong,
    backgroundColor: colors.accentStrong
  },
  bulkTagOptionText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '800',
    maxWidth: 180
  },
  bulkTagOptionTextSelected: {
    color: colors.onAccent
  },
  bulkTagEmpty: {
    color: colors.subtle,
    fontSize: 13,
    lineHeight: 20
  },
  bulkSaveButton: {
    minHeight: 48,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: colors.accentStrong,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8
  },
  bulkSaveButtonText: {
    color: colors.onAccent,
    fontSize: 15,
    fontWeight: '900'
  }
})
