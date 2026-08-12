const { getPublicVideoDirectories, loadSettings, onSettingsChanged } = require('../../settings')
const { scanWithCache } = require('../../scanner')
const { pathKey } = require('../../paths')
const {
  createThumbnailToken,
  getDirectoryId,
  getDirectoryName,
  replaceRememberedVideos,
  toRemoteVideo
} = require('../video-index')
const { sendJson } = require('../http-utils')
const {
  NETWORK_DIRECTORY_ID,
  NETWORK_DIRECTORY_NAME,
  listRemoteNetworkItems,
  toRemoteNetworkVideo
} = require('./network-resources')

const LIBRARY_SNAPSHOT_TTL_MS = 1000
const DEFAULT_PAGE_LIMIT = 100
const MAX_PAGE_LIMIT = 500

let librarySnapshotCache = null
let pendingLibrarySnapshot = null

function clearLibrarySnapshotCache() {
  librarySnapshotCache = null
}

onSettingsChanged(clearLibrarySnapshotCache)

function filterHiddenTags(items, hiddenTags) {
  if (!Array.isArray(hiddenTags) || hiddenTags.length === 0) return items
  const hiddenSet = new Set(hiddenTags)
  return items.filter(item => {
    const customTags = Array.isArray(item.customTags) ? item.customTags : []
    const systemTags = Array.isArray(item.systemTags) ? item.systemTags : []
    for (const tag of customTags) {
      if (hiddenSet.has(`custom:${tag}`)) return false
    }
    for (const tag of systemTags) {
      if (hiddenSet.has(`system:${tag}`)) return false
    }
    return true
  })
}

