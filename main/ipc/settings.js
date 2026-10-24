const { app } = require('electron')
const { ipcMain: appIpcMain } = require('../security/ipc')
const { IPC } = require('../ipc-channels')
const { settingsLegacyListenerSchema, settingsReplyOptionsSchema, settingsReadOptionsSchema } = require('../../packages/contracts')
const { settingsBroadcast } = require('../application/settings-broadcast')
const {
  loadSettings,
  captureRendererSettings,
  saveSettingsAndFlush,
  commitSettingsPatch,
  sanitizeSettingsForRenderer,
  sanitizeSettingsForSave
} = require('../settings')

function registerSettingsIpc(ipcMain = appIpcMain) {
  ipcMain.handle(IPC.GET_SETTINGS_FEED, async (event, options) => settingsBroadcast.openFeed(event,
    options === undefined ? undefined : settingsReadOptionsSchema.parse(options)))
  ipcMain.handle(IPC.SETTINGS_LEGACY_LISTENER, async (event, value) => { settingsBroadcast.setLegacy(event, settingsLegacyListenerSchema.parse(value)); return true })
  ipcMain.handle(IPC.GET_SETTINGS, async (_event, options) => {
    if (options !== undefined) { settingsReadOptionsSchema.parse(options); return captureRendererSettings().read() }
    return sanitizeSettingsForRenderer(loadSettings())
  })

  ipcMain.handle(IPC.GET_APP_VERSION, async () => {
    return app.getVersion()
  })

  ipcMain.handle(IPC.SAVE_SETTINGS, async (_event, settings, options) => {
    const reply = options === undefined ? undefined : settingsReplyOptionsSchema.parse(options)
    if (['favorites', 'customTags', 'playbackStates', 'customTagRevisions', 'tagMutationReceipts'].some(key => Object.hasOwn(settings || {}, key))) {
      throw new Error('收藏、标签和进度请通过媒体操作接口保存')
    }
    const patch = sanitizeSettingsForSave(settings)
    if (reply) {
      const result = await commitSettingsPatch(patch, { returnSettings: false, returnVersion: true })
      return { success: true, settingsVersion: result.settingsVersion }
    }
    const saved = await saveSettingsAndFlush(patch)
    return { success: true, settings: sanitizeSettingsForRenderer(saved) }
  })
}

module.exports = { registerSettingsIpc }
