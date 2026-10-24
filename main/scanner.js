const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')
const crypto = require('crypto')
const { EventEmitter } = require('events')
const { SCAN_CACHE_TTL } = require('./constants')
const { pathKey, isPathInside, isVideoFile, isVideoContentFile, resolvePathForAccessAsync, resolvePathsForAccess } = require('./paths')
const { setDirectoryChangeHandler, resolvePathForAccess } = require('./settings')
const { getCachedVideoMetadata, warmVideoMetadataCache } = require('./video-metadata')
const { getUserDataDir } = require('./user-data')
const { createMediaAccessPolicyAsync } = require('./security/media-access')
const { rememberVideos } = require('./remote/video-index')
const { compareLibraryVideos } = require('../packages/domain')

const SCAN_INDEX_VERSION = 2

// ─── 目录扫描缓存 + 文件监听 ──────────────────────────
// 缓存：key=pathKey(dirPath) → { videos, scannedAt, dirMtime }
// 失效策略：fs.watch recursive 主动失效 + TTL 兜底漏事件
const directoryScanCache = new Map()
const directoryWatchers = new Map() // key=pathKey(dirPath) → fs.FSWatcher
const backgroundScanRefreshes = new Map()
const workshopManifestCache = new Map()
const R18_TAG = 'R18'
const SCAN_METADATA_WARM_LIMIT = 24
const scanEvents = new EventEmitter()
const indexWrites = new Map()
const scanGenerations = new Map()
const generationFor = key => scanGenerations.get(key) || 0
function assertScanGeneration(key, generation) {
  if (generation !== undefined && generation !== generationFor(key)) throw Object.assign(new Error('目录正在变化，请重新读取'), {
    code: 'scan_changed', status: 503, retryable: true
  })
}
const canonicalVideoKeys = new WeakMap()
function getScanCanonicalPathKey(video) { return canonicalVideoKeys.get(video) }
async function filterAccessibleVideos(videos, access, root, check = () => {}) {
  const paths = await resolvePathsForAccess(videos.map(video => video.fullPath), check)
  const policy = await createMediaAccessPolicyAsync(access)
  check()
  policy.assertReadResolvedPath(root, { allowSessionFile: false })
  return { policy, videos: videos.filter(video => {
    const resolved = policy.resolveScanResolvedPath(paths.get(video.fullPath), root)
    if (!resolved) return false
    canonicalVideoKeys.set(video, pathKey(resolved)); return true
  }) }
}
function onScanChanged(listener) { scanEvents.on('change', listener); return () => scanEvents.off('change', listener) }

function getScanIndexDir() {
  return path.join(getUserDataDir(), 'scan-index')
}

// 索引路径按 realpath 归一化：扫描入口（scanWithCache）会把目录
// resolvePathForAccess 后再保存索引，调用方若传字面量路径（subst 映射盘/
// junction/大小写差异）会导致读写路径不一致、索引永不命中。
function getScanIndexPath(dirPath) {
  const resolved = resolvePathForAccess(dirPath)
  return getResolvedScanIndexPath(resolved)
}

function getResolvedScanIndexPath(resolved) {
  const digest = crypto
    .createHash('sha256')
    .update(pathKey(resolved))
    .digest('hex')
  return path.join(getScanIndexDir(), `${digest}.json`)
}

async function loadScanIndex(dirPath) {
  try {
    const resolved = await resolvePathForAccessAsync(dirPath)
    const parsed = JSON.parse(await fsp.readFile(getResolvedScanIndexPath(resolved), 'utf-8'))
    if (parsed?.version !== SCAN_INDEX_VERSION || pathKey(parsed.root || '') !== pathKey(resolved) ||
        !parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
      return { version: SCAN_INDEX_VERSION, entries: {} }
    }
    return parsed
  } catch {
    return { version: SCAN_INDEX_VERSION, entries: {} }
  }
}

