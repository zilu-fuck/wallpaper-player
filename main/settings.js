const path = require('path')
const fs = require('fs')
const { app } = require('electron')
const { pathKey, isExistingFile, isMpvExecutablePath } = require('./paths')

const sessionAllowedDirectories = new Set()
const sessionAllowedMpvPaths = new Set()
const sessionAllowedFiles = new Set()
const fallbackUserDataDir = path.join(process.cwd(), '.tmp-wallpaper-player')

let directoryChangeHandler = null
const settingsChangeHandlers = new Set()

function setDirectoryChangeHandler(handler) {
  directoryChangeHandler = handler
}

function onSettingsChanged(handler) {
  if (typeof handler !== 'function') return () => {}
  settingsChangeHandlers.add(handler)
  return () => settingsChangeHandlers.delete(handler)
}

function notifySettingsChanged(settings) {
  for (const handler of settingsChangeHandlers) {
    try {
      handler(settings)
    } catch {}
  }
}

function getSettingsPath() {
  const baseDir = app?.getPath
    ? app.getPath('userData')
    : fallbackUserDataDir
  return path.join(baseDir, 'settings.json')
}

function normalizeDirectoryList(directories) {
  return Array.isArray(directories)
    ? directories.filter(dir => typeof dir === 'string' && dir.trim())
    : []
}

function normalizeCustomTags(customTags) {
  if (!customTags || typeof customTags !== 'object' || Array.isArray(customTags)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(customTags)
      .filter(([key]) => typeof key === 'string' && key.trim())
      .map(([key, tags]) => [
        key,
        Array.isArray(tags)
          ? [...new Set(tags.filter(tag => typeof tag === 'string' && tag.trim()).map(tag => tag.trim()))]
          : []
      ])
      .filter(([, tags]) => tags.length > 0)
  )
}

function normalizePlaybackState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null

  const position = Number(state.position)
  const volume = Number(state.volume)
  const speed = Number(state.speed)
  const subtitleScale = Number(state.subtitleScale)
  const audioId = state.audioId == null || state.audioId === '' ? null : Number(state.audioId)
  const subtitleId = state.subtitleId == null || state.subtitleId === '' ? null : Number(state.subtitleId)
  const abLoopA = state.abLoopA == null || state.abLoopA === '' ? null : Number(state.abLoopA)
  const abLoopB = state.abLoopB == null || state.abLoopB === '' ? null : Number(state.abLoopB)
  const updatedAt = Number(state.updatedAt)

  return {
    position: Number.isFinite(position) && position >= 0 ? position : 0,
    volume: Number.isFinite(volume) ? Math.max(0, Math.min(100, volume)) : 100,
    speed: Number.isFinite(speed) && speed > 0 ? speed : 1,
    muted: Boolean(state.muted),
    audioId: Number.isFinite(audioId) ? audioId : null,
    subtitleId: Number.isFinite(subtitleId) ? subtitleId : null,
    subtitleVisible: state.subtitleVisible == null ? true : Boolean(state.subtitleVisible),
    subtitleScale: Number.isFinite(subtitleScale) && subtitleScale > 0 ? subtitleScale : 1,
    loopMode: ['off', 'inf', 'a-b'].includes(state.loopMode) ? state.loopMode : 'off',
    abLoopA: Number.isFinite(abLoopA) ? abLoopA : null,
    abLoopB: Number.isFinite(abLoopB) ? abLoopB : null,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now()
  }
}

function normalizePlaybackStates(playbackStates) {
  if (!playbackStates || typeof playbackStates !== 'object' || Array.isArray(playbackStates)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(playbackStates)
      .filter(([key]) => typeof key === 'string' && key.trim())
      .map(([key, state]) => [key, normalizePlaybackState(state)])
      .filter(([, state]) => Boolean(state))
      .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))
      .slice(0, 200)
  )
}

function normalizeRemoteAccess(remoteAccess) {
  const remote = remoteAccess && typeof remoteAccess === 'object' && !Array.isArray(remoteAccess)
    ? remoteAccess
    : {}
  const port = Number(remote.port)
  return {
    enabled: Boolean(remote.enabled),
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 38127,
    keepRunningInTray: remote.keepRunningInTray == null ? true : Boolean(remote.keepRunningInTray),
    allowLegacyToken: Boolean(remote.allowLegacyToken)
  }
}

