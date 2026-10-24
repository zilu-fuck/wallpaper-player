const settingsNormalizer = require('./repositories/settings-normalize')
const { normalizeDirectoryList, resolvePathForAccess, normalizePrivateDirectories, getPublicDirectories, normalizeDownloadDirectories, normalizeHiddenTags, normalizeCustomTags, normalizePlaybackState, normalizePlaybackStates, normalizeNetworkResources, normalizeNetworkResourcePage, normalizeRemoteAccess, normalizeWindowClose, normalizePlugins } = settingsNormalizer
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { app } = require('electron')
const { getUserDataDir } = require('./user-data')
const { pathKey, isPathInside, isExistingFile, isMpvExecutablePath } = require('./paths')
const { normalizeTagRevisions, normalizeTagReceipts } = require('./repositories/tag-state')
const { normalizePrivacy, createPrivacyPassword, verifyPrivacyPassword: verifyPassword } = require('./security/privacy-password')
const { createSettingsJson } = require('./application/settings-json')
const { createSettingsReader } = require('./application/settings-reader')
const { sanitizeRendererSettings } = require('./repositories/settings-renderer')
const { SETTINGS_MAP_FIELDS, diffSettingsMap, applySettingsMap } = require('../packages/contracts/dist/settings-feed')
const { CURRENT_SCHEMA_VERSION, createSettingsFile } = require('./repositories/settings-file')
const settingsFiles = new Map()

const sessionAllowedDirectories = new Set()
const sessionPrivateDirectories = new Set()
const sessionAllowedMpvPaths = new Set()
const sessionAllowedFiles = new Set()
const settingsSections = new Map()
const SETTINGS_WRITE_DEBOUNCE_MS = 75

let directoryChangeHandler = null
const settingsChangeHandlers = new Set()
const settingsCommitHandlers = new Set()
let settingsCache = null
let settingsCachePath = ''
let pendingSettingsWrite = null
let settingsWriteTimer = null
let settingsWriteChain = Promise.resolve()
let settingsFlushHooksInstalled = false
let settingsRecoveryInFlight = false
let settingsWriteError = null
let settingsWriteInFlight = false
const snapshotEpoch = crypto.randomUUID()
const snapshotVersions = new WeakMap()
let snapshotRevision = 0
const ownedSettingsPatches = new WeakSet()
const normalizedSettingsPatchFields = new WeakMap()
const settingsJsonSnapshots = new WeakMap()
let settingsJson = null
let settingsReader = null
let settingsInitialization = null
let settingsSectionsRevision = 0
let settingsSerializationGeneration = 0

function settingsSnapshot(settings, text = JSON.stringify(settings)) {
  const owned = JSON.parse(text)
  if (!owned || typeof owned !== 'object' || Array.isArray(owned)) throw Object.assign(Error('设置必须序列化为 JSON 对象'), { code: 'settings_invalid_document' })
  if (owned.schemaVersion !== CURRENT_SCHEMA_VERSION) { owned.schemaVersion = CURRENT_SCHEMA_VERSION; text = JSON.stringify(owned) }
  return { text, owned }
}
function ownSettingsSnapshot(settings) {
  const { text, owned } = settingsSnapshot(settings)
  stampSettings(owned)
  settingsJsonSnapshots.set(owned, { text, id: null })
  return owned
}

async function encodeSettings(settings, { base = settings, patch } = {}) {
  if (settingsInitialization) {
    try { await settingsInitialization.promise }
    catch (error) { if (error.code === 'app_quitting') throw error }
  }
  if (typeof settings.toJSON === 'function') {
    const { text, owned } = settingsSnapshot(settings)
    return { text, bytes: Buffer.from(JSON.stringify(owned, null, 2)), snapshot: owned, id: null }
  }
  const keys = patch ? new Set(Object.keys(patch)) : new Set()
  if (['directories', 'privateDirectories', 'defaultDirectory'].some(key => keys.has(key))) {
    for (const key of ['directories', 'privateDirectories', 'defaultDirectory']) keys.add(key)
  }
  const changes = [...keys].filter(key => key !== '_settingsVersion').map(key => {
    let value = settings[key]
    // Custom serializers keep the original property-key JSON semantics. Their
    // output is captured before crossing the worker boundary.
    if (!ownedSettingsPatches.has(patch) || settingsSections.has(key)) value = JSON.parse(JSON.stringify({ [key]: value }))[key]
    return [key, value]
  })
  settingsJson ||= createSettingsJson()
  const result = await settingsJson.encode({ base, baseId: settingsJsonSnapshots.get(base)?.id, changes, mapDeltas: true })
  if (result.documentVersion !== CURRENT_SCHEMA_VERSION) throw Object.assign(Error('设置编码格式版本无效'), { code: 'settings_invalid_document' })
  const snapshot = { ...base }
  for (const field of result.fields) {
    if (field.present) Object.defineProperty(snapshot, field.key, { value: field.mapDelta ? applySettingsMap(base[field.key], field.mapDelta) : field.value, enumerable: true, writable: true, configurable: true })
    else delete snapshot[field.key]
  }
  delete snapshot._settingsVersion
  return { ...result, snapshot }
}