async function saveScanIndex(dirPath, videos) {
  const resolved = await resolvePathForAccessAsync(dirPath)
  const entries = {}
  for (const video of Array.isArray(videos) ? videos : []) {
    if (typeof video?.fullPath !== 'string' || !video.fullPath) continue
    entries[pathKey(video.fullPath)] = {
      size: Number(video.size) || 0,
      modified: Math.round(Number(video.fileModified || video.modified) || 0),
      video
    }
  }

  const payload = {
    version: SCAN_INDEX_VERSION,
    root: resolved,
    savedAt: Date.now(),
    entries
  }
  const indexPath = getResolvedScanIndexPath(resolved)
  const previous = indexWrites.get(indexPath) || Promise.resolve()
  const write = previous.catch(() => {}).then(async () => {
    await fsp.mkdir(path.dirname(indexPath), { recursive: true })
    const temporary = `${indexPath}.${crypto.randomBytes(8).toString('hex')}.tmp`
    let handle
    try {
      handle = await fsp.open(temporary, 'wx')
      await handle.writeFile(JSON.stringify(payload), 'utf-8')
      await handle.sync(); await handle.close(); handle = null
      await fsp.rename(temporary, indexPath)
    } finally {
      if (handle) await handle.close().catch(() => {})
      await fsp.unlink(temporary).catch(() => {})
    }
  })
  indexWrites.set(indexPath, write)
  try { await write } finally { if (indexWrites.get(indexPath) === write) indexWrites.delete(indexPath) }
}

function invalidateScanCache(cacheKey) {
  scanGenerations.set(cacheKey, generationFor(cacheKey) + 1)
  directoryScanCache.delete(cacheKey)
  scanEvents.emit('change', { type: 'invalidated', cacheKey })
}

function watchDirectory(dirPath) {
  const resolved = path.resolve(dirPath)
  const key = pathKey(resolved)
  if (directoryWatchers.has(key)) return
  try {
    const watcher = fs.watch(resolved, { recursive: true }, () => invalidateScanCache(key))
    watcher.on('error', () => {
      directoryWatchers.delete(key)
      invalidateScanCache(key)
    })
    directoryWatchers.set(key, watcher)
  } catch {
    // recursive watch 不支持或目录不存在，静默失败，靠 TTL 兜底
  }
}

function unwatchDirectory(dirPath) {
  const key = pathKey(path.resolve(dirPath))
  const watcher = directoryWatchers.get(key)
  if (watcher) {
    try { watcher.close() } catch {}
    directoryWatchers.delete(key)
  }
}

function unwatchAllDirectories() {
  for (const watcher of directoryWatchers.values()) {
    try { watcher.close() } catch {}
  }
  directoryWatchers.clear()
}

function getWorkshopManifestPath(dirPath) {
  const resolved = path.resolve(dirPath)
  const parts = resolved.split(path.sep)
  const contentIndex = parts.findIndex((part, index) => (
    part.toLowerCase() === 'content' &&
    parts[index - 1]?.toLowerCase() === 'workshop' &&
    /^\d+$/.test(parts[index + 1] || '')
  ))
  if (contentIndex < 1) return ''

  const appId = parts[contentIndex + 1]
  return path.join(parts.slice(0, contentIndex).join(path.sep), `appworkshop_${appId}.acf`)
}

async function loadWorkshopManifest(manifestPath) {
  if (!manifestPath) return null
  const cached = workshopManifestCache.get(manifestPath)
  try {
    const stats = await fsp.stat(manifestPath)
    if (cached && cached.mtimeMs === stats.mtimeMs) return cached.items

    const raw = await fsp.readFile(manifestPath, 'utf-8')
    const items = new Map()
    const itemPattern = /"(\d+)"\s*\{([\s\S]*?)\n\s*\}/g
    let match
    while ((match = itemPattern.exec(raw))) {
      const timeMatch = match[2].match(/"timeupdated"\s*"(\d+)"/)
      if (timeMatch) items.set(match[1], Number(timeMatch[1]) * 1000)
    }

    workshopManifestCache.set(manifestPath, { mtimeMs: stats.mtimeMs, items })
    return items
  } catch {
    workshopManifestCache.delete(manifestPath)
    return null
  }
}

// 目录列表变化时清理被移除目录的缓存 + watcher
setDirectoryChangeHandler((remainingDirectories) => {
  const remainingKeys = new Set(remainingDirectories.map(dir => pathKey(path.resolve(dir))))
  for (const key of [...directoryScanCache.keys()]) {
    if (!remainingKeys.has(key)) directoryScanCache.delete(key)
  }
  for (const key of [...directoryWatchers.keys()]) {
    if (!remainingKeys.has(key)) {
      const w = directoryWatchers.get(key)
      try { w.close() } catch {}
      directoryWatchers.delete(key)
    }
  }
})

