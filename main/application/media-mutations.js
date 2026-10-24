const fs = require('fs')
const {
  getPlaybackState,
  loadSettingsFields,
  upsertPlaybackState
} = require('../settings')
const { updateUserMedia } = require('../repositories/user-media')
const { pathKey, normalizedPathKey, resolvePathsForAccess } = require('../paths')
const { DEFAULT_ACCESS, favoritePath, mapMediaTargets, prepareMediaMutationPaths } = require('./media-mutation-paths')
const { assertAllowedVideoPath, directoryScanCache } = require('../scanner')
const { createMediaAccessPolicy } = require('../security/media-access')
const { getFavoriteKeyForVideoId, getVideoId } = require('../remote/video-index')
const { getTagOperation, getTagRevisionKey, getTagsRevision, normalizeTagReceipts } = require('../repositories/tag-state')
const { tagWriteSchema } = require('../../packages/contracts')
const {
  getLegacyNetworkFavoriteKey,
  getNetworkFavoriteKey,
  getRemoteNetworkItemById,
  listRemoteNetworkItems
} = require('../remote/handlers/network-resources')

function normalizeRequestTags(tags) {
  return Array.isArray(tags)
    ? [...new Set(tags.filter(tag => typeof tag === 'string' && tag.trim()).map(tag => tag.trim()))]
    : []
}

