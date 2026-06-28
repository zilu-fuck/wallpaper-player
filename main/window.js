const { BrowserWindow, shell, session, app } = require('electron')
const path = require('path')
const fs = require('fs')

let mainWindow = null
let windowCloseHandler = null
const WEBVIEW_PARTITION = 'persist:wallpaper-player-web'

function getMainWindow() {
  return mainWindow
}

function setMainWindow(win) {
  mainWindow = win
}

function setWindowCloseHandler(handler) {
  windowCloseHandler = typeof handler === 'function' ? handler : null
}

function setupCSP() {
  const webviewSession = session.fromPartition(WEBVIEW_PARTITION)
  webviewSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  webviewSession.setPermissionCheckHandler(() => false)

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
          "script-src 'self'; " +
          "style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' file: data: blob:; " +
          "media-src 'self' file: http: https: data: blob:; " +
          "font-src 'self' file: data:; " +
          "connect-src 'self' ws: wss:;"
        ]
      }
    })
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: '视频画廊',
    backgroundColor: '#0a0a0f',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: true
    }
  })

  setMainWindow(mainWindow)
  mainWindow.setAutoHideMenuBar(true)
  mainWindow.setMenuBarVisibility(false)
  mainWindow.setMenu(null)

  function isAppNavigationUrl(url) {
    return (
      url.startsWith('file://') ||
      url.startsWith('http://localhost:5173') ||
      url.startsWith('http://127.0.0.1:5173')
    )
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    let parsed
    try {
      parsed = new URL(params.src || '')
    } catch {
      event.preventDefault()
      return
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      event.preventDefault()
      return
    }
    if (params.partition && params.partition !== WEBVIEW_PARTITION) {
      event.preventDefault()
      return
    }

    delete webPreferences.preload
    webPreferences.partition = WEBVIEW_PARTITION
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.webSecurity = true
    webPreferences.allowRunningInsecureContent = false
  })

  mainWindow.webContents.on('did-attach-webview', (_event, webContents) => {
    webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http://') || url.startsWith('https://')) {
        shell.openExternal(url)
      }
      return { action: 'deny' }
    })
    webContents.on('will-navigate', (event, url) => {
      if (url.startsWith('http://') || url.startsWith('https://')) return
      event.preventDefault()
    })
  })

  // 仅在开发模式转发渲染进程日志到主进程 stdout，避免打包后刷屏
  if (!app.isPackaged) {
    mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
      const labels = ['debug', 'log', 'warn', 'error']
      console.log(`[renderer:${labels[level] || level}] ${message} (${sourceId}:${line})`)
    })
  }

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('[renderer] render-process-gone:', details)
  })

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[window] did-finish-load:', mainWindow.webContents.getURL())
  })

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error('[window] did-fail-load:', errorCode, errorDescription, validatedURL)
  })

  mainWindow.webContents.on('preload-error', (event, preloadPath, error) => {
    console.error('[window] preload-error:', preloadPath, error)
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const currentUrl = mainWindow.webContents.getURL()
    if (url === currentUrl || (!currentUrl && isAppNavigationUrl(url))) return

    event.preventDefault()
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
    }
  })

  const distPath = path.join(__dirname, '..', 'dist', 'index.html')
  if (fs.existsSync(distPath)) {
    mainWindow.loadFile(distPath)
  } else {
    mainWindow.loadURL('http://localhost:5173')
  }

  mainWindow.on('close', (event) => {
    windowCloseHandler?.(event, mainWindow)
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  return mainWindow
}

module.exports = {
  getMainWindow,
  setMainWindow,
  setWindowCloseHandler,
  setupCSP,
  createWindow
}
