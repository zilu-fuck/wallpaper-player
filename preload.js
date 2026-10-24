const { contextBridge, ipcRenderer, webUtils } = require('electron')

// 首帧主题提示：在任何页面脚本之前把上次的主题写到 <html data-theme>，
// 这样浅色用户不会先看到一帧深色开屏。
// 放在 preload 而不是内联脚本，是因为窗口 CSP 为 script-src 'self'，内联脚本会被拦截。
try {
  if (window.localStorage.getItem('wallpaper-player:theme') === 'light') {
    document.documentElement.setAttribute('data-theme', 'light')
  }
} catch (error) {}

// 注意：本文件运行在 Electron 沙箱化的 preload 上下文中，
// require() 只能加载 electron 内置模块，不能 require 本地文件，
// 因此通道名以字符串字面量书写；与 main/ipc-channels.js 的一致性
// 由 scripts/verify-electron-api-types.js 在 CI 中强制校验。

function on(channel, callback) {
  const handler = (_event, data) => callback(data)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}
let settingsLegacyListeners = 0, settingsLegacySequence = 0, settingsLegacyRecovery = null
function decodeSettingsSnapshot(value) {
  if (value?.kind !== 'settings-json-v1' || Object.keys(value).length !== 2) return value
  if (typeof value.text !== 'string') throw new Error('读取到无效的设置快照')
  const snapshot = JSON.parse(value.text), version = snapshot?._settingsVersion, privacy = snapshot?.privacy
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
      !version || typeof version.epoch !== 'string' || !version.epoch || version.epoch.length > 128 ||
      !Number.isSafeInteger(version.revision) || version.revision < 0 ||
      !privacy || typeof privacy !== 'object' || typeof privacy.passwordSet !== 'boolean' ||
      Object.keys(privacy).some(key => key !== 'passwordSet') || Object.hasOwn(snapshot, 'tagMutationReceipts')) {
    throw new Error('读取到无效的设置快照')
  }
  return snapshot
}
function settingsLegacySubscription(callback) {
  const publish = () => { void Promise.resolve(ipcRenderer.invoke('settings-legacy-listener', {
    enabled: settingsLegacyListeners > 0, sequence: ++settingsLegacySequence, encoding: 'json-v1'
  })).catch(() => {}) }
  if (++settingsLegacyListeners === 1) publish()
  const sequence = settingsLegacySequence
  let removed = false, recoveryPending = null, latestVersion = null, observation = 0
  const deliver = snapshot => {
    if (removed || sequence !== settingsLegacySequence) return
    const version = snapshot?._settingsVersion
    if (latestVersion && version?.epoch === latestVersion.epoch && version.revision <= latestVersion.revision) return
    latestVersion = version; observation++; callback(snapshot)
  }
  const recover = () => {
    if (!settingsLegacyRecovery || settingsLegacyRecovery.sequence !== sequence) {
      const recovery = { sequence }
      recovery.promise = ipcRenderer.invoke('get-settings', { encoding: 'json-v1' }).then(decodeSettingsSnapshot)
        .finally(() => { if (settingsLegacyRecovery === recovery) settingsLegacyRecovery = null })
      settingsLegacyRecovery = recovery
    }
    const promise = settingsLegacyRecovery.promise, captured = observation
    if (recoveryPending === promise) return
    recoveryPending = promise
    void promise.then(snapshot => {
      // A late authoritative read cannot replace a newer live notification.
      if (captured === observation || snapshot?._settingsVersion?.epoch === latestVersion?.epoch) deliver(snapshot)
    }, () => {}).finally(() => { if (recoveryPending === promise) recoveryPending = null })
  }
  const remove = on('settings-changed', value => {
    if (value?.kind === 'settings-legacy-resync-v1') { if (value.sequence === sequence) recover(); return }
    if (value?.kind === 'settings-legacy-json-v1') {
      if (value.sequence !== sequence) return
      let snapshot
      try { snapshot = decodeSettingsSnapshot(value.snapshot) } catch { recover(); return }
      deliver(snapshot); return
    }
    deliver(value)
  })
  return () => { if (removed) return; removed = true; remove(); if (--settingsLegacyListeners === 0) publish() }
}

function settingsPatchedSubscription(callback) {
  return on('settings-patched', value => {
    if (value?.kind !== 'settings-snapshot-v1') { callback(value); return }
    let snapshot
    try { snapshot = decodeSettingsSnapshot(value.snapshot) }
    catch { callback({ kind: 'settings-resync-v1', feedId: value.feedId, version: value.version }); return }
    callback({ kind: value.kind, feedId: value.feedId, snapshot })
  })
}

