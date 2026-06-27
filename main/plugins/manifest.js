const path = require('path')

const MANIFEST_FILE = 'plugin.json'
const MANIFEST_VERSION = 1
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/
const PERMISSION_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,79}$/
const MAX_TEXT_LENGTH = 400
const MAX_PERMISSIONS = 32
const MAX_SETTINGS_KEYS = 24
const MAX_REMOTE_ROUTES = 16
const MAX_ACTION_ARGS = 8
const ALLOWED_REMOTE_METHODS = new Set(['GET', 'POST'])
const MAX_SECRET_KEYS = 16
const CAPABILITY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/
const SETTINGS_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const METHOD_PATTERN = /^[a-z][a-zA-Z0-9_]{0,63}$/

function asPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function normalizeText(value, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : ''
  return (text || fallback).slice(0, MAX_TEXT_LENGTH)
}

function normalizePluginId(id) {
  const value = normalizeText(id).toLowerCase()
  if (!ID_PATTERN.test(value)) {
    throw new Error('Invalid plugin id. Use 2-64 lowercase letters, numbers, dot, dash, or underscore.')
  }
  return value
}

function normalizePermissions(permissions) {
  if (!Array.isArray(permissions)) return []
  return [...new Set(
    permissions
      .filter(item => typeof item === 'string')
      .map(item => item.trim())
      .filter(item => PERMISSION_PATTERN.test(item))
  )].slice(0, MAX_PERMISSIONS)
}

function normalizeSettingsSchema(schema) {
  const source = asPlainObject(schema)
  const normalized = {}
  for (const [key, value] of Object.entries(source).slice(0, MAX_SETTINGS_KEYS)) {
    if (!SETTINGS_KEY_PATTERN.test(key)) continue
    const item = asPlainObject(value)
    normalized[key] = {
      type: ['object', 'string', 'number', 'boolean', 'enum', 'array'].includes(item.type) ? item.type : 'object',
      title: normalizeText(item.title, key),
      description: normalizeText(item.description)
    }
    if (Array.isArray(item.enum)) {
      normalized[key].enum = item.enum
        .filter(option => typeof option === 'string' || typeof option === 'number' || typeof option === 'boolean')
        .slice(0, 50)
    }
  }
  return normalized
}

function normalizeSecretKeys(secretKeys) {
  if (!Array.isArray(secretKeys)) return []
  return [...new Set(
    secretKeys
      .filter(item => typeof item === 'string')
      .map(item => item.trim())
      .filter(item => SETTINGS_KEY_PATTERN.test(item))
  )].slice(0, MAX_SECRET_KEYS)
}

function isPluginRoutePattern(pattern) {
  return typeof pattern === 'string' && /^\/plugins\/[a-z0-9._-]+(?:\/[a-z0-9._~:/-]+)?$/i.test(pattern)
}

function normalizeRemoteRoutes(routes, pluginId) {
  if (!Array.isArray(routes)) return []
  const normalized = []
  for (const route of routes.slice(0, MAX_REMOTE_ROUTES)) {
    const value = asPlainObject(route)
    const method = normalizeText(value.method, 'GET').toUpperCase()
    const pattern = normalizeText(value.pattern)
    if (!ALLOWED_REMOTE_METHODS.has(method)) continue
    if (!isPluginRoutePattern(pattern)) continue
    const expectedPrefix = `/plugins/${pluginId}`
    if (pattern !== expectedPrefix && !pattern.startsWith(`${expectedPrefix}/`)) continue
    normalized.push({
      method,
      pattern,
      routePattern: `/v1${pattern}`,
      response: normalizeRouteResponse(value.response),
      action: normalizeRouteAction(value.action)
    })
  }
  return normalized
}

function normalizeRouteAction(action) {
  const value = asPlainObject(action)
  const capability = normalizeText(value.capability)
  const method = normalizeText(value.method)
  if (!CAPABILITY_PATTERN.test(capability) || !METHOD_PATTERN.test(method)) return null
  const args = Array.isArray(value.args)
    ? value.args.slice(0, MAX_ACTION_ARGS).map(normalizeActionArg).filter(Boolean)
    : []
  return { capability, method, args }
}

function normalizeActionArg(arg) {
  const value = asPlainObject(arg)
  const source = normalizeText(value.source)
  if (source === 'literal') return { source, value: value.value }
  if (!['param', 'query', 'body', 'config'].includes(source)) return null
  const key = normalizeText(value.key)
  if (!key || key.length > 80) return null
  return { source, key }
}

function normalizeRouteResponse(response) {
  const value = asPlainObject(response)
  const body = asPlainObject(value.body)
  return {
    status: Number.isInteger(value.status) && value.status >= 200 && value.status <= 599 ? value.status : 200,
    body: JSON.parse(JSON.stringify(body))
  }
}

function normalizeContributions(contributions, pluginId) {
  const value = asPlainObject(contributions)
  return {
    remoteRoutes: normalizeRemoteRoutes(value.remoteRoutes, pluginId)
  }
}

function normalizeManifest(rawManifest, options = {}) {
  const raw = asPlainObject(rawManifest)
  const manifestVersion = Number(raw.manifestVersion)
  if (manifestVersion !== MANIFEST_VERSION) {
    throw new Error(`Unsupported plugin manifestVersion: ${raw.manifestVersion}`)
  }

  const id = normalizePluginId(raw.id)
  const plugin = {
    id,
    name: normalizeText(raw.name, id),
    version: normalizeText(raw.version, '0.0.0'),
    description: normalizeText(raw.description),
    author: normalizeText(raw.author),
    publisher: normalizeText(options.publisher || raw.publisher, 'third-party'),
    homepage: normalizeText(raw.homepage),
    entry: normalizeText(raw.entry || 'index.js'),
    manifestVersion: MANIFEST_VERSION,
    source: options.source || 'user',
    location: options.location ? path.resolve(options.location) : '',
    external: true,
    trusted: options.publisher === 'official',
    executable: options.executable === true,
    enabled: raw.enabled === true,
    status: normalizeText(raw.status) || undefined,
    configurable: raw.configurable !== false,
    permissions: normalizePermissions(raw.permissions),
    settingsDefaults: asPlainObject(raw.settingsDefaults),
    settingsSchema: normalizeSettingsSchema(raw.settingsSchema),
    secretKeys: normalizeSecretKeys(raw.secretKeys),
    contributions: null
  }
  plugin.contributions = normalizeContributions(raw.contributions, id)
  return plugin
}

module.exports = {
  MANIFEST_FILE,
  MANIFEST_VERSION,
  normalizeManifest
}
