const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { app } = require('electron')

const projectRoot = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wallpaper-player-video-plugin-'))

async function main() {
  app.setPath('userData', tempRoot)

  const { loadSettings, saveSettings, sanitizeSettingsForSave } = require(path.join(projectRoot, 'main', 'settings'))
  const { pluginRegistry, setupPlugins, disposePlugins } = require(path.join(projectRoot, 'main', 'plugins'))

  saveSettings({
    plugins: {
      'video-analysis': {
        enabled: false,
        updatedAt: new Date().toISOString()
      }
    },
    videoAnalysis: {
      enabled: true
    }
  })

  await setupPlugins()
  assert.strictEqual(
    pluginRegistry.listPlugins().find(plugin => plugin.id === 'video-analysis')?.enabled,
    false
  )

  const enabled = await pluginRegistry.setPluginEnabled('video-analysis', true)
  assert.strictEqual(enabled.success, true, enabled.error || 'video-analysis should enable')
  assert.strictEqual(
    pluginRegistry.listPlugins().find(plugin => plugin.id === 'video-analysis')?.enabled,
    true
  )
  assert.ok(pluginRegistry.getCapability('video-analysis.results'))
  assert.ok(pluginRegistry.matchRemoteRoute('GET', '/v1/videos/test/analysis'))
  assert.strictEqual(
    loadSettings().videoAnalysis.outputDir,
    path.join(tempRoot, 'analysis-results')
  )

  saveSettings(sanitizeSettingsForSave({ videoAnalysis: { enabled: false } }))
  const analysisSummary = pluginRegistry.getCapability('video-analysis.summary')
  assert.ok(analysisSummary)
  const blockedStart = await analysisSummary.start('missing-video-id')
  assert.strictEqual(blockedStart.accepted, false)
  assert.strictEqual(blockedStart.reason, 'disabled')
  saveSettings(sanitizeSettingsForSave({ videoAnalysis: { enabled: true } }))

  const disabled = await pluginRegistry.setPluginEnabled('video-analysis', false)
  assert.strictEqual(disabled.success, true, disabled.error || 'video-analysis should disable')
  assert.strictEqual(
    pluginRegistry.listPlugins().find(plugin => plugin.id === 'video-analysis')?.enabled,
    false
  )
  assert.strictEqual(pluginRegistry.getCapability('video-analysis.results'), undefined)
  assert.strictEqual(pluginRegistry.matchRemoteRoute('GET', '/v1/videos/test/analysis'), null)

  assert.strictEqual(loadSettings().videoAnalysis.enabled, true)
  const sanitized = sanitizeSettingsForSave({
    videoAnalysis: {
      outputDir: path.join(tempRoot, 'not-session-approved')
    }
  })
  assert.notStrictEqual(
    sanitized.videoAnalysis.outputDir,
    path.join(tempRoot, 'not-session-approved')
  )

  await disposePlugins()
  console.log('video analysis plugin lifecycle verification passed')
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
