const { BrowserWindow, shell, session, app, screen } = require('electron')
const path = require('path')
const fs = require('fs')
const log = require('electron-log')
const { pathToFileURL } = require('url')
const { bindAppWindow, guardAppNavigation } = require('./security/ipc-sender')
const { watchWindowState } = require('./ipc/window-shell')

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
  const { width: workWidth, height: workHeight } = screen.getPrimaryDisplay().workAreaSize
  mainWindow = new BrowserWindow({
    width: Math.min(1440, workWidth),
    height: Math.min(900, workHeight),
    minWidth: Math.min(900, workWidth),
    minHeight: Math.min(600, workHeight),
    title: '视频画廊',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    backgroundColor: '#070a11',
    autoHideMenuBar: true,
    // 自绘标题栏：去掉系统原生标题栏，窗口按钮由渲染层绘制，
    // 这样标题栏也能跟随主题与设计系统。窗口拖拽依靠渲染层的
    // -webkit-app-region: drag 区域。
    frame: false,
    // thickFrame 保留 Windows 的边缘拖拽缩放与窗口阴影
    thickFrame: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: true
    }
  })

  setMainWindow(mainWindow)
  const distPath = path.join(__dirname, '..', 'dist', 'index.html')
  const useFile = app.isPackaged || fs.existsSync(distPath)
  const entryUrl = useFile ? pathToFileURL(distPath).href : 'http://localhost:5173/'
  bindAppWindow(mainWindow, entryUrl)
  guardAppNavigation(mainWindow.webContents, entryUrl, url => { void shell.openExternal(url).catch(() => {}) })
  mainWindow.setAutoHideMenuBar(true)
  mainWindow.setMenuBarVisibility(false)
  mainWindow.setMenu(null)
  const stopWatchingWindowState = watchWindowState(mainWindow)
  mainWindow.once('closed', () => stopWatchingWindowState())

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
    mainWindow.webContents.on('console-message', details => {
      const methods = { debug: 'debug', info: 'info', warning: 'warn', error: 'error' }
      log[methods[details.level] || 'info'](`[renderer:${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`)
    })
  }

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    log.error('[renderer] render-process-gone:', details)
  })

  mainWindow.webContents.on('did-finish-load', () => {
    log.info('[window] did-finish-load:', mainWindow.webContents.getURL())
  })

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    log.error('[window] did-fail-load:', errorCode, errorDescription, validatedURL)
  })

  mainWindow.webContents.on('preload-error', (event, preloadPath, error) => {
    log.error('[window] preload-error:', preloadPath, error)
  })

  if (useFile) {
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
