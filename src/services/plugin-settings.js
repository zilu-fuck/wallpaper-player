import { SettingsDraft } from './settings-state'
import { acceptsSnapshot, createSettingsQueue } from './settings-operations'
import { shareJson } from '../utils/share-json'

const mutate = createSettingsQueue()
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
const emptyUi = () => ({ trustedSiteInput: '', bindingTagInput: '', bindingSiteInput: '', selectedBindingTags: [], tagSearch: '', tagPickerOpen: false })
const fields = plugin => plain(plugin?.settingsSchema) ? plugin.settingsSchema : {}
export function formatPluginField(field, value) {
  if (field?.type === 'boolean') return Boolean(value)
  if (['object', 'array'].includes(field?.type)) return typeof value === 'string' ? value : JSON.stringify(value ?? (field.type === 'array' ? [] : {}), null, 2)
  return value == null ? '' : String(value)
}
function parsePluginField(field, value) {
  if (field?.type === 'number') { const number = Number(value); if (String(value).trim() === '' || !Number.isFinite(number)) throw Error('请输入有效数字'); return number }
  if (field?.type === 'boolean') return Boolean(value)
  if (['object', 'array'].includes(field?.type)) {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    if (field.type === 'object' ? !plain(parsed) : !Array.isArray(parsed)) throw Error(field.type === 'object' ? 'JSON 必须是对象' : 'JSON 必须是数组')
    return parsed
  }
  if (field?.type === 'enum') { const option = field.enum?.find(item => String(item) === String(value)); if (option === undefined) throw Error('请选择有效选项'); return option }
  return value
}
const values = plugin => Object.fromEntries(Object.entries(fields(plugin)).map(([key, field]) => [key, formatPluginField(field, plugin?.config?.[key])]))
const identity = plugin => JSON.stringify([plugin.id, plugin.installedAt, plugin.location, plugin.publisher])
export const initialPluginSettings = plugins => ({ activePluginId: plugins.find(item => item.id === 'video-analysis')?.id || plugins[0]?.id || 'video-analysis',
  busyPluginId: '', configSaving: false, configDrafts: {}, configErrors: {}, draftChanged: false, message: '', messageError: false,
  pluginUi: emptyUi(), pluginLoading: false, pluginLoadError: '' })

