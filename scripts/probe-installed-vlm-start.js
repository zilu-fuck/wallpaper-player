const path = require('path')
const { app } = require('electron')

const projectRoot = path.resolve(__dirname, '..')
const installedUserData = path.join(app.getPath('appData'), 'wallpaper-player')

async function main() {
  app.setPath('userData', installedUserData)
  const { setupPlugins, disposePlugins } = require(path.join(projectRoot, 'main', 'plugins'))

  await setupPlugins()
  const pluginVlmServicePath = path.join(installedUserData, 'plugins', 'video-analysis', 'vlm-service.js')
  const { getVlmServiceState, startVlmService, stopVlmService } = require(pluginVlmServicePath)
  const before = await getVlmServiceState()
  console.log(JSON.stringify({
    phase: 'before',
    serverExecutable: before.serverExecutable,
    modelPath: before.modelPath,
    modelExists: before.modelExists,
    connected: before.connected,
    running: before.running
  }, null, 2))

  const timeoutMs = Number(process.env.VLM_PROBE_TIMEOUT_MS || 45000)
  const result = await Promise.race([
    startVlmService(),
    new Promise(resolve => setTimeout(() => resolve({ success: false, timedOut: true }), timeoutMs))
  ])
  const after = await getVlmServiceState()
  console.log(JSON.stringify({
    phase: 'after',
    result,
    state: {
      serverExecutable: after.serverExecutable,
      modelPath: after.modelPath,
      modelExists: after.modelExists,
      connected: after.connected,
      running: after.running,
      lastOutput: after.lastOutput
    }
  }, null, 2))

  if (process.env.VLM_PROBE_KEEP_RUNNING !== '1') {
    await stopVlmService()
  }
  await disposePlugins()
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
