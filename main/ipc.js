const { registerDownloadIpc } = require('./ipc/downloads')
const { registerFileIpc } = require('./ipc/files')
const { registerMediaIpc } = require('./ipc/media')
const { registerNetworkResourceIpc } = require('./ipc/network-resources')
const { registerPlayerIpc } = require('./ipc/player')
const { registerPluginIpc } = require('./ipc/plugins')
const { registerPrivacyIpc } = require('./ipc/privacy')
const { registerRemoteIpc } = require('./ipc/remote')
const { registerSettingsIpc } = require('./ipc/settings')
const { registerUpdaterIpc } = require('./ipc/updater')

function setupIPC() {
  registerMediaIpc()
  registerSettingsIpc()
  registerPluginIpc()
  registerNetworkResourceIpc()
  registerDownloadIpc()
  registerPrivacyIpc()
  registerFileIpc()
  registerPlayerIpc()
  registerUpdaterIpc()
  registerRemoteIpc()
}

module.exports = { setupIPC }
