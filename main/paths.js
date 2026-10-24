const { pathKey, isPathInside } = require('./path-identity')
const path = require('path')
const fs = require('fs')
const { app } = require('electron')
const { VIDEO_EXTENSIONS } = require('./constants')

function getResourcePath(...segments) {
  if (app?.isPackaged) {
    return path.join(process.resourcesPath, ...segments)
  }
  return path.join(__dirname, '..', ...segments)
}

function isPortableApp() {
  return Boolean(process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR)
}



// realpath 归一化后的 pathKey：解析 subst/junction/大小写差异。
// 路径不存在时回退为普通 pathKey（如已删除文件的遗留标签键）。
function normalizedPathKey(inputPath) {
  const resolved = path.resolve(inputPath)
  try {
    return pathKey(fs.realpathSync.native(resolved))
  } catch {
    return pathKey(resolved)
  }
}

async function resolvePathForAccessAsync(inputPath) {
  const resolved = path.resolve(inputPath)
  try { return await fs.promises.realpath(resolved) } catch { return resolved }
}

// Keep large legacy-key/index batches off the main thread without issuing one IO per item at once.
// Wait for issued IO even when a policy/generation check fails; no work outlives the batch.
async function resolvePathsForAccess(inputPaths, check = () => {}) {
  check()
  const entries = [...new Set(inputPaths)], resolved = new Map()
  let next = 0, failed = false
  const results = await Promise.allSettled(Array.from({ length: Math.min(8, entries.length) }, async () => {
    try {
      while (!failed && next < entries.length) {
        check(); const entry = entries[next++]
        const canonical = await resolvePathForAccessAsync(entry)
        check(); resolved.set(entry, canonical)
      }
    } catch (error) { failed = true; throw error }
  }))
  const rejected = results.find(result => result.status === 'rejected')
  if (rejected) throw rejected.reason
  check()
  return resolved
}



function isVideoFile(filePath) {
  return VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

function hasMpegTransportStreamSignature(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 3 * 188) return false
  for (const packetSize of [188, 192, 204]) {
    const maxOffset = Math.min(packetSize, buffer.length - (packetSize * 2))
    for (let offset = 0; offset < maxOffset; offset++) {
      if (
        buffer[offset] === 0x47 &&
        buffer[offset + packetSize] === 0x47 &&
        buffer[offset + (packetSize * 2)] === 0x47
      ) {
        return true
      }
    }
  }
  return false
}

async function isVideoContentFile(filePath) {
  if (!isVideoFile(filePath)) return false
  if (path.extname(filePath).toLowerCase() !== '.ts') return true

  let handle
  try {
    handle = await fs.promises.open(filePath, 'r')
    const buffer = Buffer.alloc(4096)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return hasMpegTransportStreamSignature(buffer.subarray(0, bytesRead))
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => {})
  }
}

function isExistingFile(inputPath) {
  try {
    return fs.statSync(inputPath).isFile()
  } catch {
    return false
  }
}

function isMpvExecutablePath(inputPath) {
  if (inputPath === 'mpv' || inputPath === 'mpv.exe') return true
  return path.basename(inputPath).toLowerCase() === 'mpv.exe'
}

module.exports = {
  getResourcePath,
  isPortableApp,
  pathKey,
  normalizedPathKey,
  resolvePathForAccessAsync,
  resolvePathsForAccess,
  isPathInside,
  isVideoFile,
  isVideoContentFile,
  hasMpegTransportStreamSignature,
  isExistingFile,
  isMpvExecutablePath
}
