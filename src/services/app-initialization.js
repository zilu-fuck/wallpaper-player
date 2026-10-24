const initial = () => ({ initializationErrors: {}, initializationPending: {} })
const labels = { settings: '应用设置', plugins: '插件列表', ffmpeg: 'FFmpeg 状态', mpv: 'mpv 状态' }

export class AppInitialization {
  constructor(operations, publish) {
    this.operations = operations; this.publish = publish; this.view = initial()
    this.active = true; this.jobs = new Map()
  }
  update(key, pending, error = '') {
    this.view = { initializationErrors: { ...this.view.initializationErrors, [key]: error }, initializationPending: { ...this.view.initializationPending, [key]: pending } }
    if (this.active) this.publish(this.view)
  }
  run(key = 'settings') {
    if (!this.active || !Object.hasOwn(labels, key)) return Promise.resolve(null)
    if (this.jobs.has(key)) return this.jobs.get(key).promise
    const record = { valid: true }, current = () => this.active && record.valid
    this.update(key, true)
    if (key === 'settings') this.operations.setLoading(true)
    const job = Promise.resolve().then(async () => {
      if (!this.active) return null
      if (key !== 'settings') return this.operations[key](current)
      const settings = await this.operations.settings()
      if (!this.active) return null
      void this.run('plugins')
      await this.operations.scan(settings)
      if (!this.active) return null
      void this.run('ffmpeg'); void this.run('mpv')
      return settings
    }).then(result => { if (current()) this.update(key, false); return result }, error => {
      if (current()) this.update(key, false, error?.message?.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') || `${labels[key]}读取失败`)
      return null
    }).finally(() => {
      this.jobs.delete(key)
      if (key === 'settings' && this.active) this.operations.setLoading(false)
    })
    record.promise = job; this.jobs.set(key, record); return job
  }
  accept(key) { if (this.jobs.has(key)) this.jobs.get(key).valid = false; if (this.active) this.update(key, false) }
  dispose() { this.active = false; this.operations.cancelScan() }
}

export const initialAppInitialization = initial
