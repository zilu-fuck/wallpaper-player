const { createPluginRegistry } = require('./registry')
const { loadOfficialPluginImplementation } = require('./builtin')
const { loadSettings, removePluginSettings, saveSettings } = require('../settings')
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

function snapshotPluginSettings(pluginId) {
  const plugins = loadSettings().plugins || {}
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
  registerCoreCapabilities()
  const plugins = (await listExternalPluginManifests()).map(loadOfficialPluginImplementation)
  return pluginRegistry.setup(plugins)
}

async function disposePlugins() {
  await pluginRegistry.dispose()
  for (const disposer of [...coreCapabilityDisposers].reverse()) {
    try {
      disposer()
    } catch {}
  }
  coreCapabilityDisposers = []
}

async function installPlugin(sourcePath) {
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

async function uninstallPlugin(pluginId) {
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