// ─── 路径校验 ──────────────────────────────────────────
function checkAccessWork(options) { options.throwIfAborted?.(); if (options.signal?.aborted) throw options.signal.reason }
async function resolveExistingPath(inputPath, options = {}) {
  checkAccessWork(options)
  if (typeof inputPath !== 'string' || !inputPath.trim()) {
    throw new Error('路径无效')
  }
  const resolved = await fsp.realpath(path.resolve(inputPath))
  checkAccessWork(options)
  await fsp.access(resolved)
  checkAccessWork(options)
  return resolved
}

async function assertAllowedDirectory(dirPath) {
  const resolved = await resolveExistingPath(dirPath)
  const stats = await fsp.stat(resolved)
  if (!stats.isDirectory()) {
    throw new Error('路径不是目录')
  }
  return resolved
}

async function assertAllowedVideoPath(filePath, access = {}) {
  checkAccessWork(access)
  const resolved = await resolveExistingPath(filePath, access)
  const stats = await fsp.stat(resolved)
  checkAccessWork(access)
  if (!stats.isFile() || !(await isVideoContentFile(resolved))) {
    throw new Error('路径不是支持的视频文件')
  }

  const policy = await createMediaAccessPolicyAsync(access)
  checkAccessWork(access)
  return policy.assertReadResolvedPath(resolved)
}

// ─── Wallpaper Engine 元数据 ───────────────────────────
async function readWallpaperMetadata(dirPath, workshopManifest = null) {
  try {
    const projectPath = path.join(dirPath, 'project.json')
    const raw = await fsp.readFile(projectPath, 'utf-8')
    const project = JSON.parse(raw)
    const tags = normalizeWallpaperTags(project.tags)
    if (hasWallpaperR18Flag(project, tags)) {
      tags.push(R18_TAG)
    }
    const workshopId = project.workshopid ? String(project.workshopid) : path.basename(dirPath)
    const workshopUpdatedAt = Number(workshopManifest?.get(workshopId)) || 0
    const wallpaperDir = path.resolve(dirPath)
    const previewPath = typeof project.preview === 'string' && project.preview.trim()
      ? path.resolve(dirPath, project.preview)
      : null
    const safePreviewPath = previewPath && isPathInside(wallpaperDir, previewPath) && await fsp.access(previewPath).then(() => true, () => false)
      ? previewPath
      : null

    return {
      projectDir: dirPath,
      title: typeof project.title === 'string' ? project.title.trim() : '',
      description: typeof project.description === 'string' ? project.description : '',
      tags: normalizeWallpaperTags(tags),
      type: typeof project.type === 'string' ? project.type.trim() : '',
      file: typeof project.file === 'string' ? project.file : '',
      previewPath: safePreviewPath,
      workshopId,
      workshopUpdatedAt,
      workshopUrl: typeof project.workshopurl === 'string' ? project.workshopurl : ''
    }
  } catch {
    return null
  }
}

function normalizeWallpaperTags(values) {
  const input = Array.isArray(values) ? values : []
  const seen = new Set()
  const tags = []

  for (const value of input) {
    const tag = normalizeWallpaperTag(value)
    const key = tag.toLocaleLowerCase()
    if (!tag || seen.has(key)) continue
    seen.add(key)
    tags.push(tag)
  }

  return tags
}

function normalizeWallpaperTag(value) {
  const tag = String(value || '').trim()
  if (!tag) return ''
  return isR18Value(tag) ? R18_TAG : tag
}

function hasWallpaperR18Flag(project, tags = []) {
  if (tags.some(isR18Value)) return true

  const fields = [
    'contentrating',
    'contentRating',
    'content_rating',
    'rating',
    'maturity',
    'ageRating',
    'age_rating',
    'adult',
    'mature',
    'r18',
    'nsfw'
  ]

  return fields.some(field => isR18Value(project?.[field]))
}

function isR18Value(value) {
  if (value === true) return true
  if (typeof value === 'number') return value >= 18
  if (typeof value !== 'string') return false
  const normalized = value.trim().toLocaleLowerCase().replace(/[\s_-]+/g, '')
  return normalized === 'r18' ||
    normalized === '18+' ||
    normalized === 'adult' ||
    normalized === 'mature' ||
    normalized === 'explicit' ||
    normalized === 'nsfw' ||
    normalized === 'pornographic'
}

