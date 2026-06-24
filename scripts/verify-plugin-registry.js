const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const projectRoot = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wallpaper-player-plugin-registry-'))
process.chdir(tempRoot)

const { createPluginRegistry } = require(path.join(projectRoot, 'main', 'plugins', 'registry'))

async function main() {
  const registry = createPluginRegistry()
  let setupCalled = false
  let disabledSetupCalled = false
  let lifecycleSetupCount = 0
  let lifecycleDisposeCount = 0
  let failingDisposeCount = 0
  let registeredSectionNormalizeCount = 0
  let noArgsCapabilityCount = 0

  await registry.setup([
    {
      id: 'test-route',
      name: 'Test Route',
      enabled: true,
      permissions: ['remote:routes'],
      setup(ctx) {
        setupCalled = true
        ctx.settings.defineDefaults({ testRoute: { enabled: true } })
        ctx.settings.defineSchema({ testRoute: { type: 'object' } })
        ctx.remote.route('GET', '/v1/tests/:testId/items/:itemId', () => {})
      }
    },
    {
      id: 'disabled-route',
      name: 'Disabled Route',
      enabled: false,
      setup() {
        disabledSetupCalled = true
      }
    },
    {
      id: 'lifecycle-route',
      name: 'Lifecycle Route',
      enabled: false,
      setup(ctx) {
        lifecycleSetupCount += 1
        ctx.remote.route('GET', '/v1/lifecycle/:value', () => {})
        ctx.capabilities.provide('lifecycle.value', { ok: true })
        ctx.lifecycle.onDispose(() => {
          lifecycleDisposeCount += 1
        })
      }
    },
    {
      id: 'failing-route',
      name: 'Failing Route',
      enabled: true,
      setup(ctx) {
        ctx.remote.route('GET', '/v1/failing', () => {})
        ctx.lifecycle.onDispose(() => {
          failingDisposeCount += 1
        })
        throw new Error('expected setup failure')
      }
    },
    {
      id: 'manual-failing-route',
      name: 'Manual Failing Route',
      enabled: false,
      setup() {
        throw new Error('manual setup failure')
      }
    },
    {
      id: 'settings-section-route',
      name: 'Settings Section Route',
      enabled: false,
      settingsSections: {
        registrySection: {
          defaults: { enabled: false },
          normalize(value) {
            registeredSectionNormalizeCount += 1
            return {
              enabled: Boolean(value?.enabled)
            }
          }
        }
      },
      setup() {}
    },
    {
      id: 'declarative-no-args',
      name: 'Declarative No Args',
      enabled: false,
      executable: false,
      permissions: ['remote:routes', 'video:index:read'],
      contributions: {
        remoteRoutes: [
          {
            method: 'GET',
            pattern: '/v1/declarative/no-args',
            action: {
              capability: 'video-library.query',
              method: 'list'
            }
          }
        ]
      }
    }
  ])

  assert.strictEqual(setupCalled, true)
  assert.strictEqual(disabledSetupCalled, false)

  const plugins = registry.listPlugins()
  assert.strictEqual(plugins.length, 7)
  assert.deepStrictEqual(
    plugins.map(plugin => [plugin.id, plugin.enabled, plugin.status]),
    [
      ['test-route', true, 'active'],
      ['disabled-route', false, 'disabled'],
      ['lifecycle-route', false, 'disabled'],
      ['failing-route', false, 'error'],
      ['manual-failing-route', false, 'disabled'],
      ['settings-section-route', false, 'disabled'],
      ['declarative-no-args', false, 'disabled']
    ]
  )
  const failingPlugin = plugins.find(plugin => plugin.id === 'failing-route')
  assert.strictEqual(failingPlugin.lastError, 'expected setup failure')
  assert.strictEqual(failingPlugin.canEnable, true)
  assert.strictEqual(failingDisposeCount, 1)
  assert.strictEqual(registry.matchRemoteRoute('GET', '/v1/failing'), null)
  assert.deepStrictEqual(plugins[0].permissions, ['remote:routes'])
  assert.deepStrictEqual(plugins[0].settingsDefaults, { testRoute: { enabled: true } })
  assert.deepStrictEqual(plugins[0].settingsSchema, { testRoute: { type: 'object' } })
  assert.deepStrictEqual(registry.getSettingsSchemas()['test-route'], {
    defaults: { testRoute: { enabled: true } },
    schema: { testRoute: { type: 'object' } }
  })

  const match = registry.matchRemoteRoute('GET', '/v1/tests/foo%20bar/items/item_1')
  assert.ok(match)
  assert.strictEqual(match.params.testId, 'foo bar')
  assert.strictEqual(match.params.itemId, 'item_1')
  assert.strictEqual(registry.matchRemoteRoute('POST', '/v1/tests/foo/items/item_1'), null)
  assert.strictEqual(registry.matchRemoteRoute('GET', '/v1/lifecycle/foo'), null)
  assert.strictEqual(registry.getCapability('lifecycle.value'), undefined)
  assert.deepStrictEqual(registry.getSettingsSchemas()['settings-section-route'], {
    defaults: {},
    schema: {}
  })

  registry.provideCoreCapability('video-library.query', {
    list() {
      noArgsCapabilityCount += 1
      return { ok: true }
    }
  })
  const declarativeEnabled = await registry.setPluginEnabled('declarative-no-args', true)
  assert.strictEqual(declarativeEnabled.success, true)
  const declarativeMatch = registry.matchRemoteRoute('GET', '/v1/declarative/no-args')
  assert.ok(declarativeMatch)
  await invokeRoute(declarativeMatch)
  assert.strictEqual(noArgsCapabilityCount, 1)

  const { loadSettings, saveSettings, sanitizeSettingsForSave } = require(path.join(projectRoot, 'main', 'settings'))
  assert.deepStrictEqual(loadSettings().registrySection, { enabled: false })
  assert.ok(registeredSectionNormalizeCount > 0)

  await assert.rejects(
    () => registry.register({
      id: 'duplicate-settings-section-route',
      name: 'Duplicate Settings Section Route',
      settingsSections: {
        registrySection: {
          defaults: { enabled: true }
        }
      },
      setup() {}
    }),
    /Settings section already registered/
  )
  assert.strictEqual(registry.getPlugin('duplicate-settings-section-route'), null)

  const manualFailure = await registry.setPluginEnabled('manual-failing-route', true)
  assert.strictEqual(manualFailure.success, false)
  assert.strictEqual(manualFailure.error, 'manual setup failure')
  assert.strictEqual(manualFailure.plugin.status, 'error')
  assert.strictEqual(manualFailure.plugin.enabled, false)

  const enabled = await registry.setPluginEnabled('lifecycle-route', true)
  assert.strictEqual(enabled.success, true)
  assert.strictEqual(lifecycleSetupCount, 1)
  assert.ok(registry.matchRemoteRoute('GET', '/v1/lifecycle/foo'))
  assert.deepStrictEqual(registry.getCapability('lifecycle.value'), { ok: true })
  assert.strictEqual(loadSettings().plugins['lifecycle-route']?.enabled, true)

  const pluginSettingsPath = path.join(tempRoot, '.tmp-wallpaper-player', 'settings.json')
  const staleSettings = loadSettings()
  staleSettings.plugins['lifecycle-route'].enabled = false
  fs.mkdirSync(path.dirname(pluginSettingsPath), { recursive: true })
  fs.writeFileSync(pluginSettingsPath, JSON.stringify(staleSettings, null, 2))
  const noOpEnabled = await registry.setPluginEnabled('lifecycle-route', true)
  assert.strictEqual(noOpEnabled.success, true)
  assert.strictEqual(loadSettings().plugins['lifecycle-route']?.enabled, true)
  saveSettings(sanitizeSettingsForSave({
    plugins: {
      'lifecycle-route': {
        enabled: false,
        config: {}
      }
    }
  }))
  saveSettings(sanitizeSettingsForSave({ theme: 'light' }))
  assert.strictEqual(loadSettings().plugins['lifecycle-route']?.enabled, false)

  const disabled = await registry.setPluginEnabled('lifecycle-route', false)
  assert.strictEqual(disabled.success, true)
  assert.strictEqual(lifecycleDisposeCount, 1)
  assert.strictEqual(registry.matchRemoteRoute('GET', '/v1/lifecycle/foo'), null)
  assert.strictEqual(registry.getCapability('lifecycle.value'), undefined)

  await registry.dispose()
  assert.strictEqual(registry.matchRemoteRoute('GET', '/v1/tests/foo/items/item_1'), null)

  console.log('plugin registry verification passed')
}

async function invokeRoute(match) {
  const req = {
    method: 'GET',
    headers: {},
    on() {},
    setEncoding() {}
  }
  const res = {
    writeHead() {},
    end() {}
  }
  await match.route.handler(req, res, {
    params: match.params,
    url: new URL('http://127.0.0.1/declarative/no-args')
  })
}

main()
  .finally(() => {
    process.chdir(projectRoot)
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