function buildCategoryGroups(items) {
  const customCounts = new Map()
  const systemCounts = new Map()

  for (const item of items) {
    for (const tag of item.customTags || []) {
      customCounts.set(tag, (customCounts.get(tag) || 0) + 1)
    }
    for (const tag of item.systemTags || []) {
      systemCounts.set(tag, (systemCounts.get(tag) || 0) + 1)
    }
  }

  const toCategories = (counts, type) => [...counts.entries()]
    .map(([name, count]) => ({
      key: `${type}:${name}`,
      name,
      count,
      type
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN'))

  return {
    custom: toCategories(customCounts, 'custom'),
    system: toCategories(systemCounts, 'system')
  }
}

function applyDesktopMetadata(video, settings) {
  const favoriteKey = video.favoriteKey
  const systemTags = Array.isArray(video.tags) ? video.tags : []
  const directTags = Array.isArray(settings.customTags?.[favoriteKey])
    ? settings.customTags[favoriteKey]
    : []
  // 旧版本以原始路径字符串为键写入，与 fullPath 存在大小写/realpath 差异时
  // 按 pathKey 归一化匹配，保证 legacy path-key 标签在库中可见
  const legacyTags = directTags.length
    ? []
    : (Object.entries(settings.customTags || {})
        .filter(([key]) => pathKey(key) === pathKey(video.fullPath))
        .flatMap(([, tags]) => (Array.isArray(tags) ? tags : [])))
  const customTags = directTags.length ? directTags : legacyTags

  return {
    ...video,
    systemTags,
    customTags,
    tags: [...new Set([...systemTags, ...customTags])],
    group: [...systemTags, ...customTags][0] || video.group
  }
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}

function getPagination(url, total) {
  const hasLimit = url.searchParams.has('limit')
  const hasOffset = url.searchParams.has('offset')
  const offset = Math.min(parsePositiveInteger(url.searchParams.get('offset'), 0), total)
  if (!hasLimit && !hasOffset) {
    return {
      offset: 0,
      limit: total,
      paginated: false
    }
  }

  const rawLimit = parsePositiveInteger(url.searchParams.get('limit'), DEFAULT_PAGE_LIMIT)
  const limit = Math.max(1, Math.min(rawLimit || DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT))
  return {
    offset,
    limit,
    paginated: true
  }
}

function addRequestThumbnailTokens(items, accessToken) {
  if (!accessToken) return items
  return items.map(item => item.id?.startsWith('video_')
    ? {
      ...item,
      thumbnailToken: createThumbnailToken(item.id, accessToken)
    }
    : item)
}

async function buildLibrarySnapshot() {
  const directories = getPublicVideoDirectories()
  const items = []
  const localIndexVideos = []
  const directorySummaries = []
  const settings = loadSettings()
  const favoriteKeys = new Set(Array.isArray(settings.favorites) ? settings.favorites : [])
  let indexed = false
  let refreshing = false

  for (const directory of directories) {
    const directoryId = getDirectoryId(directory)
    const directoryName = getDirectoryName(directory)
    const result = await scanWithCache(directory)
    indexed = indexed || Boolean(result?.indexed)
    refreshing = refreshing || Boolean(result?.refreshing)
    if (Array.isArray(result?.videos)) {
      const localVideos = result.videos.map(video => applyDesktopMetadata(video, settings))
      const remoteVideos = localVideos.map(video => toRemoteVideo(
        video,
        '',
        { directoryId, directoryName, favoriteKeys }
      ))
      localIndexVideos.push(...localVideos)
      items.push(...remoteVideos)
      directorySummaries.push({
        id: directoryId,
        name: directoryName,
        count: remoteVideos.length
      })
    }
  }

  replaceRememberedVideos(localIndexVideos)

  const networkItems = listRemoteNetworkItems(settings).map(item => toRemoteNetworkVideo(item, {
    favoriteKeys,
    customTags: settings.customTags || {}
  }))
  items.push(...networkItems)
  if (networkItems.length > 0) {
    directorySummaries.push({
      id: NETWORK_DIRECTORY_ID,
      name: NETWORK_DIRECTORY_NAME,
      count: networkItems.length
    })
  }

  const hiddenTags = Array.isArray(settings.hiddenTags) ? settings.hiddenTags : []
  const filteredItems = filterHiddenTags(items, hiddenTags)

  const filteredCounts = new Map()
  for (const item of filteredItems) {
    const dirId = item.directoryId
    if (dirId) filteredCounts.set(dirId, (filteredCounts.get(dirId) || 0) + 1)
  }
  for (const summary of directorySummaries) {
    summary.count = filteredCounts.get(summary.id) || 0
  }

  return {
    items: filteredItems,
    count: filteredItems.length,
    directories: directorySummaries,
    categoryGroups: buildCategoryGroups(filteredItems),
    favoriteCount: filteredItems.filter(item => item.favorite).length,
    hiddenTagCount: hiddenTags.length,
    scannedAt: Date.now(),
    indexed,
    refreshing
  }
}

async function getLibrarySnapshot() {
  const now = Date.now()
  if (librarySnapshotCache && now - librarySnapshotCache.createdAt < LIBRARY_SNAPSHOT_TTL_MS) {
    return librarySnapshotCache.snapshot
  }
  if (pendingLibrarySnapshot) return pendingLibrarySnapshot

  pendingLibrarySnapshot = buildLibrarySnapshot()
    .then(snapshot => {
      librarySnapshotCache = {
        createdAt: Date.now(),
        snapshot
      }
      return snapshot
    })
    .finally(() => {
      pendingLibrarySnapshot = null
    })
  return pendingLibrarySnapshot
}

function createLibraryHandlers({ getRequestToken }) {
  async function handleLibrary(req, res, url) {
    const accessToken = getRequestToken(req, url, false)
    const snapshot = await getLibrarySnapshot()
    const pagination = getPagination(url, snapshot.items.length)
    const pageItems = snapshot.items.slice(pagination.offset, pagination.offset + pagination.limit)
    const items = addRequestThumbnailTokens(pageItems, accessToken)

    sendJson(req, res, 200, {
      ...snapshot,
      items,
      pagination: {
        offset: pagination.offset,
        limit: pagination.limit,
        total: snapshot.count,
        returned: items.length,
        hasMore: pagination.offset + items.length < snapshot.count
      }
    })
  }

  return {
    handleLibrary
  }
}

module.exports = {
  buildCategoryGroups,
  applyDesktopMetadata,
  clearLibrarySnapshotCache,
  createLibraryHandlers
}
