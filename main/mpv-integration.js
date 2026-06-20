const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const MpvManager = require('../mpv')
const { isMpvExecutablePath, isExistingFile } = require('./paths')
const { loadSettings, saveSettings, upsertPlaybackState } = require('./settings')
const { getMainWindow } = require('./window')

const mpvManager = new MpvManager()
const PLAYBACK_SAVE_DELAY_MS = 1000

let playbackSaveTimer = null
let pendingPlaybackSnapshot = null

function snapshotPlaybackState(state) {
  if (!state || !state.filePath) return null

  return {
    filePath: state.filePath,
    position: state.eofReached ? 0 : Math.max(0, Number(state.timePos) || 0),
    volume: Math.max(0, Math.min(100, Number(state.volume) || 100)),
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

function flushPlaybackState(snapshot = pendingPlaybackSnapshot) {
  if (!snapshot) return

  const settings = loadSettings()
  const playbackStates = upsertPlaybackState(settings.playbackStates, snapshot.filePath, snapshot)
  saveSettings({ playbackStates })
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
    flushPlaybackState(snapshot)
    return
  }

  if (playbackSaveTimer) return
  playbackSaveTimer = setTimeout(() => {
    playbackSaveTimer = null
    flushPlaybackState()
  }, PLAYBACK_SAVE_DELAY_MS)
}

async function resolveMpvPath() {
  const settings = loadSettings()
  if (settings.mpvPath) {
    const customPath = path.resolve(settings.mpvPath)
    if (isMpvExecutablePath(customPath) && fs.existsSync(customPath)) {
      mpvManager.setMpvPath(customPath)
      return customPath
    }
    mpvManager.setMpvPath(null)
  }

  const current = mpvManager.getMpvPath()
  if (current) {
    if (isMpvExecutablePath(current) && (current === 'mpv' || current === 'mpv.exe' || fs.existsSync(current))) {
      return current
    }
    mpvManager.setMpvPath(null)
  }

  return mpvManager.findMpv(null)
}

async function initMpv() {
  const found = await resolveMpvPath()

  if (found) {
    console.log('[mpv] 宸叉壘鍒?', found)
  } else {
    console.log('[mpv] 鏈壘鍒帮紝棣栨浣跨敤鏃跺皢鑷姩涓嬭浇')
  }

  mpvManager.on('state', (data) => {
    persistPlaybackState(data, Boolean(data?.paused) || Boolean(data?.eofReached))
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('mpv-state', data)
    }
  })

  mpvManager.on('ended', (data) => {
    persistPlaybackState(mpvManager.getState(), true)
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('mpv-ended', data)
    }
  })

  mpvManager.on('mpv-event', (data) => {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('mpv-event', data)
    }
  })

  mpvManager.on('error', (data) => {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('mpv-error', data)
    }
  })
}

function destroyMpv() {
  if (playbackSaveTimer) {
    clearTimeout(playbackSaveTimer)
    playbackSaveTimer = null
  }
  flushPlaybackState()
  mpvManager.destroy()
}

module.exports = {
  mpvManager,
  resolveMpvPath,
  initMpv,
  destroyMpv
}
