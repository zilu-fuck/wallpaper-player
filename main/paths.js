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

function pathKey(inputPath) {
  const resolved = path.resolve(inputPath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isPathInside(parentPath, targetPath) {
  const relative = path.relative(parentPath, targetPath)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
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
  isPathInside,
  isVideoFile,
  isVideoContentFile,
  hasMpegTransportStreamSignature,
  isExistingFile,
  isMpvExecutablePath
}
