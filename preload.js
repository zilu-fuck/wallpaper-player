const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // 目录扫描
  scanDirectory: (dirPath, force) => ipcRenderer.invoke('scan-directory', dirPath, force),

  // 缩略图
  generateThumbnail: (videoPath) => ipcRenderer.invoke('generate-thumbnail', videoPath),
  generateThumbnails: (videoPaths) => ipcRenderer.invoke('generate-thumbnails', videoPaths),
  getThumbnailUrl: (thumbnailPath) => ipcRenderer.invoke('get-thumbnail-url', thumbnailPath),
  onThumbnailProgress: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('thumbnail-progress', handler)
    return () => ipcRenderer.removeListener('thumbnail-progress', handler)
  },

  // 设置
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // 目录选择
  selectDirectory: () => ipcRenderer.invoke('select-directory'),

  // 工具
  showInFolder: (filePath) => ipcRenderer.invoke('show-in-folder', filePath),
  getFileUrl: (filePath) => ipcRenderer.invoke('get-file-url', filePath),
  checkFfmpeg: () => ipcRenderer.invoke('check-ffmpeg'),

  // 自动更新
  updaterGetStatus: () => ipcRenderer.invoke('updater-get-status'),
  updaterCheck: () => ipcRenderer.invoke('updater-check'),
  updaterDownload: () => ipcRenderer.invoke('updater-download'),
  updaterInstall: () => ipcRenderer.invoke('updater-install'),
  onUpdaterStatus: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('updater-status', handler)
    return () => ipcRenderer.removeListener('updater-status', handler)
  },

  // mpv 播放器
  checkMpv: () => ipcRenderer.invoke('check-mpv'),
  downloadMpv: () => ipcRenderer.invoke('download-mpv'),
  mpvPlay: (filePath) => ipcRenderer.invoke('mpv-play', filePath),
  mpvStop: () => ipcRenderer.invoke('mpv-stop'),
  mpvIsPlaying: () => ipcRenderer.invoke('mpv-is-playing'),
  selectMpvPath: () => ipcRenderer.invoke('select-mpv-path'),
  onMpvEnded: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('mpv-ended', handler)
    return () => ipcRenderer.removeListener('mpv-ended', handler)
  },
  onMpvEvent: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('mpv-event', handler)
    return () => ipcRenderer.removeListener('mpv-event', handler)
  },
  onMpvError: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('mpv-error', handler)
    return () => ipcRenderer.removeListener('mpv-error', handler)
  },
  onMpvDownloadProgress: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('mpv-download-progress', handler)
    return () => ipcRenderer.removeListener('mpv-download-progress', handler)
  }
})
