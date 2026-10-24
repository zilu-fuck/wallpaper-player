export class DownloadStateObserver {
  constructor(api, { onState, onError, delay = 1000 }) {
    this.api = api || {}; this.onState = onState; this.onError = onError; this.delay = delay
    this.active = false; this.disposed = false; this.generation = 0; this.current = null; this.timer = null; this.pendingRefresh = false
  }
  cancel(record) {
    if (!record || record.cancelled || record.finished) return
    record.cancelled = true
    try { Promise.resolve(this.api.cancelMediaWork?.(record.requestId)).catch(() => {}) } catch {}
  }
  setActive(active) {
    if (this.disposed || this.active === active) return
    this.active = active; this.generation++
    clearTimeout(this.timer); this.timer = null
    if (!active) this.cancel(this.current)
    else if (!this.current) void this.refresh()
  }
  publishMutation(value) {
    if (this.disposed) return
    this.generation++; this.cancel(this.current); this.onState(value)
    if (this.active && !this.current) this.schedule()
  }
  schedule() {
    clearTimeout(this.timer)
    const refresh = this.pendingRefresh
    if (this.active && !this.disposed) this.timer = setTimeout(() => { this.timer = null; void this.refresh({ refresh }) }, refresh ? 0 : this.delay)
  }
  refresh({ refresh = false } = {}) {
    if (this.disposed || !this.active) return Promise.resolve(null)
    if (this.current) { this.pendingRefresh ||= refresh; return this.current.promise }
    clearTimeout(this.timer); this.timer = null
    const record = { requestId: 'downloads-' + crypto.randomUUID(), generation: this.generation, finished: false }
    this.current = record; this.pendingRefresh = false
    record.promise = (async () => {
      try {
        const result = await this.api.downloadGetState({ start: false, refresh, requestId: record.requestId })
        record.finished = true
        if (!this.active || this.disposed || record.generation !== this.generation) return null
        if (!result?.success) throw new Error(result?.error || '读取下载中心状态失败')
        this.onState({ engine: result.engine, tasks: result.tasks || [] }); return result
      } catch (error) {
        if (this.active && !this.disposed && record.generation === this.generation) this.onError(error.message || '读取下载中心状态失败')
        return null
      } finally {
        this.cancel(record)
        if (this.current === record) { this.current = null; this.schedule() }
      }
    })()
    return record.promise
  }
  dispose() { this.disposed = true; this.active = false; this.generation++; clearTimeout(this.timer); this.timer = null; this.cancel(this.current) }
}