export class PluginSettings {
  constructor(api, refreshPlugins, publish, plugins = [], confirm = () => false) {
    this.api = api; this.refreshPlugins = refreshPlugins; this.publish = publish; this.confirm = confirm
    this.models = new Map(); this.active = false; this.disposed = false; this.operation = null; this.selection = 0; this.readId = 0; this.reading = null
    this.view = initialPluginSettings(plugins); this.reconcile(plugins)
  }
  model() { return this.models.get(this.view.activePluginId) }
  update(patch = {}) {
    const model = this.models.get(patch.activePluginId ?? this.view.activePluginId), operation = this.operation
    this.view = shareJson(this.view, { ...this.view,
      configDrafts: model ? { ...model.draft.values } : {}, configErrors: model?.errors || {}, draftChanged: Boolean(model?.draft.dirty.size), pluginUi: model?.ui || emptyUi(),
      busyPluginId: operation?.busyId || '', configSaving: operation?.kind === 'config', message: model?.message || '', messageError: Boolean(model?.error), ...patch })
    if (this.active && !this.disposed) this.publish(this.view)
  }
  upsert(plugin) {
    let model = this.models.get(plugin.id)
    if (!model || model.identity !== identity(plugin)) {
      model = { identity: identity(plugin), plugin, draft: new SettingsDraft(values(plugin)), errors: {}, ui: emptyUi(), message: '', error: false }
      this.models.set(plugin.id, model); return model
    }
    if (acceptsSnapshot(model.plugin, plugin, '_settingsVersion')) {
      model.plugin = plugin
      const patch = values(plugin)
      for (const key of Object.keys(model.draft.values)) if (!Object.hasOwn(patch, key)) {
        delete model.draft.values[key]; delete model.draft.confirmed[key]; model.draft.dirty.delete(key); model.draft.applied.delete(key); delete model.errors[key]
      }
      model.draft.merge(patch, model.draft.ticket())
    }
    return model
  }
  reconcile(plugins) {
    const ids = new Set(plugins.map(plugin => plugin.id))
    for (const id of this.models.keys()) if (!ids.has(id)) this.models.delete(id)
    for (const plugin of plugins) this.upsert(plugin)
    if (!ids.has(this.view.activePluginId)) { this.view = { ...this.view, activePluginId: plugins.find(item => item.id === 'video-analysis')?.id || plugins[0]?.id || 'video-analysis' }; this.selection++ }
    this.update()
  }
  select(id) { if (this.models.has(id)) { this.selection++; this.update({ activePluginId: id }) } }
  edit(key, value, id = this.view.activePluginId) {
    const model = this.models.get(id), field = fields(model?.plugin)[key]
    if (!model || !field) return
    model.draft.edit({ [key]: formatPluginField(field, value) }); model.errors = { ...model.errors, [key]: '' }; model.message = ''; model.error = false; this.update()
  }
  editUi(patch, id = this.view.activePluginId) {
    const model = this.models.get(id)
    if (model) { model.ui = { ...model.ui, ...Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, typeof value === 'function' ? value(model.ui[key]) : value])) }; this.update() }
  }
  setActive(active) { if (this.disposed || this.active === active) return; this.active = active; this.update(); if (active) void this.load() }
  load(force = false) {
    if (this.disposed) return Promise.resolve([])
    if (this.reading && !force) return this.reading
    const id = ++this.readId; this.update({ pluginLoading: true })
    const promise = Promise.resolve().then(async () => {
      try {
        const plugins = await this.refreshPlugins()
        if (this.disposed || id !== this.readId) return []
        if (!Array.isArray(plugins)) throw Error('插件列表响应无效')
        this.reconcile(plugins); this.update({ pluginLoadError: '' }); return plugins
      } catch (error) { if (!this.disposed && id === this.readId) this.update({ pluginLoadError: error.message }); return [] }
      finally { if (this.reading === promise) this.reading = null; if (!this.disposed && id === this.readId) this.update({ pluginLoading: false }) }
    })
    this.reading = promise; return promise
  }
  feedback(id, text, error = false) { const model = this.models.get(id); if (model) { model.message = text; model.error = error; this.update() } }
  run(key, kind, busyId, action) {
    if (!this.active || this.disposed) return Promise.resolve({ success: false, cancelled: true })
    if (this.operation) return this.operation.key === key ? this.operation.promise : Promise.resolve({ success: false, busy: true })
    const operation = { key, kind, busyId }; this.operation = operation; this.update()
    operation.promise = mutate(async () => this.disposed ? { success: false, cancelled: true } : action()).catch(error => {
      if (!this.disposed) this.feedback(this.models.has(busyId) ? busyId : this.view.activePluginId, error.message, true)
      return { success: false, error: error.message }
    }).finally(() => { if (this.operation === operation) { this.operation = null; if (!this.disposed) this.update() } })
    return operation.promise
  }
  save(onlyKey, targetId = this.view.activePluginId) {
    const model = this.models.get(targetId)
    if (!model) return Promise.resolve({ success: false })
    const schema = fields(model.plugin), keys = onlyKey ? [onlyKey] : [...model.draft.dirty.keys()], patch = {}, errors = {}
    for (const key of keys) try { patch[key] = parsePluginField(schema[key], model.draft.values[key]) } catch (error) { errors[key] = error.message }
    model.errors = errors; this.update()
    if (Object.keys(errors).length || !keys.length) return Promise.resolve({ success: false })
    const id = model.plugin.id, ticket = model.draft.ticket()
    return this.run('config:' + id + ':' + JSON.stringify(patch), 'config', id, async () => {
      const result = await this.api.savePluginConfig(id, patch)
      if (this.disposed) return { success: false, cancelled: true }
      if (result?.success === false || !result) throw Error(result?.error || '插件配置保存失败')
      if (result.plugin) this.upsert(result.plugin)
      await this.load(true)
      if (this.disposed || this.models.get(id) !== model) return { success: false, cancelled: true }
      for (const key of keys) if (model.draft.dirty.get(key) === ticket.edits.get(key)) model.draft.dirty.delete(key)
      model.draft.merge(values(model.plugin), model.draft.ticket())
      this.feedback(id, '插件配置已保存' + (model.draft.dirty.size ? '；新更改尚未保存' : ''))
      return result
    })
  }
  commit(key, value, id = this.view.activePluginId) { this.edit(key, value, id); return this.save(key, id) }
  toggle(id, enabled) {
    return this.run('toggle:' + id + ':' + enabled, 'lifecycle', id, async () => {
      const result = await this.api.setPluginEnabled(id, enabled)
      if (this.disposed) return { success: false, cancelled: true }
      await this.load(true)
      this.feedback(id, result?.success ? enabled ? '插件已启用' : '插件已停用' : result?.error || '插件状态更新失败', !result?.success)
      return result
    })
  }
  install(type = 'file') {
    const selection = this.selection
    return this.run('install:' + type, 'install', 'install-' + type, async () => {
      const result = await this.api.installPlugin(type)
      if (this.disposed || result?.canceled) return result
      await this.load(true)
      if (result?.success && selection === this.selection && this.models.has(result.plugin?.id)) this.select(result.plugin.id)
      this.feedback(this.view.activePluginId, result?.success ? '插件已安装：' + (result.plugin?.name || result.plugin?.id) : result?.error || '插件安装失败', !result?.success)
      return result
    })
  }
  uninstall(id) {
    const model = this.models.get(id)
    if (!model?.plugin.uninstallable || this.operation || !this.confirm(model.plugin)) return Promise.resolve({ success: false, canceled: true })
    return this.run('uninstall:' + id, 'lifecycle', id, async () => {
      const result = await this.api.uninstallPlugin(id)
      if (this.disposed) return { success: false, cancelled: true }
      await this.load(true); this.feedback(this.view.activePluginId, result?.success ? '插件已卸载' : result?.error || '插件卸载失败', !result?.success)
      return result
    })
  }
  openDirectory() { return this.run('directory', 'directory', 'directory', async () => {
    const result = await this.api.openPluginsDirectory()
    if (!this.disposed) this.feedback(this.view.activePluginId, result?.success ? '已打开插件目录' : result?.error || '打开插件目录失败', !result?.success)
    return result
  }) }
  dispose() { this.disposed = true; this.active = false; this.readId++; this.models.clear() }
}
