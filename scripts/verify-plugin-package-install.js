const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { app } = require('electron')

const projectRoot = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wallpaper-player-plugin-package-'))

async function main() {
  app.setPath('userData', path.join(tempRoot, 'user-data'))
  const { pluginRegistry, setupPlugins, disposePlugins, installPlugin, uninstallPlugin } = require(path.join(projectRoot, 'main', 'plugins'))

  await setupPlugins()
  const zipPath = path.join(projectRoot, 'release', 'plugins', 'Wallpaper-Player-Plugin-video-analysis-1.0.0.zip')
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

  await disposePlugins()
  console.log('plugin package install verification passed')
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
