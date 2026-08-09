const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const PORTABLE_FALLBACK_ENV = 'WALLPAPER_PLAYER_PORTABLE_DATA_FALLBACK'

function probeDirectoryWritable(directory, fsModule = fs) {
  fsModule.mkdirSync(directory, { recursive: true })
  const probePath = path.join(directory, `.write-probe-${process.pid}-${crypto.randomBytes(4).toString('hex')}`)
  let descriptor = null
  try {
    descriptor = fsModule.openSync(probePath, 'wx')
  } finally {
    if (descriptor !== null) fsModule.closeSync(descriptor)
    try {
      fsModule.unlinkSync(probePath)
    } catch {}
  }
}

function configurePortableUserData(app, env = process.env, fsModule = fs) {
  delete env[PORTABLE_FALLBACK_ENV]
  const portableDir = String(env.PORTABLE_EXECUTABLE_DIR || '').trim()
  if (!portableDir) return { portable: false, fallback: false }

  const requestedPath = path.join(portableDir, 'Data')
  const fallbackPath = app.getPath('userData')
  try {
    probeDirectoryWritable(requestedPath, fsModule)
    app.setPath('userData', requestedPath)
    return { portable: true, fallback: false, userDataPath: requestedPath }
  } catch (error) {
    const state = {
      portable: true,
      fallback: true,
      requestedPath,
      fallbackPath,
      error: error?.message || String(error)
    }
    env[PORTABLE_FALLBACK_ENV] = JSON.stringify(state)
    return state
  }
}

function getPortableDataFallback(env = process.env) {
  try {
    const state = JSON.parse(env[PORTABLE_FALLBACK_ENV] || 'null')
    return state?.fallback ? state : null
  } catch {
    return null
  }
}

module.exports = {
  PORTABLE_FALLBACK_ENV,
  configurePortableUserData,
  getPortableDataFallback,
  probeDirectoryWritable
}
