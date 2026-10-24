const { readPlaybackState, loadSettings, updateSettingsAndFlush, verifyPrivacyPassword } = require('../../settings')
const { createPrivacyAttemptQueue } = require('../../security/privacy-password')
const { withRequestSignal } = require('../request-lifecycle')
const { createFailureLimiter } = require('../../rate-limiter')
const { readBody, sendError, sendJson } = require('../http-utils')
const { getRemoteNetworkItemById } = require('./network-resources')
const { collectLegacyTagEntries, normalizeRequestTags } = require('../../application/media-mutations')
const { createRemoteMediaMutationService } = require('../media-mutations')

// 远程隐私密码尝试频率限制（与桌面端 IPC 共用同一套规则：5 次失败后锁定 30 秒）
const remotePrivacyLimiter = createFailureLimiter({ limit: 5, lockMs: 30 * 1000 })
const passwordAttempts = createPrivacyAttemptQueue()

function getClientIp(req) {
  return String(req?.socket?.remoteAddress || 'unknown')
}

function playbackActor(req) {
  const auth = req.remoteAuthorization
  return auth?.type === 'paired' ? `paired:${auth.deviceId}` : 'legacy'
}

function publicPlayback(req, state) {
  if (!state) return null
  const cursor = state.writers?.[playbackActor(req)]
  return { position: state.position, updatedAt: state.updatedAt, revision: state.revision || 0,
    ...(cursor ? { writer: { session: cursor.session, sequence: cursor.sequence } } : {}) }
}

function createTagsHandlers({ resolveVideoPath }) {
  const mutations = createRemoteMediaMutationService({ resolveVideoPath })

  async function handleGetPlayback(req, res, videoId) {
    const networkItem = getRemoteNetworkItemById(videoId)
    const videoPath = networkItem ? networkItem.url : await resolveVideoPath(videoId)
    return sendJson(req, res, 200, publicPlayback(req, readPlaybackState(videoPath)))
  }

  async function handlePutPlayback(req, res, videoId) {
    if (!getRemoteNetworkItemById(videoId)) await resolveVideoPath(videoId)
    const body = await readBody(req)
    if (!Number.isFinite(body?.position) || body.position < 0) {
      sendError(req, res, 400, 'invalid_playback_position', '播放位置必须是非负数')
      return
    }
    const versioned = ['baseRevision', 'session', 'sequence'].some(key => Object.hasOwn(body, key))
    if (versioned && (!Number.isSafeInteger(body.baseRevision) || body.baseRevision < 0 ||
      !Number.isSafeInteger(body.session) || body.session <= 0 || !Number.isSafeInteger(body.sequence) || body.sequence <= 0)) {
      sendError(req, res, 400, 'invalid_playback_revision', '播放进度版本无效')
      return
    }
    const result = await mutations.savePlayback(videoId, {
      position: body.position
    }, versioned ? { actor: playbackActor(req), baseRevision: body.baseRevision, session: body.session, sequence: body.sequence } : undefined)
    return sendJson(req, res, 200, { success: true, playback: publicPlayback(req, result.value.playback) })
  }

  async function handleToggleFavorite(req, res, videoId) {
    const body = await readBody(req)
    const desired = body && Object.hasOwn(body, 'favorite') ? body.favorite : undefined
    const result = await mutations.setFavorite(videoId, desired)
    return sendJson(req, res, 200, { success: true, favorite: result.value.favorite })
  }

  async function handlePutTags(req, res, videoId) {
    const body = await readBody(req)
    const condition = body.expectedRevision === undefined ? undefined : { expectedRevision: body.expectedRevision, operationId: body.operationId }
    const service = createRemoteMediaMutationService({ resolveVideoPath, actor: playbackActor(req) })
    const result = await service.setVideoTags(videoId, body?.tags, condition)
    const { customTags, customTagsRevision, operationRevision, replayed } = result.value
    return sendJson(req, res, 200, { success: true, customTags, customTagsRevision, operationRevision, replayed })
  }

  async function handleGetTags(req, res, videoId) {
    const result = await mutations.getVideoTags(videoId)
    return sendJson(req, res, 200, { customTags: result.value.customTags, customTagsRevision: result.value.customTagsRevision })
  }

  async function handlePutBulkTags(req, res) {
    const body = await readBody(req)
    const videoIds = Array.isArray(body?.videoIds)
      ? [...new Set(body.videoIds.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))]
      : []
    const tags = normalizeRequestTags(body?.tags)
    if (!videoIds.length) {
      sendError(req, res, 400, 'missing_video_ids', '请选择要添加标签的视频')
      return
    }
    if (!tags.length) {
      sendError(req, res, 400, 'missing_tags', '请输入要添加的标签')
      return
    }
    const result = await mutations.appendTagsBulk(videoIds, tags)
    return sendJson(req, res, 200, {
      success: true, updatedCount: result.value.updatedCount, tags,
      updated: result.value.updated.map(({ id, index, customTags, customTagsRevision }) => ({ id, index, customTags, customTagsRevision })),
      failed: result.value.failed
    })
  }

  // 还原所有隐藏标签：需验证隐私密码，通过后清空 hiddenTags
  async function handleRestoreHiddenTags(req, res) {
    return withRequestSignal(req, res, async signal => {
      const body = await readBody(req)
      const clientIp = getClientIp(req)
      return passwordAttempts(clientIp, async () => {
        const check = () => signal.throwIfAborted()
        check()
        const waitMs = remotePrivacyLimiter.getWaitMs(clientIp)
        if (waitMs > 0) {
          sendError(req, res, 429, 'too_many_attempts', `密码错误次数过多，请 ${Math.ceil(waitMs / 1000)} 秒后再试`)
          return
        }

        const password = typeof body?.password === 'string' ? body.password : ''
        const settings = loadSettings()

        if (!settings.privacy?.passwordSet) {
          sendError(req, res, 400, 'privacy_not_set', '尚未设置隐私密码，请在电脑端设置后再使用此功能')
          return
        }
        const correct = await verifyPrivacyPassword(password, settings.privacy, check)
        check()
        if (!correct) {
          const lockedMs = remotePrivacyLimiter.recordFailure(clientIp)
          if (lockedMs > 0) {
            sendError(req, res, 429, 'too_many_attempts', `密码错误次数过多，请 ${Math.ceil(lockedMs / 1000)} 秒后再试`)
            return
          }
          sendError(req, res, 403, 'invalid_password', '隐私密码不正确')
          return
        }
        remotePrivacyLimiter.reset(clientIp)

        await updateSettingsAndFlush(current => {
          check()
          if (current.privacy?.salt !== settings.privacy.salt || current.privacy?.passwordHash !== settings.privacy.passwordHash) throw Object.assign(new Error('隐私密码已变化，请重新验证'), { status: 409, code: 'privacy_changed' })
          return { patch: { hiddenTags: [] } }
        })
        return sendJson(req, res, 200, { success: true })
      })
    })
  }

  return {
    handleGetPlayback,
    handlePutPlayback,
    handleToggleFavorite,
    handlePutTags,
    handleGetTags,
    handlePutBulkTags,
    handleRestoreHiddenTags
  }
}

module.exports = {
  createTagsHandlers,
  normalizeRequestTags,
  collectLegacyTagEntries
}