// ─── 递归扫描目录 ──────────────────────────────────────
function createVideoRecord({ fullPath, entryName, dirPath, baseDir, stats, metadata, canonicalPathKey }) {
  const relDir = path.relative(baseDir, dirPath)
  const group = relDir ? relDir.split(path.sep)[0] : path.basename(baseDir)
  const title = metadata?.title || path.basename(entryName, path.extname(entryName))
  const workshopId = metadata?.workshopId || (group || path.basename(baseDir))
  const favoriteKey = metadata
    ? `workshop:${workshopId}`
    : `file:${Buffer.from(fullPath).toString('base64url')}`

  return {
    id: Buffer.from(path.relative(baseDir, fullPath)).toString('base64url'),
    playbackKey: pathKey(fullPath),
    name: title,
    fileName: path.basename(entryName, path.extname(entryName)),
    fullPath,
    extension: path.extname(entryName).toLowerCase(),
    size: stats.size,
    modified: metadata?.workshopUpdatedAt || stats.mtimeMs,
    fileModified: stats.mtimeMs,
    group: metadata?.tags?.[0] || group,
    tags: metadata?.tags || [],
    wallpaperType: metadata?.type || '',
    previewPath: metadata?.previewPath || null,
    workshopId,
    workshopUpdatedAt: metadata?.workshopUpdatedAt || 0,
    workshopUrl: metadata?.workshopUrl || '',
    favoriteKey,
    description: typeof metadata?.description === 'string' ? metadata.description.slice(0, 300) : '',
    media: getCachedVideoMetadata(fullPath, {
      size: stats.size,
      mtimeMs: Math.round(stats.mtimeMs)
    }, canonicalPathKey)
  }
}

function reuseIndexedVideo(index, fullPath, stats, metadata, entryName, dirPath, baseDir, canonicalPathKey) {
  const indexed = index?.entries?.[pathKey(fullPath)]
  if (!indexed?.video) return null
  if (indexed.size !== stats.size || indexed.modified !== Math.round(stats.mtimeMs)) return null

  const next = createVideoRecord({ fullPath, entryName, dirPath, baseDir, stats, metadata, canonicalPathKey })
  return {
    ...indexed.video,
    ...next,
    media: next.media || indexed.video.media || null
  }
}

function attachCachedMedia(videos) {
  return Array.isArray(videos)
    ? videos.map(video => {
      const item = {
        ...video,
        media: getCachedVideoMetadata(video.fullPath, {
          size: video.size,
          mtimeMs: Math.round(Number(video.fileModified || video.modified) || 0)
        }, canonicalVideoKeys.get(video)) || video.media || null
      }
      if (canonicalVideoKeys.has(video)) canonicalVideoKeys.set(item, canonicalVideoKeys.get(video))
      return item
    })
    : []
}

async function getValidatedIndexedVideos(index, resolvedDir, accessPolicy, limit = Infinity) {
  if (!index?.entries || typeof index.entries !== 'object') return []
  const entries = Object.values(index.entries), videos = new Array(entries.length)
  if (Number.isFinite(limit)) entries.sort((a, b) => compareLibraryVideos(a.video || {}, b.video || {}, 'name'))
  const root = path.resolve(resolvedDir)
  let next = 0, validated = 0
  await Promise.all(Array.from({ length: Math.min(8, entries.length) }, async () => {
   while (next < entries.length && validated < limit) {
    const position = next++, entry = entries[position]
    const video = entry?.video
    if (typeof video?.fullPath !== 'string' || !video.fullPath) continue
    const fullPath = accessPolicy.resolveScanResolvedPath(await resolvePathForAccessAsync(video.fullPath), resolvedDir)
    if (!fullPath || !isPathInside(root, fullPath) || !isVideoFile(fullPath)) continue

    try {
      const stats = await fsp.stat(fullPath)
      if (!stats.isFile() || !(await isVideoContentFile(fullPath))) continue
      const indexedSize = Number(entry.size ?? video.size) || 0
      const indexedModified = Math.round(Number(entry.modified ?? video.modified) || 0)
      if (indexedSize !== stats.size || indexedModified !== Math.round(stats.mtimeMs)) continue
      const current = {
        ...video,
        fullPath,
        size: stats.size,
        fileModified: stats.mtimeMs
      }
      canonicalVideoKeys.set(current, pathKey(fullPath)); videos[position] = current
      validated++
    } catch {}
   }
  }))
  return videos.filter(Boolean)
}

