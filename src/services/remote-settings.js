import { SettingsObserver } from './settings-state'
import { acceptsSnapshot, createSettingsQueue } from './settings-operations'
import { shareJson } from '../utils/share-json'

const mutate = createSettingsQueue()
export const initialRemoteSettings = settings => ({ remoteState: null, remotePort: String(settings?.remoteAccess?.port || 38127),
  remoteDirty: false, remoteSaving: false, remoteBusy: '', remoteCopied: '', remoteError: '', remoteLoadError: '', remoteLoading: true,
  pairingCode: null, pairingLoading: false, pairingTick: Date.now() })

export class RemoteSettings {
  constructor(api, publish, settings) {
    this.api = api; this.publish = publish; this.view = initialRemoteSettings(settings)
    this.active = false; this.disposed = false; this.portEdit = 0; this.portDirty = false; this.activity = 0; this.operation = null; this.countdown = null
    this.observer = new SettingsObserver(() => this.api.remoteGetState(), state => {
      this.accept(state); this.update({ remoteLoading: false, remoteLoadError: '' })
    }, error => this.update({ remoteLoading: false, remoteLoadError: error }), 3000)
  }
  update(patch = {}) { this.view = shareJson(this.view, { ...this.view, ...patch }); if (this.active && !this.disposed) this.publish(this.view) }
  accept(state) {
    if (!state || typeof state.running !== 'boolean' || !state.settings || typeof state.settings !== 'object') throw Error('手机访问状态无效')
    if (!acceptsSnapshot(this.view.remoteState, state, '_remoteVersion')) return false
    if (this.view.remoteState?.endpoint !== state.endpoint || !state.running) this.clearPairing()
    this.update({ remoteState: state, ...(!this.portDirty ? { remotePort: String(state.settings.port) } : {}) })
    return true
  }
  event(state) { if (!this.active || this.disposed) return; this.observer.generation++; this.accept(state) }
  reconcile(settings) { if (!this.portDirty && !this.view.remoteState) this.update({ remotePort: String(settings?.remoteAccess?.port || 38127) }) }
  editPort(value) { this.portEdit++; this.portDirty = true; this.update({ remotePort: value, remoteDirty: true, remoteError: '', remoteCopied: '' }) }
  setActive(active) {
    if (this.disposed || this.active === active) return
    this.active = active; this.activity++; this.observer.setActive(active && !this.operation)
    this.update({ pairingTick: Date.now() }); this.scheduleCountdown()
  }
  refresh() { this.update({ remoteLoading: true }); return this.observer.refresh() }
  clearPairing() { clearInterval(this.countdown); this.countdown = null; this.observer.delay = 3000; this.update({ pairingCode: null }) }
  scheduleCountdown() {
    clearInterval(this.countdown); this.countdown = null
    const tick = () => {
      if (!this.active || !this.view.pairingCode || this.disposed) return
      this.update({ pairingTick: Date.now() })
      if (this.view.pairingTick >= this.view.pairingCode.expiresAt) {
        clearInterval(this.countdown); this.countdown = null; this.observer.delay = 3000
      }
    }
    tick()
    if (this.active && this.view.pairingCode?.expiresAt > Date.now()) this.countdown = setInterval(tick, 1000)
  }
  run(key, action) {
    if (!this.active || this.disposed) return Promise.resolve({ success: false, cancelled: true })
    if (this.operation) return this.operation.key === key ? this.operation.promise : Promise.resolve({ success: false, busy: true })
    const operation = { key, activity: this.activity, endpoint: this.view.remoteState?.endpoint }; this.operation = operation
    this.observer.setActive(false)
    this.update({ remoteBusy: key, remoteSaving: key.startsWith('save:'), pairingLoading: key === 'pair', remoteError: '', remoteCopied: '' })
    operation.promise = mutate(async () => {
      if (this.disposed) return { success: false, cancelled: true }
      return action(operation)
    }).catch(error => {
      if (!this.disposed) this.update({ remoteError: error?.message || '手机访问操作失败' })
      return { success: false, error: error?.message }
    }).finally(() => {
      if (this.operation !== operation) return
      this.operation = null
      if (!this.disposed) {
        this.update({ remoteBusy: '', remoteSaving: false, pairingLoading: false })
        this.observer.setActive(this.active)
      }
    })
    return operation.promise
  }
  save(patch = {}) {
    const submittingPort = !Object.keys(patch).length
    if (submittingPort && !this.portDirty) return Promise.resolve({ success: true })
    const edit = this.portEdit
    if (submittingPort) {
      const port = Number(this.view.remotePort)
      if (!/^\d+$/.test(this.view.remotePort) || !Number.isInteger(port) || port < 1 || port > 65535) {
        this.update({ remoteError: '端口必须是 1 到 65535 的整数' }); return Promise.resolve({ success: false })
      }
      patch = { port }
    }
    return this.run('save:' + JSON.stringify(patch), async () => {
      const state = await this.api.remoteSaveSettings(patch)
      if (this.disposed) return { success: false, cancelled: true }
      this.accept(state)
      if (submittingPort && this.portEdit === edit) { this.portDirty = false; this.update({ remotePort: String(this.view.remoteState.settings.port), remoteDirty: false }) }
      this.update({ remoteError: state.error ? '服务启动失败：' + state.error : '', remoteCopied: state.error ? '' : '手机访问设置已保存' })
      return { success: !state.error, state }
    })
  }
  action(key, method, args = [], message = '') {
    return this.run(key, async operation => {
      const result = await this.api[method](...args)
      if (this.disposed) return { success: false, cancelled: true }
      if (result?.success === false) throw Error(result.error || '操作未完成，请重试')
      const state = result?.state || (result?.settings ? result : null)
      if (state) this.accept(state)
      if (key === 'pair') {
        if (operation.activity !== this.activity || !this.active) return { success: false, cancelled: true }
        if (operation.endpoint !== this.view.remoteState?.endpoint || !this.view.remoteState?.running) throw Error('访问地址已变化，请重新生成绑定码')
        if (!result?.pairingCode || !Number.isFinite(result.expiresAt)) throw Error('绑定码响应无效')
        this.update({ pairingCode: result, pairingTick: Date.now() }); this.observer.delay = 1000; this.scheduleCountdown()
      }
      if (key === 'rotate') this.clearPairing()
      this.update({ remoteCopied: message })
      return result
    })
  }
  copyPairing() {
    if (!this.view.pairingCode || this.view.pairingCode.expiresAt <= Date.now()) return Promise.resolve({ success: false })
    return this.action('copy-pair', 'remoteCopyPairingCode', [this.view.pairingCode.pairingCode], '绑定码已复制')
  }
  dispose() { this.disposed = true; this.active = false; this.activity++; this.observer.dispose(); clearInterval(this.countdown); this.countdown = null }
}
