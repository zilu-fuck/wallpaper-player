const { shell } = require('electron')
const { loadSettings, saveSettings, upsertPlaybackState } = require('../../settings')
const { getMainWindow } = require('../../window')
const { readBody, sendError, sendJson } = require('../http-utils')
const { getRemoteNetworkItemById } = require('./network-resources')

function createDesktopHandlers({ resolveVideoPath }) {
  async function handlePlayOnDesktop(req, res, videoId) {
    const networkItem = getRemoteNetworkItemById(videoId)
    const videoPath = networkItem ? networkItem.url : await resolveVideoPath(videoId)
    const body = await readBody(req)
    const position = Math.max(0, Number(body.position) || 0)
    const settings = loadSettings()
    const playbackStates = upsertPlaybackState(settings.playbackStates, videoPath, {
      position,
      updatedAt: Date.now()
    })
    saveSettings({ playbackStates })

    const win = getMainWindow()
    if (!win || win.isDestroyed()) {
      sendError(req, res, 503, 'desktop_window_unavailable', '电脑端窗口不可用')
      return
    }

    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.show()
    win.focus()
    if (networkItem) {
      win.webContents.send('remote-play-on-desktop', {
        networkResource: networkItem.desktopResource,
        position
      })
    } else {
      win.webContents.send('remote-play-on-desktop', {
        filePath: videoPath,
        position
      })
    }
    sendJson(req, res, 200, { success: true })
  }

  async function handleRevealOnDesktop(req, res, videoId) {
    if (getRemoteNetworkItemById(videoId)) {
      sendError(req, res, 422, 'network_resource_no_file', '网络资源没有本地文件位置')
      return
    }
    const videoPath = await resolveVideoPath(videoId)
    shell.showItemInFolder(videoPath)
    sendJson(req, res, 200, { success: true })
  }

  return {
    handlePlayOnDesktop,
    handleRevealOnDesktop
  }
}

module.exports = {
  createDesktopHandlers
}
