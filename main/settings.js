const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { app } = require('electron')
const { getResourcePath, pathKey, isExistingFile, isMpvExecutablePath } = require('./paths')

const PRIVACY_PASSWORD_ITERATIONS = 120000
const PRIVACY_PASSWORD_KEY_LENGTH = 32
const PRIVACY_PASSWORD_DIGEST = 'sha256'

const sessionAllowedDirectories = new Set()
const sessionPrivateDirectories = new Set()
const sessionAllowedMpvPaths = new Set()
const sessionAllowedFiles = new Set()
const sessionAllowedAnalysisResultDirectories = new Set()
const sessionAllowedAnalysisModelDirectories = new Set()
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

function getDefaultAnalysisResultDirectory() {
  const baseDir = app?.getPath
    ? app.getPath('userData')
    : fallbackUserDataDir
  return path.join(baseDir, 'analysis-results')
}

function getDefaultAnalysisModelDirectory() {
  return getResourcePath('video comprehension', 'video comprehension', 'models')
}

function normalizeDirectoryList(directories) {
  return Array.isArray(directories)
    ? directories.filter(dir => typeof dir === 'string' && dir.trim())
    : []
}

function normalizePrivateDirectories(privateDirectories, directories = []) {
  const directoryKeys = new Set(normalizeDirectoryList(directories).map(dir => pathKey(path.resolve(dir))))
  return normalizeDirectoryList(privateDirectories)
    .map(dir => path.resolve(dir))
    .filter(dir => directoryKeys.has(pathKey(dir)))
}

function getPublicDirectories(directories, privateDirectories = []) {
  const privateKeys = new Set(normalizePrivateDirectories(privateDirectories, directories).map(pathKey))
  return normalizeDirectoryList(directories)
    .filter(dir => !privateKeys.has(pathKey(path.resolve(dir))))
}

function normalizePrivacy(privacy) {
  const value = privacy && typeof privacy === 'object' && !Array.isArray(privacy)
    ? privacy
    : {}
  const salt = typeof value.salt === 'string' && /^[0-9a-f]{32}$/i.test(value.salt)
    ? value.salt.toLowerCase()
    : ''
  const passwordHash = typeof value.passwordHash === 'string' && /^[0-9a-f]{64}$/i.test(value.passwordHash)
    ? value.passwordHash.toLowerCase()
    : ''
  return {
    salt,
    passwordHash,
    passwordSet: Boolean(salt && passwordHash)
  }
}

function hashPrivacyPassword(password, salt) {
  return crypto.pbkdf2Sync(
    String(password),
    salt,
    PRIVACY_PASSWORD_ITERATIONS,
    PRIVACY_PASSWORD_KEY_LENGTH,
    PRIVACY_PASSWORD_DIGEST
  ).toString('hex')
}

function createPrivacyPassword(password) {
  const normalized = typeof password === 'string' ? password : ''
  if (normalized.length < 4) {
    throw new Error('隐私密码至少需要 4 位')
  }
  const salt = crypto.randomBytes(16).toString('hex')
  return normalizePrivacy({
    salt,
    passwordHash: hashPrivacyPassword(normalized, salt)
  })
}

function verifyPrivacyPassword(password, privacy = loadSettings().privacy) {
  const current = normalizePrivacy(privacy)
  if (!current.passwordSet) return false
  const nextHash = hashPrivacyPassword(typeof password === 'string' ? password : '', current.salt)
  const expected = Buffer.from(current.passwordHash, 'hex')
  const actual = Buffer.from(nextHash, 'hex')
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
}

