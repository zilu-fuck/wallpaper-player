import { SettingsDraft, SettingsObserver } from './settings-state'
export { SettingsDraft, SettingsObserver } from './settings-state'

export const DEFAULT_ANALYSIS_RUNTIME_CONFIG = {
  mode: 'balance', maxDurationSeconds: 1800, modelStorageDir: '', llmProvider: 'local',
  llmBaseUrl: 'http://127.0.0.1:11434/v1', llmName: 'qwen2.5:14b', llmApiKey: 'local-placeholder',
  vlmBaseUrl: 'http://127.0.0.1:5803', vlmName: 'Huihui-Qwen3.5-9B-Claude-4.6-Opus-abliterated.Q4_K_M.gguf',
  vlmApiKey: 'local-placeholder', vlmProvider: 'local', vlmModelPath: '', vlmModelDownloadUrl: '',
  vlmHfRepo: '', vlmHfRevision: 'main', vlmHfToken: '', vlmServerExecutable: 'vendor\\llama.cpp-cuda\\llama-server.exe',
  vlmServerArgs: '-m "{modelPath}" --host 127.0.0.1 --port {port}', vlmConcurrency: 4
}
const LLM_KEYS = ['llmProvider', 'llmBaseUrl', 'llmName', 'llmApiKey']
const VLM_KEYS = Object.keys(DEFAULT_ANALYSIS_RUNTIME_CONFIG).filter(key => key.startsWith('vlm'))
const MODEL_KEYS = ['vlmProvider', 'vlmModelPath', 'vlmName', 'vlmModelDownloadUrl', 'vlmHfRepo', 'vlmHfRevision']
const cleanRuntime = config => {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw Error('读取到无效的分析配置')
  const result = {}
  for (const [key, fallback] of Object.entries(DEFAULT_ANALYSIS_RUNTIME_CONFIG)) {
    if (!Object.hasOwn(config, key)) continue
    if (typeof config[key] !== typeof fallback || typeof fallback === 'number' && !Number.isFinite(config[key])) throw Error('分析配置字段无效：' + key)
    result[key] = config[key]
  }
  return result
}


let mutationTail = Promise.resolve(), queuedMutations = 0
function serializeMutation(action) {
  if (queuedMutations >= 16) return Promise.reject(Error('设置操作过多，请等待当前操作完成'))
  queuedMutations++
  const work = mutationTail.then(action).finally(() => queuedMutations--)
  mutationTail = work.catch(() => {})
  return work
}

export function initialAnalysisSettings(seed = {}) {
  return { analysisOutputDir: seed.outputDir || '', analysisModelDir: seed.modelDir || '', defaultAnalysisModelDir: '',
    analysisOutputMessage: '', analysisModelMessage: '', analysisRuntimeConfig: { ...DEFAULT_ANALYSIS_RUNTIME_CONFIG },
    analysisRuntimeLoaded: false, analysisRuntimeLoading: false, analysisRuntimeError: '', analysisConfigSaving: false, analysisConfigMessage: '', analysisConfigDirty: false, vlmConfigDirty: false,
    vlmState: null, vlmSaving: false, vlmStarting: false, vlmDownloading: false, vlmMessage: '', vlmObservationError: '',
    vlmModelOptions: { models: [], precisions: [], defaultModelId: '', defaultPrecision: 'Q4_K_M' },
    selectedVlmModelId: '', selectedVlmPrecision: 'Q4_K_M', localVlmFiles: [], localVlmLoading: false }
}

