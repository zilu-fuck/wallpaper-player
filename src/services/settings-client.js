import { shareJson } from '../utils/share-json'
import { applySettingsMap, settingsEventSchema, settingsFeedSchema, settingsVersionSchema } from '@wallpaper/contracts'

const record = value => value && typeof value === 'object' && !Array.isArray(value)
const closed = () => Object.assign(new Error('设置操作所属界面已关闭'), { code: 'settings_owner_closed' })
const versionOf = value => {
  const version = value?._settingsVersion
  if (!version) return null
  if (!record(version) || typeof version.epoch !== 'string' || !version.epoch || version.epoch.length > 128 ||
      !Number.isSafeInteger(version.revision) || version.revision < 0) throw new Error('设置快照版本无效，请重新读取')
  return version
}
const mergePatch = (value, patch) => {
  const next = { ...value, ...patch }
  for (const [key, item] of Object.entries(patch)) {
    if (record(item) && record(value?.[key])) next[key] = { ...value[key], ...item }
  }
  return next
}

// One owner holds confirmed snapshots and ordered optimistic intents. Native writes finish once sent.
export class SettingsClient {
  constructor(api, publish, reportError, { maxPending = 32 } = {}) {
    this.api = api; this.publish = publish; this.reportError = reportError; this.maxPending = maxPending
    this.confirmed = null; this.view = null; this.pending = []; this.sequence = 0; this.observation = 0
    this.generation = 0; this.active = true; this.tail = Promise.resolve(); this.outstanding = 0
    this.incremental = typeof api.getSettingsFeed === 'function' && typeof api.onSettingsPatched === 'function'
    this.feedId = null; this.feedRequest = null; this.patchRefresh = null; this.patchWanted = null; this.patchInvalid = 0
    this.pendingFeedVersions = new Map()
  }
  resume() { if (!this.active) { this.active = true; this.generation++; this.updateView() } }
  current(generation) { return this.active && generation === this.generation }
  updateView() {
    const next = this.pending.reduce((settings, item) => mergePatch(settings, item.patch), this.confirmed)
    this.view = shareJson(this.view, next)
    if (this.active) this.publish(this.view)
  }
  receive(snapshot) {
    if (!this.active || !record(snapshot)) return false
    const incoming = versionOf(snapshot), previous = versionOf(this.confirmed)
    if (previous && (!incoming || incoming.epoch !== previous.epoch || incoming.revision <= previous.revision)) return false
    const next = shareJson(this.confirmed, snapshot)
    if (next !== this.confirmed) { this.confirmed = next; this.observation++ }
    this.updateView()
    return true
  }
  async read() {
    if (this.incremental) return this.readFeed()
    const generation = this.generation, observation = this.observation
    if (!this.current(generation)) throw closed()
    const snapshot = await this.api.getSettings()
    if (!this.current(generation)) throw closed()
    if (!record(snapshot)) throw new Error('读取到无效的设置')
    if (versionOf(snapshot) || observation === this.observation) this.receive(snapshot)
    return this.view
  }
  wantsPatchRefresh() {
    if (this.patchInvalid) return true
    const current = versionOf(this.confirmed)
    return Boolean(this.patchWanted && (!current || current.epoch !== this.patchWanted.epoch || current.revision < this.patchWanted.revision))
  }
  wantPatch(version) {
    if (!this.patchWanted || this.patchWanted.epoch !== version.epoch || this.patchWanted.revision < version.revision) this.patchWanted = version
  }
  readFeed() {
    const generation = this.generation
    if (!this.current(generation)) return Promise.reject(closed())
    if (this.feedRequest) {
      if (this.feedRequest.generation === generation) return this.feedRequest.promise
      return this.feedRequest.promise.catch(() => {}).then(() => { if (!this.current(generation)) throw closed(); return this.readFeed() })
    }
    const request = { generation, succeeded: false, wantedAtStart: this.patchWanted, invalidAtStart: this.patchInvalid }; this.feedRequest = request
    request.promise = Promise.resolve().then(async () => {
      const feed = settingsFeedSchema.parse(await this.api.getSettingsFeed())
      if (!this.current(generation)) throw closed()
      this.feedId = feed.feedId; this.receive(feed.snapshot)
      const pending = this.pendingFeedVersions.get(feed.feedId)
      this.pendingFeedVersions.clear(); if (pending) this.wantPatch(pending)
      if (this.patchInvalid === request.invalidAtStart) this.patchInvalid = 0
      const current = versionOf(this.confirmed)
      if (current && this.patchWanted && (this.patchWanted === request.wantedAtStart || current.epoch !== this.patchWanted.epoch || current.revision >= this.patchWanted.revision)) this.patchWanted = null
      request.succeeded = true
      return this.view
    }).finally(() => {
      if (this.feedRequest === request) this.feedRequest = null
      if (request.succeeded && this.current(generation) && this.wantsPatchRefresh()) this.refreshPatch()
    })
    return request.promise
  }
  refreshPatch() {
    if (!this.active || !this.incremental || this.feedRequest || this.patchRefresh || !this.wantsPatchRefresh()) return
    const generation = this.generation, sequence = this.sequence
    let succeeded = false, task
    task = this.readFeed().then(() => { succeeded = true }).catch(error => {
      if (this.current(generation) && sequence === this.sequence && this.wantsPatchRefresh()) this.reportError(error?.message || '设置同步失败')
    }).finally(() => {
      if (this.patchRefresh === task) this.patchRefresh = null
      if (succeeded && this.current(generation) && this.wantsPatchRefresh()) this.refreshPatch()
    })
    this.patchRefresh = task
  }
  receivePatch(input) {
    if (!this.active || !this.incremental) return false
    let event
    try { event = settingsEventSchema.parse(input) }
    catch { this.patchInvalid++; this.refreshPatch(); return false }
    const incoming = event.kind === 'settings-snapshot-v1' ? versionOf(event.snapshot) : event.version
    if (event.feedId !== this.feedId) {
      if (this.feedRequest) {
        const previous = this.pendingFeedVersions.get(event.feedId)
        if (!previous || previous.epoch !== incoming.epoch || previous.revision < incoming.revision) this.pendingFeedVersions.set(event.feedId, incoming)
        if (this.pendingFeedVersions.size > 8) this.pendingFeedVersions.delete(this.pendingFeedVersions.keys().next().value)
      }
      return false
    }
    if (event.kind === 'settings-snapshot-v1') return this.receive(event.snapshot)
    const current = versionOf(this.confirmed)
    if (current?.epoch === incoming.epoch && current.revision >= incoming.revision) return false
    if (event.kind === 'settings-resync-v1') { this.wantPatch(incoming); this.refreshPatch(); return false }
    if (!current || current.epoch !== event.baseVersion.epoch || current.revision !== event.baseVersion.revision) {
      this.wantPatch(incoming); this.refreshPatch(); return false
    }
    try {
      const next = { ...this.confirmed }
      for (const name of event.removed) delete next[name]
      for (const [name, value] of Object.entries(event.set)) Object.defineProperty(next, name, { value, enumerable: true, writable: true, configurable: true })
      for (const [name, delta] of Object.entries(event.maps)) Object.defineProperty(next, name, {
        value: applySettingsMap(this.confirmed[name], delta), enumerable: true, writable: true, configurable: true
      })
      next._settingsVersion = incoming
      const accepted = this.receive(next)
      if (!this.wantsPatchRefresh()) this.patchWanted = null
      return accepted
    } catch { this.patchInvalid++; this.refreshPatch(); return false }
  }
  async reconcileMutation(result) {
    const generation = this.generation
    if (!this.current(generation)) throw closed()
    if (record(result?.settings)) this.receive(result.settings)
    if (!Object.hasOwn(result || {}, 'settingsVersion')) return this.confirmed
    const expected = settingsVersionSchema.parse(result.settingsVersion)
    const reached = () => {
      const actual = versionOf(this.confirmed)
      return actual?.epoch === expected.epoch && actual.revision >= expected.revision
    }
    if (!reached()) await this.read()
    if (!this.current(generation)) throw closed()
    if (!reached()) throw new Error('修改已保存，但设置同步未完成，请重新读取')
    return this.confirmed
  }
  save(input) {
    if (!this.active) return Promise.reject(closed())
    const id = ++this.sequence
    const reject = message => { this.reportError(message); return Promise.reject(new Error(message)) }
    if (!record(input)) return reject('设置修改无效')
    if (this.outstanding >= this.maxPending) return reject('设置保存请求过多，请稍后重试')
    let patch
    try { patch = JSON.parse(JSON.stringify(input)); delete patch._settingsVersion }
    catch { return reject('设置修改必须是有效 JSON') }
    const intent = { id, generation: this.generation, patch }
    this.outstanding++; this.pending.push(intent); this.reportError(''); this.updateView()
    const work = this.tail.then(async () => {
      if (!this.current(intent.generation)) throw closed()
      const observation = this.observation
      try {
        const result = await this.api.saveSettings(patch, this.incremental ? { settingsReply: 'version-v1' } : undefined)
        if (!this.current(intent.generation)) throw closed()
        if (result?.success === false) throw new Error(result.error || '设置保存失败')
        if (Object.hasOwn(result || {}, 'settingsVersion')) await this.reconcileMutation(result)
        else if (record(result?.settings)) {
          if (versionOf(result.settings) || observation === this.observation) this.receive(result.settings)
          else await this.read() // Older servers have no clock; reconcile a reply overtaken by a broadcast.
        } else await this.read()
        return this.confirmed
      } catch (error) {
        if (this.current(intent.generation) && intent.id === this.sequence) this.reportError(error?.message || '设置保存失败')
        throw error
      } finally {
        this.pending = this.pending.filter(item => item !== intent)
        if (this.current(intent.generation)) this.updateView()
      }
    }).finally(() => this.outstanding--)
    this.tail = work.catch(() => {})
    return work
  }
  dispose() {
    this.active = false; this.generation++; this.pending = []
    this.feedId = null; this.patchWanted = null; this.patchInvalid = 0; this.pendingFeedVersions.clear(); this.patchRefresh = null
    this.view = this.confirmed
  }
}