function sanitizeSettingsForRenderer(settings) {
  const privacy = normalizePrivacy(settings?.privacy)
  return {
    ...settings,
    privacy: {
      passwordSet: privacy.passwordSet
    }
  }
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

function normalizeAnalysisLlmProfile(profile) {
  const value = profile && typeof profile === 'object' && !Array.isArray(profile)
    ? profile
    : {}
  return {
    llmBaseUrl: typeof value.llmBaseUrl === 'string' ? value.llmBaseUrl : '',
    llmName: typeof value.llmName === 'string' ? value.llmName : '',
    llmApiKey: typeof value.llmApiKey === 'string' ? value.llmApiKey : ''
  }
}

function normalizeAnalysisLlmProfiles(profiles) {
  const value = profiles && typeof profiles === 'object' && !Array.isArray(profiles)
    ? profiles
    : {}
  return {
    local: normalizeAnalysisLlmProfile(value.local),
    api: normalizeAnalysisLlmProfile(value.api)
  }
}

function mergeAnalysisLlmProfile(currentProfile, nextProfile) {
  const current = normalizeAnalysisLlmProfile(currentProfile)
  const next = nextProfile && typeof nextProfile === 'object' && !Array.isArray(nextProfile)
    ? nextProfile
    : {}
  return normalizeAnalysisLlmProfile({
    ...current,
    ...next
  })
}

function mergeAnalysisLlmProfiles(currentProfiles, nextProfiles) {
  const current = normalizeAnalysisLlmProfiles(currentProfiles)
  const next = nextProfiles && typeof nextProfiles === 'object' && !Array.isArray(nextProfiles)
    ? nextProfiles
    : {}
  return {
    local: Object.hasOwn(next, 'local')
      ? mergeAnalysisLlmProfile(current.local, next.local)
      : current.local,
    api: Object.hasOwn(next, 'api')
      ? mergeAnalysisLlmProfile(current.api, next.api)
      : current.api
  }
}

function mergeVideoAnalysis(currentVideoAnalysis, nextVideoAnalysis) {
  const current = normalizeVideoAnalysis(currentVideoAnalysis)
  const next = nextVideoAnalysis && typeof nextVideoAnalysis === 'object' && !Array.isArray(nextVideoAnalysis)
    ? nextVideoAnalysis
    : {}
  return normalizeVideoAnalysis({
    ...current,
    ...(Object.hasOwn(next, 'enabled') ? { enabled: next.enabled } : {}),
    ...(Object.hasOwn(next, 'outputDir') ? { outputDir: next.outputDir } : {}),
    ...(Object.hasOwn(next, 'modelDir') ? { modelDir: next.modelDir } : {}),
    llmProfiles: Object.hasOwn(next, 'llmProfiles')
      ? mergeAnalysisLlmProfiles(current.llmProfiles, next.llmProfiles)
      : current.llmProfiles
  })
}

function normalizeVideoAnalysis(videoAnalysis) {
  const analysis = videoAnalysis && typeof videoAnalysis === 'object' && !Array.isArray(videoAnalysis)
    ? videoAnalysis
    : {}
  const outputDir = typeof analysis.outputDir === 'string' && analysis.outputDir.trim()
    ? path.resolve(analysis.outputDir)
    : getDefaultAnalysisResultDirectory()
  const modelDir = typeof analysis.modelDir === 'string' && analysis.modelDir.trim()
    ? path.resolve(analysis.modelDir)
    : getDefaultAnalysisModelDirectory()
  return {
    enabled: Boolean(analysis.enabled),
    outputDir,
    modelDir,
    llmProfiles: normalizeAnalysisLlmProfiles(analysis.llmProfiles)
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
    privateDirectories: [],
    defaultDirectory: '',
    favorites: [],
    customTags: {},
    playbackStates: {},
    playbackMode: 'order',
    privacy: normalizePrivacy(),
    remoteAccess: normalizeRemoteAccess(),
    windowClose: normalizeWindowClose(),
    videoAnalysis: normalizeVideoAnalysis()
  }

  try {
    const raw = fs.readFileSync(getSettingsPath(), 'utf-8')
    const parsed = JSON.parse(raw)
    const directories = normalizeDirectoryList(parsed.directories)
    const privateDirectories = normalizePrivateDirectories(parsed.privateDirectories, directories)
    const publicDirectories = getPublicDirectories(directories, privateDirectories)
    const defaultDirectory = typeof parsed.defaultDirectory === 'string' && publicDirectories.includes(parsed.defaultDirectory)
      ? parsed.defaultDirectory
      : publicDirectories[0] || ''

    return {
      ...defaults,
      ...parsed,
      directories,
      privateDirectories,
      defaultDirectory,
      favorites: Array.isArray(parsed.favorites) ? parsed.favorites : defaults.favorites,
      customTags: normalizeCustomTags(parsed.customTags),
      playbackStates: normalizePlaybackStates(parsed.playbackStates),
      playbackMode: ['order', 'shuffle', 'single'].includes(parsed.playbackMode) ? parsed.playbackMode : defaults.playbackMode,
      privacy: normalizePrivacy(parsed.privacy),
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

  const currentSettings = loadSettings()
  const merged = {
    ...currentSettings,
    ...settings
  }
  if (settings && Object.hasOwn(settings, 'videoAnalysis')) {
    merged.videoAnalysis = mergeVideoAnalysis(currentSettings.videoAnalysis, settings.videoAnalysis)
  }

  merged.directories = normalizeDirectoryList(merged.directories)
  merged.privateDirectories = normalizePrivateDirectories(merged.privateDirectories, merged.directories)
  const privateDirectoryKeys = new Set(merged.privateDirectories.map(pathKey))
  for (const key of [...sessionPrivateDirectories]) {
    if (!privateDirectoryKeys.has(key)) sessionPrivateDirectories.delete(key)
  }
  const publicDirectories = getPublicDirectories(merged.directories, merged.privateDirectories)
  if (!merged.defaultDirectory || !publicDirectories.includes(merged.defaultDirectory)) {
    merged.defaultDirectory = publicDirectories[0] || ''
  }
  if (!Array.isArray(merged.favorites)) merged.favorites = []
  merged.customTags = normalizeCustomTags(merged.customTags)
  merged.playbackStates = normalizePlaybackStates(merged.playbackStates)
  merged.playbackMode = ['order', 'shuffle', 'single'].includes(merged.playbackMode) ? merged.playbackMode : 'order'
  merged.privacy = normalizePrivacy(merged.privacy)
  merged.remoteAccess = normalizeRemoteAccess(merged.remoteAccess)
  merged.windowClose = normalizeWindowClose(merged.windowClose)
  merged.videoAnalysis = normalizeVideoAnalysis(merged.videoAnalysis)

  fs.writeFileSync(getSettingsPath(), JSON.stringify(merged, null, 2))

  if (Object.hasOwn(settings, 'directories') || Object.hasOwn(settings, 'privateDirectories')) {
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

function getPublicVideoDirectories() {
  const settings = loadSettings()
  const privateKeys = new Set([
    ...normalizePrivateDirectories(settings.privateDirectories, settings.directories).map(pathKey),
    ...sessionPrivateDirectories
  ])
  return getAllowedVideoDirectories()
    .filter(dir => !privateKeys.has(pathKey(dir)))
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

  if (Object.hasOwn(sanitized, 'privateDirectories')) {
    const directories = normalizeDirectoryList(sanitized.directories ?? current.directories).map(dir => path.resolve(dir))
    sanitized.privateDirectories = normalizePrivateDirectories(sanitized.privateDirectories, directories)
  }

  if (Object.hasOwn(sanitized, 'defaultDirectory')) {
    const directories = normalizeDirectoryList(sanitized.directories ?? current.directories).map(dir => path.resolve(dir))
    const privateDirectories = normalizePrivateDirectories(sanitized.privateDirectories ?? current.privateDirectories, directories)
    const publicDirectories = getPublicDirectories(directories, privateDirectories)
    const defaultDirectory = typeof sanitized.defaultDirectory === 'string'
      ? path.resolve(sanitized.defaultDirectory)
      : ''

    sanitized.defaultDirectory = publicDirectories.some(dir => pathKey(dir) === pathKey(defaultDirectory))
      ? defaultDirectory
      : publicDirectories[0] || ''
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

  if (Object.hasOwn(sanitized, 'privacy')) {
    sanitized.privacy = current.privacy || normalizePrivacy()
  }

  if (Object.hasOwn(sanitized, 'remoteAccess')) {
    sanitized.remoteAccess = normalizeRemoteAccess(sanitized.remoteAccess)
  }

  if (Object.hasOwn(sanitized, 'windowClose')) {
    sanitized.windowClose = normalizeWindowClose(sanitized.windowClose)
  }

  if (Object.hasOwn(sanitized, 'videoAnalysis')) {
    const nextAnalysis = mergeVideoAnalysis(current.videoAnalysis, sanitized.videoAnalysis)
    const currentDir = current.videoAnalysis?.outputDir
      ? path.resolve(current.videoAnalysis.outputDir)
      : getDefaultAnalysisResultDirectory()
    const currentModelDir = current.videoAnalysis?.modelDir
      ? path.resolve(current.videoAnalysis.modelDir)
      : getDefaultAnalysisModelDirectory()
    const nextDir = nextAnalysis.outputDir ? path.resolve(nextAnalysis.outputDir) : currentDir
    const nextModelDir = nextAnalysis.modelDir ? path.resolve(nextAnalysis.modelDir) : currentModelDir
    const canSaveOutputDir = (
      pathKey(nextDir) === pathKey(currentDir) ||
      pathKey(nextDir) === pathKey(getDefaultAnalysisResultDirectory()) ||
      sessionAllowedAnalysisResultDirectories.has(pathKey(nextDir))
    )
    const canSaveModelDir = (
      pathKey(nextModelDir) === pathKey(currentModelDir) ||
      pathKey(nextModelDir) === pathKey(getDefaultAnalysisModelDirectory()) ||
      sessionAllowedAnalysisModelDirectories.has(pathKey(nextModelDir))
    )

    sanitized.videoAnalysis = {
      ...nextAnalysis,
      llmProfiles: nextAnalysis.llmProfiles,
      outputDir: canSaveOutputDir ? nextDir : currentDir,
      modelDir: canSaveModelDir ? nextModelDir : currentModelDir
    }
  }

  return sanitized
}

module.exports = {
  sessionAllowedDirectories,
  sessionPrivateDirectories,
  sessionAllowedMpvPaths,
  sessionAllowedFiles,
  sessionAllowedAnalysisResultDirectories,
  sessionAllowedAnalysisModelDirectories,
  setDirectoryChangeHandler,
  onSettingsChanged,
  loadSettings,
  saveSettings,
  sanitizeSettingsForSave,
  sanitizeSettingsForRenderer,
  normalizeDirectoryList,
  normalizePrivateDirectories,
  normalizePrivacy,
  createPrivacyPassword,
  verifyPrivacyPassword,
  getPublicDirectories,
  normalizeCustomTags,
  normalizePlaybackState,
  normalizePlaybackStates,
  normalizeRemoteAccess,
  normalizeWindowClose,
  normalizeVideoAnalysis,
  mergeVideoAnalysis,
  normalizeAnalysisLlmProfiles,
  getDefaultAnalysisResultDirectory,
  getDefaultAnalysisModelDirectory,
  getPlaybackStateKey,
  getPlaybackState,
  upsertPlaybackState,
  addSessionAllowedFile,
  isSessionAllowedFile,
  getAllowedVideoDirectories,
  getPublicVideoDirectories
}