async function disposeSettingsSerialization(options) {
  settingsSerializationGeneration++
  const current = settingsJson, reader = settingsReader
  await Promise.all([current?.close(options), reader?.close(options)])
  if (settingsJson === current) settingsJson = null
  if (settingsReader === reader) settingsReader = null
}

function captureSettingsPatch(patch) {
  if (!patch || typeof patch !== 'object' || ownedSettingsPatches.has(patch)) return patch
  const visiting = new WeakSet(), checked = new WeakSet()
  function plainData(value) {
    if (!value || typeof value !== 'object') return !['function', 'symbol'].includes(typeof value)
    if (checked.has(value)) return true
    if (visiting.has(value)) return false
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value)
    if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) return false
    visiting.add(value)
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (key === 'toJSON' || (array && key !== 'length' && !descriptor.enumerable)) return false
      if (descriptor.enumerable && (descriptor.get || descriptor.set || !plainData(descriptor.value))) return false
    }
    visiting.delete(value); checked.add(value); return true
  }
  try {
    const prototype = Object.getPrototypeOf(patch)
    if (Array.isArray(patch) || (prototype !== Object.prototype && prototype !== null)) return patch
    const descriptors = Object.entries(Object.getOwnPropertyDescriptors(patch)).filter(([, descriptor]) => descriptor.enumerable)
    if (Object.hasOwn(patch, 'toJSON') || descriptors.some(([, descriptor]) => descriptor.get || descriptor.set)) return patch
    const direct = { customTags: normalizeCustomTags, customTagRevisions: normalizeTagRevisions,
      tagMutationReceipts: normalizeTagReceipts, hiddenTags: normalizeHiddenTags }
    const normalizer = key => settingsSections.has(key) || !Object.hasOwn(direct, key) ? undefined : direct[key]
    if (descriptors.some(([key, descriptor]) => !normalizer(key) && !plainData(descriptor.value))) return patch
    const normalized = new Map()
    const captured = Object.fromEntries(descriptors.map(([key, descriptor]) => {
      const normalize = normalizer(key)
      if (normalize) normalized.set(key, normalize)
      return [key, normalize ? normalize(descriptor.value) : structuredClone(descriptor.value)]
    }))
    ownedSettingsPatches.add(captured)
    normalizedSettingsPatchFields.set(captured, normalized)
    return captured
  } catch { return patch }
}

function stampSettings(settings) {
  snapshotVersions.set(settings, Object.freeze({ epoch: snapshotEpoch, revision: ++snapshotRevision }))
  return settings
}

function setDirectoryChangeHandler(handler) {
  directoryChangeHandler = handler
}

function onSettingsChanged(handler) {
  if (typeof handler !== 'function') return () => {}
  settingsChangeHandlers.add(handler)
  return () => settingsChangeHandlers.delete(handler)
}

function onSettingsCommitted(handler) {
  if (typeof handler !== 'function') return () => {}
  settingsCommitHandlers.add(handler)
  return () => settingsCommitHandlers.delete(handler)
}

function notifySettingsChanged(settings, changedKeys, previous, allowPatch = false) {
  if (!settingsChangeHandlers.size && !settingsCommitHandlers.size) return
  const keys = new Set(changedKeys)
  if (['directories', 'privateDirectories', 'defaultDirectory'].some(key => keys.has(key))) {
    for (const key of ['directories', 'privateDirectories', 'defaultDirectory']) keys.add(key)
  }
  const effectiveKeys = Object.freeze([...keys])
  if (settingsChangeHandlers.size) {
    const snapshot = cloneSettings(settings)
    for (const handler of settingsChangeHandlers) { try { handler(snapshot, { changedKeys: [...effectiveKeys] }) } catch {} }
  }
  if (!settingsCommitHandlers.size) return
  const event = Object.freeze({
    changedKeys: effectiveKeys, version: Object.freeze(getSettingsSnapshotVersion(settings)),
    baseVersion: previous ? Object.freeze(getSettingsSnapshotVersion(previous)) : undefined,
    requiresSnapshot: !allowPatch,
    readSnapshot: () => cloneSettings(settings),
    captureRendererSnapshot: () => captureRendererSnapshot(settings),
    readFields: fields => cloneSettingsFields(settings, fields),
    readPatch: () => {
      const set = Object.create(null), maps = Object.create(null), removed = []
      for (const key of effectiveKeys) {
        if (['_settingsVersion', 'tagMutationReceipts'].includes(key)) continue
        if (!Object.hasOwn(settings, key)) { removed.push(key); continue }
        const delta = SETTINGS_MAP_FIELDS.includes(key) ? diffSettingsMap(previous?.[key], settings[key], 'identity') : null
        if (delta) maps[key] = delta
        else set[key] = settings[key]
      }
      return JSON.parse(JSON.stringify({ set, maps, removed }))
    }
  })
  for (const handler of settingsCommitHandlers) { try { handler(event) } catch {} }
}

