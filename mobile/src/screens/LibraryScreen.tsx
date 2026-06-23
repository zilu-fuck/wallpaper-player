import {
  ArrowLeft,
  Calendar,
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
import { useCallback, useEffect, useMemo, useRef, useState, startTransition } from 'react'
import {
  ActivityIndicator,
  FlatList,
  InteractionManager,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View
} from 'react-native'
import type { NavigationContext } from '../../App'
import mobilePackage from '../../package.json'
import { ConnectionStatus } from '../components/ConnectionStatus'
import { MobileUpdateCard } from '../components/MobileUpdateCard'
import { PrimaryButton } from '../components/PrimaryButton'
import { VideoCard } from '../components/VideoCard'
import { addTagsToVideos, ApiError, getLibrary, toggleFavorite } from '../services/api'
import { testConnection } from '../services/connection-manager'
import { loadCachedLibrary, saveLibraryResponse } from '../stores/library'
import { useTheme } from '../theme-context'
import type { ThemeMode } from '../theme'
import type { CategorySummary, DirectorySummary, LibraryResponse, StoredDevice, VideoItem } from '../types'
import { safeSearchText } from '../utils/url'

type Props = {
  navigation: NavigationContext
  device: StoredDevice
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

type TagFilter = {
  key: string
  type: 'custom' | 'system'
  name: string
}

const GRID_COLUMNS = 2
const GRID_GAP = 10
const EMPTY_GROUPS = { custom: [], system: [] }
const APP_VERSION = mobilePackage.version
const RECONNECT_BASE_DELAY_MS = 2000
const RECONNECT_MAX_DELAY_MS = 30000
const zhCollator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })

function getSortTitle(video: VideoItem) {
  return String(video.name || video.fileName || '').trim()
}

function getSortFileName(video: VideoItem) {
  return String(video.fileName || '').trim()
}

function getSortPath(video: VideoItem) {
  return String(video.id || video.streamUrl || video.thumbnailUrl || '').trim()
}

function compareByTitle(a: VideoItem, b: VideoItem) {
  return zhCollator.compare(getSortTitle(a), getSortTitle(b)) ||
    zhCollator.compare(getSortFileName(a), getSortFileName(b)) ||
    zhCollator.compare(getSortPath(a), getSortPath(b))
}

function getVideoSearchText(video: VideoItem) {
  return safeSearchText(
    video.name,
    video.fileName,
    video.group,
    video.tags,
    video.systemTags,
    video.customTags,
    video.directoryName,
    video.extension
  )
}

function sortVideos(videos: VideoItem[], sortBy: SortKey) {
  return [...videos].sort((a, b) => {
    switch (sortBy) {
      case 'date':
        return (b.modified || 0) - (a.modified || 0) || compareByTitle(a, b)
      case 'size':
        return (b.size || 0) - (a.size || 0) || compareByTitle(a, b)
      case 'type':
        return zhCollator.compare(a.extension || '', b.extension || '') || compareByTitle(a, b)
      case 'name':
      default:
        return compareByTitle(a, b)
    }
  })
}

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
    const systemTags = item.systemTags?.length ? item.systemTags : item.tags || []
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

function getTagKey(value: string) {
  return value.trim().toLocaleLowerCase()
}

function uniqueTags(tags: string[]) {
  const seen = new Set<string>()
  const result: string[] = []

  for (const value of tags) {
    const tag = String(value || '').trim()
    const key = getTagKey(tag)
    if (!tag || seen.has(key)) continue
    seen.add(key)
    result.push(tag)
  }

  return result
}

function normalizeTagText(value: string) {
  return uniqueTags(value.split(/[,，\s]+/))
}

function videoMatchesTagFilter(video: VideoItem, filter: TagFilter) {
  if (filter.type === 'custom') return Boolean(video.customTags?.includes(filter.name))
  const systemTags = video.systemTags?.length ? video.systemTags : video.tags || []
  return systemTags.includes(filter.name)
}

