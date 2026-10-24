// 自动同步的 preload 桥类型声明。
// 变更 preload.js 暴露的 API 时，必须同步更新本文件；
// CI 中 `npm run verify:electron-api` 会做双向一致性检查。

export {}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

/** IPC 统一返回的通用结果形状 */
export interface IpcResult<T = unknown> {
  success: boolean
  error?: string
  canceled?: boolean
  settings?: AppSettings
  settingsVersion?: import('../packages/contracts').SettingsVersion
  [key: string]: unknown
}

/** 应用内询问框（替代系统 showMessageBox 的确认类弹窗） */
export interface AppAskPayload {
  id: number
  tone: 'question' | 'warning' | 'error' | 'info'
  title: string
  message: string
  detail: string
  buttons: string[]
  defaultId: number
  cancelId: number
  checkboxLabel: string
  checkboxChecked: boolean
}

export interface VideoMediaInfo {
  available: boolean
  durationSeconds: number
  width: number
  height: number
  fps: number
  videoCodec: string
  audioCodec: string
  bitRate: number
  container: string
  probedAt: number
}

export type MediaMutationTarget = import('../packages/contracts').MediaMutationTarget

export interface VideoItem {
  id: string
  playbackKey: string
  name: string
  fileName: string
  fullPath: string
  extension: string
  size: number
  modified: number
  fileModified: number
  group: string
  tags: string[]
  wallpaperType: string
  previewPath: string | null
  workshopId: string
  workshopUpdatedAt: number
  workshopUrl: string
  favoriteKey: string
  description: string
  media: VideoMediaInfo | null
  [key: string]: unknown
}

export interface AppSettings {
  /** Main-process snapshot identity; never persisted or submitted as a setting. */
  _settingsVersion?: { epoch: string; revision: number }
  theme?: 'dark' | 'light'
  playbackMode?: string
  directories?: string[]
  privateDirectories?: string[]
  defaultDirectory?: string
  customTags?: Record<string, string[]>
  hiddenTags?: string[]
  downloadDirectories?: string[]
  windowClose?: {
    mode?: 'ask' | 'minimize' | 'exit'
    rememberedDate?: string
    rememberedAction?: 'minimize' | 'exit'
  }
  remoteAccess?: {
    enabled?: boolean
    port?: number
    keepRunningInTray?: boolean
    allowLegacyToken?: boolean
  }
  privacy?: {
    passwordSet?: boolean
  }
  [key: string]: unknown
}

export interface NetworkResource {
  url: string
  title: string
  kind: 'direct' | 'webpage'
  playbackUrl?: string
  httpHeaders?: {
    referer?: string
    userAgent?: string
  }
  [key: string]: unknown
}

export interface DownloadTask {
  gid: string
  name: string
  status: string
  [key: string]: unknown
}

export interface DownloadControlOptions { expectedGeneration?: string }

export interface DownloadState {
  engine: {
    available?: boolean
    [key: string]: unknown
  } | null
  tasks: DownloadTask[]
}

export interface PluginInfo {
  _settingsVersion?: { epoch: string; revision: number }
  secretKeys?: string[]
  id: string
  name: string
  enabled: boolean
  status: string
  [key: string]: unknown
}

export interface PairedDevice {
  id: string
  name?: string
  [key: string]: unknown
}

export interface PairingRequest {
  id: string
  deviceName?: string
  [key: string]: unknown
}

export interface RemoteAccessState {
  _remoteVersion?: { epoch: string; revision: number }
  settings: {
    enabled: boolean
    port: number
    keepRunningInTray: boolean
    allowLegacyToken: boolean
  }
  running: boolean
  error: string
  port: number
  endpoint: string
  endpoints: string[]
  accessToken: string
  identityCorruptedAt: string | null
  pairedDevices: PairedDevice[]
  pendingPairingRequests: PairingRequest[]
  [key: string]: unknown
}

export interface PairingCodeResult {
  pairingCode: string
  endpoint: string
  endpoints: string[]
  qrDataUrl: string
  [key: string]: unknown
}

export interface VideoAnalysisJob {
  jobId?: string
  status: string
  videoPath?: string
  progress?: number
  taskType?: string
  message?: string
  resultPath?: string
  [key: string]: unknown
}

export interface VlmState {
  status?: string
  running?: boolean
  [key: string]: unknown
}

