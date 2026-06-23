import { useState, useMemo, useCallback, useEffect, useDeferredValue } from 'react'

const zhCollator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })

export function getCategoryKey(type, name) {
  return `${type}:${name}`
}

export function parseCategoryKey(key) {
  if (key.startsWith('custom:')) return { type: 'custom', name: key.slice(7) }
  if (key.startsWith('system:')) return { type: 'system', name: key.slice(7) }
  return { type: key, name: key }
}

function uniqueTags(tags) {
  const seen = new Set()
  const result = []
  for (const value of tags) {
    const tag = String(value || '').trim()
    const key = tag.toLocaleLowerCase()
    if (!tag || seen.has(key)) continue
    seen.add(key)
    result.push(tag)
  }
  return result
}

function categoryExists(categoryKey, categoryGroups) {
  if (categoryKey === 'favorites') return true
  const category = parseCategoryKey(categoryKey)
  if (category.type === 'custom') return categoryGroups.custom.some(item => item.name === category.name)
  if (category.type === 'system') return categoryGroups.system.some(item => item.name === category.name)
  return [...categoryGroups.custom, ...categoryGroups.system].some(item => item.name === categoryKey)
}

function videoMatchesCategory(video, categoryKey) {
  const category = parseCategoryKey(categoryKey)
  if (category.type === 'custom') return (video.customTags || []).includes(category.name)
  if (category.type === 'system') return (video.systemTags || []).includes(category.name)
  return (video.tags || []).includes(categoryKey)
}

function getSortTitle(video) {
  return String(video?.name || video?.fileName || '').trim()
}

function getSortFileName(video) {
  return String(video?.fileName || '').trim()
}

function getSortPath(video) {
  return String(video?.fullPath || video?.path || video?.id || '').trim()
}

function compareByTitle(a, b) {
  return zhCollator.compare(getSortTitle(a), getSortTitle(b)) ||
    zhCollator.compare(getSortFileName(a), getSortFileName(b)) ||
    zhCollator.compare(getSortPath(a), getSortPath(b))
}

// 过滤 / 排序 / 分类 / 搜索
export function useVideoFilter({ videos, customTags, favoriteKeys }) {
  const [searchQuery, setSearchQuery] = useState('')
  const [sortBy, setSortBy] = useState('name')
  const [selectedCategoryKeys, setSelectedCategoryKeys] = useState([])

  const setActiveCategory = useCallback((categoryKey) => {
    if (!categoryKey || categoryKey === 'all') {
      setSelectedCategoryKeys([])
      return
    }

    if (categoryKey === 'favorites') {
      setSelectedCategoryKeys(['favorites'])
      return
    }

    setSelectedCategoryKeys(current => {
      const activeTags = current.filter(key => key !== 'favorites')
      return activeTags.includes(categoryKey)
        ? activeTags.filter(key => key !== categoryKey)
        : [...activeTags, categoryKey]
    })
  }, [])

  // 合并系统标签与自定义标签后的视频列表
  const displayVideos = useMemo(() => (
    videos.map(video => {
      const tagKey = video.favoriteKey || video.fullPath
      const legacyKey = video.fullPath && video.fullPath !== tagKey ? video.fullPath : ''
      const systemTags = video.tags || []
      const userTags = uniqueTags([
        ...(Array.isArray(customTags[tagKey]) ? customTags[tagKey] : []),
        ...(legacyKey && Array.isArray(customTags[legacyKey]) ? customTags[legacyKey] : [])
      ])
      const tags = uniqueTags([...systemTags, ...userTags])
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
        case 'name': return compareByTitle(a, b)
        case 'size': return (Number(b.size) || 0) - (Number(a.size) || 0) || compareByTitle(a, b)
        case 'date': return (Number(b.modified) || 0) - (Number(a.modified) || 0) || compareByTitle(a, b)
        case 'type': return zhCollator.compare(a.extension || '', b.extension || '') || compareByTitle(a, b)
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
      .sort((a, b) => b.count - a.count || zhCollator.compare(a.name, b.name))

    return {
      custom: toCategories(customCounts, 'custom'),
      system: toCategories(systemCounts, 'system')
    }
  }, [displayVideos])

  const favoriteCount = useMemo(() => (
    displayVideos.filter(video => favoriteKeys.has(video.favoriteKey || video.fullPath)).length
  ), [displayVideos, favoriteKeys])

  // 当前选中的分类被删空后自动移除
  useEffect(() => {
    setSelectedCategoryKeys(current => current.filter(key => categoryExists(key, categoryGroups)))
  }, [categoryGroups])

  const deferredSearchQuery = useDeferredValue(searchQuery)
  const normalizedSearchQuery = useMemo(() => (
    deferredSearchQuery.trim().toLowerCase()
  ), [deferredSearchQuery])
  const trimmedSearchQuery = searchQuery.trim()

  const filteredVideos = useMemo(() => {
    const favoriteOnly = selectedCategoryKeys.includes('favorites')
    const tagFilters = selectedCategoryKeys.filter(key => key !== 'favorites')
    return sortedVideos.filter(v => (
      (!favoriteOnly || favoriteKeys.has(v.favoriteKey || v.fullPath)) &&
      tagFilters.every(categoryKey => videoMatchesCategory(v, categoryKey)) &&
      (!normalizedSearchQuery ||
        v.name.toLowerCase().includes(normalizedSearchQuery) ||
        v.fileName?.toLowerCase().includes(normalizedSearchQuery) ||
        v.group.toLowerCase().includes(normalizedSearchQuery) ||
        (v.tags || []).some(tag => tag.toLowerCase().includes(normalizedSearchQuery)))
    ))
  }, [sortedVideos, normalizedSearchQuery, selectedCategoryKeys, favoriteKeys])

  const hasSearch = trimmedSearchQuery.length > 0
  const activeCategory = selectedCategoryKeys[0] || 'all'
  const hasCategoryFilter = selectedCategoryKeys.length > 0
  const hasFilter = hasSearch || hasCategoryFilter
  const activeCategoryLabel = activeCategory === 'favorites'
    ? '我喜欢'
    : !hasCategoryFilter
      ? '全部'
      : selectedCategoryKeys.map(key => parseCategoryKey(key).name).join(' + ')

  const handleClearFilters = useCallback(() => {
    setSearchQuery('')
    setSelectedCategoryKeys([])
  }, [])

  return {
    searchQuery,
    setSearchQuery,
    sortBy,
    setSortBy,
    activeCategory,
    setActiveCategory,
    selectedCategoryKeys,
    hasCategoryFilter,
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
