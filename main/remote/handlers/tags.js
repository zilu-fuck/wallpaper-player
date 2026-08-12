const { getPlaybackState, loadSettings, saveSettingsAndFlush, upsertPlaybackState, verifyPrivacyPassword } = require('../../settings')
const { assertAllowedVideoPath } = require('../../scanner')
const { createFailureLimiter } = require('../../rate-limiter')
const { pathKey } = require('../../paths')
const { getFavoriteKeyForVideoId, getPathForVideoId } = require('../video-index')
const { readBody, sendError, sendJson } = require('../http-utils')
const { getLegacyNetworkFavoriteKey, getNetworkFavoriteKey, getRemoteNetworkItemById } = require('./network-resources')

// 远程隐私密码尝试频率限制（与桌面端 IPC 共用同一套规则：5 次失败后锁定 30 秒）
const remotePrivacyLimiter = createFailureLimiter({ limit: 5, lockMs: 30 * 1000 })

// 旧版本以原始路径字符串作为 customTags 键，而当前解析走 realpath 规范化，
// Windows 上大小写/连接点差异会导致键不匹配。按 pathKey 归一化匹配，
// 保证遗留 path-key 标签在迁移/展示时不丢失。
function collectLegacyTagEntries(customTags, target) {
  const wanted = new Set([target.path, target.rawPath].filter(Boolean).map(pathKey))
  return Object.entries(customTags).filter(([key]) => wanted.has(pathKey(key)))
}

function getClientIp(req) {
  return String(req?.socket?.remoteAddress || 'unknown')
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
      path: videoPath,
      rawPath: getPathForVideoId(videoId)
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
    await saveSettingsAndFlush({ playbackStates })
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
    await saveSettingsAndFlush({ favorites: nextFavorites })
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
    for (const [key] of collectLegacyTagEntries(customTags, target)) delete customTags[key]
    if (tags.length > 0) {
      customTags[target.favoriteKey] = tags
    } else {
      delete customTags[target.favoriteKey]
    }
    await saveSettingsAndFlush({ customTags })
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
      const legacyEntries = collectLegacyTagEntries(customTags, target)
      const currentTags = [
        ...(Array.isArray(customTags[target.favoriteKey]) ? customTags[target.favoriteKey] : []),
        ...(target.legacyFavoriteKey && Array.isArray(customTags[target.legacyFavoriteKey]) ? customTags[target.legacyFavoriteKey] : []),
        ...legacyEntries.flatMap(([, tags]) => (Array.isArray(tags) ? tags : []))
      ]
      customTags[target.favoriteKey] = [...new Set([...currentTags, ...tags])]
      if (target.legacyFavoriteKey) delete customTags[target.legacyFavoriteKey]
      for (const [key] of legacyEntries) delete customTags[key]
      updatedCount += 1
    }

    await saveSettingsAndFlush({ customTags })
    sendJson(req, res, 200, { success: true, updatedCount, tags })
  }

  // 还原所有隐藏标签：需验证隐私密码，通过后清空 hiddenTags
  async function handleRestoreHiddenTags(req, res) {
    const clientIp = getClientIp(req)
    const waitMs = remotePrivacyLimiter.getWaitMs(clientIp)
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
      const lockedMs = remotePrivacyLimiter.recordFailure(clientIp)
      if (lockedMs > 0) {
        sendError(req, res, 429, 'too_many_attempts', `密码错误次数过多，请 ${Math.ceil(lockedMs / 1000)} 秒后再试`)
        return
      }
      sendError(req, res, 403, 'invalid_password', '隐私密码不正确')
      return
    }
    remotePrivacyLimiter.reset(clientIp)

    await saveSettingsAndFlush({ hiddenTags: [] })
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
  normalizeRequestTags,
  collectLegacyTagEntries
}
