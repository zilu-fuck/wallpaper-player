const { Tray, Menu, nativeImage, app } = require('electron')
const log = require('electron-log')
const { EVENT } = require('../ipc-channels')
const { loadSettings, saveSettingsAndFlush, sanitizeSettingsForSave } = require('../settings')
const { createWindow, getMainWindow } = require('../window')
const {
  approvePairingRequest,
  createPairingCode,
  getIdentityCorruptedAt,
  listPairedDevices,
  listPendingPairingRequests,
  loadIdentity,
  rejectPairingRequest,
  revokePairedDevice,
  rotateAccessToken
} = require('./identity')
const { createRemoteServer } = require('./server')
const { getLanAddresses, getPrimaryEndpoint } = require('./network')

const DEFAULT_REMOTE_SETTINGS = {
  enabled: false,
  port: 38127,
  keepRunningInTray: true,
  allowLegacyToken: false
}

let server = null
let serverState = {
  running: false,
  error: '',
  port: DEFAULT_REMOTE_SETTINGS.port,
  endpoints: [],
  accessToken: ''
}
let tray = null
let isQuitting = false

function normalizeRemoteSettings(settings) {
  const source = settings?.remoteAccess && typeof settings.remoteAccess === 'object'
    ? settings.remoteAccess
    : settings
  const remote = source && typeof source === 'object'
    ? source
    : {}
  const port = Number(remote.port)
  return {
    enabled: Boolean(remote.enabled),
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_REMOTE_SETTINGS.port,
    keepRunningInTray: remote.keepRunningInTray == null
      ? DEFAULT_REMOTE_SETTINGS.keepRunningInTray
      : Boolean(remote.keepRunningInTray),
    allowLegacyToken: remote.allowLegacyToken == null
      ? DEFAULT_REMOTE_SETTINGS.allowLegacyToken
      : Boolean(remote.allowLegacyToken)
  }
}

function getRemoteSettings() {
  return normalizeRemoteSettings(loadSettings())
}

function getRemoteState() {
  const settings = getRemoteSettings()
  const identity = loadIdentity()
  return {
    settings,
    running: serverState.running,
    error: serverState.error,
    port: settings.port,
    endpoint: getPrimaryEndpoint(settings.port),
    endpoints: getLanAddresses(settings.port),
    accessToken: identity.accessToken,
    identityCorruptedAt: getIdentityCorruptedAt(),
    pairedDevices: listPairedDevices(),
    pendingPairingRequests: listPendingPairingRequests()
  }
}

function sendRemoteState() {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send(EVENT.REMOTE_ACCESS_STATE, getRemoteState())
  }
}