function collectLegacyTagEntries(customTags, target, prepared) {
  if (/^https?:\/\//i.test(target.path || '')) return []
  if (prepared) return prepared.collectLegacyEntries(customTags, target)
  const candidates = [target.path, target.rawPath].filter(Boolean)
  const fastKeys = new Set(candidates.map(pathKey))
  const realKeys = new Set(candidates.map(normalizedPathKey))
  return Object.entries(customTags).filter(([key]) =>
    fastKeys.has(pathKey(key)) || realKeys.has(normalizedPathKey(key)))
}

function mediaNotFound() {
  return Object.assign(new Error('视频不存在或无权访问'), { status: 404, code: 'video_not_found' })
}

function createFileTarget(videoPath, { access = DEFAULT_ACCESS, favoriteKey, rawPath } = {}) {
  return {
    kind: 'file', accessOptions: access,
    favoriteKey: favoriteKey || 'file:' + Buffer.from(videoPath).toString('base64url'),
    legacyFavoriteKey: '',
    path: videoPath,
    rawPath: rawPath || videoPath,
    assertAccess() {
      createMediaAccessPolicy(access).assertReadPath(videoPath)
      if (!fs.existsSync(videoPath) || !fs.statSync(videoPath).isFile()) throw mediaNotFound()
    }
  }
}

function createNetworkTarget(item) {
  return {
    favoriteKey: getNetworkFavoriteKey(item),
    legacyFavoriteKey: getLegacyNetworkFavoriteKey(item),
    path: item.url,
    assertAccess() {
      if (!getRemoteNetworkItemById(item.id)) throw mediaNotFound()
    }
  }
}

async function resolveDesktopTarget(input, access = DEFAULT_ACCESS) {
  if (typeof input === 'string') input = { fullPath: input }
  if (!input || typeof input !== 'object') throw mediaNotFound()
  const value = input.fullPath || input.url || ''
  if (input.sourceType === 'network' || /^https?:\/\//i.test(value)) {
    const item = listRemoteNetworkItems().find(candidate =>
      candidate.id === input.id || candidate.url === value)
    if (item) return createNetworkTarget(item)
    const resource = (loadSettingsFields(['networkResources']).networkResources || []).find(candidate =>
      candidate.id === input.id || candidate.url === value)
    if (!resource) throw mediaNotFound()
    return {
      favoriteKey: resource.url,
      legacyFavoriteKey: 'network:' + resource.url,
      path: resource.url,
      assertAccess() {
        if (!(loadSettingsFields(['networkResources']).networkResources || []).some(candidate =>
          candidate.id === resource.id && candidate.url === resource.url)) throw mediaNotFound()
      }
    }
  }
  const videoPath = await assertAllowedVideoPath(value, access)
  let key = getFavoriteKeyForVideoId(getVideoId(videoPath))
  const hint = input.favoriteKey
  if (typeof hint === 'string' && hint && hint !== key) {
    const hintPaths = !hint.startsWith('file:') && !hint.startsWith('workshop:')
      ? await resolvePathsForAccess([hint, videoPath]) : null
    if (hintPaths && pathKey(hintPaths.get(hint)) === pathKey(hintPaths.get(videoPath))) {
      // 保留显式打开外部文件时已有的按路径收藏语义。
      key = hint
    } else {
      const known = [...directoryScanCache.values()].some(entry => entry.videos?.some(video =>
        pathKey(video.fullPath) === pathKey(videoPath) && video.favoriteKey === hint))
      if (known) key = hint
    }
  }
  return createFileTarget(videoPath, {
    access,
    favoriteKey: key,
    rawPath: input.fullPath
  })
}

function createMediaMutationService({ resolveTarget = resolveDesktopTarget, actor = 'desktop', returnSettings = true, returnVersion = false } = {}) {
  async function commit(operation, targets, options, update) {
    return updateUserMedia(operation, (settings, prepared) => {
      prepared.assertCurrent(settings)
      return update(settings, prepared)
    }, { prepare: settings => prepareMediaMutationPaths(settings, targets, options),
      readOnly: options.readOnly,
      returnSettings,
      returnVersion,
      retryPreparation: error => ['media_preparation_changed', 'media_policy_changed'].includes(error.code) })
  }
  async function setFavorite(input, desired) {
    if (desired !== undefined && typeof desired !== 'boolean') {
      throw Object.assign(new Error('收藏状态必须为布尔值'), { status: 400, code: 'invalid_favorite' })
    }
    const target = await resolveTarget(input)
    return commit('favorite', [target], { favorites: true }, (settings, prepared) => {
      prepared.assertTarget(target)
      const keys = new Set([target.favoriteKey, target.legacyFavoriteKey, target.path, target.rawPath].filter(Boolean))
      const previous = settings.favorites || []
      for (const key of previous) {
        if (target.path && !/^https?:\/\//i.test(target.path)) {
          const candidate = favoritePath(key)
          if (candidate != null && prepared.canonicalKey(candidate) === prepared.canonicalKey(target.path)) keys.add(key)
        }
      }
      const favorite = desired ?? !previous.some(key => keys.has(key))
      const favorites = previous.filter(key => !keys.has(key))
      if (favorite) favorites.push(target.favoriteKey)
      return { patch: { favorites }, value: { favorite, favoriteKey: target.favoriteKey } }
    })
  }

  async function getVideoTags(input) {
    const target = await resolveTarget(input)
    return commit('readTags', [target], { tags: true, readOnly: true }, (settings, prepared) => {
      prepared.assertTarget(target)
      const key = /^https?:\/\//i.test(target.path) ? undefined : prepared.canonicalKey(target.path)
      return { patch: {}, value: { customTags: getCurrentTags(settings.customTags || {}, target, prepared),
        customTagsRevision: getTagsRevision(settings, target, key), tagRevisionKey: getTagRevisionKey(target, key) } }
    })
  }

  async function setVideoTags(input, inputTags, inputCondition) {
    const target = await resolveTarget(input)
    const tags = normalizeRequestTags(inputTags)
    const condition = inputCondition === undefined ? undefined : tagWriteSchema.parse(inputCondition)
    return commit('writeTags', [target], { tags: true }, (settings, prepared) => {
      prepared.assertTarget(target)
      const key = /^https?:\/\//i.test(target.path) ? undefined : prepared.canonicalKey(target.path)
      const revisionKey = getTagRevisionKey(target, key)
      const revision = getTagsRevision(settings, target, key)
      const currentTags = getCurrentTags(settings.customTags || {}, target, prepared)
      const operation = condition && getTagOperation(actor, condition.operationId, target, tags, key)
      const receipts = settings.tagMutationReceipts || []
      const receipt = operation && receipts.find(item => item.operationHash === operation.operationHash)
      if (receipt) {
        if (receipt.targetHash !== operation.targetHash || receipt.payloadHash !== operation.payloadHash) {
          throw Object.assign(new Error('操作编号已使用，请重新打开编辑后保存'), {
            status: 409, code: 'operation_id_reused', currentRevision: revision
          })
        }
        return { patch: {}, value: { customTags: currentTags, customTagsRevision: revision,
          operationRevision: receipt.revision, replayed: true, favoriteKey: target.favoriteKey } }
      }
      if (condition && condition.expectedRevision !== revision) {
        throw Object.assign(new Error('标签已在其他设备修改，请重新载入最新标签后编辑'), {
          status: 409, code: 'tags_conflict', currentRevision: revision
        })
      }
      const customTags = { ...(settings.customTags || {}) }
      removeLegacyKeys(customTags, target, prepared)
      if (tags.length) { customTags[target.favoriteKey] = tags; prepared.addKey(target.favoriteKey) }
      else { delete customTags[target.favoriteKey]; prepared.removeKey(target.favoriteKey) }
      const nextRevision = revision + (JSON.stringify(currentTags) === JSON.stringify(tags) ? 0 : 1)
      const patch = { customTags, customTagRevisions: { ...(settings.customTagRevisions || {}), [revisionKey]: nextRevision } }
      if (operation) patch.tagMutationReceipts = normalizeTagReceipts([{ ...operation, revision: nextRevision }, ...receipts])
      return { patch, value: { customTags: tags, customTagsRevision: nextRevision, operationRevision: nextRevision,
        replayed: false, favoriteKey: target.favoriteKey } }
    })
  }

  async function appendTagsBulk(inputs, inputTags) {
    const tags = normalizeRequestTags(inputTags)
    const resolved = await mapMediaTargets(inputs, async (input, index) => {
      try {
        return { input, index, target: await resolveTarget(input) }
      } catch (error) {
        return { input, index, error }
      }
    })
    return commit('appendTags', resolved.filter(entry => entry.target).map(entry => entry.target), { tags: true }, (settings, prepared) => {
      const customTags = { ...(settings.customTags || {}) }
      const customTagRevisions = { ...(settings.customTagRevisions || {}) }
      const updated = []
      const failed = []
      for (const entry of resolved) {
        try {
          if (entry.error) throw entry.error
          const target = entry.target
          prepared.assertTarget(target)
          const currentTags = getCurrentTags(customTags, target, prepared)
          removeLegacyKeys(customTags, target, prepared)
          customTags[target.favoriteKey] = normalizeRequestTags([...currentTags, ...tags])
          prepared.addKey(target.favoriteKey)
          const revisionKey = getTagRevisionKey(target, /^https?:\/\//i.test(target.path) ? undefined : prepared.canonicalKey(target.path))
          const revision = (customTagRevisions[revisionKey] || 0) +
            (JSON.stringify(currentTags) === JSON.stringify(customTags[target.favoriteKey]) ? 0 : 1)
          customTagRevisions[revisionKey] = revision
          updated.push({ index: entry.index, id: typeof entry.input === 'string' ? entry.input : entry.input.id,
            favoriteKey: target.favoriteKey, customTags: customTags[target.favoriteKey], customTagsRevision: revision })
        } catch (error) {
          failed.push({ index: entry.index, id: typeof entry.input === 'string' ? entry.input : entry.input?.id,
            code: error.code || 'video_not_found', message: '视频不存在或无权访问' })
        }
      }
      return { patch: { customTags, customTagRevisions }, value: { updatedCount: updated.length, updated, failed, tags } }
    })
  }

  async function savePlayback(input, patch, condition) {
    const target = await resolveTarget(input)
    return commit('playback', [target], {}, (settings, prepared) => {
      prepared.assertTarget(target)
      return playbackMutation(settings, target.path, patch, condition)
    })
  }

  return { setFavorite, getVideoTags, setVideoTags, appendTagsBulk, savePlayback }
}

function getCurrentTags(customTags, target, prepared) {
  return normalizeRequestTags([...(customTags[target.favoriteKey] || []), ...(customTags[target.legacyFavoriteKey] || []),
    ...collectLegacyTagEntries(customTags, target, prepared).flatMap(([, tags]) => tags)])
}

function removeLegacyKeys(customTags, target, prepared) {
  if (target.legacyFavoriteKey) { delete customTags[target.legacyFavoriteKey]; prepared?.removeKey(target.legacyFavoriteKey) }
  for (const [key] of collectLegacyTagEntries(customTags, target, prepared)) { delete customTags[key]; prepared?.removeKey(key) }
}

function savePlaybackRecord(videoPath, patch, assertAccess = () => {}, condition) {
  return updateUserMedia('playback', settings => {
    assertAccess()
    return playbackMutation(settings, videoPath, patch, condition)
  })
}

function playbackMutation(settings, videoPath, patch, condition) {
  const current = getPlaybackState(settings.playbackStates, videoPath) || { revision: 0, writers: {} }
  const revision = current.revision || 0
  const writers = { ...current.writers }
  if (condition) {
    const { actor, baseRevision, session, sequence } = condition
    const cursor = writers[actor]
    if (cursor && session === cursor.session && sequence === cursor.sequence && patch.position === cursor.position) {
      return { patch: {}, value: { playback: current } }
    }
    if ((cursor && (session < cursor.session || (session === cursor.session && sequence <= cursor.sequence))) ||
      baseRevision !== revision) {
      throw Object.assign(new Error('播放进度已由其他会话更新，请重新读取进度'), { status: 409, code: 'playback_conflict', currentRevision: revision })
    }
    writers[actor] = { session, sequence, position: patch.position, updatedAt: Date.now() }
  }
  const playbackStates = upsertPlaybackState(settings.playbackStates, videoPath,
    { ...patch, updatedAt: Date.now(), revision: revision + 1, writers })
  return { patch: { playbackStates }, value: { playback: getPlaybackState(playbackStates, videoPath) } }
}

module.exports = {
  collectLegacyTagEntries,
  createFileTarget,
  createMediaMutationService,
  createNetworkTarget,
  normalizeRequestTags,
  resolveDesktopTarget,
  savePlaybackRecord
}
