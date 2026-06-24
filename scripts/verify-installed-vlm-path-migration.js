const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { app } = require('electron')

const projectRoot = path.resolve(__dirname, '..')
const installedUserData = path.join(app.getPath('appData'), 'wallpaper-player')

async function main() {
  app.setPath('userData', installedUserData)
  const { setupPlugins, disposePlugins } = require(path.join(projectRoot, 'main', 'plugins'))

  await setupPlugins()
  const pluginVlmServicePath = path.join(installedUserData, 'plugins', 'video-analysis', 'vlm-service.js')
  const { getVlmServiceState, saveVlmServiceConfig } = require(pluginVlmServicePath)
  const state = await getVlmServiceState()
  const expected = path.join(installedUserData, 'plugins', 'video-analysis', 'resources', 'vendor', 'llama.cpp-cuda', 'llama-server.exe')

  assert.strictEqual(fs.existsSync(expected), true, `expected plugin llama-server missing: ${expected}`)
  assert.strictEqual(path.resolve(state.serverExecutable).toLowerCase(), path.resolve(expected).toLowerCase())
  const saved = await saveVlmServiceConfig({ vlmServerExecutable: state.serverExecutable })
  assert.strictEqual(saved.success, true, saved.error || 'installed VLM config should save')
  const envPath = path.join(installedUserData, 'video-analysis-runtime', '.env')
  const envText = fs.readFileSync(envPath, 'utf-8')
  const executableLine = envText
    .split(/\r?\n/)
    .find(line => line.startsWith('VLM_SERVER_EXECUTABLE='))
  assert.strictEqual(
    path.resolve(executableLine.replace(/^VLM_SERVER_EXECUTABLE=/, '')).toLowerCase(),
    path.resolve(expected).toLowerCase()
  )
  await disposePlugins()
  console.log(`installed VLM server path migrated and persisted to ${state.serverExecutable}`)
}

app.whenReady()
  .then(main)
  .finally(() => {
    app.quit()
  })
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
    app.quit()
  })
