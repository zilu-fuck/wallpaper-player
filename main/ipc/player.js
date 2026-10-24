const { dialog } = require('electron')
const { ipcMain: appIpcMain } = require('../security/ipc')
const { execFileTreeAsync } = require('../exec')
const { mediaScheduler } = require('../application/resource-scheduler')
const { mediaWorkService } = require('../application/media-work-service')
const path = require('path')
const { IPC, EVENT } = require('../ipc-channels')
const { isMpvExecutablePath, pathKey } = require('../paths')
const {
  sessionAllowedFiles,
  getPlaybackStateKey,
  readPlaybackState,
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

const { createPlayerService } = require('../application/player-service')
const playerService = createPlayerService({
  manager: mpvManager, getMainWindow, resolveMpvPath, readPlaybackState, setMediaPlaybackActive,
  async resolveLocal(target, senderId, context) {
    const resolved = await assertAllowedVideoPath(target, { ...context, audience: 'desktop', senderId })
    sessionAllowedFiles.add(getPlaybackStateKey(resolved)); return resolved
  },
  resolveNetwork: (request, context) => request.temporary
    ? resolveNetworkResourcePlayback({ url: request.target, title: request.title, kind: request.kind }, { ...context, refresh: true })
    : resolveKnownNetworkResourcePlayback({ url: request.target, title: request.title }, context)
})
function playerFailure(error) { return { success: false, code: error.code || 'player_failed',
  error: error.code === 'stale_session' ? '播放会话已替换' : error.code === 'player_stop_timeout'
    ? '无法确认旧播放器已退出，请稍后重试' : error.message || '播放失败', retryable: false } }

function registerPlayerIpc(ipcMain = appIpcMain) {
  ipcMain.handle(IPC.PLAYER_ACTION, async (event, request) => {
    try { return await playerService.action(event, request) } catch (error) { return playerFailure(error) }
  })
  ipcMain.handle(IPC.MPV_PLAY_URL, async (event, url, options = {}) => {
    try { return await playerService.legacyLoad(event, url, options, 'network') } catch (error) { return playerFailure(error) }
  })

  ipcMain.handle(IPC.CHECK_MPV, async event => {
    try {
      return await mediaWorkService.run(event, undefined, signal => mediaScheduler.enqueue({
        type: 'mpv-status', resources: { prepare: 1 }, priority: 60, signal, timeoutMs: 15000 }, async context => {
        const mpvPath = await resolveMpvPath(context); context.throwIfAborted()
        if (!mpvPath) return { available: false, path: null }
        const { stdout } = await execFileTreeAsync(mpvPath, ['--version'], { timeout: 5000, signal: context.signal, maxBuffer: 128 * 1024 })
        context.throwIfAborted()
        return { available: true, path: mpvPath, version: stdout.split(/\r?\n/).find(line => line.trim()) || 'unknown' }
      }))
    } catch { return { available: false, path: null, version: 'unknown' } }
  })

  ipcMain.handle(IPC.DOWNLOAD_MPV, async (event, requestId) => {
    try {
      const mpvPath = await mediaWorkService.run(event, requestId, signal => mpvManager.download(progress => {
        if (!event.sender.isDestroyed()) event.sender.send(EVENT.MPV_DOWNLOAD_PROGRESS, { ...progress, requestId })
      }, { signal }))
      return { success: true, path: mpvPath }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.MPV_PLAY, async (event, filePath, options = {}) => {
    try { return await playerService.legacyLoad(event, filePath, options, 'local') } catch (error) { return playerFailure(error) }
  })

  ipcMain.handle(IPC.MPV_SET_HOST_BOUNDS, async (_event, bounds) => {
    try {
      return mpvManager.setHostBounds(bounds)
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.MPV_STOP, async (event) => {
    try { return await playerService.legacyStop(event) } catch (error) { return playerFailure(error) }
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
