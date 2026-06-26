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

function getVideoCustomTags(video, customTags) {
  const tagKey = video.favoriteKey || video.fullPath
  const legacyKey = video.fullPath && video.fullPath !== tagKey ? video.fullPath : ''
  return uniqueTags([
    ...(Array.isArray(customTags[tagKey]) ? customTags[tagKey] : []),
    ...(legacyKey && Array.isArray(customTags[legacyKey]) ? customTags[legacyKey] : [])
  ])
}

function getSystemTags(video) {
  return Array.isArray(video.systemTags)
    ? video.systemTags
    : Array.isArray(video.tags)
      ? video.tags
      : []
}

function getCustomTags(video) {
  return Array.isArray(video.customTags) ? video.customTags : []
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
  if (category.type === 'custom') return getCustomTags(video).includes(category.name)
  if (category.type === 'system') return getSystemTags(video).includes(category.name)
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
export function useVideoFilter({ videos, customTags, favoriteKeys, hiddenTags }) {
  const [searchQuery, setSearchQuery] = useState('')
  const [sortBy, setSortBy] = useState('name')
  // 三态筛选：included = 包含(AND 交集)，excluded = 排除(并集排除，命中任一即隐藏)
  const [filterState, setFilterState] = useState({ included: [], excluded: [] })

  const setActiveCategory = useCallback((categoryKey) => {
    if (!categoryKey || categoryKey === 'all') {
      setFilterState({ included: [], excluded: [] })
      return
    }

    if (categoryKey === 'favorites') {
      // favorites 独占：选中则只看收藏，再点取消；不进入排除态
      setFilterState(prev =>
        prev.included.includes('favorites')
          ? { included: [], excluded: [] }
          : { included: ['favorites'], excluded: [] }
      )
      return
    }

    // 三态循环：未选 → 包含 → 排除 → 未选
    setFilterState(prev => {
      const { included, excluded } = prev
      if (included.includes(categoryKey)) {
        // 包含 → 排除（同时清掉 favorites 独占态）
        return {
          included: included.filter(k => k !== 'favorites' && k !== categoryKey),
          excluded: [...excluded, categoryKey]
        }
      }
      if (excluded.includes(categoryKey)) {
        // 排除 → 未选
        return { included, excluded: excluded.filter(k => k !== categoryKey) }
      }
      // 未选 → 包含（清掉 favorites 独占态）
      return {
        included: [...included.filter(k => k !== 'favorites'), categoryKey],
        excluded
      }
    })
  }, [])

  // 合并系统标签与自定义标签后的视频列表。大多数视频没有自定义标签时复用原对象，避免全库浅拷贝。
  const displayVideos = useMemo(() => {
    if (!customTags || Object.keys(customTags).length === 0) return videos

    let nextVideos = null
    for (let index = 0; index < videos.length; index += 1) {
      const video = videos[index]
      const systemTags = getSystemTags(video)
      const userTags = getVideoCustomTags(video, customTags)
      if (userTags.length === 0) {
        if (nextVideos) nextVideos.push(video)
        continue
      }

      const tags = uniqueTags([...systemTags, ...userTags])
      if (!nextVideos) nextVideos = videos.slice(0, index)
      nextVideos.push({
        ...video,
        tags,
        systemTags,
        customTags: userTags,
        group: tags[0] || video.group
      })
    }

    return nextVideos || videos
  }, [videos, customTags])

  // 隐藏标签黑名单：含任意隐藏标签的视频从画廊移除（持久化、受密码保护）
  const hiddenTagSet = useMemo(() => new Set(hiddenTags || []), [hiddenTags])
  const hiddenFilteredVideos = useMemo(() => {
    if (hiddenTagSet.size === 0) return displayVideos
    return displayVideos.filter(video => {
      const customTagsList = getCustomTags(video)
      const systemTagsList = getSystemTags(video)
      for (const tag of customTagsList) {
        if (hiddenTagSet.has(`custom:${tag}`)) return false
      }
      for (const tag of systemTagsList) {
        if (hiddenTagSet.has(`system:${tag}`)) return false
      }
      return true
    })
  }, [displayVideos, hiddenTagSet])

  const sortedVideos = useMemo(() => {
    return [...hiddenFilteredVideos].sort((a, b) => {
      switch (sortBy) {
        case 'name': return compareByTitle(a, b)
        case 'size': return (Number(b.size) || 0) - (Number(a.size) || 0) || compareByTitle(a, b)
        case 'date': return (Number(b.modified) || 0) - (Number(a.modified) || 0) || compareByTitle(a, b)
        case 'type': return zhCollator.compare(a.extension || '', b.extension || '') || compareByTitle(a, b)
        default: return 0
      }
    })
  }, [hiddenFilteredVideos, sortBy])

  const categoryGroups = useMemo(() => {
    const customCounts = new Map()
    const systemCounts = new Map()
    for (const video of hiddenFilteredVideos) {
      for (const tag of getCustomTags(video)) {
        customCounts.set(tag, (customCounts.get(tag) || 0) + 1)
      }
      for (const tag of getSystemTags(video)) {
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
  }, [hiddenFilteredVideos])

  const favoriteCount = useMemo(() => {
    let count = 0
    for (const video of hiddenFilteredVideos) {
      if (favoriteKeys.has(video.favoriteKey || video.fullPath)) count += 1
    }
    return count
  }, [hiddenFilteredVideos, favoriteKeys])

  // 可见视频总数（排除隐藏标签后的），供侧栏"全部"计数使用，保持与画廊一致
  const visibleCount = hiddenFilteredVideos.length

  // 当前选中的分类被删空后自动移除（包含与排除都检查）
  useEffect(() => {
    setFilterState(prev => {
      const nextIncluded = prev.included.filter(key => key === 'favorites' || categoryExists(key, categoryGroups))
      const nextExcluded = prev.excluded.filter(key => categoryExists(key, categoryGroups))
      if (nextIncluded.length === prev.included.length && nextExcluded.length === prev.excluded.length) {
        return prev
      }
      return { included: nextIncluded, excluded: nextExcluded }
    })
  }, [categoryGroups])

  const deferredSearchQuery = useDeferredValue(searchQuery)
  const normalizedSearchQuery = useMemo(() => (
    deferredSearchQuery.trim().toLowerCase()
  ), [deferredSearchQuery])
  const trimmedSearchQuery = searchQuery.trim()

  const filteredVideos = useMemo(() => {
    const { included, excluded } = filterState
    const favoriteOnly = included.includes('favorites')
    const includeTags = included.filter(key => key !== 'favorites')
    const excludeTags = excluded
    if (!favoriteOnly && includeTags.length === 0 && excludeTags.length === 0 && !normalizedSearchQuery) {
      return sortedVideos
    }
    return sortedVideos.filter(v => (
      (!favoriteOnly || favoriteKeys.has(v.favoriteKey || v.fullPath)) &&
      includeTags.every(categoryKey => videoMatchesCategory(v, categoryKey)) &&
      excludeTags.every(categoryKey => !videoMatchesCategory(v, categoryKey)) &&
      (!normalizedSearchQuery ||
        v.name.toLowerCase().includes(normalizedSearchQuery) ||
        v.fileName?.toLowerCase().includes(normalizedSearchQuery) ||
        v.group.toLowerCase().includes(normalizedSearchQuery) ||
        (v.tags || []).some(tag => tag.toLowerCase().includes(normalizedSearchQuery)))
    ))
  }, [sortedVideos, normalizedSearchQuery, filterState, favoriteKeys])

  const hasSearch = trimmedSearchQuery.length > 0
  const { included, excluded } = filterState
  const hasCategoryFilter = included.length > 0 || excluded.length > 0
  const hasFilter = hasSearch || hasCategoryFilter
  // activeCategory 保留 'all' / 'favorites' 两个判断所需的值，其他筛选态统一记为 'filtered'
  const activeCategory = !hasCategoryFilter
    ? 'all'
    : included.length === 1 && included[0] === 'favorites' && excluded.length === 0
      ? 'favorites'
      : 'filtered'
  const activeCategoryLabel = useMemo(() => {
    if (!hasCategoryFilter) return '全部'
    if (included.length === 1 && included[0] === 'favorites' && excluded.length === 0) return '我喜欢'
    const parts = []
    const includeTags = included.filter(key => key !== 'favorites')
    if (includeTags.length > 0) {
      parts.push(includeTags.map(key => parseCategoryKey(key).name).join(' + '))
    }
    if (excluded.length > 0) {
      parts.push('排除 ' + excluded.map(key => parseCategoryKey(key).name).join(' / '))
    }
    if (included.includes('favorites')) {
      parts.unshift('我喜欢')
    }
    return parts.join('，')
  }, [hasCategoryFilter, included, excluded])

  const handleClearFilters = useCallback(() => {
    setSearchQuery('')
    setFilterState({ included: [], excluded: [] })
  }, [])

  return {
    searchQuery,
    setSearchQuery,
    sortBy,
    setSortBy,
    activeCategory,
    setActiveCategory,
    includedCategoryKeys: included,
    excludedCategoryKeys: excluded,
    hasCategoryFilter,
    displayVideos,
    sortedVideos,
    categoryGroups,
    favoriteCount,
    visibleCount,
    filteredVideos,
    trimmedSearchQuery,
    normalizedSearchQuery,
    hasSearch,
    hasFilter,
    activeCategoryLabel,
    handleClearFilters
  }
}
