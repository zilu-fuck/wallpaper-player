const { contextBridge, ipcRenderer } = require('electron')

function on(channel, callback) {
  const handler = (_event, data) => callback(data)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('electronAPI', {
  scanDirectory: (dirPath, force) => ipcRenderer.invoke('scan-directory', dirPath, force),
  generateThumbnail: (videoPath) => ipcRenderer.invoke('generate-thumbnail', videoPath),
  generateThumbnails: (videoPaths) => ipcRenderer.invoke('generate-thumbnails', videoPaths),
  getThumbnailUrl: (thumbnailPath) => ipcRenderer.invoke('get-thumbnail-url', thumbnailPath),
  onThumbnailProgress: (callback) => on('thumbnail-progress', callback),

  getSettings: () => ipcRenderer.invoke('get-settings'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  onSettingsChanged: (callback) => on('settings-changed', callback),

  remoteGetState: () => ipcRenderer.invoke('remote-get-state'),
  remoteSaveSettings: (settings) => ipcRenderer.invoke('remote-save-settings', settings),
  remoteCopyEndpoint: () => ipcRenderer.invoke('remote-copy-endpoint'),
  remoteCopyToken: () => ipcRenderer.invoke('remote-copy-token'),
  remoteRotateToken: () => ipcRenderer.invoke('remote-rotate-token'),
  remoteCreatePairingCode: () => ipcRenderer.invoke('remote-create-pairing-code'),
  remoteCopyPairingCode: (pairingCode) => ipcRenderer.invoke('remote-copy-pairing-code', pairingCode),
  remoteRemovePairedDevice: (deviceId) => ipcRenderer.invoke('remote-remove-paired-device', deviceId),
  remoteApprovePairingRequest: (requestId) => ipcRenderer.invoke('remote-approve-pairing-request', requestId),
  remoteRejectPairingRequest: (requestId) => ipcRenderer.invoke('remote-reject-pairing-request', requestId),
  onRemoteAccessState: (callback) => on('remote-access-state', callback),
  onRemotePlayOnDesktop: (callback) => on('remote-play-on-desktop', callback),

  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  openVideoFile: () => ipcRenderer.invoke('open-video-file'),
  allowVideoFile: (filePath) => ipcRenderer.invoke('allow-video-file', filePath),

  showInFolder: (filePath) => ipcRenderer.invoke('show-in-folder', filePath),
  getFileUrl: (filePath) => ipcRenderer.invoke('get-file-url', filePath),
  getPlaybackState: (filePath) => ipcRenderer.invoke('get-playback-state', filePath),
  savePlaybackState: (filePath, statePatch) => ipcRenderer.invoke('save-playback-state', filePath, statePatch),
  getVideoAnalysis: (filePath) => ipcRenderer.invoke('video-analysis-get', filePath),
  checkFfmpeg: () => ipcRenderer.invoke('check-ffmpeg'),

  updaterGetStatus: () => ipcRenderer.invoke('updater-get-status'),
  updaterCheck: () => ipcRenderer.invoke('updater-check'),
  updaterDownload: () => ipcRenderer.invoke('updater-download'),
  updaterInstall: () => ipcRenderer.invoke('updater-install'),
  onUpdaterStatus: (callback) => on('updater-status', callback),

  checkMpv: () => ipcRenderer.invoke('check-mpv'),
  downloadMpv: () => ipcRenderer.invoke('download-mpv'),
  mpvPlay: (filePath, options = {}) => ipcRenderer.invoke('mpv-play', filePath, options),
  mpvSetHostBounds: (bounds) => ipcRenderer.invoke('mpv-set-host-bounds', bounds),
  mpvStop: () => ipcRenderer.invoke('mpv-stop'),
  mpvIsPlaying: () => ipcRenderer.invoke('mpv-is-playing'),
  mpvGetState: () => ipcRenderer.invoke('mpv-get-state'),
  mpvCommand: (method, ...args) => ipcRenderer.invoke('mpv-command', method, ...args),
  mpvSeekTo: (position) => ipcRenderer.invoke('mpv-command', 'seekTo', position),
  mpvSeekRelative: (delta) => ipcRenderer.invoke('mpv-command', 'seekRelative', delta),
  mpvCyclePause: () => ipcRenderer.invoke('mpv-command', 'cyclePause'),
  mpvSetPaused: (paused) => ipcRenderer.invoke('mpv-command', 'setPaused', paused),
  mpvSetVolume: (volume) => ipcRenderer.invoke('mpv-command', 'setVolume', volume),
  mpvSetMuted: (muted) => ipcRenderer.invoke('mpv-command', 'setMuted', muted),
  mpvToggleMute: () => ipcRenderer.invoke('mpv-command', 'toggleMute'),
  mpvSetSpeed: (speed) => ipcRenderer.invoke('mpv-command', 'setSpeed', speed),
  mpvCycleSpeed: () => ipcRenderer.invoke('mpv-command', 'cycleSpeed'),
  mpvSetAudioTrack: (trackId) => ipcRenderer.invoke('mpv-command', 'setAudioTrack', trackId),
  mpvCycleAudioTrack: () => ipcRenderer.invoke('mpv-command', 'cycleAudioTrack'),
  mpvSetSubtitleTrack: (trackId) => ipcRenderer.invoke('mpv-command', 'setSubtitleTrack', trackId),
  mpvCycleSubtitleTrack: () => ipcRenderer.invoke('mpv-command', 'cycleSubtitleTrack'),
  mpvSetSubtitleVisible: (visible) => ipcRenderer.invoke('mpv-command', 'setSubtitleVisible', visible),
  mpvToggleSubtitleVisible: () => ipcRenderer.invoke('mpv-command', 'toggleSubtitleVisible'),
  mpvSetSubtitleScale: (scale) => ipcRenderer.invoke('mpv-command', 'setSubtitleScale', scale),
  mpvSetLoopMode: (mode) => ipcRenderer.invoke('mpv-command', 'setLoopMode', mode),
  mpvSetABLoop: (a, b) => ipcRenderer.invoke('mpv-command', 'setABLoop', a, b),
  mpvClearABLoop: () => ipcRenderer.invoke('mpv-command', 'clearABLoop'),
  mpvScreenshot: () => ipcRenderer.invoke('mpv-command', 'screenshot'),
  selectMpvPath: () => ipcRenderer.invoke('select-mpv-path'),
  onMpvState: (callback) => on('mpv-state', callback),
  onMpvEnded: (callback) => on('mpv-ended', callback),
  onMpvEvent: (callback) => on('mpv-event', callback),
  onMpvError: (callback) => on('mpv-error', callback),
  onMpvDownloadProgress: (callback) => on('mpv-download-progress', callback),

  onPlayerShortcut: (callback) => on('player-shortcut', callback)
})