function normalizeWindowClose(windowClose) {
  const close = windowClose && typeof windowClose === 'object' && !Array.isArray(windowClose)
    ? windowClose
    : {}
  return {
    mode: ['ask', 'minimize', 'exit'].includes(close.mode) ? close.mode : 'ask',
    rememberedAction: ['minimize', 'exit'].includes(close.rememberedAction) ? close.rememberedAction : '',
    rememberedDate: typeof close.rememberedDate === 'string' ? close.rememberedDate : ''
  }
}

function normalizeVideoAnalysis(videoAnalysis) {
  const analysis = videoAnalysis && typeof videoAnalysis === 'object' && !Array.isArray(videoAnalysis)
    ? videoAnalysis
    : {}
  return {
    enabled: Boolean(analysis.enabled)
  }
}

function getPlaybackStateKey(filePath) {
  return pathKey(path.resolve(filePath))
}

function getPlaybackState(playbackStates, filePath) {
  if (!playbackStates || typeof playbackStates !== 'object') return null
  return playbackStates[getPlaybackStateKey(filePath)] || null
}

function upsertPlaybackState(playbackStates, filePath, patch) {
  const key = getPlaybackStateKey(filePath)
  const current = playbackStates?.[key] || {}
  const next = normalizePlaybackState({ ...current, ...patch })
  return {
    ...normalizePlaybackStates(playbackStates),
    [key]: next
  }
}

function addSessionAllowedFile(filePath) {
  sessionAllowedFiles.add(getPlaybackStateKey(filePath))
}

function isSessionAllowedFile(filePath) {
  return sessionAllowedFiles.has(getPlaybackStateKey(filePath))
}

function loadSettings() {
  const defaults = {
    theme: 'dark',
    directories: [],
    defaultDirectory: '',
    favorites: [],
    customTags: {},
    playbackStates: {},
    playbackMode: 'order',
    remoteAccess: normalizeRemoteAccess(),
    windowClose: normalizeWindowClose(),
    videoAnalysis: normalizeVideoAnalysis()
  }

  try {
    const raw = fs.readFileSync(getSettingsPath(), 'utf-8')
    const parsed = JSON.parse(raw)
    const directories = normalizeDirectoryList(parsed.directories)
    const defaultDirectory = typeof parsed.defaultDirectory === 'string' && directories.includes(parsed.defaultDirectory)
      ? parsed.defaultDirectory
      : directories[0] || ''

    return {
      ...defaults,
      ...parsed,
      directories,
      defaultDirectory,
      favorites: Array.isArray(parsed.favorites) ? parsed.favorites : defaults.favorites,
      customTags: normalizeCustomTags(parsed.customTags),
      playbackStates: normalizePlaybackStates(parsed.playbackStates),
      playbackMode: ['order', 'shuffle', 'single'].includes(parsed.playbackMode) ? parsed.playbackMode : defaults.playbackMode,
      remoteAccess: normalizeRemoteAccess(parsed.remoteAccess),
      windowClose: normalizeWindowClose(parsed.windowClose),
      videoAnalysis: normalizeVideoAnalysis(parsed.videoAnalysis)
    }
  } catch {
    return defaults
  }
}

function saveSettings(settings) {
  const dir = path.dirname(getSettingsPath())
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

  const merged = {
    ...loadSettings(),
    ...settings
  }

  merged.directories = normalizeDirectoryList(merged.directories)
  if (!merged.defaultDirectory || !merged.directories.includes(merged.defaultDirectory)) {
    merged.defaultDirectory = merged.directories[0] || ''
  }
  if (!Array.isArray(merged.favorites)) merged.favorites = []
  merged.customTags = normalizeCustomTags(merged.customTags)
  merged.playbackStates = normalizePlaybackStates(merged.playbackStates)
  merged.playbackMode = ['order', 'shuffle', 'single'].includes(merged.playbackMode) ? merged.playbackMode : 'order'
  merged.remoteAccess = normalizeRemoteAccess(merged.remoteAccess)
  merged.windowClose = normalizeWindowClose(merged.windowClose)
  merged.videoAnalysis = normalizeVideoAnalysis(merged.videoAnalysis)

  fs.writeFileSync(getSettingsPath(), JSON.stringify(merged, null, 2))

  if (Object.hasOwn(settings, 'directories')) {
    directoryChangeHandler?.(merged.directories)
  }

  notifySettingsChanged(merged)
  return merged
}

