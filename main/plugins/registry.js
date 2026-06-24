const crypto = require('crypto')
const path = require('path')
const { ipcMain } = require('electron')
const { EventEmitter } = require('events')
const { loadSettings, saveSettings, sanitizeSettingsForSave, registerSettingsSection } = require('../settings')
const { sendJson, readBody } = require('../remote/http-utils')
const { requireCoreModule } = require('./core-api')

function normalizePluginId(id) {
  return String(id || '').trim()
}

function normalizeMethod(method) {
  return String(method || '').trim().toUpperCase()
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function compileRoutePattern(pattern) {
  const keys = []
  const parts = String(pattern || '')
    .split('/')
    .filter(Boolean)
    .map(part => {
      if (part.startsWith(':')) {
        keys.push(part.slice(1))
        return '([^/]+)'
      }
      return escapeRegExp(part)
    })

  return {
    keys,
    regex: new RegExp(`^/${parts.join('/')}$`)
  }
}

const CAPABILITY_PERMISSIONS = {
  'video-library.query': {
    list: 'video:index:read'
  },
  'player.control': {
    playVideo: 'player:control'
  },
  'video-analysis.summary': {
    get: 'video-analysis:read',
    start: 'video-analysis:start'
  }
}

function hasPluginPermission(plugin, permission) {
  return Boolean(permission && plugin.permissions?.includes(permission))
}

function getActionPermission(action) {
  const permission = CAPABILITY_PERMISSIONS[action.capability]
  if (typeof permission === 'string') return permission
  if (!permission) return ''
  return permission[action.method] || permission['*'] || ''
}

function assertActionAllowed(plugin, action) {
  const permission = getActionPermission(action)
  if (!permission) {
    throw Object.assign(new Error(`Plugin ${plugin.id} cannot call capability ${action.capability}.${action.method}`), {
      status: 403,
      code: 'plugin_capability_not_allowed'
    })
  }
  if (!hasPluginPermission(plugin, permission)) {
    throw Object.assign(new Error(`Plugin ${plugin.id} missing permission ${permission}`), {
      status: 403,
      code: 'plugin_permission_denied'
    })
  }
}

function createPluginRegistry() {
  const plugins = new Map()
  const remoteRoutes = []
  const capabilities = new Map()
  const events = new EventEmitter()
  let setupComplete = false

  function createSetupErrorPlugin(plugin, error) {
    const seed = [
      plugin?.id,
      plugin?.location,
      plugin?.installDirectoryName,
      error?.message || String(error)
    ].join('|')
    const baseId = `invalid.${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 12)}`
    let id = baseId
    let suffix = 1
    while (plugins.has(id)) {
      id = `${baseId}.${suffix}`
      suffix += 1
    }
    return {
      id,
      name: plugin?.name || plugin?.id || 'Invalid plugin',
      version: plugin?.version || '',
      description: plugin?.description || '',
      source: plugin?.source || 'user',
      publisher: plugin?.publisher || 'third-party',
      external: true,
      trusted: false,
      executable: false,
      enabled: false,
      status: 'error',
      loadError: true,
      lastError: error?.message || String(error),
      location: plugin?.location || '',
      installDirectoryName: plugin?.installDirectoryName || (plugin?.location ? path.basename(plugin.location) : ''),
      permissions: [],
      settingsDefaults: {},
      settingsSchema: {},
      contributions: { remoteRoutes: [] }
    }
  }

  function createContext(plugin, pluginState) {
    function assertActive() {
      if (!pluginState.active) {
        throw new Error(`Plugin ${plugin.id} is not active`)
      }
    }

    function addDisposer(disposer) {
      if (typeof disposer === 'function') {
        pluginState.disposers.push(disposer)
      }
      return disposer
    }

    return {
      id: plugin.id,
      name: plugin.name || plugin.id,
      ipc: {
        handle(channel, handler) {
          assertActive()
          if (typeof handler !== 'function') {
            throw new Error(`Plugin ${plugin.id} IPC handler must be a function`)
          }
          ipcMain.handle(channel, handler)
          return addDisposer(() => ipcMain.removeHandler(channel))
        }
      },
      remote: {
        route(method, pattern, handler) {
          assertActive()
          if (typeof handler !== 'function') {
            throw new Error(`Plugin ${plugin.id} remote route handler must be a function`)
          }
          const compiled = compileRoutePattern(pattern)
          const route = {
            pluginId: plugin.id,
            method: normalizeMethod(method),
            pattern,
            keys: compiled.keys,
            regex: compiled.regex,
            handler
          }
          remoteRoutes.push(route)
          return addDisposer(() => {
            const index = remoteRoutes.indexOf(route)
            if (index >= 0) remoteRoutes.splice(index, 1)
          })
        }
      },
      settings: {
        get() {
          return loadSettings()
        },
        savePatch(patch) {
          return saveSettings(sanitizeSettingsForSave(patch))
        },
        defineDefaults(defaults) {
          plugin.settingsDefaults = defaults && typeof defaults === 'object' ? defaults : {}
        },
        defineSchema(schema) {
          plugin.settingsSchema = schema && typeof schema === 'object' ? schema : {}
        },
        defineSection(key, definition) {
          return addDisposer(registerSettingsSection(key, definition))
        }
      },
      capabilities: {
        provide(name, value) {
          assertActive()
          const key = String(name || '').trim()
          if (!key) throw new Error(`Plugin ${plugin.id} capability name is required`)
          if (capabilities.has(key)) {
            throw new Error(`Capability already registered: ${key}`)
          }
          capabilities.set(key, { pluginId: plugin.id, value })
          return addDisposer(() => {
            const current = capabilities.get(key)
            if (current?.pluginId === plugin.id) capabilities.delete(key)
          })
        },
        get(name) {
          return capabilities.get(String(name || '').trim())?.value
        }
      },
      plugins: {
        getConfig() {
          return loadSettings()?.plugins?.[plugin.id]?.config || {}
        },
        saveConfig(config) {
          return saveSettings(sanitizeSettingsForSave({
            plugins: {
              [plugin.id]: {
                config: config && typeof config === 'object' && !Array.isArray(config) ? config : {},
                updatedAt: new Date().toISOString()
              }
            }
          }))?.plugins?.[plugin.id]?.config || {}
        }
      },
      events,
      lifecycle: {
        onDispose(disposer) {
          return addDisposer(disposer)
        }
      },
      isEnabled() {
        return Boolean(plugin.enabled)
      },
      requireCore(name) {
        if (!plugin.trusted || !plugin.executable) {
          throw new Error(`Plugin ${plugin.id} cannot require core modules`)
        }
        return requireCoreModule(name)
      }
    }
  }

  async function disposePlugin(pluginState) {
    if (!pluginState?.active) return
    for (const disposer of [...pluginState.disposers].reverse()) {
      try {
        await disposer()
      } catch {}
    }
    pluginState.disposers.length = 0
    pluginState.active = false
  }

  async function cleanupPluginActivation(pluginState) {
    for (const disposer of [...pluginState.disposers].reverse()) {
      try {
        await disposer()
      } catch {}
    }
    pluginState.disposers.length = 0
    pluginState.active = false
  }

  function getPersistedEnabled(id, fallbackEnabled) {
    const state = loadSettings()?.plugins?.[id]
    if (state && Object.hasOwn(state, 'enabled')) return Boolean(state.enabled)
    return fallbackEnabled
  }

  function getPluginStatus(plugin) {
    if (plugin.status === 'planned') return 'planned'
    return plugin.enabled ? 'active' : 'disabled'
  }

  function canEnable(plugin) {
    return plugin.status !== 'planned' && !plugin.loadError && typeof plugin.setup === 'function'
  }

  function getStoredPluginConfig(id) {
    return loadSettings()?.plugins?.[id]?.config || {}
  }

  function persistPluginState(plugin) {
    saveSettings(sanitizeSettingsForSave({
      plugins: {
        [plugin.id]: {
          enabled: plugin.enabled,
          config: getStoredPluginConfig(plugin.id),
          updatedAt: new Date().toISOString()
        }
      }
    }))
  }

  function normalizePluginConfig(plugin, config) {
    const source = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
    const schema = plugin.settingsSchema && typeof plugin.settingsSchema === 'object' ? plugin.settingsSchema : {}
    const defaults = plugin.settingsDefaults && typeof plugin.settingsDefaults === 'object' ? plugin.settingsDefaults : {}
    const normalized = {}
    for (const [key, field] of Object.entries(schema)) {
      const value = Object.hasOwn(source, key) ? source[key] : defaults[key]
      if (field?.type === 'boolean') {
        normalized[key] = Boolean(value)
      } else if (field?.type === 'number') {
        const number = Number(value)
        normalized[key] = Number.isFinite(number) ? number : 0
      } else if (field?.type === 'enum') {
        normalized[key] = Array.isArray(field.enum) && field.enum.includes(value) ? value : field.enum?.[0] ?? ''
      } else if (field?.type === 'object') {
        normalized[key] = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
      } else {
        normalized[key] = typeof value === 'string' ? value : ''
      }
    }
    return normalized
  }

  function createDeclarativeSetup(plugin) {
    const remoteRoutes = Array.isArray(plugin.contributions?.remoteRoutes)
      ? plugin.contributions.remoteRoutes
      : []
    return function setupDeclarativePlugin(ctx) {
      for (const route of remoteRoutes) {
        assertDeclarativeRouteAllowed(plugin, route)
        ctx.remote.route(route.method, route.routePattern || route.pattern, async (req, res, routeContext = {}) => {
          const actionResult = route.action
            ? await executeRouteAction(plugin, route, req, routeContext)
            : null
          sendJson(req, res, route.response?.status || 200, {
            plugin: {
              id: plugin.id,
              name: plugin.name,
              version: plugin.version
            },
            result: actionResult,
            ...(route.response?.body || {})
          })
        })
      }
    }
  }

  async function executeRouteAction(plugin, route, req, routeContext) {
    const action = route.action
    assertActionAllowed(plugin, action)
    const capability = getCapability(action.capability)
    const method = capability?.[action.method]
    if (typeof method !== 'function') {
      throw Object.assign(new Error(`Capability not available: ${action.capability}.${action.method}`), {
        status: 503,
        code: 'plugin_capability_unavailable'
      })
    }
    const body = req.method === 'POST' ? await readBody(req) : {}
    const actionArgs = Array.isArray(action.args) ? action.args : []
    const args = actionArgs.map(arg => resolveActionArg(arg, {
      params: routeContext.params || {},
      url: routeContext.url,
      body,
      config: getStoredPluginConfig(plugin.id)
    }))
    return method(...args)
  }

  function assertDeclarativeRouteAllowed(plugin, route) {
    if (!hasPluginPermission(plugin, 'remote:routes')) {
      throw Object.assign(new Error(`Plugin ${plugin.id} missing permission remote:routes`), {
        status: 403,
        code: 'plugin_permission_denied'
      })
    }
    if (!route.action) return
    assertActionAllowed(plugin, route.action)
  }

  function resolveActionArg(arg, context) {
    if (arg.source === 'literal') return arg.value
    if (arg.source === 'param') return context.params[arg.key]
    if (arg.source === 'query') return context.url?.searchParams?.get(arg.key) || ''
    if (arg.source === 'body') return context.body?.[arg.key]
    if (arg.source === 'config') return context.config?.[arg.key]
    return undefined
  }

  async function setupPlugin(pluginState) {
    const { plugin, context } = pluginState
    if (!plugin.enabled || pluginState.active || typeof plugin.setup !== 'function') return
    pluginState.active = true
    try {
      await plugin.setup(context)
    } catch (error) {
      plugin.enabled = false
      plugin.status = 'error'
      plugin.lastError = error?.message || String(error)
      await cleanupPluginActivation(pluginState)
      throw error
    }
    plugin.status = getPluginStatus(plugin)
    plugin.lastError = ''
  }

  async function activateRegisteredPlugin(pluginState, options = {}) {
    try {
      await setupPlugin(pluginState)
    } catch (error) {
      if (options.throwOnError) throw error
    }
  }

  async function register(plugin, options = {}) {
    const id = normalizePluginId(plugin?.id)
    if (!id) throw new Error('Plugin id is required')
    if (plugins.has(id)) throw new Error(`Plugin already registered: ${id}`)
    const defaultEnabled = plugin.enabled === true
    const enabled = plugin.status === 'planned' ? false : getPersistedEnabled(id, defaultEnabled)

    const normalizedPlugin = {
      ...plugin,
      id,
      name: plugin.name || id,
      enabled,
      status: plugin.status || (enabled ? 'active' : 'disabled'),
      source: plugin.source || 'user',
      publisher: plugin.publisher || (plugin.official ? 'official' : 'third-party'),
      official: Boolean(plugin.official || plugin.publisher === 'official'),
      external: true,
      trusted: Boolean(plugin.trusted || plugin.official || plugin.publisher === 'official'),
      executable: Boolean(plugin.executable),
      location: plugin.location || '',
      author: plugin.author || '',
      homepage: plugin.homepage || '',
      manifestVersion: plugin.manifestVersion || null,
      loadError: Boolean(plugin.loadError),
      uninstallable: Boolean(plugin.installDirectoryName) || !(plugin.official || plugin.publisher === 'official'),
      installDirectoryName: plugin.installDirectoryName || '',
      configurable: plugin.configurable !== false,
      settingsDefaults: plugin.settingsDefaults && typeof plugin.settingsDefaults === 'object' ? plugin.settingsDefaults : {},
      settingsSchema: plugin.settingsSchema && typeof plugin.settingsSchema === 'object' ? plugin.settingsSchema : {},
      contributions: plugin.contributions && typeof plugin.contributions === 'object' ? plugin.contributions : {}
    }
    if (!normalizedPlugin.executable && typeof normalizedPlugin.setup !== 'function') {
      normalizedPlugin.setup = createDeclarativeSetup(normalizedPlugin)
    }
    const pluginState = {
      plugin: normalizedPlugin,
      context: null,
      active: false,
      disposers: [],
      registrationDisposers: []
    }
    pluginState.context = createContext(normalizedPlugin, pluginState)

    try {
      if (normalizedPlugin.settingsSections && typeof normalizedPlugin.settingsSections === 'object') {
        for (const [key, definition] of Object.entries(normalizedPlugin.settingsSections)) {
          pluginState.registrationDisposers.push(registerSettingsSection(key, definition))
        }
      }
      if (Object.keys(normalizedPlugin.settingsSchema || {}).length) {
        const currentState = loadSettings()?.plugins?.[normalizedPlugin.id] || {}
        const now = new Date().toISOString()
        saveSettings(sanitizeSettingsForSave({
          plugins: {
            [normalizedPlugin.id]: {
              config: normalizePluginConfig(normalizedPlugin, currentState.config),
              ...(currentState.installedAt ? {} : { installedAt: now }),
              ...(currentState.updatedAt ? {} : { updatedAt: now })
            }
          }
        }))
      }
    } catch (error) {
      for (const disposer of [...pluginState.registrationDisposers].reverse()) {
        try {
          await disposer()
        } catch {}
      }
      pluginState.registrationDisposers.length = 0
      throw error
    }

    plugins.set(id, pluginState)
    try {
      await activateRegisteredPlugin(pluginState, {
        throwOnError: Boolean(options.throwOnActivationError)
      })
    } catch (error) {
      await unregister(id)
      throw error
    }
    return normalizedPlugin
  }

  async function unregister(id) {
    const pluginState = plugins.get(normalizePluginId(id))
    if (!pluginState) return false
    await disposePlugin(pluginState)
    for (const disposer of [...pluginState.registrationDisposers].reverse()) {
      try {
        await disposer()
      } catch {}
    }
    pluginState.registrationDisposers.length = 0
    plugins.delete(pluginState.plugin.id)
    return true
  }

  async function setup(pluginsToRegister = []) {
    if (setupComplete) return listPlugins()
    for (const plugin of pluginsToRegister) {
      try {
        await register(plugin)
      } catch (error) {
        try {
          await register(createSetupErrorPlugin(plugin, error))
        } catch {}
      }
    }
    setupComplete = true
    return listPlugins()
  }

  function listPlugins() {
    const settings = loadSettings()
    return [...plugins.values()].map(({ plugin }) => {
      const persisted = settings?.plugins?.[plugin.id] || {}
      return {
        id: plugin.id,
        name: plugin.name,
        version: plugin.version || '',
        enabled: plugin.enabled,
        status: plugin.status,
        description: plugin.description || '',
        source: plugin.source || 'user',
        publisher: plugin.publisher || 'third-party',
        official: Boolean(plugin.official || plugin.publisher === 'official'),
        external: true,
        trusted: Boolean(plugin.trusted),
        executable: Boolean(plugin.executable),
        location: plugin.location || '',
        author: plugin.author || '',
        homepage: plugin.homepage || '',
        manifestVersion: plugin.manifestVersion || null,
        loadError: Boolean(plugin.loadError),
        uninstallable: Boolean(plugin.uninstallable),
        installDirectoryName: plugin.installDirectoryName || '',
        permissions: Array.isArray(plugin.permissions) ? plugin.permissions : [],
        configurable: plugin.configurable !== false,
        canEnable: canEnable(plugin),
        lastError: plugin.lastError || '',
        config: persisted.config || {},
        installedAt: persisted.installedAt || '',
        updatedAt: persisted.updatedAt || '',
        settingsDefaults: plugin.settingsDefaults || {},
        settingsSchema: plugin.settingsSchema || {},
        contributions: plugin.contributions || {}
      }
    })
  }

  function getPlugin(id) {
    return plugins.get(normalizePluginId(id))?.plugin || null
  }

  async function setPluginEnabled(id, enabled) {
    const pluginState = plugins.get(normalizePluginId(id))
    if (!pluginState) {
      return { success: false, error: '插件不存在' }
    }

    const { plugin } = pluginState
    const nextEnabled = Boolean(enabled)
    if (nextEnabled && !canEnable(plugin)) {
      return { success: false, error: plugin.status === 'planned' ? '插件仍在规划中' : '插件不可启用' }
    }

    if (plugin.enabled === nextEnabled && pluginState.active === nextEnabled) {
      persistPluginState(plugin)
      return { success: true, plugin: listPlugins().find(item => item.id === plugin.id) }
    }

    if (!nextEnabled) {
      await disposePlugin(pluginState)
      plugin.enabled = false
      plugin.status = getPluginStatus(plugin)
      plugin.lastError = ''
    } else {
      plugin.enabled = true
      plugin.status = 'active'
      try {
        await setupPlugin(pluginState)
      } catch (error) {
        plugin.enabled = false
        plugin.status = 'error'
        plugin.lastError = error?.message || String(error)
        events.emit('plugin-state-changed', { id: plugin.id, enabled: plugin.enabled, status: plugin.status })
        return {
          success: false,
          error: plugin.lastError,
          plugin: listPlugins().find(item => item.id === plugin.id)
        }
      }
    }

    persistPluginState(plugin)

    events.emit('plugin-state-changed', { id: plugin.id, enabled: plugin.enabled, status: plugin.status })
    return { success: true, plugin: listPlugins().find(item => item.id === plugin.id) }
  }

  function getSettingsSchemas() {
    return Object.fromEntries(
      [...plugins.values()].map(({ plugin }) => [
        plugin.id,
        {
          defaults: plugin.settingsDefaults || {},
          schema: plugin.settingsSchema || {}
        }
      ])
    )
  }

  function matchRemoteRoute(method, pathname) {
    const normalizedMethod = normalizeMethod(method)
    for (const route of remoteRoutes) {
      if (route.method !== normalizedMethod) continue
      const match = route.regex.exec(pathname)
      if (!match) continue
      const params = {}
      for (let i = 0; i < route.keys.length; i += 1) {
        try {
          params[route.keys[i]] = decodeURIComponent(match[i + 1])
        } catch {
          params[route.keys[i]] = ''
        }
      }
      return { route, params }
    }
    return null
  }

  function getCapability(name) {
    return capabilities.get(String(name || '').trim())?.value
  }

  function provideCoreCapability(name, value) {
    const key = String(name || '').trim()
    if (!key) throw new Error('Core capability name is required')
    if (capabilities.has(key)) {
      throw new Error(`Capability already registered: ${key}`)
    }
    capabilities.set(key, { pluginId: 'core', value })
    return () => {
      const current = capabilities.get(key)
      if (current?.pluginId === 'core') capabilities.delete(key)
    }
  }

  async function dispose() {
    for (const pluginState of [...plugins.values()].reverse()) {
      await disposePlugin(pluginState)
      for (const disposer of [...pluginState.registrationDisposers].reverse()) {
        try {
          await disposer()
        } catch {}
      }
      pluginState.registrationDisposers.length = 0
    }
    remoteRoutes.length = 0
    capabilities.clear()
    events.removeAllListeners()
    plugins.clear()
    setupComplete = false
  }

  return {
    register,
    unregister,
    setup,
    listPlugins,
    getPlugin,
    setPluginEnabled,
    getSettingsSchemas,
    matchRemoteRoute,
    getCapability,
    normalizePluginConfig,
    provideCoreCapability,
    dispose
  }
}

module.exports = {
  createPluginRegistry
}