contextBridge.exposeInMainWorld('electronAPI', {
  scanDirectory: (dirPath, force) => ipcRenderer.invoke('scan-directory', dirPath, force),
  generateThumbnail: (videoPath, requestId) => ipcRenderer.invoke('generate-thumbnail', videoPath, requestId),
  getThumbnailUrl: (thumbnailPath) => ipcRenderer.invoke('get-thumbnail-url', thumbnailPath),
  generatePreviewFrame: (videoPath, seconds, requestId) => ipcRenderer.invoke('generate-preview-frame', videoPath, seconds, requestId),
  cancelMediaWork: (requestId) => ipcRenderer.invoke('cancel-media-work', requestId),
  getVideoMetadata: (videoPath, options) => ipcRenderer.invoke('get-video-metadata', videoPath, options),

  getSettings: () => ipcRenderer.invoke('get-settings', { encoding: 'json-v1' }).then(decodeSettingsSnapshot),
  getSettingsFeed: () => ipcRenderer.invoke('settings-get-feed', { encoding: 'json-v1' }).then(feed => ({ ...feed, snapshot: decodeSettingsSnapshot(feed.snapshot) })),
  onSettingsPatched: (callback) => settingsPatchedSubscription(callback),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  addNetworkResource: (resource) => ipcRenderer.invoke('network-resource-add', resource),
  updateNetworkResource: (resource) => ipcRenderer.invoke('network-resource-update', resource),
  resolveNetworkResource: (resource) => ipcRenderer.invoke('network-resource-resolve', resource),
  removeNetworkResource: (resourceId) => ipcRenderer.invoke('network-resource-remove', resourceId),
  removeNetworkResources: (resourceIds) => ipcRenderer.invoke('network-resources-remove', resourceIds),
  downloadSelectDirectory: () => ipcRenderer.invoke('download-select-directory'),
  downloadGetState: (options) => ipcRenderer.invoke('download-get-state', options),
  downloadAddNetworkResource: (payload) => ipcRenderer.invoke('download-add-network-resource', payload),
  downloadAddUrl: (payload) => ipcRenderer.invoke('download-add-url', payload),
  downloadAddMagnet: (payload) => ipcRenderer.invoke('download-add-magnet', payload),
  downloadAddXunlei: (payload) => ipcRenderer.invoke('download-add-xunlei', payload),
  downloadSelectFiles: (gid, fileIndexes, options) => ipcRenderer.invoke('download-select-files', gid, fileIndexes, options),
  downloadPause: (gid, options) => ipcRenderer.invoke('download-pause', gid, options),
  downloadResume: (gid, options) => ipcRenderer.invoke('download-resume', gid, options),
  downloadRemove: (gid, options) => ipcRenderer.invoke('download-remove', gid, options),
  downloadOpenDirectory: (dirPath) => ipcRenderer.invoke('download-open-directory', dirPath),
  listPlugins: () => ipcRenderer.invoke('plugins-list'),
  setPluginEnabled: (pluginId, enabled) => ipcRenderer.invoke('plugins-set-enabled', pluginId, enabled),
  installPlugin: (sourceType) => ipcRenderer.invoke('plugins-install', sourceType),
  uninstallPlugin: (pluginId) => ipcRenderer.invoke('plugins-uninstall', pluginId),
  openPluginsDirectory: () => ipcRenderer.invoke('plugins-open-directory'),
  savePluginConfig: (pluginId, config) => ipcRenderer.invoke('plugins-save-config', pluginId, config),
  saveSettings: (settings, options) => ipcRenderer.invoke('save-settings', settings, options),
  onSettingsChanged: (callback) => settingsLegacySubscription(callback),
  setVideoFavorite: (video, favorite, options) => ipcRenderer.invoke('media-set-favorite', video, favorite, options),
  setVideoCustomTags: (video, tags, condition, options) => ipcRenderer.invoke('media-set-tags', video, tags, condition, options),
  getVideoCustomTags: (video, options) => ipcRenderer.invoke('media-get-tags', video, options),
  appendVideoCustomTags: (videos, tags, options) => ipcRenderer.invoke('media-append-tags', videos, tags, options),
  setPrivacyPassword: (password, options = {}) => ipcRenderer.invoke('privacy-set-password', password, options),
  unlockPrivacy: (password, options = {}) => ipcRenderer.invoke('privacy-unlock', password, options),
  lockPrivacy: () => ipcRenderer.invoke('privacy-lock'),
  onPrivacyStateChanged: (callback) => on('privacy-state-changed', callback),

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

  windowGetState: () => ipcRenderer.invoke('window-get-state'),
  windowMinimize: () => ipcRenderer.invoke('window-minimize'),
  windowToggleMaximize: () => ipcRenderer.invoke('window-toggle-maximize'),
  windowClose: () => ipcRenderer.invoke('window-close'),
  windowCloseDecide: (payload) => ipcRenderer.invoke('window-close-decide', payload),
  onWindowClosePrompt: (callback) => on('window-close-prompt', callback),
  onWindowMaximizedChanged: (callback) => on('window-maximized-changed', callback),
  appAskReply: (payload) => ipcRenderer.invoke('app-ask-reply', payload),
  onAppAsk: (callback) => on('app-ask', callback),

  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  selectVideoDirectory: () => ipcRenderer.invoke('select-video-directory'),
  openVideoFile: () => ipcRenderer.invoke('open-video-file'),
  allowVideoFile: (filePath) => ipcRenderer.invoke('allow-video-file', filePath),
  getPathForFile: (file) => webUtils.getPathForFile(file),

  showInFolder: (filePath) => ipcRenderer.invoke('show-in-folder', filePath),
  getFileUrl: (filePath) => ipcRenderer.invoke('get-file-url', filePath),
  getPlaybackState: (filePath) => ipcRenderer.invoke('get-playback-state', filePath),
  savePlaybackState: (filePath, statePatch) => ipcRenderer.invoke('save-playback-state', filePath, statePatch),
  getVideoAnalysis: (filePath) => ipcRenderer.invoke('video-analysis-get', filePath),
  listSavedVideoAnalysis: (videos) => ipcRenderer.invoke('video-analysis-list-saved', videos),
  deleteSavedVideoAnalysis: (resultPath) => ipcRenderer.invoke('video-analysis-delete-saved', resultPath),
  startVideoAnalysis: (filePath, interestId) => ipcRenderer.invoke('video-analysis-start', filePath, interestId),
  cancelVideoAnalysis: (jobId, interestId) => ipcRenderer.invoke('video-analysis-cancel', jobId, interestId),
  getVideoAnalysisJob: () => ipcRenderer.invoke('video-analysis-job'),
  getVideoAnalysisOutputDir: () => ipcRenderer.invoke('video-analysis-get-output-dir'),
  selectVideoAnalysisOutputDir: () => ipcRenderer.invoke('video-analysis-select-output-dir'),
  openVideoAnalysisOutputDir: () => ipcRenderer.invoke('video-analysis-open-output-dir'),
  getVideoAnalysisModelDir: () => ipcRenderer.invoke('video-analysis-get-model-dir'),
  getDefaultVideoAnalysisModelDir: () => ipcRenderer.invoke('video-analysis-get-default-model-dir'),
  selectVideoAnalysisModelDir: () => ipcRenderer.invoke('video-analysis-select-model-dir'),
  openVideoAnalysisModelDir: () => ipcRenderer.invoke('video-analysis-open-model-dir'),
  getVideoAnalysisRuntimeConfig: () => ipcRenderer.invoke('video-analysis-get-runtime-config'),
  saveVideoAnalysisRuntimeConfig: (config) => ipcRenderer.invoke('video-analysis-save-runtime-config', config),
  resetVideoAnalysisRuntimeConfig: () => ipcRenderer.invoke('video-analysis-reset-runtime-config'),
  getVideoAnalysisVlmState: () => ipcRenderer.invoke('video-analysis-vlm-state'),
  getVideoAnalysisVlmModelOptions: () => ipcRenderer.invoke('video-analysis-vlm-model-options'),
  saveVideoAnalysisVlmConfig: (patch) => ipcRenderer.invoke('video-analysis-vlm-save-config', patch),
  selectVideoAnalysisVlmModelFile: () => ipcRenderer.invoke('video-analysis-vlm-select-model-file'),
  selectVideoAnalysisVlmServerExecutable: () => ipcRenderer.invoke('video-analysis-vlm-select-server-executable'),
  listVideoAnalysisLocalVlmFiles: () => ipcRenderer.invoke('video-analysis-vlm-local-list-files'),
  selectVideoAnalysisLocalVlmFile: (filePath) => ipcRenderer.invoke('video-analysis-vlm-local-select-file', filePath),
  downloadVideoAnalysisVlmModel: (selection) => ipcRenderer.invoke('video-analysis-vlm-download', selection),
  cancelVideoAnalysisVlmDownload: () => ipcRenderer.invoke('video-analysis-vlm-download-cancel'),
  startVideoAnalysisVlmService: () => ipcRenderer.invoke('video-analysis-vlm-start'),
  stopVideoAnalysisVlmService: () => ipcRenderer.invoke('video-analysis-vlm-stop'),
  onVideoAnalysisEvent: (callback) => on('video-analysis-event', callback),
  onVideoAnalysisVlmEvent: (callback) => on('video-analysis-vlm-event', callback),
  checkFfmpeg: () => ipcRenderer.invoke('check-ffmpeg'),

  updaterGetStatus: () => ipcRenderer.invoke('updater-get-status'),
  updaterCheck: () => ipcRenderer.invoke('updater-check'),
  updaterDownload: () => ipcRenderer.invoke('updater-download'),
  updaterInstall: () => ipcRenderer.invoke('updater-install'),
  onUpdaterStatus: (callback) => on('updater-status', callback),

  checkMpv: () => ipcRenderer.invoke('check-mpv'),
  downloadMpv: (requestId) => ipcRenderer.invoke('download-mpv', requestId),
  mpvPlay: (filePath, options = {}) => ipcRenderer.invoke('mpv-play', filePath, options),
  playerAction: (request) => ipcRenderer.invoke('player-action', request),
  mpvPlayUrl: (url, options = {}) => ipcRenderer.invoke('mpv-play-url', url, options),
  setMediaPlaybackActive: (active) => ipcRenderer.invoke('set-media-playback-active', active),
  mpvSetHostBounds: (bounds) => ipcRenderer.invoke('mpv-set-host-bounds', bounds),
  mpvStop: () => ipcRenderer.invoke('mpv-stop'),
  mpvGetState: () => ipcRenderer.invoke('mpv-get-state'),
  mpvSeekTo: (position) => ipcRenderer.invoke('mpv-command', 'seekTo', position),
  mpvSeekRelative: (delta) => ipcRenderer.invoke('mpv-command', 'seekRelative', delta),
  mpvCyclePause: () => ipcRenderer.invoke('mpv-command', 'cyclePause'),
  mpvSetPaused: (paused) => ipcRenderer.invoke('mpv-command', 'setPaused', paused),
  mpvSetVolume: (volume) => ipcRenderer.invoke('mpv-command', 'setVolume', volume),
  mpvToggleMute: () => ipcRenderer.invoke('mpv-command', 'toggleMute'),
  mpvSetSpeed: (speed) => ipcRenderer.invoke('mpv-command', 'setSpeed', speed),
  mpvSetAudioTrack: (trackId) => ipcRenderer.invoke('mpv-command', 'setAudioTrack', trackId),
  mpvSetSubtitleTrack: (trackId) => ipcRenderer.invoke('mpv-command', 'setSubtitleTrack', trackId),
  mpvSetSubtitleVisible: (visible) => ipcRenderer.invoke('mpv-command', 'setSubtitleVisible', visible),
  mpvSetSubtitleScale: (scale) => ipcRenderer.invoke('mpv-command', 'setSubtitleScale', scale),
  mpvScreenshot: () => ipcRenderer.invoke('mpv-command', 'screenshot'),
  selectMpvPath: () => ipcRenderer.invoke('select-mpv-path'),
  onMpvState: (callback) => on('mpv-state', callback),
  onMpvEnded: (callback) => on('mpv-ended', callback),
  onMpvError: (callback) => on('mpv-error', callback),
  onMpvDownloadProgress: (callback) => on('mpv-download-progress', callback),

  startAiSearch: (videoInfo) => ipcRenderer.invoke('ai-search-start', videoInfo),
  cancelAiSearch: (taskId) => ipcRenderer.invoke('ai-search-cancel', taskId),
  submitAiSearchFeedback: (feedback) => ipcRenderer.invoke('ai-search-feedback', feedback),
  onAiSearchEvent: (callback) => on('ai-search-event', callback),

  onPlayerShortcut: (callback) => on('player-shortcut', callback)
})