export interface MpvState {
  filePath: string | null
  timePos: number
  duration: number
  paused: boolean
  volume: number
  muted: boolean
  speed: number
  audioId: number | null
  subtitleId: number | null
  subtitleVisible: boolean
  subtitleScale: number
  loopFile: string
  abLoopA: number | null
  abLoopB: number | null
  playlistPos: number
  playlistCount: number
  eofReached: boolean
  trackList: unknown[]
}

export interface MpvPlayOptions {
  playlist?: string[]
  [key: string]: unknown
}

export interface UpdaterStatus {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error' | 'disabled'
  currentVersion: string
  error?: string
  updateInfo?: {
    version: string
    currentVersion: string
    releaseName: string
    releaseNotes: string
    releaseDate: string
    releaseUrl: string
  }
  downloadProgress?: unknown
  [key: string]: unknown
}

export interface RemotePlayOnDesktopPayload {
  filePath?: string
  networkResource?: NetworkResource
}

export interface PlayerShortcutPayload {
  action: 'play-pause' | 'next' | 'prev' | 'stop'
  value?: unknown
}

export interface ScanResult {
  videos: VideoItem[]
  count: number
  cached?: boolean
  indexed?: boolean
  refreshing?: boolean
  error?: string
}

export interface ElectronAPI {
  // 扫描与缩略图
  scanDirectory(dirPath: string, force?: boolean): Promise<ScanResult | { error: string }>
  generateThumbnail(videoPath: string, requestId?: string): Promise<IpcResult>
  getThumbnailUrl(thumbnailPath: string): Promise<string | null>
  generatePreviewFrame(videoPath: string, seconds: number, requestId?: string): Promise<IpcResult>
  cancelMediaWork(requestId: string): Promise<IpcResult>
  getVideoMetadata(videoPath: string, options?: { force?: boolean; requestId?: string }): Promise<{ success: boolean; media?: VideoMediaInfo; error?: string }>

  // 设置与通用
  getSettings(): Promise<AppSettings>
  getSettingsFeed(): Promise<import('../packages/contracts').SettingsFeed>
  onSettingsPatched(callback: (event: import('../packages/contracts').SettingsEvent) => void): () => void
  getAppVersion(): Promise<string>
  saveSettings(settings: Partial<AppSettings>, options?: import('../packages/contracts').SettingsReplyOptions): Promise<IpcResult>
  onSettingsChanged(callback: (settings: AppSettings) => void): () => void
  setVideoFavorite(video: MediaMutationTarget, favorite: boolean, options?: import('../packages/contracts').SettingsReplyOptions): Promise<IpcResult>
  setVideoCustomTags(video: MediaMutationTarget, tags: string[], condition?: import('../packages/contracts').TagWrite, options?: import('../packages/contracts').SettingsReplyOptions): Promise<IpcResult>
  getVideoCustomTags(video: MediaMutationTarget, options?: import('../packages/contracts').SettingsReplyOptions): Promise<IpcResult>
  appendVideoCustomTags(videos: MediaMutationTarget[], tags: string[], options?: import('../packages/contracts').SettingsReplyOptions): Promise<IpcResult>
  checkFfmpeg(): Promise<unknown>
  selectMpvPath(): Promise<IpcResult>

  // 网络资源
  addNetworkResource(resource: NetworkResource): Promise<IpcResult>
  updateNetworkResource(resource: NetworkResource): Promise<IpcResult>
  resolveNetworkResource(resource: NetworkResource): Promise<IpcResult>
  removeNetworkResource(resourceId: string): Promise<IpcResult>
  removeNetworkResources(resourceIds: string[]): Promise<IpcResult>

  // 下载中心
  downloadSelectDirectory(): Promise<IpcResult & { path?: string; libraryDirectory?: boolean }>
  downloadGetState(options?: { start?: boolean; refresh?: boolean; requestId?: string }): Promise<DownloadState>
  downloadAddNetworkResource(payload: unknown): Promise<IpcResult & DownloadState>
  downloadAddUrl(payload: unknown): Promise<IpcResult & DownloadState>
  downloadAddMagnet(payload: unknown): Promise<IpcResult & DownloadState>
  downloadAddXunlei(payload: unknown): Promise<IpcResult & DownloadState>
  downloadSelectFiles(gid: string, fileIndexes: number[], options?: DownloadControlOptions): Promise<IpcResult & DownloadState>
  downloadPause(gid: string, options?: DownloadControlOptions): Promise<IpcResult & DownloadState>
  downloadResume(gid: string, options?: DownloadControlOptions): Promise<IpcResult & DownloadState>
  downloadRemove(gid: string, options?: DownloadControlOptions): Promise<IpcResult & DownloadState>
  downloadOpenDirectory(dirPath: string): Promise<IpcResult>

