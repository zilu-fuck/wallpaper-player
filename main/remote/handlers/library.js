const { getPublicVideoDirectories, loadSettings } = require('../../settings')
const { scanWithCache } = require('../../scanner')
const { getDirectoryId, getDirectoryName, toRemoteVideo } = require('../video-index')
const { sendJson } = require('../http-utils')
const {
  NETWORK_DIRECTORY_ID,
  NETWORK_DIRECTORY_NAME,
  listRemoteNetworkItems,
  toRemoteNetworkVideo
} = require('./network-resources')

// 过滤掉含隐藏标签的视频（隐藏标签持久化在 settings.hiddenTags，受密码保护）
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
  const customTags = Array.isArray(settings.customTags?.[favoriteKey])
    ? settings.customTags[favoriteKey]
    : Array.isArray(settings.customTags?.[video.fullPath])
      ? settings.customTags[video.fullPath]
      : []

  return {
    ...video,
    systemTags,
    customTags,
    tags: [...new Set([...systemTags, ...customTags])],
    group: [...systemTags, ...customTags][0] || video.group
  }
}

function createLibraryHandlers({ getRequestToken }) {
  async function handleLibrary(req, res, url) {
    const directories = getPublicVideoDirectories()
    const items = []
    const directorySummaries = []
    const settings = loadSettings()
    const favoriteKeys = new Set(Array.isArray(settings.favorites) ? settings.favorites : [])
    const accessToken = getRequestToken(req, url, false)
    let indexed = false
    let refreshing = false

    for (const directory of directories) {
      const directoryId = getDirectoryId(directory)
      const directoryName = getDirectoryName(directory)
      const result = await scanWithCache(directory)
      indexed = indexed || Boolean(result?.indexed)
      refreshing = refreshing || Boolean(result?.refreshing)
      if (Array.isArray(result?.videos)) {
        const remoteVideos = result.videos.map(video => toRemoteVideo(
          applyDesktopMetadata(video, settings),
          '',
          { directoryId, directoryName, favoriteKeys, accessToken }
        ))
        items.push(...remoteVideos)
        directorySummaries.push({
          id: directoryId,
          name: directoryName,
          count: remoteVideos.length
        })
      }
    }

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

    // 应用隐藏标签过滤（与桌面端 useVideoFilter 一致：含隐藏标签的视频从画廊移除）
    const hiddenTags = Array.isArray(settings.hiddenTags) ? settings.hiddenTags : []
    const filteredItems = filterHiddenTags(items, hiddenTags)

    // 基于过滤后的视频重新计算各目录计数，保持与画廊一致
    const filteredCounts = new Map()
    for (const item of filteredItems) {
      const dirId = item.directoryId
      if (dirId) filteredCounts.set(dirId, (filteredCounts.get(dirId) || 0) + 1)
    }
    for (const summary of directorySummaries) {
      summary.count = filteredCounts.get(summary.id) || 0
    }

    sendJson(req, res, 200, {
      items: filteredItems,
      count: filteredItems.length,
      directories: directorySummaries,
      categoryGroups: buildCategoryGroups(filteredItems),
      favoriteCount: filteredItems.filter(item => item.favorite).length,
      hiddenTagCount: hiddenTags.length,
      scannedAt: Date.now(),
      indexed,
      refreshing
    })
  }

  return {
    handleLibrary
  }
}

module.exports = {
  buildCategoryGroups,
  applyDesktopMetadata,
  createLibraryHandlers
}
