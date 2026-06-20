const { BrowserWindow, shell, session } = require('electron')
const path = require('path')
const fs = require('fs')

let mainWindow = null

function getMainWindow() {
  return mainWindow
}

function setMainWindow(win) {
  mainWindow = win
}

function setupCSP() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
          "script-src 'self'; " +
          "style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' file: data: blob:; " +
          "media-src 'self' file: data: blob:; " +
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
    title: '瑙嗛鐢诲粖',
    backgroundColor: '#0a0a0f',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
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

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

module.exports = {
  getMainWindow,
  setMainWindow,
  setupCSP,
  createWindow
}
