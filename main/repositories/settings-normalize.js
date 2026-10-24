const path = require('node:path'), fs = require('node:fs'), crypto = require('node:crypto')
const { pathKey, isPathInside } = require('../path-identity')
const { normalizeTagRevisions, normalizeTagReceipts } = require('./tag-normalizers')
const { normalizePrivacy } = require('../security/privacy-password')
const { CURRENT_SCHEMA_VERSION } = require('./settings-file')

function createSettingsNormalizer({ cwd = () => process.cwd() } = {}) {
function normalizeDirectoryList(directories) {
  return Array.isArray(directories)
    ? directories.filter(dir => typeof dir === 'string' && dir.trim())
    : []
}

function resolvePathForAccess(inputPath) {
  const resolved = path.resolve(cwd(), inputPath)
  try {
    return fs.realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

function normalizePrivateDirectories(privateDirectories, directories = []) {
  const directoryKeys = new Set(normalizeDirectoryList(directories).map(dir => pathKey(resolvePathForAccess(dir))))
  return normalizeDirectoryList(privateDirectories)
    .map(dir => resolvePathForAccess(dir))
    .filter(dir => directoryKeys.has(pathKey(dir)))
}

function getPublicDirectories(directories, privateDirectories = []) {
  const privateRoots = normalizePrivateDirectories(privateDirectories, directories)
  return normalizeDirectoryList(directories)
    .map(dir => resolvePathForAccess(dir))
    .filter(dir => !privateRoots.some(root => isPathInside(root, dir)))
}

function normalizeDownloadDirectories(downloadDirectories) {
  const seen = new Set()
  return normalizeDirectoryList(downloadDirectories)
    .map(dir => resolvePathForAccess(dir))
    .filter(dir => {
      const key = pathKey(dir)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
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
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
    revision: Number.isSafeInteger(state.revision) && state.revision >= 0 ? state.revision : 0,
    writers: Object.fromEntries(Object.entries(state.writers || {})
      .filter(([key, cursor]) => key.length <= 120 && cursor && Number.isSafeInteger(cursor.session) && cursor.session > 0 &&
        Number.isSafeInteger(cursor.sequence) && cursor.sequence > 0 && Number.isFinite(cursor.position) && cursor.position >= 0)
      .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0)).slice(0, 32)
      .map(([key, cursor]) => [key, { session: cursor.session, sequence: cursor.sequence,
        position: cursor.position, updatedAt: Number(cursor.updatedAt) || 0 }]))
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

function normalizeNetworkResources(resources) {
  if (!Array.isArray(resources)) return []
  const seen = new Set()
  const seenIds = new Set()
  const result = []
  for (const item of resources) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const url = typeof item.url === 'string' ? item.url.trim() : ''
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      continue
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue
    const normalizedUrl = parsed.toString()
    // URL already normalizes the scheme/host; paths and query values retain their identity.
    const key = normalizedUrl
    if (seen.has(key)) continue
    seen.add(key)
    const title = typeof item.title === 'string' ? item.title.trim().slice(0, 120) : ''
    const kind = item.kind === 'webpage' ? 'webpage' : 'direct'
    const playbackUrl = typeof item.playbackUrl === 'string' ? item.playbackUrl.trim() : ''
    const rawHttpHeaders = item.httpHeaders && typeof item.httpHeaders === 'object' && !Array.isArray(item.httpHeaders)
      ? item.httpHeaders
      : null
    const httpHeaders = rawHttpHeaders
      ? {
        referer: typeof rawHttpHeaders.referer === 'string' ? rawHttpHeaders.referer.trim() : '',
        userAgent: typeof rawHttpHeaders.userAgent === 'string' ? rawHttpHeaders.userAgent.trim() : ''
      }
      : null
    const parser = typeof item.parser === 'string' ? item.parser.trim().slice(0, 40) : ''
    const page = item.page && typeof item.page === 'object' && !Array.isArray(item.page)
      ? normalizeNetworkResourcePage(item.page)
      : null
    const createdAt = typeof item.createdAt === 'string' && item.createdAt.trim()
      ? item.createdAt.trim()
      : new Date().toISOString()
    const fallbackId = crypto.createHash('sha1').update(normalizedUrl).digest('hex').slice(0, 16)
    let id = typeof item.id === 'string' && item.id.trim()
      ? item.id.trim()
      : fallbackId
    if (seenIds.has(id)) {
      id = fallbackId
    }
    let suffix = 2
    while (seenIds.has(id)) {
      id = `${fallbackId}-${suffix}`
      suffix += 1
    }
    seenIds.add(id)
    result.push({
      id,
      kind,
      title,
      url: normalizedUrl,
      playbackUrl,
      httpHeaders,
      parser,
      page,
      createdAt
    })
  }
  return result.slice(0, 200)
}

function normalizeNetworkResourcePage(page) {
  const normalized = { ...page }
  if (Array.isArray(normalized.episodes)) {
    normalized.episodes = normalized.episodes.slice(0, 2000).map(episode => {
      if (!episode || typeof episode !== 'object' || Array.isArray(episode)) return episode
      const rawHeaders = episode.httpHeaders && typeof episode.httpHeaders === 'object' && !Array.isArray(episode.httpHeaders)
        ? episode.httpHeaders
        : null
      const httpHeaders = rawHeaders
        ? {
          referer: typeof rawHeaders.referer === 'string' ? rawHeaders.referer.trim() : '',
          userAgent: typeof rawHeaders.userAgent === 'string' ? rawHeaders.userAgent.trim() : ''
        }
        : null
      return httpHeaders
        ? { ...episode, httpHeaders }
        : { ...episode, httpHeaders: undefined }
    })
  }
  return normalized
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

function getDefaultSettings(sectionDefaults = {}) {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    theme: 'dark',
    directories: [],
    privateDirectories: [],
    defaultDirectory: '',
    favorites: [],
    customTags: {},
    customTagRevisions: {},
    tagMutationReceipts: [],
    hiddenTags: [],
    networkResources: [],
    downloadDirectories: [],
    playbackStates: {},
    playbackMode: 'order',
    privacy: normalizePrivacy(),
    remoteAccess: normalizeRemoteAccess(),
    windowClose: normalizeWindowClose(),
    plugins: normalizePlugins(),
    ...sectionDefaults
  }
}

function normalizeSettings(settings, { sectionDefaults = {}, normalizeSections = () => ({}) } = {}) {
  const defaults = getDefaultSettings(sectionDefaults)
  const parsed = settings && typeof settings === 'object' && !Array.isArray(settings)
    ? { ...settings }
    : {}
  delete parsed._settingsVersion
  const directories = normalizeDirectoryList(parsed.directories)
  const privateDirectories = normalizePrivateDirectories(parsed.privateDirectories, directories)
  const publicDirectories = getPublicDirectories(directories, privateDirectories)
  const defaultDirectory = typeof parsed.defaultDirectory === 'string' && publicDirectories.includes(parsed.defaultDirectory)
    ? parsed.defaultDirectory
    : publicDirectories[0] || ''

  return {
    ...defaults,
    ...parsed,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    directories,
    privateDirectories,
    defaultDirectory,
    favorites: Array.isArray(parsed.favorites) ? parsed.favorites : defaults.favorites,
    customTags: normalizeCustomTags(parsed.customTags),
    customTagRevisions: normalizeTagRevisions(parsed.customTagRevisions),
    tagMutationReceipts: normalizeTagReceipts(parsed.tagMutationReceipts),
    hiddenTags: normalizeHiddenTags(parsed.hiddenTags),
    networkResources: normalizeNetworkResources(parsed.networkResources),
    downloadDirectories: normalizeDownloadDirectories(parsed.downloadDirectories),
    playbackStates: normalizePlaybackStates(parsed.playbackStates),
    playbackMode: ['order', 'shuffle', 'single'].includes(parsed.playbackMode) ? parsed.playbackMode : defaults.playbackMode,
    privacy: normalizePrivacy(parsed.privacy),
    remoteAccess: normalizeRemoteAccess(parsed.remoteAccess),
    windowClose: normalizeWindowClose(parsed.windowClose),
    plugins: normalizePlugins(parsed.plugins),
    ...normalizeSections(parsed)
  }
}

return { normalizeDirectoryList, resolvePathForAccess, normalizePrivateDirectories, getPublicDirectories, normalizeDownloadDirectories, normalizeHiddenTags, normalizeCustomTags, normalizePlaybackState, normalizePlaybackStates, normalizeNetworkResources, normalizeNetworkResourcePage, normalizeRemoteAccess, normalizeWindowClose, normalizePlugins, getDefaultSettings, normalizeSettings }
}

module.exports = { createSettingsNormalizer, ...createSettingsNormalizer() }
