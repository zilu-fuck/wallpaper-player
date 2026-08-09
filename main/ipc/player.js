const { dialog, ipcMain } = require('electron')
const { execFileSync } = require('child_process')
const path = require('path')
const { IPC, EVENT } = require('../ipc-channels')
const { isMpvExecutablePath, pathKey } = require('../paths')
const {
  addSessionAllowedFile,
  getPlaybackState,
  loadSettings,
  sessionAllowedMpvPaths
} = require('../settings')
const { assertAllowedVideoPath } = require('../scanner')
const { mpvManager, resolveMpvPath } = require('../mpv-integration')
const { setMediaPlaybackActive } = require('../thumbnail')
const { getMainWindow } = require('../window')
const {
  resolveKnownNetworkResourcePlayback,
  resolveNetworkResourcePlayback
} = require('./network-resource-service')

const MPV_COMMANDS = new Set([
  'seekTo',
  'seekRelative',
  'cyclePause',
  'setPaused',
  'setVolume',
  'setMuted',
  'toggleMute',
  'setSpeed',
  'cycleSpeed',
  'setAudioTrack',
  'cycleAudioTrack',
  'setSubtitleTrack',
  'cycleSubtitleTrack',
  'setSubtitleVisible',
  'toggleSubtitleVisible',
  'setSubtitleScale',
  'setLoopMode',
  'setABLoop',
  'clearABLoop',
  'screenshot'
])

function registerPlayerIpc() {
  ipcMain.handle(IPC.MPV_PLAY_URL, async (_event, url, options = {}) => {
    try {
      const settings = loadSettings()
      const resource = options?.temporary === true
        ? await resolveNetworkResourcePlayback({ url, title: options?.title, kind: options?.kind }, { refresh: true })
        : await resolveKnownNetworkResourcePlayback({ url, title: options?.title }, { settings })

      const mpvPath = await resolveMpvPath()
      if (!mpvPath) {
        return { success: false, error: 'mpv 未安装' }
      }

      const playOptions = options && typeof options === 'object' ? options : {}
      const resume = playOptions.resume === false
        ? false
        : getPlaybackState(settings.playbackStates, resource.url)
      setMediaPlaybackActive(true)
      await mpvManager.play(resource.playbackUrl || resource.url, {
        hostBounds: playOptions.hostBounds,
        playlist: [resource.playbackUrl || resource.url],
        playlistIndex: 0,
        resume,
        httpHeaders: resource.httpHeaders
      })
      return { success: true }
    } catch (err) {
      setMediaPlaybackActive(false)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.CHECK_MPV, async () => {
    const mpvPath = await resolveMpvPath()
    if (mpvPath) {
      try {
        const stdout = execFileSync(mpvPath, ['--version'], { timeout: 5000, encoding: 'utf-8', stdio: 'pipe' })
        const versionLine = stdout.split(/\r?\n/).find(line => line.trim()) || 'unknown'
        return { available: true, path: mpvPath, version: versionLine }
      } catch {
        return { available: false, path: mpvPath, version: 'unknown' }
      }
    }
    return { available: false, path: null }
  })

  ipcMain.handle(IPC.DOWNLOAD_MPV, async () => {
    try {
      const mpvPath = await mpvManager.download((progress) => {
        const win = getMainWindow()
        if (win && !win.isDestroyed()) {
          win.webContents.send(EVENT.MPV_DOWNLOAD_PROGRESS, progress)
        }
      })
      return { success: true, path: mpvPath }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.MPV_PLAY, async (_event, filePath, options = {}) => {
    try {
      const resolvedPath = await assertAllowedVideoPath(filePath)
      addSessionAllowedFile(resolvedPath)
      const mpvPath = await resolveMpvPath()
      if (!mpvPath) {
        return { success: false, error: 'mpv 未安装' }
      }

      const settings = loadSettings()
      const playOptions = options && typeof options === 'object' ? options : {}
      const playlist = []
      if (Array.isArray(playOptions.playlist)) {
        for (const item of playOptions.playlist) {
          try {
            playlist.push(await assertAllowedVideoPath(item))
          } catch {}
        }
      }
      const playlistIndex = Number.isInteger(Number(playOptions.playlistIndex))
        ? Number(playOptions.playlistIndex)
        : undefined
      const resume = playOptions.resume === false
        ? false
        : getPlaybackState(settings.playbackStates, resolvedPath)
      setMediaPlaybackActive(true)
      await mpvManager.play(resolvedPath, {
        hostBounds: playOptions.hostBounds,
        playlist,
        playlistIndex,
        resume
      })
      return { success: true }
    } catch (err) {
      setMediaPlaybackActive(false)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.MPV_SET_HOST_BOUNDS, async (_event, bounds) => {
    try {
      return mpvManager.setHostBounds(bounds)
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.MPV_STOP, async () => {
    mpvManager.stop()
    setMediaPlaybackActive(false)
    return { success: true }
  })

  ipcMain.handle(IPC.MPV_GET_STATE, async () => {
    return mpvManager.getState()
  })

  ipcMain.handle(IPC.MPV_COMMAND, async (_event, method, ...args) => {
    if (!MPV_COMMANDS.has(method)) {
      throw new Error(`Unsupported mpv command: ${method}`)
    }
    const fn = mpvManager[method]
    if (typeof fn !== 'function') {
      throw new Error(`Unsupported mpv command: ${method}`)
    }
    return fn.apply(mpvManager, args)
  })

  ipcMain.handle(IPC.SELECT_MPV_PATH, async () => {
    const win = getMainWindow()
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      title: '选择 mpv.exe',
      filters: [{ name: '可执行文件', extensions: ['exe'] }, { name: '所有文件', extensions: ['*'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const selectedPath = path.resolve(result.filePaths[0])
    if (!isMpvExecutablePath(selectedPath)) return null
    sessionAllowedMpvPaths.add(pathKey(selectedPath))
    return selectedPath
  })
}

module.exports = { registerPlayerIpc }