export function LibraryScreen({ navigation, device }: Props) {
  const { colors, themeMode, setThemeMode } = useTheme()
  const styles = createStyles(colors)
  const [activeDevice, setActiveDevice] = useState(device)
  const activeDeviceRef = useRef(device)
  const readyRef = useRef(false)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const libraryRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const libraryRequestRef = useRef(0)
  const reconnectAttemptRef = useRef(0)
  const loadRef = useRef<((useCache?: boolean) => Promise<void>) | null>(null)
  const pendingSortTaskRef = useRef<{ cancel?: () => void } | null>(null)
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
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [visibleSortBy, setVisibleSortBy] = useState<SortKey>('name')
  const [sortBy, setSortBy] = useState<SortKey>('name')
  const [selection, setSelection] = useState<Selection>({ mode: 'all', label: device.name })
  const [tagFilters, setTagFilters] = useState<TagFilter[]>([])
  const [selectedVideoIds, setSelectedVideoIds] = useState<string[]>([])
  const [bulkTagOpen, setBulkTagOpen] = useState(false)
  const [bulkTagText, setBulkTagText] = useState('')
  const [bulkTagQuery, setBulkTagQuery] = useState('')
  const [bulkSelectedTags, setBulkSelectedTags] = useState<string[]>([])
  const [bulkSaving, setBulkSaving] = useState(false)
  const { width } = useWindowDimensions()

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

  const load = useCallback(async (useCache = true) => {
    const isInitialLoad = !readyRef.current
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

    if (useCache && !isInitialLoad) {
      const cached = await loadCachedLibrary(activeDeviceRef.current.id)
      if (cached?.items.length) {
        applyLibrary(cached)
        setLoading(false)
      }
    }

    try {
      const connectedDevice = await testConnection(activeDeviceRef.current, isInitialLoad ? setConnectionGate : undefined)
      setActiveDevice(connectedDevice)
      setOnline(true)
      if (isInitialLoad) {
        setConnectionGate({
          progress: 0.76,
          title: '正在同步视频库',
          detail: '正在读取电脑端目录和分类...'
        })
      }
      const response = await getLibrary(connectedDevice)
      if (requestId !== libraryRequestRef.current) return
      if (isInitialLoad) {
        setConnectionGate({
          progress: 0.92,
          title: '正在准备界面',
          detail: `已找到 ${response.count || response.items.length} 个视频`
        })
      }
      applyLibrary(response)
      await saveLibraryResponse(connectedDevice.id, response)
      if (response.refreshing) {
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
      if (requestId !== libraryRequestRef.current) return
      setOnline(false)
      const message = err instanceof Error ? err.message : '无法连接电脑'
      setError(message)
      const shouldReconnect = !(err instanceof ApiError && (
        err.status === 401 ||
        err.status === 403 ||
        err.code === 'unauthorized' ||
        err.code === 'device_mismatch' ||
        err.code === 'legacy_token_disabled'
      ))
      if (shouldReconnect && !isInitialLoad) {
        scheduleReconnect(message)
      }
      if (isInitialLoad) {
        setConnectionGate({
          progress: 1,
          title: '连接失败',
          detail: message,
          error: message
        })
      }
    } finally {
      if (requestId === libraryRequestRef.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [applyLibrary, clearLibraryRefreshTimer, clearReconnectTimer, scheduleReconnect])

  useEffect(() => {
    loadRef.current = load
  }, [load])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => () => {
    clearReconnectTimer()
    clearLibraryRefreshTimer()
  }, [clearLibraryRefreshTimer, clearReconnectTimer])

  const videos = library.items
  const directories = library.directories || []
  const categoryGroups = library.categoryGroups || EMPTY_GROUPS
  const totalCount = library.count || videos.length
  const currentFavoriteCount = library.favoriteCount ?? favoriteCount(videos)

  const filteredVideos = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    const scoped = videos.filter(video => {
      if (selection.mode === 'favorites') return Boolean(video.favorite)
      if (selection.mode === 'directory') return video.directoryId === selection.id
      return tagFilters.every(filter => videoMatchesTagFilter(video, filter))
    })

    const searched = keyword
      ? scoped.filter(video => getVideoSearchText(video).includes(keyword))
      : scoped

    return sortVideos(searched, sortBy)
  }, [query, selection, sortBy, tagFilters, videos])

  const subtitle = useMemo(() => {
    if (loading) return '正在读取视频库'
    if (selection.mode === 'settings') return '手机访问与远程播放'
    if (filteredVideos.length === 0) return query.trim() ? '没有匹配的视频' : '没有可显示的视频'
    return `${filteredVideos.length} / ${totalCount} 个视频`
  }, [filteredVideos.length, loading, query, selection.mode, totalCount])

  const gridPadding = 10
  const cardWidth = Math.max(144, Math.floor((width - gridPadding * 2 - GRID_GAP) / GRID_COLUMNS))
  const title = tagFilters.length
    ? tagFilters.map(filter => filter.name).join(' + ')
    : selection.mode === 'all' ? activeDevice.name : selection.label
  const selectedVideoIdSet = useMemo(() => new Set(selectedVideoIds), [selectedVideoIds])
  const selectionModeActive = selectedVideoIds.length > 0
  const tagFilterKeySet = useMemo(() => new Set(tagFilters.map(filter => filter.key)), [tagFilters])
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
    if (next.mode !== 'custom' && next.mode !== 'system') {
      setTagFilters([])
    }
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

  const toggleTagFilter = useCallback((filter: TagFilter) => {
    setTagFilters(current => {
      const exists = current.some(item => item.key === filter.key)
      const next = exists ? current.filter(item => item.key !== filter.key) : [...current, filter]
      setSelection(next.length
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

  const handleSortSelect = useCallback((key: SortKey) => {
    setVisibleSortBy(key)
    pendingSortTaskRef.current?.cancel?.()
    pendingSortTaskRef.current = InteractionManager.runAfterInteractions(() => {
      startTransition(() => {
        setSortBy(key)
      })
      pendingSortTaskRef.current = null
    })
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
      await addTagsToVideos(activeDevice, selectedVideoIds, tags)
      setLibrary(current => {
        const items = current.items.map(item => {
          if (!selectedVideoIds.includes(item.id)) return item
          const customTags = [...new Set([...(item.customTags || []), ...tags])]
          const allTags = [...new Set([...(item.tags || []), ...tags])]
          return { ...item, customTags, tags: allTags }
        })
        return {
          ...current,
          items,
          categoryGroups: inferCategoryGroups(items)
        }
      })
      clearVideoSelection()
    } catch (err) {
      setError(err instanceof Error ? err.message : '批量添加标签失败')
    } finally {
      setBulkSaving(false)
    }
  }, [activeDevice, pendingBulkTags, selectedVideoIds, clearVideoSelection])

  useEffect(() => () => {
    pendingSortTaskRef.current?.cancel?.()
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
        favoriteCount: favoriteCount(items)
      }
    })

    try {
      const result = await toggleFavorite(activeDevice, video.id)
      setLibrary(current => {
        const items = current.items.map(item => item.id === video.id ? { ...item, favorite: result.favorite } : item)
        return {
          ...current,
          items,
          favoriteCount: favoriteCount(items)
        }
      })
    } catch (err) {
      setLibrary(current => {
        const items = current.items.map(item => item.id === video.id ? { ...item, favorite: video.favorite } : item)
        return {
          ...current,
          items,
          favoriteCount: favoriteCount(items)
        }
      })
      setError(err instanceof Error ? err.message : '收藏同步失败')
    }
  }, [activeDevice])

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
        <View style={styles.gate}>
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
            </View>
          ) : (
            <ActivityIndicator color={colors.accent} />
          )}
        </View>
      </View>
    )
  }

  return (
    <View style={styles.shell}>
      <View style={styles.header}>
        {searchOpen ? (
          <View style={styles.searchHeader}>
            <Pressable style={styles.iconButton} onPress={closeSearch}>
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
              />
              {query ? (
                <Pressable style={styles.clearButton} onPress={() => setQuery('')}>
                  <X color={colors.muted} size={18} />
                </Pressable>
              ) : null}
            </View>
          </View>
        ) : (
          <View style={styles.titleRow}>
            <Pressable style={styles.iconButton} onPress={() => setDrawerOpen(true)}>
              <Menu color={colors.text} size={22} />
            </Pressable>
            <View style={styles.titleBlock}>
              <Text style={styles.title} numberOfLines={1}>{title}</Text>
              <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text>
            </View>
            <Pressable style={styles.iconButton} onPress={openSearch}>
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
        {!searchOpen && error ? <Text style={styles.error}>{error}</Text> : null}
      </View>

      {selection.mode === 'settings' ? (
        <View style={styles.settingsPanel}>
          <Text style={styles.settingsTitle}>手机访问设置</Text>
          <View style={styles.settingGroup}>
            <Text style={styles.settingLabel}>外观主题</Text>
            <View style={styles.themeToggle}>
              {(['dark', 'light'] as const).map(mode => (
                <Pressable
                  key={mode}
                  style={[styles.themeOption, themeMode === mode && styles.themeOptionActive]}
                  onPress={() => handleThemeSelect(mode)}
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
            <MobileUpdateCard />
          </View>
          <Text style={styles.settingsText}>目录 {directories.length} 个 · 视频 {totalCount} 个 · 我喜欢 {currentFavoriteCount} 个</Text>
          <PrimaryButton
            label="返回视频库"
            icon={<Grid2x2 color={colors.onAccent} size={20} />}
            onPress={selectAll}
          />
        </View>
      ) : loading && videos.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.centerText}>正在加载视频库...</Text>
        </View>
      ) : (
        <>
          <View style={styles.sortBar}>
            {sortOptions.map(option => (
              <Pressable
                key={option.key}
                style={[styles.sortChip, visibleSortBy === option.key && styles.sortChipActive]}
                onPress={() => handleSortSelect(option.key)}
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
              <Text style={styles.filterBarText} numberOfLines={1}>
                交集筛选：{tagFilters.map(filter => filter.name).join(' + ')}
              </Text>
              <Pressable style={styles.filterClearButton} onPress={clearTagFilters}>
                <Text style={styles.filterClearText}>清空</Text>
              </Pressable>
            </View>
          ) : null}
          <FlatList
            key="library-grid"
            data={filteredVideos}
            keyExtractor={item => item.id}
            numColumns={GRID_COLUMNS}
            columnWrapperStyle={styles.gridRow}
            contentContainerStyle={styles.list}
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true)
              load(false)
            }}
            renderItem={({ item }) => (
              <VideoCard
                width={cardWidth}
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
                <Text style={styles.centerText}>还没有视频</Text>
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
        <View style={styles.bulkBar}>
          <Text style={styles.bulkText}>已选择 {selectedVideoIds.length} 个视频</Text>
          <Pressable style={styles.bulkButton} onPress={openBulkTagSheet}>
            <Tag color={colors.onAccent} size={17} />
            <Text style={styles.bulkButtonText}>添加标签</Text>
          </Pressable>
          <Pressable style={[styles.bulkButton, styles.bulkButtonSecondary]} onPress={clearVideoSelection}>
            <Text style={[styles.bulkButtonText, styles.bulkButtonSecondaryText]}>取消</Text>
          </Pressable>
        </View>
      ) : null}

      {bulkTagOpen ? (
        <KeyboardAvoidingView
          style={styles.bulkSheetAvoider}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          pointerEvents="box-none"
        >
          <Pressable style={styles.bulkSheetScrim} onPress={closeBulkTagSheet} />
          <View style={styles.bulkSheet}>
            <View style={styles.bulkSheetHeader}>
              <Text style={styles.bulkSheetTitle}>批量添加标签</Text>
              <Pressable style={styles.drawerClose} onPress={closeBulkTagSheet}>
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
              />
              {pendingBulkTags.length ? (
                <View style={styles.bulkPendingTags}>
                  {pendingBulkTags.map(tag => (
                    <Pressable key={tag} style={styles.bulkPendingTag} onPress={() => removePendingBulkTag(tag)}>
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
                />
                {bulkTagQuery ? (
                  <Pressable style={styles.bulkSearchClear} onPress={() => setBulkTagQuery('')}>
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
            >
              {bulkSaving ? <ActivityIndicator color={colors.onAccent} size="small" /> : null}
              <Text style={styles.bulkSaveButtonText}>{bulkSaving ? '保存中...' : '添加到已选视频'}</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      ) : null}

      {drawerOpen ? (
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          <Pressable style={styles.drawerScrim} onPress={closeDrawer} />
          <View style={styles.drawer}>
            <View style={styles.drawerHeader}>
              <Text style={styles.drawerTitle} numberOfLines={1}>{activeDevice.name}</Text>
              <Pressable style={styles.drawerClose} onPress={closeDrawer}>
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

              <DrawerSection title="自定义分类">
                {categoryGroups.custom.length ? categoryGroups.custom.map(category => (
                  <DrawerItem
                    key={category.key}
                    label={category.name}
                    count={category.count}
                    active={tagFilterKeySet.has(category.key)}
                    icon={<Tag color={tagFilterKeySet.has(category.key) ? colors.text : colors.muted} size={20} />}
                    onPress={() => toggleTagFilter({ key: category.key, type: 'custom', name: category.name })}
                  />
                )) : (
                  <Text style={styles.drawerEmpty}>暂无自定义分类</Text>
                )}
              </DrawerSection>

              <DrawerSection title="系统分类">
                {categoryGroups.system.length ? categoryGroups.system.map(category => (
                  <DrawerItem
                    key={category.key}
                    label={category.name}
                    count={category.count}
                    active={tagFilterKeySet.has(category.key)}
                    icon={<Folder color={tagFilterKeySet.has(category.key) ? colors.text : colors.muted} size={20} />}
                    onPress={() => toggleTagFilter({ key: category.key, type: 'system', name: category.name })}
                  />
                )) : (
                  <Text style={styles.drawerEmpty}>暂无系统分类</Text>
                )}
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
    </View>
  )
}

type DrawerSectionProps = {
  title: string
  children: ReactNode
}

function DrawerSection({ title, children }: DrawerSectionProps) {
  const { colors } = useTheme()
  const styles = createStyles(colors)

  return (
    <View style={styles.drawerSection}>
      <Text style={styles.drawerSectionTitle}>{title}</Text>
      {children}
    </View>
  )
}

type DrawerItemProps = {
  label: string
  count?: number
  active?: boolean
  icon: ReactNode
  onPress: () => void
}

function DrawerItem({ label, count, active, icon, onPress }: DrawerItemProps) {
  const { colors } = useTheme()
  const styles = createStyles(colors)

  return (
    <Pressable style={[styles.drawerItem, active && styles.drawerItemActive]} onPress={onPress}>
      {icon}
      <Text style={[styles.drawerItemText, active && styles.drawerItemTextActive]} numberOfLines={1}>{label}</Text>
      {typeof count === 'number' ? <Text style={styles.drawerItemCount}>{count}</Text> : null}
    </Pressable>
  )
}

const createStyles = (colors: ReturnType<typeof useTheme>['colors']) => StyleSheet.create({
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
    width: 40,
    height: 40,
    borderRadius: 8,
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
    height: 40,
    borderRadius: 8,
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
    color: colors.text,
    fontSize: 16,
    paddingVertical: 0
  },
  clearButton: {
    width: 28,
    height: 28,
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
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border
  },
  sortChip: {
    flex: 1,
    minHeight: 30,
    borderRadius: 8,
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
    minHeight: 28,
    borderRadius: 8,
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
    flex: 1,
    padding: 28,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14
  },
  gateIcon: {
    width: 72,
    height: 72,
    borderRadius: 16,
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
    height: 8,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    marginTop: 4
  },
  progressFill: {
    height: '100%',
    borderRadius: 8,
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
    backgroundColor: 'rgba(0,0,0,0.42)'
  },
  drawer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: 304,
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
    width: 38,
    height: 38,
    borderRadius: 8,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center'
  },
  drawerScroll: {
    gap: 6,
    paddingBottom: 8
  },
  drawerItem: {
    minHeight: 44,
    borderRadius: 8,
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
  drawerSection: {
    paddingTop: 10,
    gap: 4
  },
  drawerSectionTitle: {
    color: colors.subtle,
    fontSize: 12,
    fontWeight: '800',
    paddingHorizontal: 10,
    paddingBottom: 2
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
  settingsPanel: {
    flex: 1,
    padding: 20,
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
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: 4,
    gap: 4
  },
  themeOption: {
    flex: 1,
    minHeight: 38,
    borderRadius: 6,
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
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceElevated,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10
  },
  bulkText: {
    flex: 1,
    color: colors.text,
    fontSize: 14,
    fontWeight: '800'
  },
  bulkButton: {
    minHeight: 38,
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
    maxHeight: '74%',
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
    minHeight: 46,
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
    minHeight: 32,
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
    minHeight: 42,
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
    paddingVertical: 0
  },
  bulkSearchClear: {
    width: 32,
    height: 32,
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
    minHeight: 32,
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
    minHeight: 46,
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
