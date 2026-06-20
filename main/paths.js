const path = require('path')
const fs = require('fs')
const { app } = require('electron')
const { VIDEO_EXTENSIONS } = require('./constants')

function getResourcePath(...segments) {
  if (app.isPackaged) {
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
  isExistingFile,
  isMpvExecutablePath
}