function getSettingsPath() {
  return path.join(getUserDataDir(), 'settings.json')
}











function verifyPrivacyPassword(password, privacy = loadSettingsFields(['privacy']).privacy, check) { return verifyPassword(password, privacy, check) }

function getSettingsSnapshotVersion(settings) {
  const version = settings && snapshotVersions.get(settings)
  return version ? { ...version } : undefined
}

function sanitizeSettingsForRenderer(settings, { partial = false } = {}) {
  return sanitizeRendererSettings(settings, getSettingsSnapshotVersion(settings), { partial })
}

function captureRendererSettings() {
  return captureRendererSnapshot(getCachedSettings())
}

function captureRendererSnapshot(snapshot) {
  const text = settingsJsonSnapshots.get(snapshot)?.text
  if (typeof text !== 'string') throw Object.assign(Error('设置快照不可用'), { code: 'settings_snapshot_missing' })
  const version = Object.freeze(getSettingsSnapshotVersion(snapshot))
  return Object.freeze({ version, read: () => {
    settingsReader ||= createSettingsReader()
    return settingsReader.read(text, version)
  } })
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

function getDefaultSettings() { return settingsNormalizer.getDefaultSettings(getSettingsSectionDefaults()) }

function normalizeRegisteredSettingsSections(settings) {
  return Object.fromEntries([...settingsSections].map(([key, section]) => [key, normalizeSettingsSectionValue(section, settings?.[key])]))
}

function addSettingsSection(key, definition = {}) {
  const sectionKey = typeof key === 'string' ? key.trim() : ''
  if (!sectionKey) throw new Error('Settings section key is required')
  if (['_settingsVersion', 'schemaVersion'].includes(sectionKey)) throw new Error('Settings snapshot/storage metadata is reserved')
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
  settingsSectionsRevision++
  return { sectionKey, section }
}

function registerSettingsSection(key, definition = {}) {
  const { sectionKey, section } = addSettingsSection(key, definition)
  if (settingsCache) settingsCache = ownSettingsSnapshot(normalizeSettings(cloneSettings(settingsCache)))
  return () => {
    if (settingsSections.get(sectionKey) === section) {
      settingsSections.delete(sectionKey)
      settingsSectionsRevision++
      if (settingsCache) settingsCache = ownSettingsSnapshot(normalizeSettings(cloneSettings(settingsCache)))
    }
  }
}

async function normalizePreparedSettingsSections(prepared, keys, check, stable) {
  let owned = prepared.value, text = prepared.text, id = prepared.id
  if (keys.length) {
    // Extension callbacks stay in their main-thread owner. Only their output is
    // captured here; the full document remains the worker's canonical base.
    getSettingsSectionDefaults()
    const sections = normalizeRegisteredSettingsSections(prepared.sections)
    check(); if (!stable()) return null
    const changes = keys.map(key => {
      const captured = JSON.parse(JSON.stringify({ [key]: sections[key] }))
      return [key, Object.hasOwn(captured, key) ? captured[key] : undefined]
    })
    const encoded = await settingsJson.encode({ base: owned, baseId: id, changes })
    check(); if (!stable()) return null
    owned = { ...owned }
    for (const field of encoded.fields) {
      if (field.present) Object.defineProperty(owned, field.key, { value: field.value, enumerable: true, writable: true, configurable: true })
      else delete owned[field.key]
    }
    text = encoded.text; id = encoded.id
  }
  return { owned, text, id }
}

function enqueueSettingsSectionPreparation(operation) {
  const task = settingsWriteChain.catch(() => {}).then(operation)
  settingsWriteChain = task.then(() => undefined, () => undefined)
  return task
}

async function prepareRegisteredSettingsCache(check) {
  for (let attempt = 0; attempt < 8; attempt++) {
    check()
    const base = getCachedSettings(), revision = settingsSectionsRevision, keys = [...settingsSections.keys()]
    const stable = () => settingsCache === base && settingsSectionsRevision === revision
    const canonical = settingsJsonSnapshots.get(base)
    if (!canonical) throw Object.assign(Error('设置快照缺少规范数据'), { code: 'settings_invalid_document' })
    settingsJson ||= createSettingsJson()
    let prepared
    try { prepared = await settingsJson.prepare(Buffer.from(canonical.text), { sectionKeys: keys, cwd: process.cwd() }) }
    catch (error) { check(); throw error }
    check(); if (!stable()) continue
    const snapshot = await normalizePreparedSettingsSections(prepared, keys, check, stable)
    check(); if (!snapshot || !stable()) continue
    stampSettings(snapshot.owned)
    settingsJsonSnapshots.set(snapshot.owned, { text: snapshot.text, id: snapshot.id })
    settingsCache = snapshot.owned
    return
  }
  throw Object.assign(Error('插件设置准备期间配置持续变化，请重试'), { code: 'settings_sections_changed' })
}

// Declared plugin sections use the existing settings queue without writing a
// file. Legacy synchronous defineSection/registerSettingsSection stays intact.
function registerSettingsSectionAsync(key, definition = {}) {
  const filename = getSettingsPath(), generation = settingsSerializationGeneration
  const ownsScope = () => generation === settingsSerializationGeneration && getSettingsPath() === filename
  const check = () => {
    if (generation !== settingsSerializationGeneration) throw Object.assign(Error('应用正在关闭'), { code: 'app_quitting' })
    if (getSettingsPath() !== filename) throw Object.assign(Error('插件设置所属目录已改变'), { code: 'settings_sections_retired' })
  }
  return enqueueSettingsSectionPreparation(async () => {
    check(); await initializeSettings(); check()
    const { sectionKey, section } = addSettingsSection(key, definition)
    try { await prepareRegisteredSettingsCache(check) }
    catch (error) {
      if (settingsSections.get(sectionKey) === section) { settingsSections.delete(sectionKey); settingsSectionsRevision++ }
      throw error
    }
    let removal
    return () => removal ||= enqueueSettingsSectionPreparation(async () => {
      if (settingsSections.get(sectionKey) !== section) return
      settingsSections.delete(sectionKey); settingsSectionsRevision++
      if (ownsScope() && settingsCache) await prepareRegisteredSettingsCache(check)
    })
  })
}

function getPlaybackStateKey(filePath) {
  if (typeof filePath === 'string') {
    const value = filePath.trim()
    try {
      const url = new URL(value)
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        return url.toString().toLowerCase()
      }
    } catch {}
  }
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

function cloneSettings(settings) {
  const clone = JSON.parse(settingsJsonSnapshots.get(settings)?.text ?? JSON.stringify(settings))
  const version = snapshotVersions.get(settings)
  if (version) snapshotVersions.set(clone, version)
  return clone
}

function cloneSettingsFields(settings, fields) {
  validateSettingsFields(fields)
  const selected = Object.fromEntries([...new Set(fields)].filter(key => Object.hasOwn(settings, key)).map(key => [key, settings[key]]))
  const version = snapshotVersions.get(settings)
  if (version) snapshotVersions.set(selected, version)
  return cloneSettings(selected)
}

function loadSettingsFields(fields) { return cloneSettingsFields(getCachedSettings(), fields) }
function validateSettingsFields(fields) {
  if (!Array.isArray(fields) || fields.length > 512 || fields.some(key => typeof key !== 'string')) throw new TypeError('Invalid settings fields')
  return fields
}
function loadSettingsMapKeys(field) {
  if (!SETTINGS_MAP_FIELDS.includes(field)) throw new TypeError('Invalid settings map field')
  return Object.keys(getCachedSettings()[field] || {})
}
function readPlaybackState(filePath) { return cloneSettings({ value: getPlaybackState(getCachedSettings().playbackStates, filePath) }).value }

function normalizeSettings(settings) { return settingsNormalizer.normalizeSettings(settings, { sectionDefaults: getSettingsSectionDefaults(), normalizeSections: normalizeRegisteredSettingsSections }) }

function readSettingsFromDisk() {
  return normalizeSettings(settingsFile().read())
}
function settingsFile() {
  const filename = getSettingsPath(), key = pathKey(filename)
  if (!settingsFiles.has(key)) settingsFiles.set(key, createSettingsFile(filename, { onWarning: error => {
    if (app?.getPath) require('electron-log').warn('[settings storage]', error.message)
    else console.error('[settings storage]', error.message)
  } }))
  return settingsFiles.get(key)
}
async function recoverSettingsBackup(recoveryId) {
  if (settingsRecoveryInFlight || settingsWriteInFlight || pendingSettingsWrite) throw Object.assign(Error('设置仍在使用，请重新启动后恢复'), { code: 'settings_busy' })
  settingsRecoveryInFlight = true
  const generation = settingsSerializationGeneration
  const check = () => { if (generation !== settingsSerializationGeneration) throw Object.assign(Error('应用正在关闭'), { code: 'app_quitting' }) }
  try {
    const result = await settingsFile().recover(recoveryId, { check, decode: async bytes => {
      check(); settingsJson ||= createSettingsJson()
      const parsed = await settingsJson.prepare(bytes); check(); return parsed
    } })
    settingsCache = null; settingsCachePath = ''
    return result
  } finally { settingsRecoveryInFlight = false }
}

// Startup owns one asynchronous preparation. Synchronous compatibility readers
// can still establish a newer cache; a late startup result never replaces it.
function initializeSettings() {
  const filename = getSettingsPath()
  if (settingsCache && settingsCachePath === filename) return Promise.resolve()
  if (settingsInitialization) {
    if (settingsInitialization.filename === filename) return settingsInitialization.promise
    return settingsInitialization.promise.catch(() => {}).then(() => initializeSettings())
  }
  const request = { filename }, generation = settingsSerializationGeneration, cwd = process.cwd(), file = settingsFile()
  const current = () => {
    if (generation !== settingsSerializationGeneration) throw Object.assign(Error('应用正在关闭'), { code: 'app_quitting' })
    if (getSettingsPath() !== filename) throw Object.assign(Error('启动设置所属目录已改变'), { code: 'settings_startup_retired' })
  }
  const alreadyLoaded = () => settingsCache && settingsCachePath === filename
  settingsInitialization = request
  request.promise = (async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      current()
      if (alreadyLoaded()) return
      const revision = settingsSectionsRevision, keys = [...settingsSections.keys()]
      let prepared
      try {
        await file.readAsync(async bytes => {
          current(); settingsJson ||= createSettingsJson()
          prepared = await settingsJson.prepare(bytes, { sectionKeys: keys, cwd }); current()
          return prepared
        })
      } catch (error) {
        current()
        if (alreadyLoaded()) return
        throw error
      }
      current()
      if (alreadyLoaded()) return
      if (revision !== settingsSectionsRevision) continue
      const snapshot = await normalizePreparedSettingsSections(prepared, keys, current,
        () => !alreadyLoaded() && revision === settingsSectionsRevision)
      current(); if (alreadyLoaded()) return
      if (!snapshot || revision !== settingsSectionsRevision) continue
      const { owned, text, id } = snapshot
      stampSettings(owned); settingsJsonSnapshots.set(owned, { text, id })
      settingsCache = owned; settingsCachePath = filename
      return
    }
    throw Object.assign(Error('启动期间插件设置持续变化，请重新启动'), { code: 'settings_startup_changed' })
  })().finally(() => { if (settingsInitialization === request) settingsInitialization = null })
  return request.promise
}

