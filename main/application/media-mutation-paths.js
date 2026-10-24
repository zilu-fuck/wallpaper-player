const fsp = require('fs/promises')
const { pathKey, resolvePathsForAccess } = require('../paths')
const { getMediaAccessSettings, sessionAllowedDirectories, sessionPrivateDirectories } = require('../settings')
const { createMediaAccessPolicy, createMediaAccessPolicyAsync } = require('../security/media-access')

const DEFAULT_ACCESS = Object.freeze({})
const changed = () => Object.assign(new Error('媒体路径或权限正在改变，请重试'), { code: 'media_preparation_changed', status: 409 })
const rootsSignature = () => JSON.stringify([getMediaAccessSettings(), [...sessionAllowedDirectories], [...sessionPrivateDirectories]])
const fileTarget = target => target?.kind === 'file'
const networkKey = key => /^(?:https?:\/\/|network:https?:\/\/)/i.test(key)
const legacyTagPath = key => !key.startsWith('file:') && !key.startsWith('workshop:') && !networkKey(key)
const favoritePath = key => key.startsWith('workshop:') || networkKey(key) ? null : key.startsWith('file:')
  ? Buffer.from(key.slice(5), 'base64url').toString('utf8') : key

async function mapMediaTargets(inputs, resolve) {
  const results = new Array(inputs.length)
  let next = 0, failed = false
  const settled = await Promise.allSettled(Array.from({ length: Math.min(8, inputs.length) }, async () => {
    try { while (!failed && next < inputs.length) { const index = next++; results[index] = await resolve(inputs[index], index) } }
    catch (error) { failed = true; throw error }
  }))
  const rejected = settled.find(result => result.status === 'rejected')
  if (rejected) throw rejected.reason
  return results
}

async function prepareMediaMutationPaths(settings, targets, { tags = false, favorites = false } = {}) {
  const localTargets = targets.filter(target => !/^https?:\/\//i.test(target.path || ''))
  const needsTagPaths = tags && localTargets.length > 0
  const needsFavoritePaths = favorites && localTargets.length > 0
  const roots = rootsSignature(), tagKeys = needsTagPaths ? settings.customTagKeys || Object.keys(settings.customTags || {}) : []
  const favoriteKeys = needsFavoritePaths ? settings.favorites || [] : []
  const legacyKeys = tagKeys.filter(legacyTagPath), entries = new Set(legacyKeys)
  for (const target of localTargets) {
    for (const key of [target.path, target.rawPath]) if (key) entries.add(key)
    for (const key of [target.favoriteKey, target.legacyFavoriteKey]) if (key && legacyTagPath(key)) entries.add(key)
  }
  for (const key of favoriteKeys) { const value = favoritePath(key); if (value != null) entries.add(value) }
  const paths = await resolvePathsForAccess([...entries])
  const initialTargets = new Map(localTargets.map(target => [target.path, paths.get(target.path)]))
  const canonicalKeys = new Map()
  const canonicalKey = value => {
    if (!paths.has(value)) throw changed()
    if (!canonicalKeys.has(value)) canonicalKeys.set(value, pathKey(paths.get(value)))
    return canonicalKeys.get(value)
  }
  const legacyIndex = new Map(), keyOrder = new Map(tagKeys.map((key, index) => [key, index]))
  let nextOrder = tagKeys.length
  if (needsTagPaths) {
    const possibleKeys = new Set([...legacyKeys, ...localTargets.flatMap(target => [target.favoriteKey, target.legacyFavoriteKey].filter(key => key && legacyTagPath(key)))])
    let indexed = 0
    for (const key of possibleKeys) {
      for (const indexKey of new Set([pathKey(key), canonicalKey(key)])) {
        if (!legacyIndex.has(indexKey)) legacyIndex.set(indexKey, new Set())
        legacyIndex.get(indexKey).add(key)
      }
      if (++indexed % 128 === 0) await new Promise(resolve => setImmediate(resolve))
    }
  }
  const currentTargetPaths = await resolvePathsForAccess(localTargets.flatMap(target => [target.path, target.rawPath].filter(Boolean)))
  for (const [key, value] of currentTargetPaths) { paths.set(key, value); canonicalKeys.delete(key) }
  const failures = new Map()
  await mapMediaTargets(targets.filter(fileTarget), async target => {
    try {
      const resolved = paths.get(target.path)
      if (pathKey(initialTargets.get(target.path)) !== pathKey(resolved) ||
        (target.rawPath && pathKey(paths.get(target.rawPath)) !== pathKey(resolved))) throw Error('media alias changed')
      if (!(await fsp.stat(resolved)).isFile()) throw Error('not a file')
    } catch (error) { failures.set(target, error.status ? error : Object.assign(new Error('视频不存在或无权访问'), { status: 404, code: 'video_not_found' })) }
  })
  // Roots are resolved after all yielding preparation: a retargeted junction
  // must not leave a stale authorization policy at the synchronous commit boundary.
  const policies = new Map()
  for (const target of targets) {
    if (fileTarget(target) && !policies.has(target.accessOptions)) {
      policies.set(target.accessOptions, await createMediaAccessPolicyAsync(target.accessOptions))
    }
  }
  const integerIndex = key => String(Number(key)) === key && Number.isInteger(Number(key)) && Number(key) >= 0 && Number(key) < 4294967295 ? Number(key) : Infinity
  return {
    canonicalKey,
    removeKey: key => keyOrder.delete(key),
    addKey(key) { if (!keyOrder.has(key)) keyOrder.set(key, nextOrder++) },
    collectLegacyEntries(customTags, target) {
      const matches = new Set()
      for (const candidate of [target.path, target.rawPath].filter(Boolean)) {
        for (const indexKey of [pathKey(candidate), canonicalKey(candidate)]) {
          for (const key of legacyIndex.get(indexKey) || []) if (Object.hasOwn(customTags, key)) matches.add(key)
        }
      }
      return [...matches].sort((a, b) => {
        const ai = integerIndex(a), bi = integerIndex(b)
        return ai !== bi ? ai - bi : keyOrder.get(a) - keyOrder.get(b)
      }).map(key => [key, customTags[key]])
    },
    assertCurrent(current) {
      if (roots !== rootsSignature() || (needsTagPaths && JSON.stringify(tagKeys) !== JSON.stringify(Object.keys(current.customTags || {}))) ||
        (needsFavoritePaths && JSON.stringify(favoriteKeys) !== JSON.stringify(current.favorites || []))) throw changed()
    },
    assertTarget(target) {
      if (!fileTarget(target)) { target.assertAccess(); return }
      if (failures.has(target)) throw failures.get(target)
      const policy = policies.get(target.accessOptions)
      // Re-evaluate the current desktop unlock/session state without repeating filesystem IO.
      createMediaAccessPolicy({ ...target.accessOptions, resolvedRoots: { allowed: policy.allowedDirectories, private: policy.privateDirectories } })
        .assertReadResolvedPath(paths.get(target.path))
    }
  }
}

module.exports = { DEFAULT_ACCESS, favoritePath, mapMediaTargets, prepareMediaMutationPaths }
