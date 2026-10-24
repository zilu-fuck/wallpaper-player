const assert = require('assert')
const { phone } = require('./mobile-module-harness')
const { createHookHarness } = require('./verify-mobile-player-behavior')
const next = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }

async function main() {
  const client = phone(), timers = new Map(); let sequence = 0
  client.control.globals = { setTimeout: (fn, ms) => { const id = ++sequence; timers.set(id, { fn, ms }); return id }, clearTimeout: id => timers.delete(id) }
  const { AnalysisSettings, SettingsDraft, SettingsObserver, DEFAULT_ANALYSIS_RUNTIME_CONFIG: defaults } = client.load('src/services/analysis-settings.js')
  const draft = new SettingsDraft({ field: 'baseline', other: 'initial' }), read = draft.ticket()
  draft.edit({ field: 'typed' }); draft.merge({ field: 'old read', other: 'fresh' }, read)
  assert.strictEqual(draft.values.field, 'typed'); assert.strictEqual(draft.values.other, 'fresh')
  assert.strictEqual(draft.confirmed.field, 'old read', 'confirmed data remains separate from the edited value')
  const saved = draft.ticket(); draft.edit({ field: 'typed while saving' }); draft.merge({ field: 'saved old' }, saved, ['field'])
  assert.strictEqual(draft.values.field, 'typed while saving')
  const newer = draft.ticket(); draft.merge({ other: 'newest' }, newer); draft.merge({ other: 'late old' }, read)
  assert.strictEqual(draft.values.other, 'newest')

  const reads = [], observed = [], failures = []
  const observer = new SettingsObserver(() => { const item = deferred(); reads.push(item); return item.promise }, value => observed.push(value), error => failures.push(error), 3000)
  observer.setActive(true)
  for (let i = 0; i < 20; i++) observer.refresh()
  assert.strictEqual(reads.length, 1)
  observer.setActive(false); observer.setActive(true); assert.strictEqual(reads.length, 1)
  reads[0].resolve('late-hidden'); await next(); assert.strictEqual(observed.length, 0)
  const fire = async () => { const [id, timer] = timers.entries().next().value; timers.delete(id); timer.fn(); await next() }
  await fire(); assert.strictEqual(reads.length, 2)
  observer.invalidate('mutation'); reads[1].resolve('before-mutation'); await next()
  assert.strictEqual(observed.at(-1), 'mutation')
  await fire(); reads[2].reject(Error('probe failed')); await next(); assert.strictEqual(failures[0], 'probe failed')
  observer.dispose(); assert.strictEqual(timers.size, 0)

  const controllers = [], nativeCalls = [], snapshots = [], saves = [], configs = [], starts = []
  let initialRead = deferred(), outputRead = deferred(), statusReadsDuringActions = 0, stopResult = { success: true, state: { connected: false, marker: 'stopped' } }
  const api = {
    getVideoAnalysisRuntimeConfig: () => initialRead.promise,
    getVideoAnalysisOutputDir: () => outputRead.promise,
    getVideoAnalysisModelDir: async () => '/models', getDefaultVideoAnalysisModelDir: async () => '/defaults',
    getVideoAnalysisVlmModelOptions: async () => ({ success: true, options: { models: [{ id: 'model-a', precisions: ['Q4_K_M'] }], defaultModelId: 'model-a' } }),
    getVideoAnalysisVlmState: async () => { statusReadsDuringActions++; return { success: true, state: { connected: false } } },
    selectVideoAnalysisOutputDir: async () => '/new-output',
    saveVideoAnalysisRuntimeConfig: config => { const item = deferred(); saves.push({ ...item, config }); return item.promise },
    saveVideoAnalysisVlmConfig: config => { const item = deferred(); configs.push({ ...item, config }); return item.promise },
    startVideoAnalysisVlmService: () => { nativeCalls.push('start'); const item = deferred(); starts.push(item); return item.promise },
    stopVideoAnalysisVlmService: async () => { nativeCalls.push('stop'); return stopResult },
    resetVideoAnalysisRuntimeConfig: async () => ({ success: true, config: defaults }),
    selectVideoAnalysisVlmModelFile: async () => ({ success: true, config: { ...defaults, llmName: 'server old text model', vlmModelPath: '/chosen/model.gguf' } })
  }
  const make = () => { const controller = new AnalysisSettings(api, value => snapshots.push(value)); controllers.push(controller); controller.setEnabled(true); controller.setActive(true); return controller }
  try {
    const controller = make(); await next()
    controller.edit('llmName', 'edited before loading')
    await controller.selectOutput()
    initialRead.resolve({ success: true, config: { ...defaults, llmProvider: 'api', llmName: 'old server profile', modelStorageDir: '/models' } })
    outputRead.resolve('/old-output'); await controller.loading
    assert.strictEqual(controller.view.analysisOutputDir, '/new-output', 'late directory reads cannot undo a committed selection')
    assert.strictEqual(controller.view.analysisRuntimeConfig.llmName, 'edited before loading')
    assert.strictEqual(controller.view.analysisRuntimeConfig.llmProvider, 'local', 'provider and its edited fields stay together')
    assert.strictEqual(controller.view.analysisRuntimeLoaded, true)
    const saving = controller.save(); await next(); assert.strictEqual(saves.length, 1)
    const beforeRefresh = statusReadsDuringActions; await controller.refresh()
    assert.strictEqual(statusReadsDuringActions, beforeRefresh, 'a settings write suspends status probes until its acknowledgment')
    controller.edit('llmName', 'edited during saving')
    saves[0].resolve({ success: true, config: { ...saves[0].config, llmName: 'saved first value' } }); await saving
    assert.strictEqual(controller.view.analysisRuntimeConfig.llmName, 'edited during saving')
    assert.strictEqual(controller.view.analysisConfigDirty, true)
    assert.ok(controller.view.analysisConfigMessage.includes('新更改尚未保存'))
    const failed = controller.save(); await next(); saves[1].reject(Error('disk failure')); await failed
    assert.strictEqual(controller.view.analysisConfigSaving, false); assert.strictEqual(controller.view.analysisRuntimeConfig.llmName, 'edited during saving')
    assert.ok(controller.view.analysisConfigMessage.includes('disk failure'))
    controller.provider('api'); controller.edit('llmName', 'api draft'); controller.provider('local')
    assert.strictEqual(controller.view.analysisRuntimeConfig.llmName, 'edited during saving')
    controller.provider('api'); assert.strictEqual(controller.view.analysisRuntimeConfig.llmName, 'api draft')
    await controller.selectModelFile()
    assert.strictEqual(controller.view.analysisRuntimeConfig.llmName, 'api draft', 'model selection does not acknowledge an unsaved text-model draft')
    assert.strictEqual(controller.view.analysisRuntimeConfig.vlmModelPath, '/chosen/model.gguf')
    const resetReply = deferred(); api.resetVideoAnalysisRuntimeConfig = () => resetReply.promise
    const resetting = controller.reset(); await next(); controller.edit('mode', 'quantity')
    resetReply.resolve({ success: true, config: defaults }); await resetting
    assert.strictEqual(controller.view.analysisRuntimeConfig.mode, 'quantity', 'reset acknowledges prior edits while retaining edits made during the request')
    assert.strictEqual(controller.view.analysisConfigSaving, false)

    const preparing = controller.start(); await next(); assert.strictEqual(configs.length, 1)
    const stopping = controller.stop(); assert.strictEqual(controller.stop(), stopping, 'duplicate stop keeps the same operation owner')
    await stopping; configs[0].resolve({ success: true, config: configs[0].config }); await preparing
    assert.strictEqual(nativeCalls.filter(value => value === 'start').length, 0, 'stop during save prevents a late native start')
    const starting = controller.start(); await next(); configs[1].resolve({ success: true, config: configs[1].config }); await next()
    assert.strictEqual(starts.length, 1)
    await controller.stop(); const stoppedMessage = controller.view.vlmMessage
    starts[0].reject(Error('old native start failed')); await starting
    assert.strictEqual(controller.view.vlmMessage, stoppedMessage); assert.strictEqual(controller.view.vlmState.marker, 'stopped')

    initialRead = { promise: Promise.resolve({ success: true, config: defaults }) }; outputRead = { promise: Promise.resolve('/output') }
    const other = make(); await other.loading
    const first = controller.save(); await next()
    const pending = other.save(); await next(); assert.strictEqual(saves.length, 3, 'writes are serialized across mounted owners')
    other.dispose(); saves[2].resolve({ success: true, config: saves[2].config }); await Promise.all([first, pending])
    assert.strictEqual(saves.length, 3, 'disposed queued owners cannot commit a late write')
    const inFlight = controller.save(); await next(); const count = snapshots.length
    controller.dispose(); saves[3].resolve({ success: true, config: saves[3].config }); await inFlight
    assert.strictEqual(snapshots.length, count, 'disposed replies cannot publish or create feedback timers')
    let failRead = true
    const retry = new AnalysisSettings({ ...api, getVideoAnalysisRuntimeConfig: async () => {
      if (failRead) throw Error('read failed'); return { success: true, config: defaults }
    } }, () => {})
    controllers.push(retry); retry.setEnabled(true); retry.setActive(true); await retry.loading
    assert.strictEqual(retry.view.analysisRuntimeLoaded, false); assert.strictEqual(retry.view.analysisRuntimeLoading, false)
    assert.strictEqual(retry.view.analysisRuntimeError, 'read failed')
    retry.edit('llmName', 'retry draft'); failRead = false; await retry.load()
    assert.strictEqual(retry.view.analysisRuntimeLoaded, true); assert.strictEqual(retry.view.analysisRuntimeConfig.llmName, 'retry draft')
    const early = make(); early.provider('api'); await early.loading
    early.reconcileSettings({ llmProfiles: { api: { llmName: 'first saved api profile' } } })
    assert.strictEqual(early.view.analysisRuntimeConfig.llmName, 'first saved api profile', 'a provider chosen before initial settings can still hydrate its unedited profile')

    let serverConfig = { ...defaults, modelStorageDir: '/models' }
    const patches = []
    const patchApi = { ...api, getVideoAnalysisRuntimeConfig: async () => ({ success: true, config: serverConfig }),
      saveVideoAnalysisRuntimeConfig: async patch => { patches.push(patch); serverConfig = { ...serverConfig, ...patch }; return { success: true, config: serverConfig } },
      saveVideoAnalysisVlmConfig: async patch => { patches.push(patch); serverConfig = { ...serverConfig, ...patch }; return { success: true, config: serverConfig } } }
    const partial = new AnalysisSettings(patchApi, () => {}); controllers.push(partial)
    partial.setEnabled(true); partial.setActive(true); await partial.loading
    serverConfig = { ...serverConfig, vlmModelPath: '/background-download/new.gguf', modelStorageDir: '/background-models' }
    partial.edit('llmName', 'text edit'); await partial.save()
    assert.deepStrictEqual(Object.keys(patches[0]).sort(), ['llmProvider', 'llmBaseUrl', 'llmName', 'llmApiKey'].sort(), 'the edited text profile does not resubmit stale clean model settings')
    assert.strictEqual(partial.view.analysisRuntimeConfig.vlmModelPath, '/background-download/new.gguf')
    assert.strictEqual(partial.view.analysisRuntimeConfig.modelStorageDir, '/background-models')
    partial.edit('llmName', 'unsaved text draft'); partial.edit('vlmName', 'visual edit'); await partial.saveVlm()
    assert.deepStrictEqual(Object.keys(patches[1]), ['vlmName'], 'visual-model save does not submit the unsaved text-model draft')
    assert.strictEqual(partial.view.analysisRuntimeConfig.llmName, 'unsaved text draft')
    assert.strictEqual(serverConfig.llmName, 'text edit')
  } finally { controllers.forEach(controller => controller.dispose()) }
  assert.strictEqual(timers.size, 0)

  const hookClient = phone(), harness = createHookHarness(hookClient), visibility = new Set(), events = new Set()
  const document = { visibilityState: 'visible', addEventListener: (_type, fn) => visibility.add(fn), removeEventListener: (_type, fn) => visibility.delete(fn) }
  let statusReads = 0, configReads = 0, props = { enabled: true, active: false, settings: {} }
  hookClient.control.globals = { ...hookClient.control.globals, document, window: { electronAPI: { ...api,
    getVideoAnalysisRuntimeConfig: async () => { configReads++; return { success: true, config: defaults } },
    getVideoAnalysisOutputDir: async () => '/output',
    getVideoAnalysisVlmState: async () => { statusReads++; return { success: true, state: { connected: false } } },
    onVideoAnalysisVlmEvent: fn => { events.add(fn); return () => events.delete(fn) }
  } } }
  const { useVideoAnalysisSettings } = hookClient.load('src/hooks/useVideoAnalysisSettings.js')
  harness.mount(() => useVideoAnalysisSettings(props)); await harness.settle(); assert.strictEqual(configReads + statusReads, 0)
  props = { ...props, active: true }; harness.mount(() => useVideoAnalysisSettings(props)); await harness.until(() => harness.tree().analysisRuntimeLoaded)
  harness.tree().onAnalysisRuntimeChange('llmName', 'hook draft'); await harness.settle()
  props = { ...props, settings: { theme: 'changed', llmProfiles: { local: { llmName: 'broadcast old value' } } } }
  harness.mount(() => useVideoAnalysisSettings(props)); await harness.settle(); assert.strictEqual(harness.tree().analysisRuntimeConfig.llmName, 'hook draft')
  props = { ...props, settings: { llmProfiles: { api: { llmName: 'late saved api profile', llmBaseUrl: 'http://saved.invalid/v1', llmApiKey: 'fixture' } } } }
  harness.mount(() => useVideoAnalysisSettings(props)); await harness.settle()
  harness.tree().onLlmProviderChange('api'); await harness.settle()
  assert.strictEqual(harness.tree().analysisRuntimeConfig.llmName, 'late saved api profile', 'late initial settings hydrate an untouched inactive profile')
  harness.tree().onLlmProviderChange('local'); await harness.settle(); assert.strictEqual(harness.tree().analysisRuntimeConfig.llmName, 'hook draft')
  document.visibilityState = 'hidden'; visibility.forEach(fn => fn()); const hiddenReads = statusReads
  events.forEach(fn => fn()); await harness.settle(); assert.strictEqual(statusReads, hiddenReads)
  document.visibilityState = 'visible'; visibility.forEach(fn => fn()); await harness.until(() => statusReads > hiddenReads)
  harness.unmount(); assert.strictEqual(visibility.size, 0); assert.strictEqual(events.size, 0)
  const appClient = phone(), appHarness = createHookHarness(appClient), settingsAck = deferred()
  let broadcast, submitted
  appClient.control.globals = { ...appClient.control.globals, window: { electronAPI: {
    onSettingsChanged: fn => { broadcast = fn; return () => {} },
    saveSettings: patch => { submitted = patch; return settingsAck.promise }
  } } }
  const { useAppState } = appClient.load('src/hooks/useAppState.js')
  appHarness.mount(() => useAppState())
  broadcast({ videoAnalysis: { enabled: true, modelDir: '/saved-models', llmProfiles: { local: { llmName: 'saved profile' } } } })
  await appHarness.settle()
  const toggling = appHarness.tree().saveSettings({ videoAnalysis: { enabled: false } }); await appHarness.settle()
  assert.strictEqual(appHarness.tree().settings.videoAnalysis.modelDir, '/saved-models', 'optimistic partial settings retain other confirmed section fields')
  assert.strictEqual(appHarness.tree().settings.videoAnalysis.llmProfiles.local.llmName, 'saved profile')
  assert.strictEqual(Object.keys(submitted.videoAnalysis).length, 1, 'the bridge receives only the changed field')
  settingsAck.resolve({ settings: appHarness.tree().settings }); await toggling; appHarness.unmount()
  console.log('analysis settings passed: production draft/controller/hook, late read/save/reset isolation, dirty/provider drafts, directory/model selection, failed read/save recovery, serialized/disposed writes, stop-before-start and stale failure rejection, completion-paced observation, page/visibility ownership and cleanup')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