function getAllowedVideoDirectories() {
  const settings = loadSettings()
  const seen = new Set()
  return [
    ...normalizeDirectoryList(settings.directories),
    ...sessionAllowedDirectories
  ]
    .map(dir => path.resolve(dir))
    .filter(dir => {
      const key = pathKey(dir)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

function sanitizeSettingsForSave(settings) {
  const current = loadSettings()
  const sanitized = { ...settings }

  if (Object.hasOwn(sanitized, 'directories')) {
    const allowedDirectoryKeys = new Set([
      ...normalizeDirectoryList(current.directories),
      ...sessionAllowedDirectories
    ].map(pathKey))

    sanitized.directories = normalizeDirectoryList(sanitized.directories)
      .map(dir => path.resolve(dir))
      .filter(dir => allowedDirectoryKeys.has(pathKey(dir)))
  }

  if (Object.hasOwn(sanitized, 'defaultDirectory')) {
    const directories = normalizeDirectoryList(sanitized.directories ?? current.directories).map(dir => path.resolve(dir))
    const defaultDirectory = typeof sanitized.defaultDirectory === 'string'
      ? path.resolve(sanitized.defaultDirectory)
      : ''

    sanitized.defaultDirectory = directories.some(dir => pathKey(dir) === pathKey(defaultDirectory))
      ? defaultDirectory
      : directories[0] || ''
  }

  if (Object.hasOwn(sanitized, 'mpvPath') && sanitized.mpvPath) {
    const mpvPath = path.resolve(sanitized.mpvPath)
    const currentMpvPath = current.mpvPath ? path.resolve(current.mpvPath) : null
    const canSaveMpvPath = (
      (currentMpvPath && pathKey(currentMpvPath) === pathKey(mpvPath)) ||
      sessionAllowedMpvPaths.has(pathKey(mpvPath))
    )

    sanitized.mpvPath = canSaveMpvPath && isMpvExecutablePath(mpvPath) && isExistingFile(mpvPath)
      ? mpvPath
      : current.mpvPath
  }

  if (Object.hasOwn(sanitized, 'favorites')) {
    sanitized.favorites = Array.isArray(sanitized.favorites)
      ? [...new Set(sanitized.favorites.filter(item => typeof item === 'string' && item.trim()))]
      : current.favorites
  }

  if (Object.hasOwn(sanitized, 'customTags')) {
    sanitized.customTags = sanitized.customTags && typeof sanitized.customTags === 'object' && !Array.isArray(sanitized.customTags)
      ? normalizeCustomTags(sanitized.customTags)
      : current.customTags || {}
  }

  if (Object.hasOwn(sanitized, 'playbackStates')) {
    sanitized.playbackStates = normalizePlaybackStates(sanitized.playbackStates)
  }

  if (Object.hasOwn(sanitized, 'playbackMode')) {
    sanitized.playbackMode = ['order', 'shuffle', 'single'].includes(sanitized.playbackMode)
      ? sanitized.playbackMode
      : current.playbackMode || 'order'
  }

  if (Object.hasOwn(sanitized, 'remoteAccess')) {
    sanitized.remoteAccess = normalizeRemoteAccess(sanitized.remoteAccess)
  }

  if (Object.hasOwn(sanitized, 'windowClose')) {
    sanitized.windowClose = normalizeWindowClose(sanitized.windowClose)
  }

  if (Object.hasOwn(sanitized, 'videoAnalysis')) {
    sanitized.videoAnalysis = normalizeVideoAnalysis(sanitized.videoAnalysis)
  }

  return sanitized
}

module.exports = {
  sessionAllowedDirectories,
  sessionAllowedMpvPaths,
  sessionAllowedFiles,
  setDirectoryChangeHandler,
  onSettingsChanged,
  loadSettings,
  saveSettings,
  sanitizeSettingsForSave,
  normalizeDirectoryList,
  normalizeCustomTags,
  normalizePlaybackState,
  normalizePlaybackStates,
  normalizeRemoteAccess,
  normalizeWindowClose,
  normalizeVideoAnalysis,
  getPlaybackStateKey,
  getPlaybackState,
  upsertPlaybackState,
  addSessionAllowedFile,
  isSessionAllowedFile,
  getAllowedVideoDirectories
}
