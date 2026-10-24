const fs = require('fs')
const path = require('path')
const log = require('electron-log')
const MpvManager = require('./mpv')
const { EVENT } = require('./ipc-channels')
const { isMpvExecutablePath, isExistingFile } = require('./paths')
const { loadSettingsFields } = require('./settings')
const { savePlaybackRecord } = require('./application/media-mutations')
const { getMainWindow } = require('./window')
const { setMediaPlaybackActive } = require('./thumbnail')

const mpvManager = new MpvManager()
const PLAYBACK_SAVE_DELAY_MS = 1000

let playbackSaveTimer = null
let pendingPlaybackSnapshot = null

function snapshotPlaybackState(state) {
  if (!state || !state.filePath) return null

  return {
    filePath: state.filePath,
    position: state.eofReached ? 0 : Math.max(0, Number(state.timePos) || 0),
    volume: Math.max(0, Math.min(100, state.volume != null && Number.isFinite(Number(state.volume)) ? Number(state.volume) : 100)),
    speed: Math.max(0.1, Number(state.speed) || 1),
    muted: Boolean(state.muted),
    audioId: state.audioId == null ? null : Number(state.audioId),
    subtitleId: state.subtitleId == null ? null : Number(state.subtitleId),
    subtitleVisible: state.subtitleVisible == null ? true : Boolean(state.subtitleVisible),
    subtitleScale: Math.max(0.1, Number(state.subtitleScale) || 1),
    loopMode: state.abLoopA != null && state.abLoopB != null
      ? 'a-b'
      : (state.loopFile === 'inf' ? 'inf' : 'off'),
    abLoopA: state.abLoopA == null ? null : Number(state.abLoopA),
    abLoopB: state.abLoopB == null ? null : Number(state.abLoopB)
  }
}

async function flushPlaybackState(snapshot = pendingPlaybackSnapshot) {
  if (!snapshot) return

  await savePlaybackRecord(snapshot.filePath, snapshot)
  if (pendingPlaybackSnapshot === snapshot) {
    pendingPlaybackSnapshot = null
  }
}

function persistPlaybackState(state, immediate = false) {
  const snapshot = snapshotPlaybackState(state)
  if (!snapshot) return

  pendingPlaybackSnapshot = snapshot

  if (immediate) {
    if (playbackSaveTimer) {
      clearTimeout(playbackSaveTimer)
      playbackSaveTimer = null
    }
    flushPlaybackState(snapshot).catch(error => log.error('[playback] save failed:', error))
    return
  }

  if (playbackSaveTimer) return
  playbackSaveTimer = setTimeout(() => {
    playbackSaveTimer = null
    flushPlaybackState().catch(error => log.error('[playback] save failed:', error))
  }, PLAYBACK_SAVE_DELAY_MS)
}

async function resolveMpvPath(options = {}) {
  const check = () => { if (options.signal?.aborted) throw options.signal.reason }
  check()
  const settings = loadSettingsFields(['mpvPath'])
  if (settings.mpvPath) {
    const customPath = path.resolve(settings.mpvPath)
    const exists = isMpvExecutablePath(customPath) && await fs.promises.stat(customPath).then(stat => stat.isFile(), () => false)
    check()
    if (exists) {
      const canonical = await fs.promises.realpath(customPath); check()
      return mpvManager.setMpvPath(canonical, options)
    }
    await mpvManager.setMpvPath(null, options)
  }

  const current = mpvManager.getMpvPath()
  if (current) {
    const exists = current === 'mpv' || current === 'mpv.exe' || await fs.promises.stat(current).then(stat => stat.isFile(), () => false)
    check()
    if (isMpvExecutablePath(current) && exists) {
      return current
    }
    await mpvManager.setMpvPath(null, options)
  }

  return mpvManager.findMpv(null, options)
}

async function initMpv() {
  const found = await resolveMpvPath()

  if (found) {
    log.info('[mpv] 已找到:', found)
  } else {
    log.info('[mpv] 未找到，首次使用时将自动下载')
  }

  mpvManager.on('state', (data) => {
    persistPlaybackState(data, Boolean(data?.paused) || Boolean(data?.eofReached))
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(EVENT.MPV_STATE, data)
    }
  })

  mpvManager.on('ended', (data) => {
    setMediaPlaybackActive(false)
    persistPlaybackState(mpvManager.getState(), true)
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(EVENT.MPV_ENDED, data)
    }
  })

  mpvManager.on('error', (data) => {
    setMediaPlaybackActive(false)
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(EVENT.MPV_ERROR, data)
    }
  })
}

async function destroyMpv() {
  if (playbackSaveTimer) {
    clearTimeout(playbackSaveTimer)
    playbackSaveTimer = null
  }
  try {
    await flushPlaybackState()
  } finally {
    setMediaPlaybackActive(false)
    await mpvManager.destroy()
  }
}

module.exports = {
  mpvManager,
  resolveMpvPath,
  initMpv,
  destroyMpv
}
