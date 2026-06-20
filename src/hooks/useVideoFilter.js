import { useState, useMemo, useCallback, useEffect, useDeferredValue } from 'react'

export function getCategoryKey(type, name) {
  return `${type}:${name}`
}

export function parseCategoryKey(key) {
  if (key.startsWith('custom:')) return { type: 'custom', name: key.slice(7) }
  if (key.startsWith('system:')) return { type: 'system', name: key.slice(7) }
  return { type: key, name: key }
}

// 过滤 / 排序 / 分类 / 搜索
export function useVideoFilter({ videos, customTags, favoriteKeys }) {
  const [searchQuery, setSearchQuery] = useState('')
  const [sortBy, setSortBy] = useState('name')
  const [activeCategory, setActiveCategory] = useState('all')

  // 合并系统标签与自定义标签后的视频列表
  const displayVideos = useMemo(() => (
    videos.map(video => {
      const tagKey = video.favoriteKey || video.fullPath
      const systemTags = video.tags || []
      const userTags = customTags[tagKey] || []
      const tags = [...new Set([...systemTags, ...userTags])]
      return {
        ...video,
        tags,
        systemTags,
        customTags: userTags,
        group: tags[0] || video.group
      }
    })
  ), [videos, customTags])

  const sortedVideos = useMemo(() => {
    return [...displayVideos].sort((a, b) => {
      switch (sortBy) {
        case 'name': return a.name.localeCompare(b.name, 'zh')
        case 'size': return b.size - a.size
        case 'date': return b.modified - a.modified
        case 'type': return a.extension.localeCompare(b.extension) || a.name.localeCompare(b.name, 'zh')
        default: return 0
      }
    })
  }, [displayVideos, sortBy])

  const categoryGroups = useMemo(() => {
    const customCounts = new Map()
    const systemCounts = new Map()
    for (const video of displayVideos) {
      for (const tag of video.customTags || []) {
        customCounts.set(tag, (customCounts.get(tag) || 0) + 1)
      }
      for (const tag of video.systemTags || []) {
        systemCounts.set(tag, (systemCounts.get(tag) || 0) + 1)
      }
    }

    const toCategories = (counts, type) => Array.from(counts.entries())
      .map(([name, count]) => ({ name, count, type, key: getCategoryKey(type, name) }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'))

    return {
      custom: toCategories(customCounts, 'custom'),
      system: toCategories(systemCounts, 'system')
    }
  }, [displayVideos])

  const favoriteCount = useMemo(() => (
    displayVideos.filter(video => favoriteKeys.has(video.favoriteKey || video.fullPath)).length
  ), [displayVideos, favoriteKeys])

  // 当前选中的分类被删空后自动回退到“全部”
  useEffect(() => {
    if (activeCategory === 'all' || activeCategory === 'favorites') return
    const category = parseCategoryKey(activeCategory)
    const exists = category.type === 'custom'
      ? categoryGroups.custom.some(item => item.name === category.name)
      : category.type === 'system'
        ? categoryGroups.system.some(item => item.name === category.name)
        : [...categoryGroups.custom, ...categoryGroups.system].some(item => item.name === activeCategory)
    if (!exists) {
      setActiveCategory('all')
    }
  }, [activeCategory, categoryGroups])

  const deferredSearchQuery = useDeferredValue(searchQuery)
  const normalizedSearchQuery = useMemo(() => (
    deferredSearchQuery.trim().toLowerCase()
  ), [deferredSearchQuery])
  const trimmedSearchQuery = searchQuery.trim()

  const filteredVideos = useMemo(() => {
    const category = parseCategoryKey(activeCategory)
    return sortedVideos.filter(v => (
      (activeCategory === 'all' ||
        (activeCategory === 'favorites'
          ? favoriteKeys.has(v.favoriteKey || v.fullPath)
          : category.type === 'custom'
            ? (v.customTags || []).includes(category.name)
            : category.type === 'system'
              ? (v.systemTags || []).includes(category.name)
              : (v.tags || []).includes(activeCategory))) &&
      (!normalizedSearchQuery ||
        v.name.toLowerCase().includes(normalizedSearchQuery) ||
        v.fileName?.toLowerCase().includes(normalizedSearchQuery) ||
        v.group.toLowerCase().includes(normalizedSearchQuery) ||
        (v.tags || []).some(tag => tag.toLowerCase().includes(normalizedSearchQuery)))
    ))
  }, [sortedVideos, normalizedSearchQuery, activeCategory, favoriteKeys])

  const hasSearch = trimmedSearchQuery.length > 0
  const hasFilter = hasSearch || activeCategory !== 'all'
  const activeCategoryInfo = parseCategoryKey(activeCategory)
  const activeCategoryLabel = activeCategory === 'favorites'
    ? '我喜欢'
    : activeCategory === 'all'
      ? '全部'
      : activeCategoryInfo.name

  const handleClearFilters = useCallback(() => {
    setSearchQuery('')
    setActiveCategory('all')
  }, [])

  return {
    searchQuery,
    setSearchQuery,
    sortBy,
    setSortBy,
    activeCategory,
    setActiveCategory,
    displayVideos,
    sortedVideos,
    categoryGroups,
    favoriteCount,
    filteredVideos,
    trimmedSearchQuery,
    normalizedSearchQuery,
    hasSearch,
    hasFilter,
    activeCategoryLabel,
    handleClearFilters
  }
}