function loadSettings() {
  const settingsPath = getSettingsPath()
  if (!settingsCache || settingsCachePath !== settingsPath) {
    settingsCache = ownSettingsSnapshot(readSettingsFromDisk())
    settingsCachePath = settingsPath
  }
  return cloneSettings(settingsCache)
}

function getCachedSettings() {
  const settingsPath = getSettingsPath()
  if (!settingsCache || settingsCachePath !== settingsPath) {
    settingsCache = ownSettingsSnapshot(readSettingsFromDisk())
    settingsCachePath = settingsPath
  }
  return settingsCache
}

function writeSettingsFileSync(settings) {
  settingsFile().writeSync(Buffer.from(JSON.stringify(settings, null, 2)))
}

async function writeSettingsFile(settings, options) {
  const encoded = await encodeSettings(settings, options)
  await settingsFile().write(encoded.bytes)
  if (settingsJsonSnapshots.has(settings)) settingsJsonSnapshots.set(settings, { text: encoded.text, id: encoded.id })
  return encoded
}

function flushPendingSettingsWriteSync() {
  if (settingsWriteTimer) {
    clearTimeout(settingsWriteTimer)
    settingsWriteTimer = null
  }
  if (!pendingSettingsWrite && !settingsWriteInFlight) return
  const settings = settingsCache
  pendingSettingsWrite = null
  writeSettingsFileSync(settings)
  settingsWriteError = null
}

