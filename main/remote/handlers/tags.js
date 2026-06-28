const { getPlaybackState, loadSettings, saveSettings, upsertPlaybackState, verifyPrivacyPassword } = require('../../settings')
const { assertAllowedVideoPath } = require('../../scanner')
const { getFavoriteKeyForVideoId } = require('../video-index')
const { readBody, sendError, sendJson } = require('../http-utils')
const { getLegacyNetworkFavoriteKey, getNetworkFavoriteKey, getRemoteNetworkItemById } = require('./network-resources')

// 远程隐私密码尝试频率限制（与桌面端 IPC 一致：5 次失败后锁定 30 秒）
const REMOTE_PRIVACY_FAILURE_LIMIT = 5
const REMOTE_PRIVACY_LOCK_MS = 30 * 1000
const remotePrivacyFailures = new Map()

function getClientIp(req) {
  return String(req?.socket?.remoteAddress || 'unknown')
}

function getRemotePrivacyWaitMs(ip) {
  const current = remotePrivacyFailures.get(ip)
  if (!current || !current.lockUntil) return 0
  const waitMs = current.lockUntil - Date.now()
  if (waitMs <= 0) {
    remotePrivacyFailures.delete(ip)
    return 0
  }
  return waitMs
}

function recordRemotePrivacyFailure(ip) {
  const current = remotePrivacyFailures.get(ip) || { count: 0, lockUntil: 0 }
  const nextCount = current.count + 1
  const next = {
    count: nextCount,
    lockUntil: nextCount >= REMOTE_PRIVACY_FAILURE_LIMIT ? Date.now() + REMOTE_PRIVACY_LOCK_MS : 0
  }
  remotePrivacyFailures.set(ip, next)
  return next.lockUntil ? REMOTE_PRIVACY_LOCK_MS : 0
}

function normalizeRequestTags(tags) {
  return Array.isArray(tags)
    ? [...new Set(tags.filter(tag => typeof tag === 'string' && tag.trim()).map(tag => tag.trim()))]
    : []
}

function createTagsHandlers({ resolveVideoPath }) {
  async function resolveFavoriteTarget(videoId) {
    const networkItem = getRemoteNetworkItemById(videoId)
    if (networkItem) {
      return {
        favoriteKey: getNetworkFavoriteKey(networkItem),
        legacyFavoriteKey: getLegacyNetworkFavoriteKey(networkItem),
        path: networkItem.url
      }
    }

    const videoPath = await resolveVideoPath(videoId)
    const favoriteKey = getFavoriteKeyForVideoId(videoId)
    if (!favoriteKey) return null
    await assertAllowedVideoPath(videoPath)
    return {
      favoriteKey,
      legacyFavoriteKey: '',
      path: videoPath
    }
  }

  async function handleGetPlayback(req, res, videoId) {
    const networkItem = getRemoteNetworkItemById(videoId)
    const videoPath = networkItem ? networkItem.url : await resolveVideoPath(videoId)
    const settings = loadSettings()
    sendJson(req, res, 200, getPlaybackState(settings.playbackStates, videoPath) || null)
  }

  async function handlePutPlayback(req, res, videoId) {
    const networkItem = getRemoteNetworkItemById(videoId)
    const videoPath = networkItem ? networkItem.url : await resolveVideoPath(videoId)
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
    const target = await resolveFavoriteTarget(videoId)
    if (!target) {
      sendError(req, res, 404, 'video_not_found', '视频不存在或索引尚未加载')
      return
    }

    const settings = loadSettings()
    const favorites = Array.isArray(settings.favorites) ? settings.favorites : []
    const favorite = !favorites.includes(target.favoriteKey) &&
      !favorites.includes(target.legacyFavoriteKey) &&
      !favorites.includes(target.path)
    const nextFavorites = favorite
      ? [...favorites, target.favoriteKey]
      : favorites.filter(item => (
        item !== target.favoriteKey &&
        item !== target.legacyFavoriteKey &&
        item !== target.path
      ))
    saveSettings({ favorites: nextFavorites })
    sendJson(req, res, 200, { success: true, favorite })
  }

  async function handlePutTags(req, res, videoId) {
    const target = await resolveFavoriteTarget(videoId)
    if (!target) {
      sendError(req, res, 404, 'video_not_found', '视频不存在或索引尚未加载')
      return
    }

    const body = await readBody(req)
    const tags = normalizeRequestTags(body.tags)
    const settings = loadSettings()
    const customTags = { ...(settings.customTags || {}) }
    if (target.legacyFavoriteKey) delete customTags[target.legacyFavoriteKey]
    delete customTags[target.path]
    if (tags.length > 0) {
      customTags[target.favoriteKey] = tags
    } else {
      delete customTags[target.favoriteKey]
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
      const target = await resolveFavoriteTarget(videoId)
      if (!target) continue
      const currentTags = [
        ...(Array.isArray(customTags[target.favoriteKey]) ? customTags[target.favoriteKey] : []),
        ...(target.legacyFavoriteKey && Array.isArray(customTags[target.legacyFavoriteKey]) ? customTags[target.legacyFavoriteKey] : []),
        ...(Array.isArray(customTags[target.path]) ? customTags[target.path] : [])
      ]
      customTags[target.favoriteKey] = [...new Set([...currentTags, ...tags])]
      if (target.legacyFavoriteKey) delete customTags[target.legacyFavoriteKey]
      delete customTags[target.path]
      updatedCount += 1
    }

    saveSettings({ customTags })
    sendJson(req, res, 200, { success: true, updatedCount, tags })
  }

  // 还原所有隐藏标签：需验证隐私密码，通过后清空 hiddenTags
  async function handleRestoreHiddenTags(req, res) {
    const clientIp = getClientIp(req)
    const waitMs = getRemotePrivacyWaitMs(clientIp)
    if (waitMs > 0) {
      sendError(req, res, 429, 'too_many_attempts', `密码错误次数过多，请 ${Math.ceil(waitMs / 1000)} 秒后再试`)
      return
    }

    const body = await readBody(req)
    const password = typeof body?.password === 'string' ? body.password : ''
    const settings = loadSettings()

    if (!settings.privacy?.passwordSet) {
      sendError(req, res, 400, 'privacy_not_set', '尚未设置隐私密码，请在电脑端设置后再使用此功能')
      return
    }
    if (!verifyPrivacyPassword(password, settings.privacy)) {
      const lockedMs = recordRemotePrivacyFailure(clientIp)
      if (lockedMs > 0) {
        sendError(req, res, 429, 'too_many_attempts', `密码错误次数过多，请 ${Math.ceil(lockedMs / 1000)} 秒后再试`)
        return
      }
      sendError(req, res, 403, 'invalid_password', '隐私密码不正确')
      return
    }
    remotePrivacyFailures.delete(clientIp)

    await saveSettings({ hiddenTags: [] })
    sendJson(req, res, 200, { success: true })
  }

  return {
    handleGetPlayback,
    handlePutPlayback,
    handleToggleFavorite,
    handlePutTags,
    handlePutBulkTags,
    handleRestoreHiddenTags
  }
}

module.exports = {
  createTagsHandlers,
  normalizeRequestTags
}