function createTrayImage() {
  const image = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAUYSURBVFhH1Zd/TNRlHMefaZORv4YHizsUEfWUI5A7OH7fCcexWhFXnuEEYZY5TU0cibYUxRRSK2eYE7s7JOIQcqCh9JUIpgzNKGCkoSGEkBJz3ZxzuqDcu31OjnFfDr4Xkz96b8+/39f7+zzP5/N5P4z9D+TBGPNjjIWNYwUwxjz5H3RGzzLGXmSMbXSRyHJmKhLNIlUaJ1KnciJ1CidSJ3OimGROFLuSc7euFZy7Jolz1yx/srR665oVEWeeOn/xAcbYZsaY3lkzfpNcpm4Sqd6qkbyeOzAn7VP4bi6BdMd5SHd+A2nWOSzadRaLss9g8Z7T8NtTDr+9pyDbVwZZTilkuSWQ7S+G//4iLN51BAu2ZMNnbQYk+lVNU9zddzLGIhljk/lQmwJc5wQdEOuy+3w2lCDwaC+CjBbITXchL+iDvLAXii9uQ/FlN4KLuxBi7kTIyXYoS29A+VUbQk9dQ2h5K8IqWhB+ugnhXzciovIKwisb8PyBzzB3zdv3ZwYsyWOMxfLBpBmTpkzd4vnaBxZpVgOCDPeeCjzi3GVEVjUgkqtH8IkS+Kzb8GhwJ2bzDejcNRsafNPLJwQedf4CoqrrsCTvCGYnJ7cxxlYPh0+mv6czf1rb7gge/W0Noqo5LNyWAVcvcTbtus2AJ52995v5EwqPrqlGdC0H/5zdmBUWYmCMSW0GgtwiVlTMzyh3Cp5YdXPccFVdFeTHD0GcEM8N9gqrwqjOqdSE4PTnhl/u4qrlIZJqrv9nuOpCJeTHDkKcoOUZUKdyVOdCcPpzQ1sfSP3/PIbxxh0sPdfoNFx98Qzk+fshThxhIIWjJiMEp203XP/DasCmWw8eYe2lVqfgS+srIP88F+JEDd9AMkcdTghOZ2683mtnwKbTPXfwQm39mPClDaegMORArOMbiEnmqL0KwenMadtHk6W/H+82N40Kj7lUBoVxLyS6WJ6B2JUc9XYhOF0446+3+dwRumK5C93l6hHwmO9PIti0BxJdjL0Bmmo0WITgdNuN7b/zeQ714O8BrGmqtYPHXjEjuGA3JK+q+QZWcDTVhOB0203tPXzWCFn6/0Lm1Usj4LGNRQg5keXAgCaJo5EqBKdSM93s5vPsVNzTjpcvn3UI1/xYCGXhTkiWqfgGlnM0z4XgVGqmjlt8plXdDx9gfcvFEWc+HB73UwGURe+PYiC3RBBOdW7q6LID9z9+jPzf2hxeOD48rtkAZdF7kOijeAa0eo6SjBCcmkxBZ+cQvPnen0hprHMarm05DmXxNscGKEYJwanJFHR2WG94blurwzofC65tPQalORNe+kg7AyEecYmVsn0GQTh1uHeaf4Cu4btxwbU/H0VY6VZ46SPsDMyd7q/IW5iZKwgfq8M5A4+/mofggo14Lj7QPBjbrXJ5ZtqM7fPWbZ1wePy1wwj8aBWmy7wortObY0irvVa+cTPwsHFC4aqaLCzIeMlCbw5+PJe6evvm+KxPHwgtOzMhcG3LQfjvXQ630HkUzUOGw22Kd4uILpy3KX1AYTQ9VTj9OcElOnkFYyyJD7bJheK5q7d3jndaateiHdsRcOhDBB372BqjKMlQmKB5TiOVphoNFurt1F6pw1GToTqnUqPbrixOR+AnaZBmJtwf/HOCD6Xh0USP0XXT/P0OeWhUZRQgKcNRjKIkQ2GC5jmNVBoq1rVM9WTpo6yL6pxKTfJKcIVbqC+B6cwdbvtYosdk0GC9jncRlF5BDt+D/wIt4xon09eGdAAAAABJRU5ErkJggg=='
  )
  return image.resize({ width: 16, height: 16 })
}

function ensureTray() {
  if (tray) return tray
  tray = new Tray(createTrayImage())
  tray.setToolTip('Wallpaper Player')
  tray.on('click', () => {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.show()
      win.focus()
    } else {
      createWindow()
    }
  })
  updateTrayMenu()
  return tray
}

function updateTrayMenu() {
  if (!tray) return
  const state = getRemoteState()
  const menu = Menu.buildFromTemplate([
    {
      label: '打开主界面',
      click: () => {
        const win = getMainWindow()
        if (win && !win.isDestroyed()) {
          win.show()
          win.focus()
        } else {
          createWindow()
        }
      }
    },
    {
      label: `手机访问：${state.running ? '运行中' : '已停止'}`,
      enabled: false
    },
    {
      label: '复制访问地址',
      enabled: Boolean(state.endpoint),
      click: () => clipboard.writeText(state.endpoint)
    },
    {
      label: state.running ? '暂停手机访问' : '启动手机访问',
      click: async () => {
        const settings = loadSettings()
        const remoteAccess = normalizeRemoteSettings(settings)
        const next = { ...remoteAccess, enabled: !state.running }
        await saveSettingsAndFlush(sanitizeSettingsForSave({ remoteAccess: next }))
        if (next.enabled) {
          await startRemoteAccess()
        } else {
          await stopRemoteAccess()
        }
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true
        app.quit()
      }
    }
  ])
  tray.setContextMenu(menu)
}

