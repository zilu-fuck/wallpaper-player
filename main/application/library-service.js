const { loadSettings, onSettingsCommitted } = require('../settings')
const { scanWithCache, onScanChanged, attachCachedMedia, getScanCanonicalPathKey } = require('../scanner')
const crypto = require('crypto')
const { LibraryQueryIndex, normalizeLibraryQuery, normalizeCategoryKey, aggregateCategoryGroups } = require('../../packages/domain')
const { libraryQuerySchema, libraryPageRequestSchema } = require('../../packages/contracts')
const { createMediaAccessPolicyAsync } = require('../security/media-access')
const { pathKey, resolvePathsForAccess, resolvePathForAccessAsync } = require('../paths')
const {
  createThumbnailTokenFactory,
  createStableIdFactory,
  getDirectoryId,
  getDirectoryName,
  replaceRememberedVideos,
  toRemoteVideo
} = require('../remote/video-index')
const { getTagsRevision } = require('../repositories/tag-state')
const { onPrivacyStateChanged } = require('../security/media-access')
const {
  NETWORK_DIRECTORY_ID,
  NETWORK_DIRECTORY_NAME,
  listRemoteNetworkItems,
  toRemoteNetworkVideo
} = require('../remote/handlers/network-resources')

const LIBRARY_SNAPSHOT_TTL_MS = 30 * 1000
const DEFAULT_PAGE_LIMIT = 100
const MAX_PAGE_LIMIT = 500

let librarySnapshotCache = null
let pendingLibrarySnapshot = null
let librarySnapshotRevision = 0
let librarySnapshotBuilds = 0
const directorySources = new Map()
const revisionEpoch = crypto.randomBytes(9).toString('base64url')
const cursorSecret = crypto.randomBytes(32)
let cachedQueryIndex = null
let cachedQuerySnapshot = null
let backgroundSnapshotRefresh = null
const membershipsByItems = new WeakMap()
const sourceKeysByItems = new WeakMap()
const categoryCache = new WeakMap()

function clearLibrarySnapshotCache() {
  librarySnapshotRevision += 1
  librarySnapshotCache = null
  cachedQueryIndex = null
  cachedQuerySnapshot = null
}

const LIBRARY_SETTING_KEYS = new Set([
  'directories', 'privateDirectories', 'favorites', 'customTags', 'customTagRevisions', 'hiddenTags', 'networkResources'
])
onSettingsCommitted(change => {
  if (!Array.isArray(change?.changedKeys) || change.changedKeys.some(key => LIBRARY_SETTING_KEYS.has(key))) {
    if (!Array.isArray(change?.changedKeys) || change.changedKeys.some(key => ['directories', 'privateDirectories'].includes(key))) directorySources.clear()
    clearLibrarySnapshotCache()
  }
})
onPrivacyStateChanged(() => { directorySources.clear(); clearLibrarySnapshotCache() })
onScanChanged(event => {
  if (event.type === 'invalidated') {
    directorySources.delete(event.cacheKey)
    clearLibrarySnapshotCache()
  } else if (event.type === 'updated') {
    if (event.partial) return
    const previous = directorySources.get(event.cacheKey)
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(event.videos)).digest('hex')
    directorySources.set(event.cacheKey, { ...event, fingerprint, checkedAt: Date.now() })
    if (previous && previous.fingerprint !== fingerprint) clearLibrarySnapshotCache()
  }
})

function filterHiddenTags(items, hiddenTags) {
  if (!Array.isArray(hiddenTags) || hiddenTags.length === 0) return items
  const hiddenSet = new Set(hiddenTags.map(normalizeCategoryKey))
  return items.filter(item => {
    const customTags = Array.isArray(item.customTags) ? item.customTags : []
    const systemTags = Array.isArray(item.systemTags) ? item.systemTags : []
    for (const tag of customTags) {
      if (hiddenSet.has(normalizeCategoryKey(`custom:${tag}`))) return false
    }
    for (const tag of systemTags) {
      if (hiddenSet.has(normalizeCategoryKey(`system:${tag}`))) return false
    }
    return true
  })
}

function buildCategoryGroups(items) { return aggregateCategoryGroups(items) }

async function createTagLookup(settings, check = () => {}) {
  const raw = new Map(), canonical = new Map()
  const entries = Object.entries(settings.customTags || {}).filter(([key, tags]) =>
    Array.isArray(tags) && !/^(?:https?:\/\/|file:|workshop:)/i.test(key))
  const paths = await resolvePathsForAccess(entries.map(([key]) => key), check)
  for (const [key, tags] of entries) {
    const append = (map, target) => map.set(target, [...(map.get(target) || []), ...tags])
    append(raw, pathKey(key)); append(canonical, pathKey(paths.get(key)))
  }
  return { raw, canonical }
}

