const { app, ipcMain } = require('electron')
const { IPC } = require('../ipc-channels')
const {
  loadSettings,
  saveSettingsAndFlush,
  sanitizeSettingsForRenderer,
  sanitizeSettingsForSave
} = require('../settings')

function registerSettingsIpc() {
  ipcMain.handle(IPC.GET_SETTINGS, async () => {
    return sanitizeSettingsForRenderer(loadSettings())
  })

  ipcMain.handle(IPC.GET_APP_VERSION, async () => {
    return app.getVersion()
  })

  ipcMain.handle(IPC.SAVE_SETTINGS, async (_event, settings) => {
    const saved = await saveSettingsAndFlush(sanitizeSettingsForSave(settings))
    return { success: true, settings: sanitizeSettingsForRenderer(saved) }
  })
}

module.exports = { registerSettingsIpc }