async function writeScanResult(resolvedDir, cacheKey, videos, options = {}) {
  const check = () => { checkAccessWork(options.access || {}); assertScanGeneration(cacheKey, options.generation) }
  let dirMtime = null
  try { dirMtime = (await fsp.stat(resolvedDir)).mtimeMs } catch {}
  check()
  let filtered = await filterAccessibleVideos(videos, options.access, resolvedDir, check)
  let policy = filtered.policy
  let videosWithMedia = attachCachedMedia(filtered.videos)
  if (!options.skipSave) {
    await saveScanIndex(resolvedDir, videosWithMedia).catch(() => {})
  }
  check()
  // 磁盘写入期间权限可能改变，返回与预热前再次使用最新策略。
  if (!options.skipSave) {
    filtered = await filterAccessibleVideos(videosWithMedia, options.access, resolvedDir, check)
    policy = filtered.policy; videosWithMedia = filtered.videos
  }
  rememberVideos(videosWithMedia)
  directoryScanCache.set(cacheKey, {
    videos: videosWithMedia,
    scannedAt: Date.now(),
    dirMtime,
    indexed: Boolean(options.indexed),
    refreshing: Boolean(options.refreshing),
    partial: Boolean(options.partial),
    policySignature: policy.scanResolvedSignature(resolvedDir)
  })
  scanEvents.emit('change', { type: 'updated', cacheKey, directory: resolvedDir, videos: videosWithMedia,
    indexed: Boolean(options.indexed), refreshing: Boolean(options.refreshing), partial: Boolean(options.partial), policySignature: policy.scanResolvedSignature(resolvedDir) })
  watchDirectory(resolvedDir)
  const warmPaths = videosWithMedia
    .filter(video => !video.media?.available)
    .slice(0, SCAN_METADATA_WARM_LIMIT)
    .map(video => video.fullPath)
  if (warmPaths.length) {
    warmVideoMetadataCache(warmPaths, { limit: SCAN_METADATA_WARM_LIMIT }).catch(() => {})
  }
  return videosWithMedia
}

function refreshScanIndexInBackground(resolvedDir, cacheKey, index, access, generation = generationFor(cacheKey)) {
  const previous = backgroundScanRefreshes.get(cacheKey)
  if (previous?.generation === generation) return previous
  const refresh = (async () => {
    const workshopManifest = await loadWorkshopManifest(getWorkshopManifestPath(resolvedDir))
    const policy = await createMediaAccessPolicyAsync(access)
    const videos = await scanDirectory(resolvedDir, resolvedDir, 0, null, index, workshopManifest, policy)
    await writeScanResult(resolvedDir, cacheKey, videos, { access, generation })
  })()
    .catch(() => {})
    .finally(() => {
      if (backgroundScanRefreshes.get(cacheKey) === refresh) backgroundScanRefreshes.delete(cacheKey)
    })
  backgroundScanRefreshes.set(cacheKey, refresh)
  refresh.generation = generation
  return refresh
}

async function waitForBackgroundScanRefreshes() {
  await Promise.all([...backgroundScanRefreshes.values()])
}

async function scanDirectory(dirPath, baseDir, depth = 0, inheritedMetadata = null, index = null, workshopManifest = null, accessPolicy, resolvedRoot) {
  const results = []
  if (depth > 8) return results
  accessPolicy ||= await createMediaAccessPolicyAsync()
  resolvedRoot ||= await resolvePathForAccessAsync(baseDir)
  if (!accessPolicy.resolveScanResolvedPath(await resolvePathForAccessAsync(dirPath), resolvedRoot)) return results

  const metadata = inheritedMetadata || await readWallpaperMetadata(dirPath, workshopManifest)

  let entries
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: true })
  } catch {
    return results
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name)

    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
        results.push(...await scanDirectory(fullPath, baseDir, depth + 1, metadata, index, workshopManifest, accessPolicy, resolvedRoot))
      }
    } else if (entry.isFile() && isVideoFile(entry.name)) {
      try {
        const canonical = await resolvePathForAccessAsync(fullPath)
        if (!accessPolicy.resolveScanResolvedPath(canonical, resolvedRoot)) continue
        if (!(await isVideoContentFile(fullPath))) continue
        const stats = await fsp.stat(fullPath)
        const canonicalPathKey = pathKey(canonical)
        const video = reuseIndexedVideo(index, fullPath, stats, metadata, entry.name, dirPath, baseDir, canonicalPathKey) ||
          createVideoRecord({ fullPath, entryName: entry.name, dirPath, baseDir, stats, metadata, canonicalPathKey })
        canonicalVideoKeys.set(video, pathKey(canonical)); results.push(video)
      } catch {
        // skip files with stat errors
      }
    }
  }

  return results
}

