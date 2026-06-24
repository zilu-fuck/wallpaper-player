const fs = require('fs')
const path = require('path')
const { isOfficialPluginId } = require('./official')

function isSafePluginEntry(entry) {
  const value = String(entry || '').trim()
  if (!value || path.isAbsolute(value)) return false
  const normalized = value.replace(/\\/g, '/')
  if (normalized.split('/').includes('..')) return false
  return normalized.endsWith('.js')
}

function clearRequireCache(modulePath) {
  const resolved = require.resolve(modulePath)
  const cached = require.cache[resolved]
  if (!cached) return
  for (const child of cached.children || []) {
    if (child?.filename?.startsWith(path.dirname(resolved))) {
      clearRequireCache(child.filename)
    }
  }
  delete require.cache[resolved]
}

function loadOfficialPluginImplementation(manifest) {
  if (!isOfficialPluginId(manifest?.id)) return manifest

  const pluginDir = manifest?.location ? path.resolve(manifest.location) : ''
  const entry = isSafePluginEntry(manifest?.entry) ? manifest.entry : 'index.js'
  const entryPath = pluginDir ? path.resolve(pluginDir, entry) : ''
  if (!entryPath || !fs.existsSync(entryPath)) {
    return {
      ...manifest,
      source: 'official',
      publisher: 'official',
      official: true,
      trusted: true,
      executable: true,
      loadError: true,
      enabled: false,
      status: 'error',
      lastError: '官方插件入口文件缺失，请重新安装插件包'
    }
  }

  try {
    clearRequireCache(entryPath)
    const implementation = require(entryPath)
    return {
      ...implementation,
      ...manifest,
      setup: implementation.setup,
      settingsSections: implementation.settingsSections || manifest.settingsSections,
      settingsDefaults: implementation.settingsDefaults || manifest.settingsDefaults,
      settingsSchema: implementation.settingsSchema || manifest.settingsSchema,
      source: 'official',
      publisher: 'official',
      official: true,
      trusted: true,
      executable: true
    }
  } catch (error) {
    return {
      ...manifest,
      source: 'official',
      publisher: 'official',
      official: true,
      trusted: true,
      executable: true,
      loadError: true,
      enabled: false,
      status: 'error',
      lastError: error?.message || String(error)
    }
  }
}

module.exports = {
  loadOfficialPluginImplementation
}
