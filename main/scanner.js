const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')
const crypto = require('crypto')
const { SCAN_CACHE_TTL } = require('./constants')
const { pathKey, isPathInside, isVideoFile } = require('./paths')
const { getAllowedVideoDirectories, setDirectoryChangeHandler, isSessionAllowedFile } = require('./settings')
const { getCachedVideoMetadata, warmVideoMetadataCache } = require('./video-metadata')

const fallbackUserDataDir = path.join(process.cwd(), '.tmp-wallpaper-player')
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

function getUserDataDir() {
  try {
    const { app } = require('electron')
    return app?.getPath ? app.getPath('userData') : fallbackUserDataDir
  } catch {
    return fallbackUserDataDir
  }
}

function getScanIndexDir() {
  const dir = path.join(getUserDataDir(), 'scan-index')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function getScanIndexPath(dirPath) {
  const digest = crypto
    .createHash('sha256')
    .update(pathKey(path.resolve(dirPath)))
    .digest('hex')
  return path.join(getScanIndexDir(), `${digest}.json`)
}

async function loadScanIndex(dirPath) {
  try {
    const parsed = JSON.parse(await fsp.readFile(getScanIndexPath(dirPath), 'utf-8'))
    if (parsed?.version !== SCAN_INDEX_VERSION || !parsed.entries || typeof parsed.entries !== 'object') {
      return { version: SCAN_INDEX_VERSION, entries: {} }
    }
    return parsed
  } catch {
    return { version: SCAN_INDEX_VERSION, entries: {} }
  }
}

async function saveScanIndex(dirPath, videos) {
  const entries = {}
  for (const video of Array.isArray(videos) ? videos : []) {
    if (!video?.fullPath) continue
    entries[pathKey(video.fullPath)] = {
      size: Number(video.size) || 0,
      modified: Math.round(Number(video.fileModified || video.modified) || 0),
      video
    }
  }

  const payload = {
    version: SCAN_INDEX_VERSION,
    root: path.resolve(dirPath),
    savedAt: Date.now(),
    entries
  }
  const indexPath = getScanIndexPath(dirPath)
  await fsp.mkdir(path.dirname(indexPath), { recursive: true })
  await fsp.writeFile(indexPath, JSON.stringify(payload, null, 2), 'utf-8')
}

function invalidateScanCache(cacheKey) {
  directoryScanCache.delete(cacheKey)
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
async function resolveExistingPath(inputPath) {
  if (typeof inputPath !== 'string' || !inputPath.trim()) {
    throw new Error('路径无效')
  }
  const resolved = path.resolve(inputPath)
  await fsp.access(resolved)
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

async function assertAllowedVideoPath(filePath) {
  const resolved = await resolveExistingPath(filePath)
  const stats = await fsp.stat(resolved)
  if (!stats.isFile() || !isVideoFile(resolved)) {
    throw new Error('路径不是支持的视频文件')
  }

  const allowedDirs = getAllowedVideoDirectories()

  if (!allowedDirs.some(dir => isPathInside(dir, resolved)) && !isSessionAllowedFile(resolved)) {
    throw new Error('文件不在已添加的视频目录中')
  }

  return resolved
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
    const safePreviewPath = previewPath && isPathInside(wallpaperDir, previewPath) && fs.existsSync(previewPath)
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
function createVideoRecord({ fullPath, entryName, dirPath, baseDir, stats, metadata }) {
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
    })
  }
}

function reuseIndexedVideo(index, fullPath, stats, metadata, entryName, dirPath, baseDir) {
  const indexed = index?.entries?.[pathKey(fullPath)]
  if (!indexed?.video) return null
  if (indexed.size !== stats.size || indexed.modified !== Math.round(stats.mtimeMs)) return null

  const next = createVideoRecord({ fullPath, entryName, dirPath, baseDir, stats, metadata })
  return {
    ...indexed.video,
    ...next,
    media: next.media || indexed.video.media || null
  }
}

function attachCachedMedia(videos) {
  return Array.isArray(videos)
    ? videos.map(video => ({
        ...video,
        media: getCachedVideoMetadata(video.fullPath, {
          size: video.size,
          mtimeMs: Math.round(Number(video.fileModified || video.modified) || 0)
        }) || video.media || null
      }))
    : []
}

async function getValidatedIndexedVideos(index, resolvedDir) {
  if (!index?.entries || typeof index.entries !== 'object') return []
  const videos = []
  const root = path.resolve(resolvedDir)

  for (const entry of Object.values(index.entries)) {
    const video = entry?.video
    if (!video?.fullPath) continue
    const fullPath = path.resolve(video.fullPath)
    if (!isPathInside(root, fullPath) || !isVideoFile(fullPath)) continue

    try {
      const stats = await fsp.stat(fullPath)
      if (!stats.isFile()) continue
      const indexedSize = Number(entry.size ?? video.size) || 0
      const indexedModified = Math.round(Number(entry.modified ?? video.modified) || 0)
      if (indexedSize !== stats.size || indexedModified !== Math.round(stats.mtimeMs)) continue
      videos.push({
        ...video,
        fullPath,
        size: stats.size,
        fileModified: stats.mtimeMs
      })
    } catch {}
  }

  return videos
}

async function writeScanResult(resolvedDir, cacheKey, videos, options = {}) {
  let dirMtime = null
  try { dirMtime = (await fsp.stat(resolvedDir)).mtimeMs } catch {}
  const videosWithMedia = attachCachedMedia(videos)
  directoryScanCache.set(cacheKey, {
    videos: videosWithMedia,
    scannedAt: Date.now(),
    dirMtime,
    indexed: Boolean(options.indexed),
    refreshing: Boolean(options.refreshing)
  })
  if (!options.skipSave) {
    await saveScanIndex(resolvedDir, videosWithMedia).catch(() => {})
  }
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

function refreshScanIndexInBackground(resolvedDir, cacheKey, index) {
  if (backgroundScanRefreshes.has(cacheKey)) return backgroundScanRefreshes.get(cacheKey)
  const refresh = (async () => {
    const workshopManifest = await loadWorkshopManifest(getWorkshopManifestPath(resolvedDir))
    const videos = await scanDirectory(resolvedDir, resolvedDir, 0, null, index, workshopManifest)
    await writeScanResult(resolvedDir, cacheKey, videos)
  })()
    .catch(() => {})
    .finally(() => {
      backgroundScanRefreshes.delete(cacheKey)
    })
  backgroundScanRefreshes.set(cacheKey, refresh)
  return refresh
}

async function waitForBackgroundScanRefreshes() {
  await Promise.all([...backgroundScanRefreshes.values()])
}

async function scanDirectory(dirPath, baseDir, depth = 0, inheritedMetadata = null, index = null, workshopManifest = null) {
  const results = []
  if (depth > 8) return results

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
        results.push(...await scanDirectory(fullPath, baseDir, depth + 1, metadata, index, workshopManifest))
      }
    } else if (entry.isFile() && isVideoFile(entry.name)) {
      try {
        const stats = await fsp.stat(fullPath)
        results.push(
          reuseIndexedVideo(index, fullPath, stats, metadata, entry.name, dirPath, baseDir) ||
          createVideoRecord({ fullPath, entryName: entry.name, dirPath, baseDir, stats, metadata })
        )
      } catch {
        // skip files with stat errors
      }
    }
  }

  return results
}

