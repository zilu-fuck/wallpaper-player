const { app, ipcMain } = require('electron')
const { IPC } = require('../ipc-channels')
const { isPortableApp } = require('../paths')
const {
  checkForUpdates,
  downloadUpdate,
  getUpdateState,
  getUpdaterDisabledState,
  installUpdate,
  setUpdateState
} = require('../updater')

function registerUpdaterIpc() {
  ipcMain.handle(IPC.UPDATER_GET_STATUS, async () => getUpdateState())

  ipcMain.handle(IPC.UPDATER_CHECK, async () => {
    if (!app.isPackaged || isPortableApp()) {
      return setUpdateState('disabled', getUpdaterDisabledState())
    }

    await checkForUpdates()
    return getUpdateState()
  })

  ipcMain.handle(IPC.UPDATER_DOWNLOAD, async () => {
    if (!app.isPackaged || isPortableApp()) {
      return setUpdateState('disabled', getUpdaterDisabledState())
    }

    await downloadUpdate()
    return getUpdateState()
  })

  ipcMain.handle(IPC.UPDATER_INSTALL, async () => {
    return installUpdate()
  })
}

module.exports = { registerUpdaterIpc }