function flushPendingSettingsWrite() {
  if (!pendingSettingsWrite) return settingsWriteChain
  pendingSettingsWrite = null
  settingsWriteChain = settingsWriteChain
    .catch(() => {})
    .then(async () => {
      settingsWriteError = null
      settingsWriteInFlight = true
      try {
        await writeSettingsFile(getCachedSettings())
      } finally {
        settingsWriteInFlight = false
      }
    })
    .catch(error => {
      settingsWriteError = error
      console.error('Failed to write settings:', error)
    })
  return settingsWriteChain
}

async function flushSettingsWrites() {
  do {
    if (settingsWriteTimer) {
      clearTimeout(settingsWriteTimer)
      settingsWriteTimer = null
    }
    await flushPendingSettingsWrite()
    await settingsWriteChain
  } while (pendingSettingsWrite)

  if (settingsWriteError) {
    const error = settingsWriteError
    settingsWriteError = null
    throw error
  }
}

function installSettingsFlushHooks() {
  if (settingsFlushHooksInstalled) return
  settingsFlushHooksInstalled = true
  process.on('beforeExit', flushPendingSettingsWriteSync)
  process.on('exit', flushPendingSettingsWriteSync)
}

function scheduleSettingsWrite() {
  pendingSettingsWrite = true
  installSettingsFlushHooks()
  if (settingsWriteTimer) clearTimeout(settingsWriteTimer)
  settingsWriteTimer = setTimeout(() => {
    settingsWriteTimer = null
    flushPendingSettingsWrite()
  }, SETTINGS_WRITE_DEBOUNCE_MS)
}