  // 插件
  listPlugins(): Promise<PluginInfo[]>
  setPluginEnabled(pluginId: string, enabled: boolean): Promise<IpcResult>
  installPlugin(sourceType?: string): Promise<IpcResult>
  uninstallPlugin(pluginId: string): Promise<IpcResult>
  openPluginsDirectory(): Promise<IpcResult>
  savePluginConfig(pluginId: string, config: unknown): Promise<IpcResult>

  // 隐私
  setPrivacyPassword(password: string, options?: { verifyOnly?: boolean }): Promise<IpcResult>
  unlockPrivacy(password: string, options?: { verifyOnly?: boolean }): Promise<IpcResult>
  lockPrivacy(): Promise<IpcResult>
  onPrivacyStateChanged(callback: (state: { unlocked: boolean }) => void): () => void

  // 远程访问（手机端）
  remoteGetState(): Promise<RemoteAccessState>
  remoteSaveSettings(settings: Partial<AppSettings>): Promise<IpcResult>
  remoteCopyEndpoint(): Promise<IpcResult>
  remoteCopyToken(): Promise<IpcResult>
  remoteRotateToken(): Promise<RemoteAccessState>
  remoteCreatePairingCode(): Promise<PairingCodeResult>
  remoteCopyPairingCode(pairingCode: string): Promise<IpcResult>
  remoteRemovePairedDevice(deviceId: string): Promise<IpcResult>
  remoteApprovePairingRequest(requestId: string): Promise<IpcResult>
  remoteRejectPairingRequest(requestId: string): Promise<IpcResult>
  onRemoteAccessState(callback: (state: RemoteAccessState) => void): () => void
  onRemotePlayOnDesktop(callback: (payload: RemotePlayOnDesktopPayload) => void): () => void

  // 窗口外壳（自绘标题栏）
  windowGetState(): Promise<{ success: boolean; maximized: boolean; fullscreen: boolean }>
  windowMinimize(): Promise<IpcResult>
  windowToggleMaximize(): Promise<{ success: boolean; maximized: boolean; fullscreen?: boolean }>
  windowClose(): Promise<IpcResult>
  windowCloseDecide(payload: { id: number; action: 'minimize' | 'exit' | 'cancel'; remember?: boolean }): Promise<IpcResult>
  onWindowClosePrompt(callback: (payload: { id: number }) => void): () => void
  onWindowMaximizedChanged(callback: (state: { maximized: boolean; fullscreen: boolean }) => void): () => void
  appAskReply(payload: { id: number; response: number; checkboxChecked?: boolean }): Promise<IpcResult>
  onAppAsk(callback: (payload: AppAskPayload) => void): () => void

  // 文件与目录
  selectDirectory(): Promise<string | { path: string; privateDirectory?: boolean } | null>
  selectVideoDirectory(): Promise<string | { path: string; privateDirectory?: boolean } | null>
  openVideoFile(): Promise<string | null>
  allowVideoFile(filePath: string): Promise<IpcResult>
  getPathForFile(file: File): string
  showInFolder(filePath: string): Promise<IpcResult>
  getFileUrl(filePath: string): Promise<IpcResult>
  getPlaybackState(filePath: string): Promise<unknown>
  savePlaybackState(filePath: string, statePatch: unknown): Promise<IpcResult>