async function applyDesktopMetadata(video, settings, lookup, canonicalPathKey) {
  lookup ||= await createTagLookup(settings)
  const canonicalKey = canonicalPathKey || getScanCanonicalPathKey(video) || pathKey(await resolvePathForAccessAsync(video.fullPath))
  const favoriteKey = video.favoriteKey
  const systemTags = Array.isArray(video.tags) ? video.tags : []
  const directTags = Array.isArray(settings.customTags?.[favoriteKey])
    ? settings.customTags[favoriteKey]
    : []
  // 旧版本以原始路径字符串为键写入，与 fullPath 存在大小写/subst/junction
  // 差异时按 pathKey + realpath 归一化匹配，保证 legacy path-key 标签在库中可见
  const legacyTags = directTags.length ? [] : [...new Set([
    ...(lookup.raw.get(pathKey(video.fullPath)) || []),
    ...(lookup.canonical.get(canonicalKey) || [])
  ])]
  const customTags = directTags.length ? directTags : legacyTags

  return {
    ...video,
    systemTags,
    customTags,
    customTagsRevision: getTagsRevision(settings, video, canonicalKey),
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
  const sign = createThumbnailTokenFactory(accessToken)
  return items.map(item => item.id?.startsWith('video_')
    ? {
      ...item,
      thumbnailToken: sign(item.id)
    }
    : item)
}

async function buildLibrarySnapshot() {
  librarySnapshotBuilds += 1
  const revision = librarySnapshotRevision
  const check = () => {
    if (revision !== librarySnapshotRevision) throw Object.assign(new Error('媒体库已变化，请重新读取'), { status: 409, code: 'library_changed' })
  }
  const policy = await createMediaAccessPolicyAsync({ audience: 'remote', throwIfAborted: check })
  check()
  const directories = [...new Map(policy.allowedDirectories.filter(directory => !policy.isPrivateResolvedPath(directory))
    .map(directory => [pathKey(directory), directory])).values()]
  const items = []
  const localIndexVideos = []
  const directorySummaries = []
  const memberships = new Map()
  const sourceKeys = []
  const settings = loadSettings()
  const tagLookup = await createTagLookup(settings, check)
  const favoriteKeys = new Set(Array.isArray(settings.favorites) ? settings.favorites : [])
  const videoIdFactory = createStableIdFactory()
  let indexed = false
  let refreshing = false

  for (const directory of directories) {
    sourceKeys.push(pathKey(directory))
    const directoryId = getDirectoryId(directory)
    const directoryName = getDirectoryName(directory)
    const source = directorySources.get(pathKey(directory))
    check()
    const signature = policy.scanResolvedSignature(directory)
    const result = source && source.policySignature === signature && Date.now() - source.checkedAt < LIBRARY_SNAPSHOT_TTL_MS
      ? source : await scanWithCache(directory, false, { audience: 'remote' })
    check()
    indexed = indexed || Boolean(result?.indexed)
    refreshing = refreshing || Boolean(result?.refreshing)
    if (Array.isArray(result?.videos)) {
      const sourceVideos = attachCachedMedia(result.videos)
      const missing = await resolvePathsForAccess(sourceVideos.filter(video => !getScanCanonicalPathKey(video))
        .map(video => video.fullPath), check)
      const localVideos = await Promise.all(sourceVideos.map(video => applyDesktopMetadata(video, settings, tagLookup,
        missing.has(video.fullPath) ? pathKey(missing.get(video.fullPath)) : undefined)))
      check()
      const remoteVideos = localVideos.map(video => toRemoteVideo(
        video,
        '',
        { directoryId, directoryName, favoriteKeys, videoIdFactory }
      ))
      localIndexVideos.push(...localVideos)
      for (const item of remoteVideos) memberships.set(item.id, [...new Set([...(memberships.get(item.id) || []), directoryId])])
      items.push(...remoteVideos)
      directorySummaries.push({
        id: directoryId,
        name: directoryName,
        count: remoteVideos.length
      })
    }
  }

  check()
  replaceRememberedVideos(localIndexVideos)

  const networkItems = listRemoteNetworkItems(settings).map(item => toRemoteNetworkVideo(item, {
    favoriteKeys,
    customTags: settings.customTags || {},
    customTagRevisions: settings.customTagRevisions || {}
  }))
  items.push(...networkItems)
  for (const item of networkItems) memberships.set(item.id, [NETWORK_DIRECTORY_ID])
  if (networkItems.length > 0) {
    directorySummaries.push({
      id: NETWORK_DIRECTORY_ID,
      name: NETWORK_DIRECTORY_NAME,
      count: networkItems.length
    })
  }

  const hiddenTags = Array.isArray(settings.hiddenTags) ? settings.hiddenTags : []
  const filteredItems = filterHiddenTags(items, hiddenTags)
  membershipsByItems.set(filteredItems, memberships)
  sourceKeysByItems.set(filteredItems, sourceKeys)

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

function withScanState(snapshot) {
  const sources = (sourceKeysByItems.get(snapshot.items) || []).map(key => directorySources.get(key)).filter(Boolean)
  return sources.length ? { ...snapshot, refreshing: sources.some(source => source.refreshing), indexed: sources.some(source => source.indexed) } : snapshot
}

async function getLibrarySnapshot() {
  const now = Date.now()
  if (librarySnapshotCache && now - librarySnapshotCache.createdAt < LIBRARY_SNAPSHOT_TTL_MS) {
    return withScanState(librarySnapshotCache.snapshot)
  }
  if (librarySnapshotCache && !backgroundSnapshotRefresh) {
    const cached = librarySnapshotCache.snapshot
    const revision = librarySnapshotRevision
    backgroundSnapshotRefresh = buildLibrarySnapshot().then(snapshot => {
      if (revision !== librarySnapshotRevision) return
      const before = crypto.createHash('sha256').update(JSON.stringify({ ...cached, scannedAt: 0, refreshing: false, indexed: false })).digest('hex')
      const after = crypto.createHash('sha256').update(JSON.stringify({ ...snapshot, scannedAt: 0, refreshing: false, indexed: false })).digest('hex')
      if (before !== after) {
        clearLibrarySnapshotCache()
        librarySnapshotCache = { createdAt: Date.now(), snapshot }
      } else librarySnapshotCache = { createdAt: Date.now(), snapshot: { ...cached, indexed: snapshot.indexed, refreshing: snapshot.refreshing } }
    }).catch(() => {}).finally(() => { backgroundSnapshotRefresh = null })
    return { ...cached, refreshing: true }
  }
  if (librarySnapshotCache && backgroundSnapshotRefresh) return { ...librarySnapshotCache.snapshot, refreshing: true }
  const revision = librarySnapshotRevision
  if (pendingLibrarySnapshot?.revision === revision) return pendingLibrarySnapshot.promise

  const pending = { revision, promise: null }
  pendingLibrarySnapshot = pending
  pending.promise = buildLibrarySnapshot()
    .then(snapshot => {
      if (revision !== librarySnapshotRevision) return getLibrarySnapshot()
      librarySnapshotCache = {
        createdAt: Date.now(),
        snapshot
      }
      return withScanState(snapshot)
    })
    .catch(error => {
      if (revision !== librarySnapshotRevision) return getLibrarySnapshot()
      throw error
    })
    .finally(() => {
      if (pendingLibrarySnapshot === pending) pendingLibrarySnapshot = null
    })
  return pending.promise
}

function currentRevision() { return `${revisionEpoch}_${librarySnapshotRevision}` }
function queryIndex(snapshot) {
  if (cachedQuerySnapshot !== snapshot.items) { cachedQuerySnapshot = snapshot.items; cachedQueryIndex = new LibraryQueryIndex(snapshot.items, membershipsByItems.get(snapshot.items)) }
  return cachedQueryIndex
}
function queryCategories(snapshot) {
  if (!categoryCache.has(snapshot.items)) categoryCache.set(snapshot.items, queryIndex(snapshot).categoryGroups())
  return categoryCache.get(snapshot.items)
}
async function getVersionedSnapshot() {
  while (true) {
    const revision = currentRevision()
    const snapshot = await getLibrarySnapshot()
    if (revision === currentRevision()) return snapshot
  }
}
function cursorHash(query, accessToken) {
  return crypto.createHash('sha256').update(JSON.stringify(query) + '\0' + accessToken).digest('hex')
}
function encodeCursor(queryHash, offset, kind = 'query') {
  const encoded = Buffer.from(JSON.stringify({ revision: currentRevision(), queryHash, offset, kind })).toString('base64url')
  return encoded + '.' + crypto.createHmac('sha256', cursorSecret).update(encoded).digest('base64url')
}
function decodeCursor(cursor, queryHash, kind = 'query') {
  if (!cursor) return 0
  const fail = code => { throw Object.assign(new Error(code === 'cursor_stale' ? '库已更新，请重新查询' : '分页游标无效'), {
    status: code === 'cursor_stale' ? 409 : 400, code, currentLibraryRevision: currentRevision()
  }) }
  const [encoded, signature, extra] = cursor.split('.')
  if (!encoded || !signature || extra) return fail('invalid_cursor')
  const expected = crypto.createHmac('sha256', cursorSecret).update(encoded).digest('base64url')
  const actualBytes = Buffer.from(signature), expectedBytes = Buffer.from(expected)
  if (actualBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(actualBytes, expectedBytes)) return fail('invalid_cursor')
  let value
  try { value = JSON.parse(Buffer.from(encoded, 'base64url').toString()) } catch { return fail('invalid_cursor') }
  if (value.revision !== currentRevision()) return fail('cursor_stale')
  if (value.queryHash !== queryHash || value.kind !== kind || !Number.isSafeInteger(value.offset) || value.offset < 0) return fail('invalid_cursor')
  return value.offset
}

async function queryLibrary(body, accessToken) {
    body = libraryPageRequestSchema.parse(body)
    const query = normalizeLibraryQuery(libraryQuerySchema.parse(body))
    const snapshot = await getVersionedSnapshot()
    const hash = cursorHash(query, accessToken)
    const offset = decodeCursor(body.cursor, hash)
    const page = queryIndex(snapshot).page(query, offset, body.limit)
    const nextOffset = offset + page.items.length
    const categoryLimit = 100
    const categories = queryCategories(snapshot)
    return { ...snapshot, count: queryIndex(snapshot).items.length, favoriteCount: queryIndex(snapshot).favoriteCount,
      items: addRequestThumbnailTokens(page.items, accessToken).map(item => query.directoryId ? { ...item, directoryId: query.directoryId,
        directoryName: snapshot.directories.find(directory => directory.id === query.directoryId)?.name || item.directoryName } : item), matchedCount: page.matchedCount,
      revision: currentRevision(), nextCursor: nextOffset < page.matchedCount ? encodeCursor(hash, nextOffset) : null,
      aggregationScope: 'visible-library', scanState: snapshot.refreshing ? 'refreshing' : 'ready',
      categoryGroups: { custom: categories.custom.slice(0, categoryLimit), system: categories.system.slice(0, categoryLimit) },
      categoryPagination: { customTotal: categories.custom.length, systemTotal: categories.system.length,
        customNextCursor: categories.custom.length > categoryLimit ? encodeCursor(cursorHash({ type: 'custom' }, accessToken), categoryLimit, 'categories') : null,
        systemNextCursor: categories.system.length > categoryLimit ? encodeCursor(cursorHash({ type: 'system' }, accessToken), categoryLimit, 'categories') : null },
      pagination: { offset, limit: body.limit, total: page.matchedCount, returned: page.items.length, hasMore: nextOffset < page.matchedCount } }
  }
async function getLibraryRevision() {
    const snapshot = await getVersionedSnapshot()
    return { revision: currentRevision(), count: queryIndex(snapshot).items.length, scanState: snapshot.refreshing ? 'refreshing' : 'ready' }
  }
async function queryLibraryCategories(type, cursor, token) {
    if (!['custom', 'system'].includes(type)) throw Object.assign(new Error('分类类型无效'), { status: 400, code: 'invalid_request' })
    const snapshot = await getVersionedSnapshot()
    const hash = cursorHash({ type }, token)
    const offset = decodeCursor(cursor, hash, 'categories')
    const items = queryCategories(snapshot)[type].slice(offset, offset + 100)
    const count = queryCategories(snapshot)[type].length
    return { items, count, nextCursor: offset + items.length < count ? encodeCursor(hash, offset + items.length, 'categories') : null,
      revision: currentRevision(), aggregationScope: 'visible-library' }
  }
async function getLegacyLibrary(url, accessToken) {
    const snapshot = await getLibrarySnapshot()
    const pagination = getPagination(url, snapshot.items.length)
    const pageItems = snapshot.items.slice(pagination.offset, pagination.offset + pagination.limit)
    const items = addRequestThumbnailTokens(pageItems, accessToken)

    return {
      ...snapshot,
      items,
      pagination: {
        offset: pagination.offset,
        limit: pagination.limit,
        total: snapshot.count,
        returned: items.length,
        hasMore: pagination.offset + items.length < snapshot.count
      }
    }
  }

module.exports = {
  getLibraryDiagnostics: () => ({ builds: librarySnapshotBuilds, revision: librarySnapshotRevision, cached: Boolean(librarySnapshotCache) }),
  buildCategoryGroups,
  applyDesktopMetadata,
  clearLibrarySnapshotCache,
  queryLibrary, getLibraryRevision, queryLibraryCategories, getLegacyLibrary
}
