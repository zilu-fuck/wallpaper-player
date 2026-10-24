const { captureAppSender } = require('./ipc-sender')

function createAppIpc(nativeIpc) {
  const channels = new Set()
  return {
    handle(channel, handler) {
      if (typeof handler !== 'function') throw new TypeError('IPC handler must be a function')
      nativeIpc().handle(channel, async (event, ...args) => {
        const source = captureAppSender(event)
        try { return await handler(event, ...args) }
        finally { source.assertCurrent() }
      })
      channels.add(channel)
    },
    removeHandler(channel) { nativeIpc().removeHandler(channel); channels.delete(channel) },
    registeredChannels() { return [...channels] }
  }
}

const ipcMain = createAppIpc(() => require('electron').ipcMain)
module.exports = { ipcMain }