  // 视频分析
  getVideoAnalysis(filePath: string): Promise<unknown>
  listSavedVideoAnalysis(videos: unknown[]): Promise<unknown[]>
  deleteSavedVideoAnalysis(resultPath: string): Promise<IpcResult>
  startVideoAnalysis(filePath: string, interestId?: string): Promise<VideoAnalysisJob | IpcResult>
  cancelVideoAnalysis(jobId?: string, interestId?: string): Promise<IpcResult>
  getVideoAnalysisJob(): Promise<VideoAnalysisJob | null>
  getVideoAnalysisOutputDir(): Promise<string>
  selectVideoAnalysisOutputDir(): Promise<IpcResult>
  openVideoAnalysisOutputDir(): Promise<IpcResult>
  getVideoAnalysisModelDir(): Promise<string>
  getDefaultVideoAnalysisModelDir(): Promise<string>
  selectVideoAnalysisModelDir(): Promise<IpcResult>
  openVideoAnalysisModelDir(): Promise<IpcResult>
  getVideoAnalysisRuntimeConfig(): Promise<unknown>
  saveVideoAnalysisRuntimeConfig(config: unknown): Promise<IpcResult>
  resetVideoAnalysisRuntimeConfig(): Promise<IpcResult>
  getVideoAnalysisVlmState(): Promise<VlmState>
  getVideoAnalysisVlmModelOptions(): Promise<unknown>
  saveVideoAnalysisVlmConfig(patch: unknown): Promise<IpcResult>
  selectVideoAnalysisVlmModelFile(): Promise<IpcResult>
  selectVideoAnalysisVlmServerExecutable(): Promise<IpcResult>
  listVideoAnalysisLocalVlmFiles(): Promise<unknown[]>
  selectVideoAnalysisLocalVlmFile(filePath: string): Promise<IpcResult>
  downloadVideoAnalysisVlmModel(selection: unknown): Promise<unknown>
  cancelVideoAnalysisVlmDownload(): Promise<IpcResult>
  startVideoAnalysisVlmService(): Promise<unknown>
  stopVideoAnalysisVlmService(): Promise<unknown>
  onVideoAnalysisEvent(callback: (event: unknown) => void): () => void
  onVideoAnalysisVlmEvent(callback: (event: unknown) => void): () => void

  // 更新
  updaterGetStatus(): Promise<UpdaterStatus>
  updaterCheck(): Promise<IpcResult>
  updaterDownload(): Promise<IpcResult>
  updaterInstall(): Promise<IpcResult>
  onUpdaterStatus(callback: (status: UpdaterStatus) => void): () => void

  // mpv 播放
  checkMpv(): Promise<unknown>
  downloadMpv(requestId?: string): Promise<IpcResult>
  mpvPlay(filePath: string, options?: MpvPlayOptions): Promise<IpcResult>
  playerAction(request: import('../packages/contracts').PlayerAction): Promise<import('../packages/contracts').PlayerActionResult>
  mpvPlayUrl(url: string, options?: MpvPlayOptions): Promise<IpcResult>
  setMediaPlaybackActive(active: boolean): Promise<IpcResult>
  mpvSetHostBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<IpcResult>
  mpvStop(): Promise<IpcResult>
  mpvGetState(): Promise<MpvState>
  mpvSeekTo(position: number): Promise<IpcResult>
  mpvSeekRelative(delta: number): Promise<IpcResult>
  mpvCyclePause(): Promise<IpcResult>
  mpvSetPaused(paused: boolean): Promise<IpcResult>
  mpvSetVolume(volume: number): Promise<IpcResult>
  mpvToggleMute(): Promise<IpcResult>
  mpvSetSpeed(speed: number): Promise<IpcResult>
  mpvSetAudioTrack(trackId: number | null): Promise<IpcResult>
  mpvSetSubtitleTrack(trackId: number | 'off' | 'auto' | null): Promise<IpcResult>
  mpvSetSubtitleVisible(visible: boolean): Promise<IpcResult>
  mpvSetSubtitleScale(scale: number): Promise<IpcResult>
  mpvScreenshot(): Promise<IpcResult>
  onMpvState(callback: (state: MpvState) => void): () => void
  onMpvEnded(callback: () => void): () => void
  onMpvError(callback: (error: unknown) => void): () => void
  onMpvDownloadProgress(callback: (event: unknown) => void): () => void

  // AI 搜索
  startAiSearch(videoInfo: unknown): Promise<IpcResult>
  cancelAiSearch(taskId: string): Promise<IpcResult>
  submitAiSearchFeedback(feedback: unknown): Promise<IpcResult>
  onAiSearchEvent(callback: (event: unknown) => void): () => void

  // 快捷键
  onPlayerShortcut(callback: (payload: PlayerShortcutPayload) => void): () => void
}
