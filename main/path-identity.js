const path = require('node:path')

function pathKey(inputPath) {
  const resolved = path.resolve(inputPath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isPathInside(parentPath, targetPath) {
  const relative = path.relative(parentPath, targetPath)
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith('..' + path.sep) &&
    !path.isAbsolute(relative)
  )
}

module.exports = { pathKey, isPathInside }
