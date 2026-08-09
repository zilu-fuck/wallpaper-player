const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { app } = require('electron')

const projectRoot = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wallpaper-player-plugin-package-'))
const pluginPackageDir = process.env.WALLPAPER_PLUGIN_TEST_DIR
  ? path.resolve(process.env.WALLPAPER_PLUGIN_TEST_DIR)
  : path.join(projectRoot, 'release', 'plugins')

async function main() {
  app.setPath('userData', path.join(tempRoot, 'user-data'))
  const { pluginRegistry, setupPlugins, disposePlugins, installPlugin, uninstallPlugin } = require(path.join(projectRoot, 'main', 'plugins'))
  const { readManifestFromPath } = require(path.join(projectRoot, 'main', 'plugins', 'loader'))

  await setupPlugins()
  const zipPath = path.join(pluginPackageDir, 'Wallpaper-Player-Plugin-video-analysis-1.0.0.zip')
  assert.strictEqual(fs.existsSync(zipPath), true, 'video-analysis plugin package should exist')

  const installed = await installPlugin(zipPath)
  assert.strictEqual(installed.success, true, installed.error)
  assert.strictEqual(installed.plugin.id, 'video-analysis')
  assert.strictEqual(installed.plugin.publisher, 'official')
  assert.strictEqual(installed.plugin.uninstallable, true)

  const enabled = await pluginRegistry.setPluginEnabled('video-analysis', true)
  assert.strictEqual(enabled.success, true, enabled.error)
  assert.ok(pluginRegistry.getCapability('video-analysis.results'))
  assert.ok(pluginRegistry.matchRemoteRoute('GET', '/v1/videos/test/analysis'))

  const uninstalled = await uninstallPlugin('video-analysis')
  assert.strictEqual(uninstalled.success, true, uninstalled.error)
  assert.strictEqual(pluginRegistry.getPlugin('video-analysis'), null)

  const aiZipPath = path.join(pluginPackageDir, 'Wallpaper-Player-Plugin-ai-search-0.1.0.zip')
  assert.strictEqual(fs.existsSync(aiZipPath), true, 'ai-search plugin package should exist')
  const aiInstalled = await installPlugin(aiZipPath)
  assert.strictEqual(aiInstalled.success, true, aiInstalled.error)
  assert.strictEqual(aiInstalled.plugin.id, 'ai-search')
  assert.strictEqual(aiInstalled.plugin.loadError, false)
  const aiPluginDir = path.join(app.getPath('userData'), 'plugins', 'ai-search')
  assert.strictEqual(fs.existsSync(path.join(aiPluginDir, 'logger.js')), true)
  assert.ok(require.resolve('playwright-core', { paths: [aiPluginDir] }))

  const aiEnabled = await pluginRegistry.setPluginEnabled('ai-search', true)
  assert.strictEqual(aiEnabled.success, true, aiEnabled.error)
  fs.appendFileSync(path.join(aiPluginDir, 'logger.js'), '\n// tampered after installation\n')
  await assert.rejects(
    () => readManifestFromPath(aiPluginDir),
    /官方插件包校验失败/,
    'installed official plugins must be rehashed before being trusted'
  )
  const aiUninstalled = await uninstallPlugin('ai-search')
  assert.strictEqual(aiUninstalled.success, true, aiUninstalled.error)
  assert.strictEqual(pluginRegistry.getPlugin('ai-search'), null)

  await disposePlugins()
  console.log('plugin package install verification passed')
}

app.whenReady().then(main).then(
  () => finish(0),
  (error) => {
    console.error(error)
    finish(1)
  }
)

function finish(exitCode) {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  } finally {
    app.exit(exitCode)
  }
}
