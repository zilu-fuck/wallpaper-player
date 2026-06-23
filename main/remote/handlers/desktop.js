const { shell } = require('electron')
const { loadSettings, saveSettings, upsertPlaybackState } = require('../../settings')
const { getMainWindow } = require('../../window')
const { readBody, sendError, sendJson } = require('../http-utils')

function createDesktopHandlers({ resolveVideoPath }) {
  async function handlePlayOnDesktop(req, res, videoId) {
    const videoPath = await resolveVideoPath(videoId)
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
    win.webContents.send('remote-play-on-desktop', {
      filePath: videoPath,
      position
    })
    sendJson(req, res, 200, { success: true })
  }

  async function handleRevealOnDesktop(req, res, videoId) {
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
