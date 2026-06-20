const { BaseWindow, BrowserWindow } = require('electron')
const { getMainWindow } = require('./window')

let hostWindow = null
let pendingBounds = null
let mainWindow = null
let detachMainWindowListeners = null

function clearMainWindowListeners() {
  if (typeof detachMainWindowListeners === 'function') {
    try {
      detachMainWindowListeners()
    } catch {}
  }
  detachMainWindowListeners = null
}

function setMpvHostMainWindow(win) {
  clearMainWindowListeners()
  mainWindow = win || getMainWindow() || null

  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = null
    return
  }

  const sync = () => syncMpvHostWindowBounds()
  const hide = () => hideMpvHostWindow()
  const destroy = () => destroyMpvHostWindow()

  mainWindow.on('move', sync)
  mainWindow.on('resize', sync)
  mainWindow.on('show', sync)
  mainWindow.on('restore', sync)
  mainWindow.on('maximize', sync)
  mainWindow.on('unmaximize', sync)
  mainWindow.on('enter-full-screen', sync)
  mainWindow.on('leave-full-screen', sync)
  mainWindow.on('hide', hide)
  mainWindow.once('closed', destroy)

  detachMainWindowListeners = () => {
    if (!mainWindow) return
    mainWindow.removeListener('move', sync)
    mainWindow.removeListener('resize', sync)
    mainWindow.removeListener('show', sync)
    mainWindow.removeListener('restore', sync)
    mainWindow.removeListener('maximize', sync)
    mainWindow.removeListener('unmaximize', sync)
    mainWindow.removeListener('enter-full-screen', sync)
    mainWindow.removeListener('leave-full-screen', sync)
    mainWindow.removeListener('hide', hide)
    mainWindow.removeListener('closed', destroy)
  }
}

function normalizeBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') return null

  const x = Number(bounds.x)
  const y = Number(bounds.y)
  const width = Number(bounds.width)
  const height = Number(bounds.height)

  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return null
  }

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height))
  }
}

function handleToWid(handle) {
  if (!handle || typeof handle.readUInt32LE !== 'function' || handle.length < 4) return null
  try {
    if (process.platform === 'win32') {
      return String(handle.readUInt32LE(0))
    }
    if (typeof handle.readBigUInt64LE === 'function' && handle.length >= 8) {
      return handle.readBigUInt64LE(0).toString()
    }
    return String(handle.readUInt32LE(0))
  } catch {
    return null
  }
}

function getAbsoluteBounds() {
  const win = mainWindow || getMainWindow()
  if (!win || win.isDestroyed() || !pendingBounds) return null

  const contentBounds = win.getContentBounds()
  return {
    x: Math.round(contentBounds.x + pendingBounds.x),
    y: Math.round(contentBounds.y + pendingBounds.y),
    width: Math.max(1, Math.round(pendingBounds.width)),
    height: Math.max(1, Math.round(pendingBounds.height))
  }
}

function ensureMpvHostWindow() {
  if (hostWindow && !hostWindow.isDestroyed()) return hostWindow

  const currentMainWindow = mainWindow || getMainWindow()
  if (!currentMainWindow || currentMainWindow.isDestroyed()) return null

  const bounds = getAbsoluteBounds() || { x: 0, y: 0, width: 1, height: 1 }

  const HostWindow = BaseWindow || BrowserWindow
  hostWindow = new HostWindow({
    parent: currentMainWindow,
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    hasShadow: false,
    ...(HostWindow === BrowserWindow
      ? {
          webPreferences: {
            backgroundThrottling: false,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
          }
        }
      : {})
  })

  hostWindow.setIgnoreMouseEvents(true, { forward: true })
  hostWindow.on('closed', () => {
    hostWindow = null
  })

  return hostWindow
}

function syncMpvHostWindowBounds() {
  const win = hostWindow
  if (!win || win.isDestroyed()) return false

  const bounds = getAbsoluteBounds()
  if (!bounds) return false

  win.setBounds(bounds, false)
  return true
}

function setMpvHostBounds(bounds) {
  if (bounds == null) {
    return hideMpvHostWindow(true)
  }

  const nextBounds = normalizeBounds(bounds)
  if (!nextBounds) return false

  pendingBounds = nextBounds
  const win = ensureMpvHostWindow()
  if (!win) return false

  syncMpvHostWindowBounds()
  return true
}

function showMpvHostWindow() {
  const win = ensureMpvHostWindow()
  if (!win) return false

  if (!syncMpvHostWindowBounds()) return false
  if (!win.isVisible()) {
    win.show()
  } else if (typeof win.focus === 'function') {
    win.focus()
  }
  return true
}

function hideMpvHostWindow(clearBounds = false) {
  if (clearBounds) pendingBounds = null
  if (!hostWindow || hostWindow.isDestroyed()) return false
  hostWindow.hide()
  return true
}

function destroyMpvHostWindow() {
  pendingBounds = null
  clearMainWindowListeners()

  if (!hostWindow || hostWindow.isDestroyed()) {
    hostWindow = null
    mainWindow = null
    return false
  }

  hostWindow.destroy()
  hostWindow = null
  mainWindow = null
  return true
}

function getMpvHostHandle() {
  const win = ensureMpvHostWindow()
  if (!win) return null
  return handleToWid(win.getNativeWindowHandle())
}

module.exports = {
  destroyMpvHostWindow,
  getMpvHostHandle,
  hideMpvHostWindow,
  setMpvHostMainWindow,
  setMpvHostBounds,
  showMpvHostWindow,
  syncMpvHostWindowBounds
}