function mergeSettingsPatch(currentSettings, settings) {
  const merged = {
    ...currentSettings,
    ...settings
  }
  merged.schemaVersion = CURRENT_SCHEMA_VERSION
  delete merged._settingsVersion
  if (settings && Object.hasOwn(settings, 'plugins')) {
    merged.plugins = mergePlugins(currentSettings.plugins, settings.plugins)
  }
  for (const [key, section] of settingsSections.entries()) {
    if (settings && Object.hasOwn(settings, key)) {
      const currentSection = cloneSettings({ value: currentSettings[key] }).value
      merged[key] = mergeSettingsSectionValue(section, currentSection, settings[key])
    }
  }

  const changed = key => Object.hasOwn(settings || {}, key)
  if (['directories', 'privateDirectories', 'defaultDirectory'].some(changed)) {
    merged.directories = normalizeDirectoryList(merged.directories)
    merged.privateDirectories = normalizePrivateDirectories(merged.privateDirectories, merged.directories)
    const publicDirectories = getPublicDirectories(merged.directories, merged.privateDirectories)
    if (!merged.defaultDirectory || !publicDirectories.includes(merged.defaultDirectory)) merged.defaultDirectory = publicDirectories[0] || ''
  }
  if (changed('favorites') && !Array.isArray(merged.favorites)) merged.favorites = []
  for (const [key, normalize] of Object.entries({ customTags: normalizeCustomTags, customTagRevisions: normalizeTagRevisions,
    tagMutationReceipts: normalizeTagReceipts, hiddenTags: normalizeHiddenTags, networkResources: normalizeNetworkResources,
    downloadDirectories: normalizeDownloadDirectories, playbackStates: normalizePlaybackStates, privacy: normalizePrivacy,
    remoteAccess: normalizeRemoteAccess, windowClose: normalizeWindowClose, plugins: normalizePlugins })) {
    if (changed(key) && (settingsSections.has(key) || normalizedSettingsPatchFields.get(settings)?.get(key) !== normalize)) merged[key] = normalize(merged[key])
  }
  if (changed('playbackMode')) merged.playbackMode = ['order', 'shuffle', 'single'].includes(merged.playbackMode) ? merged.playbackMode : 'order'
  for (const [key, section] of settingsSections) if (changed(key)) merged[key] = normalizeSettingsSectionValue(section, merged[key])

  return merged
}

function publishSettingsCache(merged, settings, encoded) {
  const prepared = encoded?.snapshot ? { text: encoded.text, owned: encoded.snapshot } : settingsSnapshot(merged, encoded?.text)
  const { text, owned } = prepared
  stampSettings(owned)
  settingsJsonSnapshots.set(owned, { text, id: encoded?.id ?? null })
  settingsCache = owned
  settingsCachePath = getSettingsPath()

  if (Object.hasOwn(settings, 'directories') || Object.hasOwn(settings, 'privateDirectories')) {
    const privateDirectoryKeys = new Set(merged.privateDirectories.map(pathKey))
    for (const key of [...sessionPrivateDirectories]) {
      if (!privateDirectoryKeys.has(key)) sessionPrivateDirectories.delete(key)
    }
    directoryChangeHandler?.([...owned.directories])
  }
  return owned
}