export class AnalysisSettings {
  constructor(api, publish, seed = {}) {
    this.api = api; this.publish = publish; this.view = initialAnalysisSettings(seed)
    this.draft = new SettingsDraft(DEFAULT_ANALYSIS_RUNTIME_CONFIG)
    this.profiles = { local: { llmBaseUrl: DEFAULT_ANALYSIS_RUNTIME_CONFIG.llmBaseUrl, llmName: DEFAULT_ANALYSIS_RUNTIME_CONFIG.llmName,
      llmApiKey: DEFAULT_ANALYSIS_RUNTIME_CONFIG.llmApiKey, ...seed.llmProfiles?.local }, api: { llmBaseUrl: '', llmName: '', llmApiKey: '', ...seed.llmProfiles?.api } }
    this.profileEdits = new Set(); this.knownProfiles = new Set(Object.keys(seed.llmProfiles || {})); this.providerChosen = false
    this.enabled = false; this.active = false; this.disposed = false; this.epoch = 0; this.busy = new Map(); this.messages = new Map()
    this.loading = null; this.controlId = 0; this.downloadId = 0; this.stateIntent = 0; this.outputIntent = 0; this.configurationDepth = 0
    this.observer = new SettingsObserver(async () => {
      const ticket = this.draft.ticket()
      return { ...await this.call('getVideoAnalysisVlmState'), ticket }
    }, result => {
      if (result.state) {
        const mapping = { provider: 'vlmProvider', baseUrl: 'vlmBaseUrl', modelName: 'vlmName', modelPath: 'vlmModelPath',
          modelDownloadUrl: 'vlmModelDownloadUrl', hfRepo: 'vlmHfRepo', hfRevision: 'vlmHfRevision', serverExecutable: 'vlmServerExecutable', serverArgs: 'vlmServerArgs' }
        const config = Object.fromEntries(Object.entries(mapping).filter(([key]) => Object.hasOwn(result.state, key)).map(([key, field]) => [field, result.state[key]]))
        this.draft.merge(cleanRuntime(config), result.ticket || this.draft.ticket())
        this.update({ vlmState: result.state, vlmObservationError: '' })
      }
    }, error => this.update({ vlmObservationError: error }))
  }
  update(patch = {}) {
    if (this.disposed) return
    this.view = { ...this.view, ...patch, analysisRuntimeConfig: { ...this.draft.values },
      analysisConfigDirty: this.draft.dirty.size > 0, vlmConfigDirty: VLM_KEYS.some(key => this.draft.dirty.has(key)),
      vlmSaving: this.busy.has('saveVlm'), vlmStarting: this.busy.has('start'), vlmDownloading: this.busy.has('download'),
      analysisConfigSaving: this.busy.has('save') || this.busy.has('reset'), localVlmLoading: this.busy.has('listModels') }
    this.publish(this.view)
  }
  feedback(key, message, duration = 2600) {
    if (this.disposed) return
    clearTimeout(this.messages.get(key)); this.update({ [key]: message })
    const timer = setTimeout(() => { if (this.messages.get(key) === timer) { this.messages.delete(key); this.update({ [key]: '' }) } }, duration)
    this.messages.set(key, timer)
  }
  async call(name, ...args) {
    if (typeof this.api?.[name] !== 'function') throw Error('当前桌面不支持此设置操作')
    const result = await this.api[name](...args)
    if (result?.success === false) throw Error(result.error || '设置操作失败')
    return result
  }
  current(record) { return !this.disposed && this.enabled && record.epoch === this.epoch && this.busy.get(record.key) === record && record.guard?.() !== false }
  run(key, messageKey, task) {
    if (this.disposed || !this.enabled) return Promise.resolve({ success: false })
    if (this.busy.has(key)) return this.busy.get(key).promise
    const record = { key, epoch: this.epoch, ticket: this.draft.ticket() }
    if (!['openModel', 'openOutput', 'selectOutput'].includes(key)) { record.stateId = ++this.stateIntent; this.observer.invalidate() }
    this.busy.set(key, record); this.update()
    record.promise = Promise.resolve().then(() => task(record)).catch(error => {
      if (this.current(record)) this.feedback(messageKey, error.message || '设置操作失败')
      return { success: false, error: error.message }
    }).finally(() => { if (this.busy.get(key) === record) { this.busy.delete(key); this.update() } })
    return record.promise
  }
  apply(result, record, keys = []) {
    if (!this.current(record)) return
    if (result?.config) this.draft.merge(cleanRuntime(result.config), record.ticket, keys)
    const provider = this.draft.values.llmProvider === 'api' ? 'api' : 'local'
    this.profiles[provider] = Object.fromEntries(LLM_KEYS.filter(key => key !== 'llmProvider').map(key => [key, this.draft.values[key]]))
    if (keys.includes('llmProvider')) this.profileEdits.add(provider)
    if (result?.state) this.observer.invalidate(record.stateId === this.stateIntent ? { state: result.state } : undefined)
    this.update({ analysisModelDir: this.draft.values.modelStorageDir || this.view.analysisModelDir })
  }
  setEnabled(enabled) {
    if (this.enabled === enabled || this.disposed) return
    this.enabled = enabled; this.epoch++; this.busy.clear()
    this.syncObserver()
    this.update({ analysisRuntimeLoaded: false, analysisRuntimeLoading: false })
    if (enabled && this.active) void this.load()
  }
  setActive(active) {
    if (this.active === active || this.disposed) return
    this.active = active; this.syncObserver()
    if (this.enabled && active && !this.view.analysisRuntimeLoaded) void this.load()
  }
  load() {
    if (!this.enabled || !this.active || this.disposed) return Promise.resolve(null)
    if (this.loading) return this.loading
    const epoch = this.epoch, ticket = this.draft.ticket(), outputIntent = this.outputIntent
    this.update({ analysisRuntimeLoading: true, analysisRuntimeError: '' })
    this.loading = (async () => {
      try {
        await mutationTail
        if (this.disposed || !this.enabled || this.epoch !== epoch) return null
        const [runtime, output, model, defaults, options] = await Promise.all([
          this.call('getVideoAnalysisRuntimeConfig'), this.call('getVideoAnalysisOutputDir'), this.call('getVideoAnalysisModelDir'),
          this.call('getDefaultVideoAnalysisModelDir'), this.call('getVideoAnalysisVlmModelOptions')
        ])
        if (this.disposed || !this.enabled || this.epoch !== epoch) return null
        this.draft.merge(cleanRuntime(runtime?.config), ticket)
        const provider = this.draft.values.llmProvider === 'api' ? 'api' : 'local'
        this.profiles[provider] = Object.fromEntries(LLM_KEYS.filter(key => key !== 'llmProvider').map(key => [key, this.draft.values[key]]))
        this.knownProfiles.add(runtime.config.llmProvider === 'api' ? 'api' : 'local')
        const modelOptions = options?.options || this.view.vlmModelOptions
        const modelId = this.view.selectedVlmModelId || modelOptions.defaultModelId || modelOptions.models?.[0]?.id || ''
        const precisions = modelOptions.models?.find(item => item.id === modelId)?.precisions || []
        const precision = !precisions.length || precisions.includes(this.view.selectedVlmPrecision) ? this.view.selectedVlmPrecision
          : precisions.includes(modelOptions.defaultPrecision) ? modelOptions.defaultPrecision : precisions[0]
        this.update({ analysisRuntimeLoaded: true, analysisOutputDir: this.outputIntent === outputIntent && typeof output === 'string' ? output : this.view.analysisOutputDir,
          analysisModelDir: this.draft.values.modelStorageDir || (typeof model === 'string' ? model : this.view.analysisModelDir),
          defaultAnalysisModelDir: typeof defaults === 'string' ? defaults : '', vlmModelOptions: modelOptions,
          selectedVlmModelId: modelId, selectedVlmPrecision: precision })
        if (runtime.config.unsupportedKeys?.length) this.feedback('analysisConfigMessage', '已忽略不支持的配置：' + runtime.config.unsupportedKeys.join(', '))
        return runtime
      } catch (error) {
        if (!this.disposed && this.enabled && this.epoch === epoch) this.update({ analysisRuntimeError: error.message })
        return null
      } finally {
        this.loading = null
        if (!this.disposed && this.epoch === epoch) this.update({ analysisRuntimeLoading: false })
        else if (!this.disposed && this.enabled && this.active) void this.load()
      }
    })()
    return this.loading
  }
  edit(key, value) {
    if (LLM_KEYS.includes(key)) {
      const patch = Object.fromEntries(LLM_KEYS.map(name => [name, this.draft.values[name]])); patch[key] = value
      this.draft.edit(patch)
      const provider = this.draft.values.llmProvider === 'api' ? 'api' : 'local'
      this.profileEdits.add(provider)
      this.profiles[provider] = { ...this.profiles[provider], [key]: value }
    } else this.draft.edit({ [key]: value })
    this.update()
  }
  reconcileSettings(settings) {
    for (const provider of ['local', 'api']) {
      const profile = settings?.llmProfiles?.[provider]
      if (!profile || this.profileEdits.has(provider)) continue
      const first = !this.knownProfiles.has(provider); this.knownProfiles.add(provider)
      const patch = Object.fromEntries(LLM_KEYS.filter(key => key !== 'llmProvider' && typeof profile[key] === 'string').map(key => [key, profile[key]]))
      this.profiles[provider] = { ...this.profiles[provider], ...patch }
      if (first && this.providerChosen && this.draft.values.llmProvider === provider &&
        Object.keys(patch).some(key => patch[key] !== this.draft.values[key])) {
        this.draft.edit(patch); this.update()
      }
    }
  }
  provider(provider) { this.providerChosen = true; this.draft.edit({ ...this.profiles[provider], llmProvider: provider }); this.update() }
  selectModel(id) {
    const model = this.view.vlmModelOptions.models?.find(item => item.id === id)
    this.update({ selectedVlmModelId: id, selectedVlmPrecision: model?.precisions?.length && !model.precisions.includes(this.view.selectedVlmPrecision)
      ? model.precisions.includes('Q4_K_M') ? 'Q4_K_M' : model.precisions[0] : this.view.selectedVlmPrecision })
  }
  requireLoaded() { if (!this.view.analysisRuntimeLoaded) throw Error('请先读取视频理解配置，再保存或启动模型') }
  syncObserver() { this.observer.setActive(this.enabled && this.active && this.configurationDepth === 0) }
  async write(record, operation) {
    this.configurationDepth++; this.syncObserver()
    try {
      return await serializeMutation(() => { if (!this.current(record)) throw Error('设置页面已关闭或插件已停用'); return operation() })
    } finally { this.configurationDepth--; this.syncObserver() }
  }
  saveVlm(patch = {}, options = {}) {
    const submitted = { ...Object.fromEntries(VLM_KEYS.filter(key => this.draft.dirty.has(key)).map(key => [key, this.draft.values[key]])), ...patch }
    return this.run('saveVlm', 'vlmMessage', async record => {
      record.guard = options.guard
      if (!this.current(record)) return { success: false }
      this.requireLoaded()
      const result = await this.write(record, () => this.call('saveVideoAnalysisVlmConfig', submitted))
      this.apply(result, record, Object.keys(submitted))
      if (this.current(record) && !options.quiet) this.feedback('vlmMessage', '视觉模型配置已保存')
      return this.current(record) ? result : { success: false }
    })
  }
  save() {
    const submitted = Object.fromEntries([...this.draft.dirty.keys()].map(key => [key, this.draft.values[key]]))
    return this.run('save', 'analysisConfigMessage', async record => {
      this.requireLoaded()
      const result = await this.write(record, () => this.call('saveVideoAnalysisRuntimeConfig', submitted))
      this.apply(result, record, Object.keys(submitted))
      if (this.current(record)) this.feedback('analysisConfigMessage', '分析参数已保存' + (this.draft.dirty.size ? '；新更改尚未保存' : ''))
      return result
    })
  }
  reset() { return this.run('reset', 'analysisConfigMessage', async record => {
    this.requireLoaded()
    const result = await this.write(record, () => this.call('resetVideoAnalysisRuntimeConfig'))
    this.apply(result, record, Object.keys(DEFAULT_ANALYSIS_RUNTIME_CONFIG))
    if (this.current(record)) this.feedback('analysisConfigMessage', '已恢复本地默认参数')
    return result
  }) }
  configure(key, method, keys, message, ...args) { return this.run(key, 'vlmMessage', async record => {
    this.requireLoaded()
    const result = await this.write(record, () => this.call(method, ...args))
    this.apply(result, record, keys)
    if (this.current(record) && result) this.feedback('vlmMessage', message)
    return result
  }) }
  selectModelFile() { return this.configure('selectModel', 'selectVideoAnalysisVlmModelFile', MODEL_KEYS, '已选择 VLM 模型文件') }
  selectLocalModel(file) { return this.configure('selectLocal', 'selectVideoAnalysisLocalVlmFile', MODEL_KEYS, '已使用本地 VLM 模型', file) }
  selectServer() { return this.configure('selectServer', 'selectVideoAnalysisVlmServerExecutable', ['vlmServerExecutable'], '已选择 VLM 服务程序') }
  selectOutput() { return this.run('selectOutput', 'analysisOutputMessage', async record => {
    ++this.outputIntent
    const value = await this.write(record, () => this.call('selectVideoAnalysisOutputDir'))
    if (this.current(record) && typeof value === 'string' && value) { this.update({ analysisOutputDir: value }); this.feedback('analysisOutputMessage', '保存目录已更新') }
  }) }
  selectDirectory() { return this.run('selectDirectory', 'analysisModelMessage', async record => {
    const directory = await this.write(record, () => this.call('selectVideoAnalysisModelDir'))
    if (!this.current(record) || typeof directory !== 'string' || !directory) return
    this.draft.merge({ modelStorageDir: directory }, record.ticket, ['modelStorageDir'])
    this.update({ analysisModelDir: directory }); this.feedback('analysisModelMessage', '模型目录已更新')
  }) }
  openDirectory(model) { return this.run(model ? 'openModel' : 'openOutput', model ? 'analysisModelMessage' : 'analysisOutputMessage', async record => {
    await this.call(model ? 'openVideoAnalysisModelDir' : 'openVideoAnalysisOutputDir')
    if (this.current(record)) this.feedback(model ? 'analysisModelMessage' : 'analysisOutputMessage', '已打开目录')
  }) }
  listModels() { return this.run('listModels', 'vlmMessage', async record => {
    const result = await this.call('listVideoAnalysisLocalVlmFiles')
    if (this.current(record)) { this.update({ localVlmFiles: result.files || [] }); this.apply(result, record); this.feedback('vlmMessage', result.files?.length ? `检测到 ${result.files.length} 个本地模型` : '当前模型目录没有检测到 VLM 模型') }
    return result
  }) }
  start() {
    if (this.busy.has('start')) return this.busy.get('start').promise
    const id = ++this.controlId
    return this.run('start', 'vlmMessage', async record => {
      record.guard = () => this.controlId === id
      if (!this.current(record)) return { success: false }
      this.requireLoaded(); this.feedback('vlmMessage', '正在启动 VLM 服务，模型加载可能需要一两分钟...', 240000)
      const saved = await this.saveVlm({}, { quiet: true, guard: record.guard })
      if (!saved?.success || !this.current(record) || this.controlId !== id) return
      record.stateId = ++this.stateIntent; this.observer.invalidate()
      const result = await this.call('startVideoAnalysisVlmService')
      if (this.current(record) && this.controlId === id) { this.apply(result, record); this.feedback('vlmMessage', 'VLM 服务已启动并连接', 5000) }
      return result
    })
  }
  stop() {
    if (this.busy.has('stop')) return this.busy.get('stop').promise
    const id = ++this.controlId; this.observer.invalidate()
    return this.run('stop', 'vlmMessage', async record => {
      record.guard = () => this.controlId === id
      if (!this.current(record)) return { success: false }
      const result = await this.call('stopVideoAnalysisVlmService')
      if (this.current(record) && this.controlId === id) { this.apply(result, record); this.feedback('vlmMessage', 'VLM 服务已停止') }
      return result
    })
  }
  download() {
    if (this.busy.has('download')) return this.busy.get('download').promise
    const id = ++this.downloadId, selection = { modelId: this.view.selectedVlmModelId, precision: this.view.selectedVlmPrecision }
    const directory = this.draft.values.modelStorageDir || this.view.analysisModelDir
    return this.run('download', 'vlmMessage', async record => {
      record.guard = () => this.downloadId === id
      if (!this.current(record)) return { success: false }
      const saved = await this.saveVlm({ vlmProvider: 'local', modelStorageDir: directory }, { guard: record.guard })
      if (!saved?.success || !this.current(record) || this.downloadId !== id) return
      record.stateId = ++this.stateIntent; this.observer.invalidate()
      this.feedback('vlmMessage', '开始下载视觉模型')
      const result = await this.call('downloadVideoAnalysisVlmModel', selection)
      if (this.current(record) && this.downloadId === id) {
        this.apply(result, record, MODEL_KEYS); this.feedback('vlmMessage', result?.state?.downloading ? '视觉模型正在下载' : '视觉模型下载完成')
      }
      return result
    })
  }
  cancelDownload() {
    if (this.busy.has('cancelDownload')) return this.busy.get('cancelDownload').promise
    const id = ++this.downloadId; this.observer.invalidate()
    return this.run('cancelDownload', 'vlmMessage', async record => {
      record.guard = () => this.downloadId === id
      if (!this.current(record)) return { success: false }
      const result = await this.call('cancelVideoAnalysisVlmDownload')
      if (this.current(record)) { this.apply(result, record); this.feedback('vlmMessage', '正在取消模型下载') }
      return result
    })
  }
  async refresh() {
    if (!this.view.analysisRuntimeLoaded) return this.load()
    return this.observer.refresh()
  }
  dispose() { this.disposed = true; this.epoch++; this.observer.dispose(); this.messages.forEach(clearTimeout); this.messages.clear(); this.busy.clear() }
}
