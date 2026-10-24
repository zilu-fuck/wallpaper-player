const { createPluginRegistry } = require('./registry')
const { loadOfficialPluginImplementation } = require('./builtin')
const { loadSettingsFields, removePluginSettings, saveSettings } = require('../settings')
const {
  listExternalPluginManifests,
  installExternalPlugin,
  uninstallExternalPlugin,
  readManifestFromPath,
  getExternalPluginsDir
} = require('./loader')
const { createCoreCapabilities } = require('./capabilities')

const pluginRegistry = createPluginRegistry()
let coreCapabilityDisposers = []
let setupGeneration = 0, disposalPromise = null

function snapshotPluginSettings(pluginId) {
  const plugins = loadSettingsFields(['plugins']).plugins || {}
  const id = String(pluginId || '').trim()
  if (!id || !Object.hasOwn(plugins, id)) {
    return { exists: false, state: null }
  }
  return {
    exists: true,
    state: JSON.parse(JSON.stringify(plugins[id]))
  }
}

function restorePluginSettings(pluginId, snapshot) {
  const id = String(pluginId || '').trim()
  if (!id) return
  removePluginSettings(id)
  if (snapshot?.exists) {
    saveSettings({
      plugins: {
        [id]: snapshot.state || {}
      }
    })
  }
}

function registerCoreCapabilities() {
  if (coreCapabilityDisposers.length) return
  const capabilities = createCoreCapabilities(pluginRegistry)
  coreCapabilityDisposers = Object.entries(capabilities).map(([name, value]) => (
    pluginRegistry.provideCoreCapability(name, value)
  ))
}

async function setupPlugins() {
  if (disposalPromise) await disposalPromise
  const generation = setupGeneration
  const manifests = await listExternalPluginManifests()
  if (generation !== setupGeneration) throw Object.assign(new Error('插件服务正在关闭'), { code: 'plugin_service_stopping' })
  registerCoreCapabilities()
  const plugins = manifests.map(loadOfficialPluginImplementation)
  return pluginRegistry.setup(plugins)
}

function disposePlugins() {
  if (disposalPromise) return disposalPromise
  setupGeneration++
  disposalPromise = (async () => {
    await pluginRegistry.dispose()
    for (const disposer of [...coreCapabilityDisposers].reverse()) {
      try { disposer() } catch {}
    }
    coreCapabilityDisposers = []
  })().finally(() => { disposalPromise = null })
  return disposalPromise
}

function installPlugin(sourcePath) { return pluginRegistry.runLifecycle(() => installPluginNow(sourcePath)) }

async function installPluginNow(sourcePath) {
  const transaction = await installExternalPlugin(sourcePath)
  const { manifest } = transaction
  const existing = pluginRegistry.getPlugin(manifest.id)
  const previousSettings = snapshotPluginSettings(manifest.id)
  let oldPlugin = null
  let newPluginRegistered = false
  if (existing) {
    oldPlugin = { ...existing }
    await pluginRegistry.unregister(existing.id)
  }
  try {
    await pluginRegistry.register(loadOfficialPluginImplementation(manifest), { throwOnActivationError: true })
    newPluginRegistered = true
    await transaction.commit()
  } catch (error) {
    if (newPluginRegistered) {
      await pluginRegistry.unregister(manifest.id).catch(() => {})
    }
    await transaction.rollback()
    restorePluginSettings(manifest.id, previousSettings)
    if (oldPlugin) {
      await pluginRegistry.register(oldPlugin).catch(() => {})
    }
    throw error
  }
  return {
    success: true,
    plugin: pluginRegistry.listPlugins().find(plugin => plugin.id === manifest.id)
  }
}

function uninstallPlugin(pluginId) { return pluginRegistry.runLifecycle(() => uninstallPluginNow(pluginId)) }

async function uninstallPluginNow(pluginId) {
  const plugin = pluginRegistry.getPlugin(pluginId)
  if (!plugin) return { success: false, error: '插件不存在' }
  await uninstallExternalPlugin(plugin.id, { directoryName: plugin.installDirectoryName })
  await pluginRegistry.unregister(plugin.id)
  removePluginSettings(plugin.id)
  return { success: true }
}

module.exports = {
  pluginRegistry,
  setupPlugins,
  disposePlugins,
  installPlugin,
  uninstallPlugin,
  getExternalPluginsDir
}