async function startRemoteAccess(options = {}) {
  const settings = getRemoteSettings()
  if (serverState.running && server && !options.forceRestart) return getRemoteState()

  await stopRemoteAccess()
  const nextServer = createRemoteServer({
    port: settings.port,
    onPairingRequest: sendRemoteState
  })

  await new Promise((resolve, reject) => {
    nextServer.once('error', reject)
    nextServer.listen(settings.port, '0.0.0.0', () => {
      nextServer.off('error', reject)
      resolve()
    })
  })

  server = nextServer
  serverState = {
    running: true,
    error: '',
    port: settings.port,
    endpoints: getLanAddresses(settings.port),
    accessToken: loadIdentity().accessToken
  }
  ensureTray()
  updateTrayMenu()
  sendRemoteState()
  log.info('[remote] started:', getPrimaryEndpoint(settings.port))
  return getRemoteState()
}

async function stopRemoteAccess() {
  if (!server) {
    serverState = { ...serverState, running: false, error: '' }
    updateTrayMenu()
    sendRemoteState()
    return getRemoteState()
  }

  const currentServer = server
  server = null
  await new Promise((resolve) => currentServer.close(resolve))
  serverState = { ...serverState, running: false, error: '' }
  updateTrayMenu()
  sendRemoteState()
  log.info('[remote] stopped')
  return getRemoteState()
}

async function applyRemoteSettings(nextRemoteSettings) {
  const currentSettings = loadSettings()
  const currentRemoteAccess = normalizeRemoteSettings(currentSettings)
  const remoteAccess = normalizeRemoteSettings(nextRemoteSettings)
  await saveSettingsAndFlush(sanitizeSettingsForSave({ remoteAccess }))

  try {
    if (remoteAccess.enabled) {
      await startRemoteAccess({
        forceRestart: serverState.running && currentRemoteAccess.port !== remoteAccess.port
      })
    } else {
      await stopRemoteAccess()
    }
  } catch (err) {
    serverState = {
      running: false,
      error: err.message,
      port: remoteAccess.port,
      endpoints: [],
      accessToken: loadIdentity().accessToken
    }
    await saveSettingsAndFlush(sanitizeSettingsForSave({
      ...currentSettings,
      remoteAccess: { ...remoteAccess, enabled: false }
    }))
    updateTrayMenu()
    sendRemoteState()
  }

  return getRemoteState()
}

async function initRemoteAccess() {
  loadIdentity()
  const settings = getRemoteSettings()
  if (settings.enabled) {
    try {
      await startRemoteAccess()
    } catch (err) {
      serverState = { ...serverState, running: false, error: err.message }
      log.error('[remote] start failed:', err)
    }
  }
  if (settings.enabled && settings.keepRunningInTray) ensureTray()
  sendRemoteState()
}

function shouldKeepRunningInTray() {
  const settings = getRemoteSettings()
  return settings.enabled && settings.keepRunningInTray && !isQuitting
}

function setupRemoteIPC() {
  // 远程访问 IPC 已迁移至 main/ipc/remote.js，由 main/ipc.js 统一注册。
  // 保留此占位导出是为了避免破坏外部引用；下一版本可删除。
}

async function disposeRemoteAccess() {
  isQuitting = true
  const currentServer = server
  server = null
  serverState = { ...serverState, running: false, error: '' }
  if (currentServer) {
    await new Promise((resolve) => currentServer.close(resolve))
  }
  if (tray) {
    tray.destroy()
    tray = null
  }
}

function markQuitting() {
  isQuitting = true
}

module.exports = {
  DEFAULT_REMOTE_SETTINGS,
  normalizeRemoteSettings,
  applyRemoteSettings,
  sendRemoteState,
  setupRemoteIPC,
  initRemoteAccess,
  startRemoteAccess,
  stopRemoteAccess,
  disposeRemoteAccess,
  shouldKeepRunningInTray,
  markQuitting,
  getRemoteState
}
