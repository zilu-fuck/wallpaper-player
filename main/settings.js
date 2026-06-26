const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { app } = require('electron')
const { pathKey, isExistingFile, isMpvExecutablePath } = require('./paths')

const PRIVACY_PASSWORD_ITERATIONS = 120000
const PRIVACY_PASSWORD_KEY_LENGTH = 32
const PRIVACY_PASSWORD_DIGEST = 'sha256'

const sessionAllowedDirectories = new Set()
const sessionPrivateDirectories = new Set()
const sessionAllowedMpvPaths = new Set()
const sessionAllowedFiles = new Set()
const settingsSections = new Map()
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

function normalizeHiddenTags(hiddenTags) {
  if (!Array.isArray(hiddenTags)) return []
  const seen = new Set()
  const result = []
  for (const value of hiddenTags) {
    const tag = String(value || '').trim()
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    result.push(tag)
  }
  return result
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

function normalizePlugins(plugins) {
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(plugins)
      .filter(([pluginId, state]) => (
        typeof pluginId === 'string' &&
        pluginId.trim() &&
        state &&
        typeof state === 'object' &&
        !Array.isArray(state)
      ))
      .map(([pluginId, state]) => [
        pluginId.trim(),
        {
          ...(Object.hasOwn(state, 'enabled') ? { enabled: Boolean(state.enabled) } : {}),
          ...(state.config && typeof state.config === 'object' && !Array.isArray(state.config) ? { config: state.config } : {}),
          ...(typeof state.installedAt === 'string' ? { installedAt: state.installedAt } : {}),
          ...(typeof state.updatedAt === 'string' ? { updatedAt: state.updatedAt } : {})
        }
      ])
  )
}

function mergePlugins(currentPlugins, nextPlugins) {
  const current = normalizePlugins(currentPlugins)
  const patch = nextPlugins && typeof nextPlugins === 'object' && !Array.isArray(nextPlugins) ? nextPlugins : {}
  const merged = {
    ...current,
    ...Object.fromEntries(
      Object.entries(normalizePlugins(patch)).map(([pluginId, state]) => [
        pluginId,
        {
          ...(current[pluginId] || {}),
          ...state
        }
      ])
    )
  }
  for (const [pluginId, state] of Object.entries(patch)) {
    if (state && typeof state === 'object' && !Array.isArray(state) && state.removed === true) {
      delete merged[pluginId]
    }
  }
  return merged
}

function removePluginSettings(pluginId) {
  const id = typeof pluginId === 'string' ? pluginId.trim() : ''
  if (!id) return loadSettings()
  return saveSettings({
    plugins: {
      [id]: {
        removed: true
      }
    }
  })
}

function clonePlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...value }
    : {}
}

function normalizeSettingsSectionValue(section, value) {
  if (typeof section.normalize === 'function') return section.normalize(value)
  return clonePlainObject(value)
}

function mergeSettingsSectionValue(section, currentValue, nextValue) {
  if (typeof section.merge === 'function') return section.merge(currentValue, nextValue)
  return {
    ...normalizeSettingsSectionValue(section, currentValue),
    ...clonePlainObject(nextValue)
  }
}

function getSettingsSectionDefaults() {
  return Object.fromEntries(
    [...settingsSections.entries()].map(([key, section]) => [
      key,
      normalizeSettingsSectionValue(section, section.defaults)
    ])
  )
}

function normalizeRegisteredSettingsSections(settings) {
  const normalized = {}
  for (const [key, section] of settingsSections.entries()) {
    normalized[key] = normalizeSettingsSectionValue(section, settings?.[key])
  }
  return normalized
}

