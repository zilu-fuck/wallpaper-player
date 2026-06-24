const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { app } = require('electron')

const projectRoot = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wallpaper-player-external-plugin-'))
const sourceRoot = path.join(tempRoot, 'source-plugin')
const brokenRoot = path.join(tempRoot, 'broken-plugin')
const officialCollisionRoot = path.join(tempRoot, 'official-collision-plugin')
const permissionDeniedRoot = path.join(tempRoot, 'permission-denied-plugin')
const remotePermissionDeniedRoot = path.join(tempRoot, 'remote-permission-denied-plugin')
const analysisStartDeniedRoot = path.join(tempRoot, 'analysis-start-denied-plugin')
const unknownCapabilityRoot = path.join(tempRoot, 'unknown-capability-plugin')
const directJobsCapabilityRoot = path.join(tempRoot, 'direct-jobs-capability-plugin')
const pathLeakRoot = path.join(tempRoot, 'path-leak-plugin')
  const replacementRoot = path.join(tempRoot, 'replacement-plugin')
  const failingReplacementRoot = path.join(tempRoot, 'failing-replacement-plugin')

async function main() {
  app.setPath('userData', path.join(tempRoot, 'user-data'))
  fs.mkdirSync(sourceRoot, { recursive: true })
  fs.writeFileSync(path.join(sourceRoot, 'plugin.json'), JSON.stringify({
    manifestVersion: 1,
    id: 'sample.external',
    name: 'Sample External',
    version: '1.0.0',
    description: 'Declarative external plugin fixture',
    author: 'Verifier',
    permissions: ['remote:routes', 'video:index:read'],
    settingsDefaults: {
      greeting: 'hello'
    },
    settingsSchema: {
      greeting: {
        type: 'string',
        title: 'Greeting',
        description: 'Response greeting'
      }
    },
    contributions: {
      remoteRoutes: [
        {
          method: 'GET',
          pattern: '/plugins/sample.external/hello/:name',
          action: {
            capability: 'video-library.query',
            method: 'list',
            args: [
              { source: 'literal', value: { limit: 2 } }
            ]
          },
          response: {
            body: {
              ok: true
            }
          }
        }
      ]
    }
  }, null, 2))
  fs.mkdirSync(brokenRoot, { recursive: true })
  fs.writeFileSync(path.join(brokenRoot, 'plugin.json'), '{')
  fs.mkdirSync(officialCollisionRoot, { recursive: true })
  fs.writeFileSync(path.join(officialCollisionRoot, 'plugin.json'), JSON.stringify({
    manifestVersion: 1,
    id: 'video-analysis',
    name: 'Fake Video Analysis',
    version: '1.0.0'
  }, null, 2))
  fs.mkdirSync(permissionDeniedRoot, { recursive: true })
  fs.writeFileSync(path.join(permissionDeniedRoot, 'plugin.json'), JSON.stringify({
    manifestVersion: 1,
    id: 'permission.denied',
    name: 'Permission Denied',
    version: '1.0.0',
    permissions: ['remote:routes'],
    contributions: {
      remoteRoutes: [
        {
          method: 'GET',
          pattern: '/plugins/permission.denied/videos',
          action: {
            capability: 'video-library.query',
            method: 'list',
            args: [
              { source: 'literal', value: { limit: 1 } }
            ]
          }
        }
      ]
    }
  }, null, 2))
  fs.mkdirSync(remotePermissionDeniedRoot, { recursive: true })
  fs.writeFileSync(path.join(remotePermissionDeniedRoot, 'plugin.json'), JSON.stringify({
    manifestVersion: 1,
    id: 'remote.permission.denied',
    name: 'Remote Permission Denied',
    version: '1.0.0',
    contributions: {
      remoteRoutes: [
        {
          method: 'GET',
          pattern: '/plugins/remote.permission.denied/ping'
        }
      ]
    }
  }, null, 2))
  fs.mkdirSync(analysisStartDeniedRoot, { recursive: true })
  fs.writeFileSync(path.join(analysisStartDeniedRoot, 'plugin.json'), JSON.stringify({
    manifestVersion: 1,
    id: 'analysis.start.denied',
    name: 'Analysis Start Denied',
    version: '1.0.0',
    permissions: ['remote:routes', 'video-analysis:read'],
    contributions: {
      remoteRoutes: [
        {
          method: 'POST',
          pattern: '/plugins/analysis.start.denied/start/:videoId',
          action: {
            capability: 'video-analysis.summary',
            method: 'start',
            args: [
              { source: 'param', key: 'videoId' }
            ]
          }
        }
      ]
    }
  }, null, 2))
  fs.mkdirSync(unknownCapabilityRoot, { recursive: true })
  fs.writeFileSync(path.join(unknownCapabilityRoot, 'plugin.json'), JSON.stringify({
    manifestVersion: 1,
    id: 'unknown.capability',
    name: 'Unknown Capability',
    version: '1.0.0',
    permissions: ['remote:routes'],
    contributions: {
      remoteRoutes: [
        {
          method: 'GET',
          pattern: '/plugins/unknown.capability/run',
          action: {
            capability: 'video-analysis.jobs',
            method: 'getActiveAnalysisJob'
          }
        }
      ]
    }
  }, null, 2))
  fs.mkdirSync(directJobsCapabilityRoot, { recursive: true })
  fs.writeFileSync(path.join(directJobsCapabilityRoot, 'plugin.json'), JSON.stringify({
    manifestVersion: 1,
    id: 'direct.jobs',
    name: 'Direct Jobs',
    version: '1.0.0',
    permissions: ['remote:routes', 'video-analysis:start'],
    contributions: {
      remoteRoutes: [
        {
          method: 'POST',
          pattern: '/plugins/direct.jobs/start',
          action: {
            capability: 'video-analysis.jobs',
            method: 'startVideoAnalysis',
            args: [
              { source: 'literal', value: 'C:\\\\not-allowed.mp4' }
            ]
          }
        }
      ]
    }
  }, null, 2))
  fs.mkdirSync(pathLeakRoot, { recursive: true })
  fs.writeFileSync(path.join(pathLeakRoot, 'plugin.json'), JSON.stringify({
    manifestVersion: 1,
    id: 'path.leak',
    name: 'Path Leak',
    version: '1.0.0',
    permissions: ['remote:routes', 'video:index:read'],
    contributions: {
      remoteRoutes: [
        {
          method: 'GET',
          pattern: '/plugins/path.leak/:videoId',
          action: {
            capability: 'video-library.query',
            method: 'resolveVideoPathById',
            args: [
              { source: 'param', key: 'videoId' }
            ]
          }
        }
      ]
    }
  }, null, 2))
  fs.mkdirSync(replacementRoot, { recursive: true })
  fs.writeFileSync(path.join(replacementRoot, 'plugin.json'), JSON.stringify({
    manifestVersion: 1,
    id: 'sample.external',
    name: 'Sample External Replacement',
    version: '2.0.0',
    description: 'Replacement fixture',
    author: 'Verifier',
    permissions: ['remote:routes', 'video:index:read'],
    contributions: {
      remoteRoutes: [
        {
          method: 'GET',
          pattern: '/plugins/sample.external/replacement'
        }
      ]
    }
  }, null, 2))
  fs.mkdirSync(failingReplacementRoot, { recursive: true })
  fs.writeFileSync(path.join(failingReplacementRoot, 'plugin.json'), JSON.stringify({
    manifestVersion: 1,
    id: 'sample.external',
    name: 'Sample External Failing Replacement',
    version: '3.0.0',
    permissions: ['remote:routes'],
    contributions: {
      remoteRoutes: [
        {
          method: 'GET',
          pattern: '/plugins/sample.external/failing',
          action: {
            capability: 'video-library.query',
            method: 'list'
          }
        }
      ]
    }
  }, null, 2))

  const pluginsDir = path.join(tempRoot, 'user-data', 'plugins')
  fs.mkdirSync(path.join(pluginsDir, 'broken-installed'), { recursive: true })
  fs.copyFileSync(path.join(brokenRoot, 'plugin.json'), path.join(pluginsDir, 'broken-installed', 'plugin.json'))
  const { loadSettings } = require(path.join(projectRoot, 'main', 'settings'))
  const { pluginRegistry, setupPlugins, disposePlugins, installPlugin, uninstallPlugin } = require(path.join(projectRoot, 'main', 'plugins'))

  await setupPlugins()
  assert.strictEqual(pluginRegistry.getPlugin('sample.external'), null)
  const invalidPlugins = pluginRegistry.listPlugins().filter(plugin => plugin.id.startsWith('invalid.'))
  const invalidBrokenPlugin = invalidPlugins.find(plugin => plugin.installDirectoryName === 'broken-installed')
  assert.ok(invalidBrokenPlugin)
  assert.strictEqual(invalidBrokenPlugin.status, 'error')
  assert.strictEqual(invalidBrokenPlugin.canEnable, false)
  assert.strictEqual(fs.existsSync(path.join(pluginsDir, 'broken-installed')), true)
  const officialVideoAnalysis = pluginRegistry.getPlugin('video-analysis')
  assert.ok(officialVideoAnalysis)
  assert.strictEqual(officialVideoAnalysis.publisher, 'official')
  assert.strictEqual(officialVideoAnalysis.external, true)
  assert.strictEqual(officialVideoAnalysis.uninstallable, false)
  assert.strictEqual(fs.existsSync(path.join(pluginsDir, 'video-analysis', 'plugin.json')), false)

  await assert.rejects(
    () => installPlugin(officialCollisionRoot),
    /官方插件 ID/
  )

  const installed = await installPlugin(sourceRoot)
  assert.strictEqual(installed.success, true, installed.error)
  assert.strictEqual(installed.plugin.id, 'sample.external')
  assert.strictEqual(installed.plugin.external, true)
  assert.strictEqual(installed.plugin.executable, false)
  assert.strictEqual(installed.plugin.enabled, false)
  assert.strictEqual(installed.plugin.config.greeting, 'hello')
  assert.ok(installed.plugin.installedAt)
  assert.strictEqual(pluginRegistry.matchRemoteRoute('GET', '/v1/plugins/sample.external/hello/Ada'), null)

  const enabled = await pluginRegistry.setPluginEnabled('sample.external', true)
  assert.strictEqual(enabled.success, true, enabled.error)
  const originalPluginSettings = JSON.parse(JSON.stringify(loadSettings().plugins['sample.external']))
  const route = pluginRegistry.matchRemoteRoute('GET', '/v1/plugins/sample.external/hello/Ada')
  assert.ok(route)
  assert.deepStrictEqual(route.params, { name: 'Ada' })
  const response = await invokePluginRoute(route, '/v1/plugins/sample.external/hello/Ada')
  assert.strictEqual(response.status, 200)
  assert.strictEqual(response.data.ok, true)
  assert.strictEqual(response.data.config, undefined)
  assert.ok(Array.isArray(response.data.result.items))
  assert.strictEqual(typeof response.data.result.count, 'number')

  const originalRename = fs.promises.rename
  try {
    fs.promises.rename = async (from, to) => {
      const isReplacementMove = (
        path.basename(to) === 'sample.external' &&
        path.basename(from).startsWith('.sample.external.install-')
      )
      if (isReplacementMove) {
        throw new Error('simulated replacement move failure')
      }
      return originalRename.call(fs.promises, from, to)
    }
    await assert.rejects(
      () => installPlugin(replacementRoot),
      /simulated replacement move failure/
    )
  } finally {
    fs.promises.rename = originalRename
  }
  const preservedPlugin = pluginRegistry.getPlugin('sample.external')
  assert.strictEqual(preservedPlugin.version, '1.0.0')
  assert.strictEqual(preservedPlugin.enabled, true)
  assert.ok(pluginRegistry.matchRemoteRoute('GET', '/v1/plugins/sample.external/hello/Ada'))
  assert.strictEqual(
    JSON.parse(fs.readFileSync(path.join(pluginsDir, 'sample.external', 'plugin.json'), 'utf-8')).version,
    '1.0.0'
  )

  const originalRegister = pluginRegistry.register
  try {
    pluginRegistry.register = async (manifest) => {
      if (manifest.id === 'sample.external' && manifest.version === '2.0.0') {
        throw new Error('simulated registry failure')
      }
      return originalRegister.call(pluginRegistry, manifest)
    }
    await assert.rejects(
      () => installPlugin(replacementRoot),
      /simulated registry failure/
    )
  } finally {
    pluginRegistry.register = originalRegister
  }
  const recoveredPlugin = pluginRegistry.getPlugin('sample.external')
  assert.strictEqual(recoveredPlugin.version, '1.0.0')
  assert.strictEqual(recoveredPlugin.enabled, true)
  assert.ok(pluginRegistry.matchRemoteRoute('GET', '/v1/plugins/sample.external/hello/Ada'))
  assert.strictEqual(
    JSON.parse(fs.readFileSync(path.join(pluginsDir, 'sample.external', 'plugin.json'), 'utf-8')).version,
    '1.0.0'
  )

  await assert.rejects(
    () => installPlugin(failingReplacementRoot),
    /video:index:read/
  )
  const setupFailureRecoveredPlugin = pluginRegistry.getPlugin('sample.external')
  assert.strictEqual(setupFailureRecoveredPlugin.version, '1.0.0')
  assert.strictEqual(setupFailureRecoveredPlugin.enabled, true)
  assert.ok(pluginRegistry.matchRemoteRoute('GET', '/v1/plugins/sample.external/hello/Ada'))
  assert.deepStrictEqual(loadSettings().plugins['sample.external'], originalPluginSettings)
  assert.strictEqual(
    JSON.parse(fs.readFileSync(path.join(pluginsDir, 'sample.external', 'plugin.json'), 'utf-8')).version,
    '1.0.0'
  )

  const deniedInstalled = await installPlugin(permissionDeniedRoot)
  assert.strictEqual(deniedInstalled.success, true, deniedInstalled.error)
  const deniedEnabled = await pluginRegistry.setPluginEnabled('permission.denied', true)
  assert.strictEqual(deniedEnabled.success, false)
  assert.match(deniedEnabled.error, /video:index:read/)
  assert.strictEqual(pluginRegistry.matchRemoteRoute('GET', '/v1/plugins/permission.denied/videos'), null)

  const remoteDeniedInstalled = await installPlugin(remotePermissionDeniedRoot)
  assert.strictEqual(remoteDeniedInstalled.success, true, remoteDeniedInstalled.error)
  const remoteDeniedEnabled = await pluginRegistry.setPluginEnabled('remote.permission.denied', true)
  assert.strictEqual(remoteDeniedEnabled.success, false)
  assert.match(remoteDeniedEnabled.error, /remote:routes/)
  assert.strictEqual(pluginRegistry.matchRemoteRoute('GET', '/v1/plugins/remote.permission.denied/ping'), null)

  const analysisDeniedInstalled = await installPlugin(analysisStartDeniedRoot)
  assert.strictEqual(analysisDeniedInstalled.success, true, analysisDeniedInstalled.error)
  const analysisDeniedEnabled = await pluginRegistry.setPluginEnabled('analysis.start.denied', true)
  assert.strictEqual(analysisDeniedEnabled.success, false)
  assert.match(analysisDeniedEnabled.error, /video-analysis:start/)
  assert.strictEqual(pluginRegistry.matchRemoteRoute('POST', '/v1/plugins/analysis.start.denied/start/video-1'), null)

  const unknownCapabilityInstalled = await installPlugin(unknownCapabilityRoot)
  assert.strictEqual(unknownCapabilityInstalled.success, true, unknownCapabilityInstalled.error)
  const unknownCapabilityEnabled = await pluginRegistry.setPluginEnabled('unknown.capability', true)
  assert.strictEqual(unknownCapabilityEnabled.success, false)
  assert.match(unknownCapabilityEnabled.error, /cannot call capability video-analysis\.jobs\.getActiveAnalysisJob/)
  assert.strictEqual(pluginRegistry.matchRemoteRoute('GET', '/v1/plugins/unknown.capability/run'), null)

  const directJobsInstalled = await installPlugin(directJobsCapabilityRoot)
  assert.strictEqual(directJobsInstalled.success, true, directJobsInstalled.error)
  const directJobsEnabled = await pluginRegistry.setPluginEnabled('direct.jobs', true)
  assert.strictEqual(directJobsEnabled.success, false)
  assert.match(directJobsEnabled.error, /cannot call capability video-analysis\.jobs\.startVideoAnalysis/)
  assert.strictEqual(pluginRegistry.matchRemoteRoute('POST', '/v1/plugins/direct.jobs/start'), null)

  const pathLeakInstalled = await installPlugin(pathLeakRoot)
  assert.strictEqual(pathLeakInstalled.success, true, pathLeakInstalled.error)
  const pathLeakEnabled = await pluginRegistry.setPluginEnabled('path.leak', true)
  assert.strictEqual(pathLeakEnabled.success, false)
  assert.match(pathLeakEnabled.error, /cannot call capability video-library\.query\.resolveVideoPathById/)
  assert.strictEqual(pluginRegistry.matchRemoteRoute('GET', '/v1/plugins/path.leak/video-1'), null)

  const disabled = await pluginRegistry.setPluginEnabled('sample.external', false)
  assert.strictEqual(disabled.success, true, disabled.error)
  assert.strictEqual(pluginRegistry.matchRemoteRoute('GET', '/v1/plugins/sample.external/hello/Ada'), null)

  const uninstalled = await uninstallPlugin('sample.external')
  assert.strictEqual(uninstalled.success, true, uninstalled.error)
  assert.strictEqual(pluginRegistry.getPlugin('sample.external'), null)
  assert.strictEqual(loadSettings().plugins['sample.external'], undefined)
  await uninstallPlugin('permission.denied')
  await uninstallPlugin('remote.permission.denied')
  await uninstallPlugin('analysis.start.denied')
  await uninstallPlugin('unknown.capability')
  await uninstallPlugin('direct.jobs')
  await uninstallPlugin('path.leak')
  const invalidUninstalled = await uninstallPlugin(invalidBrokenPlugin.id)
  assert.strictEqual(invalidUninstalled.success, true, invalidUninstalled.error)
  assert.strictEqual(fs.existsSync(path.join(pluginsDir, 'broken-installed')), false)
  await disposePlugins()
  console.log('external plugin lifecycle verification passed')
}

async function invokePluginRoute(match, urlPath) {
  const chunks = []
  const req = {
    method: 'GET',
    headers: {},
    on() {},
    setEncoding() {}
  }
  const res = {
    status: 0,
    headers: {},
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    }
  }
  await match.route.handler(req, res, {
    params: match.params,
    url: new URL(urlPath, 'http://127.0.0.1')
  })
  const text = Buffer.concat(chunks).toString('utf-8')
  return {
    status: res.status,
    data: JSON.parse(text)
  }
}

app.whenReady()
  .then(main)
  .finally(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true })
    app.quit()
  })
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
    app.quit()
  })
