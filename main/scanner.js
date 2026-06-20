const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')
const { SCAN_CACHE_TTL } = require('./constants')
const { pathKey, isPathInside, isVideoFile } = require('./paths')
const { getAllowedVideoDirectories, setDirectoryChangeHandler, isSessionAllowedFile } = require('./settings')

// ─── 目录扫描缓存 + 文件监听 ──────────────────────────
// 缓存：key=pathKey(dirPath) → { videos, scannedAt, dirMtime }
// 失效策略：fs.watch recursive 主动失效 + TTL 兜底漏事件
const directoryScanCache = new Map()
const directoryWatchers = new Map() // key=pathKey(dirPath) → fs.FSWatcher

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

// 目录列表变化时清理被移除目录的缓存 + watcher
setDirectoryChangeHandler((remainingDirectories) => {
  const remainingKeys = new Set(remainingDirectories.map(pathKey))
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
async function readWallpaperMetadata(dirPath) {
  try {
    const projectPath = path.join(dirPath, 'project.json')
    const raw = await fsp.readFile(projectPath, 'utf-8')
    const project = JSON.parse(raw)
    const tags = Array.isArray(project.tags)
      ? project.tags.filter(tag => typeof tag === 'string' && tag.trim()).map(tag => tag.trim())
      : []
    const workshopId = project.workshopid ? String(project.workshopid) : path.basename(dirPath)
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
      tags,
      type: typeof project.type === 'string' ? project.type.trim() : '',
      file: typeof project.file === 'string' ? project.file : '',
      previewPath: safePreviewPath,
      workshopId,
      workshopUrl: typeof project.workshopurl === 'string' ? project.workshopurl : ''
    }
  } catch {
    return null
  }
}

// ─── 递归扫描目录 ──────────────────────────────────────
async function scanDirectory(dirPath, baseDir, depth = 0, inheritedMetadata = null) {
  const results = []
  if (depth > 8) return results

  const metadata = inheritedMetadata || await readWallpaperMetadata(dirPath)

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
        results.push(...await scanDirectory(fullPath, baseDir, depth + 1, metadata))
      }
    } else if (entry.isFile() && isVideoFile(entry.name)) {
      try {
        const stats = await fsp.stat(fullPath)
        const relDir = path.relative(baseDir, dirPath)
        const group = relDir ? relDir.split(path.sep)[0] : path.basename(baseDir)
        const title = metadata?.title || path.basename(entry.name, path.extname(entry.name))
        const workshopId = metadata?.workshopId || (group || path.basename(baseDir))
        const favoriteKey = metadata
          ? `workshop:${workshopId}`
          : `file:${Buffer.from(fullPath).toString('base64url')}`

        results.push({
          id: Buffer.from(path.relative(baseDir, fullPath)).toString('base64url'),
          playbackKey: pathKey(fullPath),
          name: title,
          fileName: path.basename(entry.name, path.extname(entry.name)),
          fullPath,
          extension: path.extname(entry.name).toLowerCase(),
          size: stats.size,
          modified: stats.mtimeMs,
          group: metadata?.tags?.[0] || group,
          tags: metadata?.tags || [],
          wallpaperType: metadata?.type || '',
          previewPath: metadata?.previewPath || null,
          workshopId,
          workshopUrl: metadata?.workshopUrl || '',
          favoriteKey,
          description: metadata?.description || ''
        })
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
          return { videos: cached.videos, count: cached.videos.length, cached: true }
        }
      } catch {
        // stat 失败放弃缓存，继续全量扫描
      }
    }
    directoryScanCache.delete(cacheKey)
  }

  const videos = await scanDirectory(resolvedDir, resolvedDir)
  let dirMtime = null
  try { dirMtime = (await fsp.stat(resolvedDir)).mtimeMs } catch {}
  directoryScanCache.set(cacheKey, { videos, scannedAt: Date.now(), dirMtime })
  watchDirectory(resolvedDir) // 确保该目录被监听，变化时主动失效缓存
  return { videos, count: videos.length }
}

module.exports = {
  directoryScanCache,
  directoryWatchers,
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
