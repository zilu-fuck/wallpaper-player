const { dialog, shell } = require('electron')
const { ipcMain: appIpcMain } = require('../security/ipc')
const fsp = require('fs/promises')
const { IPC } = require('../ipc-channels')
const {
  updateSettingsAndFlush,
  sanitizeSettingsForSave
} = require('../settings')
const { getMainWindow } = require('../window')
const {
  getExternalPluginsDir,
  installPlugin,
  pluginRegistry,
  uninstallPlugin
} = require('../plugins')

const SECRET_PLACEHOLDER = '***'

function preserveMaskedPluginSecrets(plugin, nextConfig, currentConfig) {
  if (!nextConfig || typeof nextConfig !== 'object' || Array.isArray(nextConfig)) return nextConfig
  const secretKeys = Array.isArray(plugin?.secretKeys) ? plugin.secretKeys : []
  if (!secretKeys.length) return nextConfig
  const secretKeySet = new Set(secretKeys)
  function mergeValue(nextValue, currentValue, key) {
    if (secretKeySet.has(key) && nextValue === SECRET_PLACEHOLDER) {
      return currentValue
    }
    if (
      nextValue &&
      typeof nextValue === 'object' &&
      !Array.isArray(nextValue) &&
      currentValue &&
      typeof currentValue === 'object' &&
      !Array.isArray(currentValue)
    ) {
      return Object.fromEntries(
        Object.entries(nextValue).map(([childKey, childValue]) => [
          childKey,
          mergeValue(childValue, currentValue[childKey], childKey)
        ])
      )
    }
    return nextValue
  }
  return mergeValue(nextConfig, currentConfig || {}, '')
}

function registerPluginIpc(ipcMain = appIpcMain) {
  ipcMain.handle(IPC.PLUGINS_LIST, async () => {
    return pluginRegistry.listPlugins()
  })

  ipcMain.handle(IPC.PLUGINS_SET_ENABLED, async (_event, pluginId, enabled) => {
    try {
      return await pluginRegistry.setPluginEnabled(pluginId, enabled)
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.PLUGINS_INSTALL, async (_event, sourceType = 'file') => {
    try {
      const win = getMainWindow()
      const installDirectory = sourceType === 'directory'
      const result = await dialog.showOpenDialog(win, {
        title: installDirectory ? '选择插件文件夹' : '选择插件包或 plugin.json',
        properties: installDirectory ? ['openDirectory'] : ['openFile'],
        filters: installDirectory
          ? undefined
          : [
              { name: '插件包或清单', extensions: ['zip', 'json'] },
              { name: '所有文件', extensions: ['*'] }
            ]
      })
      if (result.canceled || !result.filePaths.length) {
        return { success: false, canceled: true }
      }
      return await installPlugin(result.filePaths[0])
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.PLUGINS_UNINSTALL, async (_event, pluginId) => {
    try {
      return await uninstallPlugin(pluginId)
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.PLUGINS_OPEN_DIRECTORY, async () => {
    try {
      const dir = getExternalPluginsDir()
      await fsp.mkdir(dir, { recursive: true })
      const error = await shell.openPath(dir)
      return { success: !error, error, dir }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.PLUGINS_SAVE_CONFIG, async (_event, pluginId, config) => {
    try {
      return await pluginRegistry.runLifecycle(async () => {
        const plugin = pluginRegistry.getPlugin(pluginId)
        if (!plugin) return { success: false, error: '插件不存在' }
        if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('插件配置修改无效')
        await updateSettingsAndFlush(settings => {
          const currentConfig = settings.plugins?.[plugin.id]?.config || {}
          const nextConfig = pluginRegistry.normalizePluginConfig(plugin, { ...currentConfig, ...preserveMaskedPluginSecrets(plugin, config, currentConfig) })
          if (plugin.id === 'ai-search' && !Object.hasOwn(config, 'feedbackMemory') && Array.isArray(currentConfig.feedbackMemory)) nextConfig.feedbackMemory = currentConfig.feedbackMemory
          return { patch: sanitizeSettingsForSave({
            plugins: {
              [plugin.id]: {
                config: nextConfig,
                updatedAt: new Date().toISOString()
              }
            }
          }) }
        })
        return {
          success: true,
          plugin: pluginRegistry.listPlugins().find(item => item.id === plugin.id)
        }
      })
    } catch (err) {
      return { success: false, error: err.message }
    }
  })
}

module.exports = { registerPluginIpc }
