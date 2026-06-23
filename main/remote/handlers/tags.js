const { getPlaybackState, loadSettings, saveSettings, upsertPlaybackState } = require('../../settings')
const { assertAllowedVideoPath } = require('../../scanner')
const { getFavoriteKeyForVideoId } = require('../video-index')
const { readBody, sendError, sendJson } = require('../http-utils')

function normalizeRequestTags(tags) {
  return Array.isArray(tags)
    ? [...new Set(tags.filter(tag => typeof tag === 'string' && tag.trim()).map(tag => tag.trim()))]
    : []
}

function createTagsHandlers({ resolveVideoPath }) {
  async function handleGetPlayback(req, res, videoId) {
    const videoPath = await resolveVideoPath(videoId)
    const settings = loadSettings()
    sendJson(req, res, 200, getPlaybackState(settings.playbackStates, videoPath) || null)
  }

  async function handlePutPlayback(req, res, videoId) {
    const videoPath = await resolveVideoPath(videoId)
    const body = await readBody(req)
    const settings = loadSettings()
    const playbackStates = upsertPlaybackState(settings.playbackStates, videoPath, {
      position: Number(body.position) || 0,
      updatedAt: Date.now()
    })
    saveSettings({ playbackStates })
    sendJson(req, res, 200, { success: true })
  }

  async function handleToggleFavorite(req, res, videoId) {
    const videoPath = await resolveVideoPath(videoId)
    const favoriteKey = getFavoriteKeyForVideoId(videoId)
    if (!favoriteKey) {
      sendError(req, res, 404, 'video_not_found', '视频不存在或索引尚未加载')
      return
    }

    await assertAllowedVideoPath(videoPath)
    const settings = loadSettings()
    const favorites = Array.isArray(settings.favorites) ? settings.favorites : []
    const favorite = !favorites.includes(favoriteKey) && !favorites.includes(videoPath)
    const nextFavorites = favorite
      ? [...favorites, favoriteKey]
      : favorites.filter(item => item !== favoriteKey && item !== videoPath)
    saveSettings({ favorites: nextFavorites })
    sendJson(req, res, 200, { success: true, favorite })
  }

  async function handlePutTags(req, res, videoId) {
    const videoPath = await resolveVideoPath(videoId)
    const favoriteKey = getFavoriteKeyForVideoId(videoId)
    if (!favoriteKey) {
      sendError(req, res, 404, 'video_not_found', '视频不存在或索引尚未加载')
      return
    }

    await assertAllowedVideoPath(videoPath)
    const body = await readBody(req)
    const tags = normalizeRequestTags(body.tags)
    const settings = loadSettings()
    const customTags = { ...(settings.customTags || {}) }
    delete customTags[videoPath]
    if (tags.length > 0) {
      customTags[favoriteKey] = tags
    } else {
      delete customTags[favoriteKey]
    }
    saveSettings({ customTags })
    sendJson(req, res, 200, { success: true, customTags: tags })
  }

  async function handlePutBulkTags(req, res) {
    const body = await readBody(req)
    const videoIds = Array.isArray(body.videoIds)
      ? [...new Set(body.videoIds.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))]
      : []
    const tags = normalizeRequestTags(body.tags)

    if (!videoIds.length) {
      sendError(req, res, 400, 'missing_video_ids', '请选择要添加标签的视频')
      return
    }
    if (!tags.length) {
      sendError(req, res, 400, 'missing_tags', '请输入要添加的标签')
      return
    }

    const settings = loadSettings()
    const customTags = { ...(settings.customTags || {}) }
    let updatedCount = 0

    for (const videoId of videoIds) {
      const videoPath = await resolveVideoPath(videoId)
      const favoriteKey = getFavoriteKeyForVideoId(videoId)
      if (!favoriteKey) continue
      await assertAllowedVideoPath(videoPath)
      const currentTags = [
        ...(Array.isArray(customTags[favoriteKey]) ? customTags[favoriteKey] : []),
        ...(Array.isArray(customTags[videoPath]) ? customTags[videoPath] : [])
      ]
      customTags[favoriteKey] = [...new Set([...currentTags, ...tags])]
      delete customTags[videoPath]
      updatedCount += 1
    }

    saveSettings({ customTags })
    sendJson(req, res, 200, { success: true, updatedCount, tags })
  }

  return {
    handleGetPlayback,
    handlePutPlayback,
    handleToggleFavorite,
    handlePutTags,
    handlePutBulkTags
  }
}

module.exports = {
  createTagsHandlers,
  normalizeRequestTags
}
