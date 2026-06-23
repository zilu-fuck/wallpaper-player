const { getPublicVideoDirectories, loadSettings } = require('../../settings')
const { scanWithCache } = require('../../scanner')
const { getDirectoryId, getDirectoryName, toRemoteVideo } = require('../video-index')
const { sendJson } = require('../http-utils')

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

    sendJson(req, res, 200, {
      items,
      count: items.length,
      directories: directorySummaries,
      categoryGroups: buildCategoryGroups(items),
      favoriteCount: items.filter(item => item.favorite).length,
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