function registerSettingsSection(key, definition = {}) {
  const sectionKey = typeof key === 'string' ? key.trim() : ''
  if (!sectionKey) throw new Error('Settings section key is required')
  if (settingsSections.has(sectionKey)) {
    throw new Error(`Settings section already registered: ${sectionKey}`)
  }
  const section = {
    defaults: definition.defaults,
    normalize: definition.normalize,
    merge: definition.merge,
    sanitizeForSave: definition.sanitizeForSave
  }
  settingsSections.set(sectionKey, section)
  return () => {
    if (settingsSections.get(sectionKey) === section) {
      settingsSections.delete(sectionKey)
    }
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
    hiddenTags: [],
    playbackStates: {},
    playbackMode: 'order',
    privacy: normalizePrivacy(),
    remoteAccess: normalizeRemoteAccess(),
    windowClose: normalizeWindowClose(),
    plugins: normalizePlugins(),
    ...getSettingsSectionDefaults()
  }

  try {
    const raw = fs.readFileSync(getSettingsPath(), 'utf-8').replace(/^\uFEFF/, '')
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
      hiddenTags: normalizeHiddenTags(parsed.hiddenTags),
      playbackStates: normalizePlaybackStates(parsed.playbackStates),
      playbackMode: ['order', 'shuffle', 'single'].includes(parsed.playbackMode) ? parsed.playbackMode : defaults.playbackMode,
      privacy: normalizePrivacy(parsed.privacy),
      remoteAccess: normalizeRemoteAccess(parsed.remoteAccess),
      windowClose: normalizeWindowClose(parsed.windowClose),
      plugins: normalizePlugins(parsed.plugins),
      ...normalizeRegisteredSettingsSections(parsed)
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
  if (settings && Object.hasOwn(settings, 'plugins')) {
    merged.plugins = mergePlugins(currentSettings.plugins, settings.plugins)
  }
  for (const [key, section] of settingsSections.entries()) {
    if (settings && Object.hasOwn(settings, key)) {
      merged[key] = mergeSettingsSectionValue(section, currentSettings[key], settings[key])
    }
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
  merged.hiddenTags = normalizeHiddenTags(merged.hiddenTags)
  merged.playbackStates = normalizePlaybackStates(merged.playbackStates)
  merged.playbackMode = ['order', 'shuffle', 'single'].includes(merged.playbackMode) ? merged.playbackMode : 'order'
  merged.privacy = normalizePrivacy(merged.privacy)
  merged.remoteAccess = normalizeRemoteAccess(merged.remoteAccess)
  merged.windowClose = normalizeWindowClose(merged.windowClose)
  merged.plugins = normalizePlugins(merged.plugins)
  Object.assign(merged, normalizeRegisteredSettingsSections(merged))

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

  if (Object.hasOwn(sanitized, 'hiddenTags')) {
    sanitized.hiddenTags = normalizeHiddenTags(sanitized.hiddenTags)
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

  if (Object.hasOwn(sanitized, 'plugins')) {
    sanitized.plugins = mergePlugins(current.plugins, sanitized.plugins)
  }

  for (const [key, section] of settingsSections.entries()) {
    if (!Object.hasOwn(sanitized, key)) continue
    const nextValue = mergeSettingsSectionValue(section, current[key], sanitized[key])
    sanitized[key] = typeof section.sanitizeForSave === 'function'
      ? section.sanitizeForSave(nextValue, current[key], { path, pathKey })
      : nextValue
  }

  return sanitized
}

module.exports = {
  sessionAllowedDirectories,
  sessionPrivateDirectories,
  sessionAllowedMpvPaths,
  sessionAllowedFiles,
  setDirectoryChangeHandler,
  onSettingsChanged,
  registerSettingsSection,
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
  normalizeHiddenTags,
  normalizePlaybackState,
  normalizePlaybackStates,
  normalizeRemoteAccess,
  normalizeWindowClose,
  normalizePlugins,
  mergePlugins,
  removePluginSettings,
  getPlaybackStateKey,
  getPlaybackState,
  upsertPlaybackState,
  addSessionAllowedFile,
  isSessionAllowedFile,
  getAllowedVideoDirectories,
  getPublicVideoDirectories
}