// ─── 扫描入口（带缓存） ────────────────────────────────
async function scanWithCache(dirPath, force = false) {
  const resolvedDir = await assertAllowedDirectory(dirPath)
  const allowedDirs = getAllowedVideoDirectories()

  if (allowedDirs.length > 0 && !allowedDirs.some(dir => isPathInside(dir, resolvedDir))) {
    return { error: `目录未添加到库中: ${dirPath}` }
  }

  const cacheKey = pathKey(resolvedDir)

  // 缓存命中：非强制 + 未过 TTL + 根目录 mtime 未变
  if (!force) {
    const cached = directoryScanCache.get(cacheKey)
    if (cached && Date.now() - cached.scannedAt < SCAN_CACHE_TTL) {
      try {
        if ((await fsp.stat(resolvedDir)).mtimeMs === cached.dirMtime) {
          const videos = attachCachedMedia(cached.videos)
          directoryScanCache.set(cacheKey, { ...cached, videos })
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
  const indexedVideos = force ? [] : await getValidatedIndexedVideos(index, resolvedDir)
  if (!force && indexedVideos.length > 0) {
    const videos = await writeScanResult(resolvedDir, cacheKey, indexedVideos, {
      indexed: true,
      refreshing: true,
      skipSave: true
    })
    refreshScanIndexInBackground(resolvedDir, cacheKey, index)
    return { videos, count: videos.length, cached: true, indexed: true, refreshing: true }
  }

  const workshopManifest = await loadWorkshopManifest(getWorkshopManifestPath(resolvedDir))
  const videos = await scanDirectory(resolvedDir, resolvedDir, 0, null, index, workshopManifest)
  const videosWithMedia = await writeScanResult(resolvedDir, cacheKey, videos)
  return { videos: videosWithMedia, count: videosWithMedia.length }
}

module.exports = {
  directoryScanCache,
  directoryWatchers,
  backgroundScanRefreshes,
  getScanIndexPath,
  loadScanIndex,
  waitForBackgroundScanRefreshes,
  invalidateScanCache,
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