function saveSettings(settings) {
  if (settingsRecoveryInFlight) throw Object.assign(Error('设置正在恢复'), { code: 'settings_busy' })
  const previous = getCachedSettings()
  const merged = mergeSettingsPatch(previous, settings)
  const committed = publishSettingsCache(merged, settings)
  scheduleSettingsWrite()
  notifySettingsChanged(committed, Object.keys(settings || {}), previous)
  return cloneSettings(committed)
}

// 所有异步配置提交和媒体修改共享落盘队列。更新函数在获得队列后
// 读取最新状态，写入成功才发布媒体数据；失败不改变缓存或广播。
// 异步准备和最多三次重试也由同一队列持有；更新函数本身保持同步。
function updateSettingsAndFlush(update, options) {
  return enqueueSettingsUpdate(update, options)
}

function enqueueSettingsUpdate(update, { prepare, retryPreparation, readOnly = false, returnSettings = true, returnVersion = false,
  fields, prepareFields = fields } = {}, directMutation) {
  // Capture selection before queueing, just like direct mutation intent.
  const selected = fields === undefined ? undefined : [...validateSettingsFields(fields)]
  const preparationSelection = prepareFields === undefined ? undefined : [...validateSettingsFields(prepareFields)]
  installSettingsFlushHooks()
  const task = settingsWriteChain.catch(() => {}).then(async () => {
    if (settingsRecoveryInFlight) throw Object.assign(Error('设置正在恢复'), { code: 'settings_busy' })
    settingsWriteInFlight = true
    if (!readOnly) settingsWriteError = null
    try {
      let current, mutation, base
      for (let attempt = 0; ; attempt++) {
        try {
          const prepared = prepare ? await prepare(preparationSelection === undefined ? loadSettings() : loadSettingsFields(preparationSelection)) : undefined
          base = getCachedSettings()
          current = directMutation ? undefined : selected === undefined ? cloneSettings(base) : cloneSettingsFields(base, selected)
          mutation = directMutation || update(current, prepared)
          break
        } catch (error) {
          if (!prepare || attempt >= 2 || !retryPreparation?.(error)) throw error
        }
      }
      if (!mutation || typeof mutation.then === 'function') {
        throw new Error('Settings transaction must return a synchronous mutation')
      }
      const patch = captureSettingsPatch(mutation.patch || {})
      if (readOnly && Object.keys(patch).length) throw new Error('Read-only settings operation cannot commit a patch')
      if (!Object.keys(patch).length) return { ...(returnSettings ? { settings: cloneSettings(selected === undefined ? current || base : base) } : {}),
        ...(returnVersion ? { settingsVersion: getSettingsSnapshotVersion(base) } : {}), value: mutation.value }
      const draft = mergeSettingsPatch(base, patch)
      const encoded = await writeSettingsFile(draft, { base, patch })
      // 兼容同步内部配置写入：在落盘期间发生的其他字段更新不能丢失。
      const latest = getCachedSettings()
      const pathPatch = ['directories', 'privateDirectories', 'defaultDirectory', 'downloadDirectories'].some(key => Object.hasOwn(patch, key))
      const rebased = latest !== base || pathPatch
      const committed = rebased ? mergeSettingsPatch(latest, patch) : draft
      const committedText = latest === base && pathPatch ? JSON.stringify(committed) : undefined
      const sameEncoded = committed === draft || committedText === encoded.text
      const published = publishSettingsCache(committed, patch, sameEncoded ? encoded : committedText === undefined ? undefined : { text: committedText })
      if (latest !== base || (pathPatch && !sameEncoded)) scheduleSettingsWrite()
      notifySettingsChanged(published, Object.keys(patch), latest, sameEncoded)
      return { ...(returnSettings ? { settings: cloneSettings(published) } : {}),
        ...(returnVersion ? { settingsVersion: getSettingsSnapshotVersion(published) } : {}), value: mutation.value }
    } finally {
      settingsWriteInFlight = false
    }
  })
  settingsWriteChain = task.then(() => undefined, () => undefined)
  return task
}

function commitSettingsPatch(settings, options) {
  const patch = captureSettingsPatch(settings)
  return enqueueSettingsUpdate(null, options, { patch })
}

async function saveSettingsAndFlush(settings) {
  return (await commitSettingsPatch(settings)).settings
}

function getMediaAccessSettings() {
  const settings = getCachedSettings()
  return { directories: [...settings.directories], privateDirectories: [...settings.privateDirectories] }
}

function getRemoteAccessSettings() { return { ...getCachedSettings().remoteAccess } }

