const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { app } = require('electron')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wallpaper-player-official-plugin-sync-'))
const projectRoot = path.resolve(__dirname, '..')

async function main() {
  app.setPath('userData', path.join(tempRoot, 'user-data'))
  const { pluginRegistry, setupPlugins, disposePlugins, getExternalPluginsDir } = require(path.join(projectRoot, 'main', 'plugins'))

  await setupPlugins()
  const pluginsDir = getExternalPluginsDir()
  for (const pluginId of ['video-analysis', 'ai-search', 'agent-bridge']) {
    assert.strictEqual(fs.existsSync(path.join(pluginsDir, pluginId, 'plugin.json')), false)
    const plugin = pluginRegistry.getPlugin(pluginId)
    assert.ok(plugin, `${pluginId} should be registered`)
    assert.strictEqual(plugin.publisher, 'official')
    assert.strictEqual(plugin.uninstallable, false)
  }

  const videoAnalysis = pluginRegistry.getPlugin('video-analysis')
  assert.strictEqual(videoAnalysis.enabled, false)
  assert.strictEqual(videoAnalysis.status, 'disabled')
  assert.ok(videoAnalysis.settingsSchema.videoAnalysis)
  assert.ok(videoAnalysis.settingsDefaults.videoAnalysis)

  const aiSearch = pluginRegistry.getPlugin('ai-search')
  assert.ok(aiSearch.settingsSchema.llmProvider)
  assert.ok(aiSearch.settingsDefaults.llmProvider)
  assert.strictEqual(aiSearch.settingsSchema.llmProvider.type, 'enum')

  const agentBridge = pluginRegistry.getPlugin('agent-bridge')
  assert.ok(agentBridge.settingsSchema.agentBridge)
  assert.ok(agentBridge.settingsDefaults.agentBridge)

  await disposePlugins()
  console.log('official plugin sync verification passed')
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
