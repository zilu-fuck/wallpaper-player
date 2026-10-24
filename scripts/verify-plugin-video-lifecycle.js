const assert = require('assert')
const fs = require('fs')
const fsp = require('fs/promises')
const os = require('os')
const path = require('path')
const { app } = require('electron')
require('./test-data-guard.cjs')
app.disableHardwareAcceleration()

const projectRoot = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wallpaper-player-video-plugin-'))
app.setPath('userData', tempRoot)
app.setPath('sessionData', path.join(tempRoot, 'session'))

async function main() {
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

  const runtimeDir = path.join(tempRoot, 'video-analysis-runtime')
  const currentModelPath = path.join(tempRoot, 'analysis-models', 'vlm', 'test.gguf')
  const staleMachineRoot = path.join(tempRoot, 'stale-machine', 'wallpaper-player')
  const staleModelDir = path.join(staleMachineRoot, 'analysis-models')
  const staleModelPath = path.join(staleModelDir, 'vlm', 'test.gguf')
  const missingInstalledVendorPath = path.join(
    tempRoot,
    'Programs',
    'Wallpaper Player',
    'resources',
    'vendor',
    'llama.cpp-cuda',
    'llama-server.exe'
  )
  await fsp.mkdir(runtimeDir, { recursive: true })
  await fsp.mkdir(path.dirname(currentModelPath), { recursive: true })
  await fsp.writeFile(currentModelPath, 'fake gguf model', 'utf-8')
  await fsp.writeFile(path.join(runtimeDir, '.env'), [
    'MAX_DURATION_SECONDS=1800',
    `MODEL_STORAGE_DIR=${staleModelDir}`,
    'LLM_PROVIDER=local',
    'LLM_BASE_URL=http://127.0.0.1:11434/v1',
    'LLM_NAME=qwen2.5:14b',
    'LLM_API_KEY=local-placeholder',
    'VLM_PROVIDER=local',
    'VLM_BASE_URL=http://127.0.0.1:5803',
    'VLM_NAME=test.gguf',
    'VLM_API_KEY=local-placeholder',
    `VLM_MODEL_PATH=${staleModelPath}`,
    'VLM_MODEL_DOWNLOAD_URL=',
    'VLM_HF_REPO=',
    'VLM_HF_REVISION=main',
    'VLM_HF_TOKEN=',
    `VLM_SERVER_EXECUTABLE=${missingInstalledVendorPath}`,
    'VLM_SERVER_ARGS=-m "{modelPath}" --host 127.0.0.1 --port {port}',
    'VLM_CONCURRENCY=4',
    'MODE=balance',
    ''
  ].join('\n'), 'utf-8')
  const { getVlmServiceState, saveVlmServiceConfig } = require(path.join(projectRoot, 'main', 'plugins', 'video-analysis', 'vlm-service'))
  const vlmState = await getVlmServiceState()
  assert.strictEqual(
    path.resolve(vlmState.modelPath).toLowerCase(),
    path.resolve(currentModelPath).toLowerCase(),
    `stale machine model path should migrate to current model directory: ${vlmState.modelPath}`
  )
  assert.strictEqual(vlmState.modelExists, true)
  assert.ok(fs.existsSync(vlmState.serverExecutable), `migrated server executable should exist: ${vlmState.serverExecutable}`)
  assert.notStrictEqual(
    path.resolve(vlmState.serverExecutable).toLowerCase(),
    path.resolve(missingInstalledVendorPath).toLowerCase()
  )
  assert.ok(
    /vendor[\\/]llama\.cpp-cuda[\\/]llama-server\.exe$/i.test(vlmState.serverExecutable),
    `unexpected migrated server executable: ${vlmState.serverExecutable}`
  )
  const savedVlm = await saveVlmServiceConfig({
    vlmServerExecutable: 'vendor\\llama.cpp-cuda\\llama-server.exe'
  })
  assert.strictEqual(savedVlm.success, true, savedVlm.error || 'vlm config should save')
  const savedEnvText = await fsp.readFile(path.join(runtimeDir, '.env'), 'utf-8')
  const savedExecutableLine = savedEnvText
    .split(/\r?\n/)
    .find(line => line.startsWith('VLM_SERVER_EXECUTABLE='))
  assert.ok(savedExecutableLine, 'saved env should include VLM_SERVER_EXECUTABLE')
  assert.notStrictEqual(savedExecutableLine, 'VLM_SERVER_EXECUTABLE=vendor\\llama.cpp-cuda\\llama-server.exe')
  assert.ok(
    /VLM_SERVER_EXECUTABLE=.*vendor[\\/]llama\.cpp-cuda[\\/]llama-server\.exe$/i.test(savedExecutableLine),
    `saved executable should persist migrated bundled path: ${savedExecutableLine}`
  )
  const savedModelLine = savedEnvText
    .split(/\r?\n/)
    .find(line => line.startsWith('VLM_MODEL_PATH='))
  assert.ok(savedModelLine, 'saved env should include VLM_MODEL_PATH')
  assert.strictEqual(
    savedModelLine,
    `VLM_MODEL_PATH=${currentModelPath}`,
    `saved model path should persist migrated current-machine path: ${savedModelLine}`
  )

  const service = require(path.join(projectRoot, 'main', 'plugins', 'video-analysis', 'service'))
  const rename = fsp.rename
  let releaseWrite, announceWrite, stopped = false
  const heldWrite = new Promise(resolve => { releaseWrite = resolve })
  const writing = new Promise(resolve => { announceWrite = resolve })
  fsp.rename = async function (from, to) {
    if (to === path.join(runtimeDir, '.env') && path.basename(from).startsWith('.runtime-env-write-')) {
      announceWrite(); await heldWrite
    }
    return rename.call(this, from, to)
  }
  const pendingSave = service.saveVideoAnalysisRuntimeConfig({ llmName: 'save accepted before disable' })
  let disabling
  try {
    await writing
    disabling = pluginRegistry.setPluginEnabled('video-analysis', false).then(result => { stopped = true; return result })
    await new Promise(resolve => setImmediate(resolve))
    assert.strictEqual(stopped, false, 'plugin disposal must wait for accepted configuration IO')
    releaseWrite()
    assert.strictEqual((await pendingSave).llmName, 'save accepted before disable')
    assert.strictEqual((await disabling).success, true)
  } finally {
    releaseWrite(); fsp.rename = rename
    await Promise.allSettled([pendingSave, disabling])
  }
  await assert.rejects(service.getVideoAnalysisRuntimeConfig(), error => error.code === 'runtime_config_stopping')
  assert.strictEqual((await pluginRegistry.setPluginEnabled('video-analysis', true)).success, true)
  assert.strictEqual((await service.getVideoAnalysisRuntimeConfig()).llmName, 'save accepted before disable')

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

async function finish(code) {
  try {
    await require(path.join(projectRoot, 'main/plugins')).disposePlugins()
    const settings = require(path.join(projectRoot, 'main/settings'))
    await settings.flushSettingsWrites(); await settings.disposeSettingsSerialization({ cancel: true })
  } catch (error) { console.error(error); code = 1 }
  // Chromium still owns session files until process exit. Keep the isolated
  // fixture rather than deleting an active profile on Windows.
  console.log('Retained isolated plugin fixture: ' + tempRoot)
  app.exit(code)
}
app.whenReady().then(main).then(() => finish(0), error => { console.error(error); finish(1) })