function getAllowedVideoDirectories() {
  const settings = getCachedSettings()
  const seen = new Set()
  return [
    ...normalizeDirectoryList(settings.directories),
    ...sessionAllowedDirectories
  ]
    .map(dir => resolvePathForAccess(dir))
    .filter(dir => {
      const key = pathKey(dir)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

function getAllowedDownloadDirectories() {
  const settings = getCachedSettings()
  const seen = new Set()
  return [
    ...normalizeDirectoryList(settings.directories),
    ...normalizeDownloadDirectories(settings.downloadDirectories),
    ...sessionAllowedDirectories
  ]
    .map(dir => resolvePathForAccess(dir))
    .filter(dir => {
      const key = pathKey(dir)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

function getPublicVideoDirectories() {
  const settings = getCachedSettings()
  const privateRoots = [
    ...normalizePrivateDirectories(settings.privateDirectories, settings.directories),
    ...sessionPrivateDirectories
  ].map(resolvePathForAccess)
  return getAllowedVideoDirectories()
    .filter(dir => !privateRoots.some(root => isPathInside(root, dir)))
}

function sanitizeSettingsForSave(settings) {
  const fields = Object.keys(settings || {})
  const current = fields.length > 500 ? loadSettings() : loadSettingsFields([
    ...fields, 'directories', 'privateDirectories', 'downloadDirectories', 'mpvPath'
  ])
  const sanitized = { ...settings }
  delete sanitized._settingsVersion
  delete sanitized.schemaVersion

  if (Object.hasOwn(sanitized, 'directories')) {
    const allowedDirectoryKeys = new Set([
      ...normalizeDirectoryList(current.directories),
      ...sessionAllowedDirectories
    ].map(dir => pathKey(resolvePathForAccess(dir))))

    sanitized.directories = normalizeDirectoryList(sanitized.directories)
      .map(dir => resolvePathForAccess(dir))
      .filter(dir => allowedDirectoryKeys.has(pathKey(dir)))
  }

  if (Object.hasOwn(sanitized, 'privateDirectories')) {
    const directories = normalizeDirectoryList(sanitized.directories ?? current.directories).map(dir => resolvePathForAccess(dir))
    sanitized.privateDirectories = normalizePrivateDirectories(sanitized.privateDirectories, directories)
  }

  if (Object.hasOwn(sanitized, 'defaultDirectory')) {
    const directories = normalizeDirectoryList(sanitized.directories ?? current.directories).map(dir => resolvePathForAccess(dir))
    const privateDirectories = normalizePrivateDirectories(sanitized.privateDirectories ?? current.privateDirectories, directories)
    const publicDirectories = getPublicDirectories(directories, privateDirectories)
    const defaultDirectory = typeof sanitized.defaultDirectory === 'string'
      ? resolvePathForAccess(sanitized.defaultDirectory)
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

  if (Object.hasOwn(sanitized, 'networkResources')) {
    sanitized.networkResources = normalizeNetworkResources(sanitized.networkResources)
  }

  if (Object.hasOwn(sanitized, 'downloadDirectories')) {
    const allowedDirectoryKeys = new Set([
      ...normalizeDirectoryList(current.directories),
      ...normalizeDownloadDirectories(current.downloadDirectories),
      ...sessionAllowedDirectories
    ].map(dir => pathKey(resolvePathForAccess(dir))))

    sanitized.downloadDirectories = normalizeDownloadDirectories(sanitized.downloadDirectories)
      .filter(dir => allowedDirectoryKeys.has(pathKey(dir)))
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
  onSettingsCommitted,
  registerSettingsSection,
  registerSettingsSectionAsync,
  loadSettings,
  captureRendererSettings,
  initializeSettings,
  recoverSettingsBackup,
  loadSettingsFields,
  loadSettingsMapKeys,
  readPlaybackState,
  saveSettings,
  saveSettingsAndFlush,
  commitSettingsPatch,
  updateSettingsAndFlush,
  flushSettingsWrites,
  disposeSettingsSerialization,
  sanitizeSettingsForSave,
  sanitizeSettingsForRenderer,
  getSettingsSnapshotVersion,
  normalizeDirectoryList,
  normalizePrivateDirectories,
  normalizePrivacy,
  createPrivacyPassword,
  verifyPrivacyPassword,
  getPublicDirectories,
  normalizeCustomTags,
  normalizeHiddenTags,
  normalizeNetworkResources,
  normalizeDownloadDirectories,
  normalizePlaybackState,
  normalizePlaybackStates,
  normalizeRemoteAccess,
  normalizeWindowClose,
  normalizePlugins,
  resolvePathForAccess,
  mergePlugins,
  removePluginSettings,
  getPlaybackStateKey,
  getPlaybackState,
  upsertPlaybackState,
  addSessionAllowedFile,
  isSessionAllowedFile,
  getAllowedVideoDirectories,
  getMediaAccessSettings,
  getRemoteAccessSettings,
  getAllowedDownloadDirectories,
  getPublicVideoDirectories
}