// ─── 扫描入口（带缓存） ────────────────────────────────
async function scanWithCacheOnce(dirPath, force = false, access = {}) {
  const resolvedDir = await assertAllowedDirectory(dirPath)
  const accessPolicy = await createMediaAccessPolicyAsync(access)
  const allowedDirs = accessPolicy.allowedDirectories
  accessPolicy.assertReadResolvedPath(resolvedDir, { allowSessionFile: false })

  if (allowedDirs.length > 0 && !allowedDirs.some(dir => isPathInside(dir, resolvedDir))) {
    return { error: `目录未添加到库中: ${dirPath}` }
  }

  const cacheKey = pathKey(resolvedDir)
  const generation = generationFor(cacheKey)

  // 缓存命中：非强制 + 未过 TTL + 根目录 mtime 未变
  if (!force) {
    const cached = directoryScanCache.get(cacheKey)
    if (cached && (!cached.partial || access.initialLimit) && cached.policySignature === accessPolicy.scanResolvedSignature(resolvedDir) &&
        Date.now() - cached.scannedAt < SCAN_CACHE_TTL) {
      try {
        if ((await fsp.stat(resolvedDir)).mtimeMs === cached.dirMtime) {
          assertScanGeneration(cacheKey, generation)
          const check = () => { checkAccessWork(access); assertScanGeneration(cacheKey, generation) }
          const filtered = await filterAccessibleVideos(cached.videos, access, resolvedDir, check)
          const videos = attachCachedMedia(filtered.videos)
          directoryScanCache.set(cacheKey, { ...cached, videos, policySignature: filtered.policy.scanResolvedSignature(resolvedDir) })
          if (cached.refreshing) {
            if (backgroundScanRefreshes.has(cacheKey)) {
              return {
                videos,
                count: videos.length,
                cached: true,
                indexed: Boolean(cached.indexed),
                refreshing: true
              }
            }
            directoryScanCache.delete(cacheKey)
          } else {
            return { videos, count: videos.length, cached: true }
          }
        }
      } catch {
        // stat 失败放弃缓存，继续全量扫描
      }
    }
    directoryScanCache.delete(cacheKey)
  }

  const index = force ? null : await loadScanIndex(resolvedDir)
  const initialLimit = access.audience === 'remote' ? Infinity : Math.max(100, Number(access.initialLimit) || Infinity)
  const indexedVideos = force ? [] : await getValidatedIndexedVideos(index, resolvedDir, accessPolicy, initialLimit)
  if (!force && indexedVideos.length > 0) {
    const videos = await writeScanResult(resolvedDir, cacheKey, indexedVideos, {
      indexed: true,
      refreshing: true,
      partial: Number.isFinite(initialLimit) && indexedVideos.length < Object.keys(index.entries).length,
      skipSave: true,
      generation,
      access
    })
    refreshScanIndexInBackground(resolvedDir, cacheKey, index, access, generation)
    return { videos, count: videos.length, cached: true, indexed: true, refreshing: true }
  }

  const workshopManifest = await loadWorkshopManifest(getWorkshopManifestPath(resolvedDir))
  const videos = await scanDirectory(resolvedDir, resolvedDir, 0, null, index, workshopManifest, accessPolicy)
  const videosWithMedia = await writeScanResult(resolvedDir, cacheKey, videos, { access, generation })
  return { videos: videosWithMedia, count: videosWithMedia.length }
}

async function scanWithCache(dirPath, force = false, access = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await scanWithCacheOnce(dirPath, force, access) }
    catch (error) { if (error.code !== 'scan_changed' || attempt >= 2) throw error }
  }
}

module.exports = {
  onScanChanged,
  invalidateScanCache,
  attachCachedMedia,
  getScanCanonicalPathKey,
  directoryScanCache,
  directoryWatchers,
  backgroundScanRefreshes,
  getScanIndexPath,
  loadScanIndex,
  waitForBackgroundScanRefreshes,
  watchDirectory,
  unwatchDirectory,
  unwatchAllDirectories,
  resolveExistingPath,
  assertAllowedDirectory,
  assertAllowedVideoPath,
  readWallpaperMetadata,
  scanDirectory,
  scanWithCache
}
