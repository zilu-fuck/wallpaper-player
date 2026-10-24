const { clipboard } = require('electron')
const { ipcMain: appIpcMain } = require('../security/ipc')
const QRCode = require('qrcode')
const { IPC } = require('../ipc-channels')
const {
  applyRemoteSettings,
  initRemoteAccess,
  getRemoteState,
  sendRemoteState
} = require('../remote')
const {
  approvePairingRequest,
  createPairingCode,
  loadIdentity,
  getIdentityReadError,
  refreshIdentity,
  rejectPairingRequest,
  revokePairedDevice,
  rotateAccessToken
} = require('../remote/identity')

function registerRemoteIpc(ipcMain = appIpcMain) {
  ipcMain.handle(IPC.REMOTE_GET_STATE, async () => {
    const wasUnavailable = Boolean(getIdentityReadError())
    try { await refreshIdentity() }
    catch (error) { if (!getIdentityReadError()) throw error; return getRemoteState() }
    if (wasUnavailable) await initRemoteAccess()
    return getRemoteState()
  })
  ipcMain.handle(IPC.REMOTE_SAVE_SETTINGS, async (_event, remoteSettings) => applyRemoteSettings(remoteSettings))
  ipcMain.handle(IPC.REMOTE_COPY_ENDPOINT, async () => {
    await refreshIdentity()
    const state = getRemoteState()
    await clipboard.writeText(state.endpoint)
    return { success: true, text: state.endpoint }
  })
  ipcMain.handle(IPC.REMOTE_COPY_TOKEN, async () => {
    await refreshIdentity()
    const state = getRemoteState()
    if (!state.settings.allowLegacyToken) {
      throw new Error('请先开启“兼容旧版手动 Token”')
    }
    const token = loadIdentity().accessToken
    await clipboard.writeText(token)
    return { success: true }
  })
  ipcMain.handle(IPC.REMOTE_ROTATE_TOKEN, async () => {
    await rotateAccessToken()
    sendRemoteState()
    return getRemoteState()
  })
  ipcMain.handle(IPC.REMOTE_CREATE_PAIRING_CODE, async () => {
    await refreshIdentity()
    const state = getRemoteState()
    if (!state.running) {
      throw new Error('请先开启手机访问')
    }
    const pairing = createPairingCode({
      endpoint: state.endpoint,
      endpoints: state.endpoints
    })
    const qrDataUrl = await QRCode.toDataURL(pairing.pairingCode, {
      errorCorrectionLevel: 'Q',
      margin: 4,
      width: 360
    })
    return {
      ...pairing,
      qrDataUrl
    }
  })
  ipcMain.handle(IPC.REMOTE_COPY_PAIRING_CODE, async (_event, pairingCode) => {
    if (typeof pairingCode === 'string' && pairingCode.trim()) {
      await clipboard.writeText(pairingCode.trim())
      return { success: true }
    }
    return { success: false }
  })
  ipcMain.handle(IPC.REMOTE_REMOVE_PAIRED_DEVICE, async (_event, deviceId) => {
    const success = await revokePairedDevice(deviceId)
    sendRemoteState()
    return { success, state: getRemoteState() }
  })
  ipcMain.handle(IPC.REMOTE_APPROVE_PAIRING_REQUEST, async (_event, requestId) => {
    approvePairingRequest(requestId)
    sendRemoteState()
    return { success: true, state: getRemoteState() }
  })
  ipcMain.handle(IPC.REMOTE_REJECT_PAIRING_REQUEST, async (_event, requestId) => {
    rejectPairingRequest(requestId)
    sendRemoteState()
    return { success: true, state: getRemoteState() }
  })
}

module.exports = { registerRemoteIpc }
