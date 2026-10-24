export const emptyProgressPreview = () => ({ visible: false, time: 0, x: 0, imageUrl: '', loading: false })
export const mediaRequestId = () => 'media_' + (globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + '_' + Math.random().toString(36).slice(2))

/** One view owns its debounce, cache, current frame request and latest pending position. */
export class ProgressPreviewController {
  constructor(api, target, publish, { cacheLimit = 24, cacheBytes = 4 * 1024 * 1024, debounceMs = 120 } = {}) {
    this.api = api; this.target = target; this.publish = publish
    this.cacheLimit = cacheLimit; this.cacheBytes = cacheBytes; this.debounceMs = debounceMs
    this.cache = new Map(); this.bytes = 0; this.timer = null; this.flight = null; this.pending = null
    this.disposed = false; this.state = emptyProgressPreview(); this.requestId = null
  }
  update(patch) { if (!this.disposed) { this.state = { ...this.state, ...patch }; this.publish(this.state) } }
  show(time, x) {
    if (this.disposed) return
    const seconds = Math.max(0, Math.round(Number(time) || 0)), imageUrl = this.cache.get(seconds) || ''
    this.cancelTimer(); this.pending = null
    this.update({ visible: true, time, x, imageUrl, loading: !imageUrl && Boolean(this.target) })
    if (!imageUrl && this.target) this.timer = setTimeout(() => { this.timer = null; this.request(seconds) }, this.debounceMs)
  }
  cancelTimer() { if (this.timer !== null) clearTimeout(this.timer); this.timer = null }
  cancelRequest() {
    if (this.requestId && this.api?.cancelMediaWork) {
      try { Promise.resolve(this.api.cancelMediaWork(this.requestId)).catch(() => {}) } catch {}
    }
  }
  hide() { this.cancelTimer(); this.pending = null; this.cancelRequest(); this.update({ visible: false, loading: false }) }
  request(seconds) {
    if (this.disposed || !this.state.visible) return
    if (this.flight) { this.pending = seconds; return }
    if (!this.api?.generatePreviewFrame || !this.api?.getThumbnailUrl) { this.update({ loading: false }); return }
    const requestId = mediaRequestId(); this.requestId = requestId
    const flight = Promise.resolve().then(() => {
      if (!this.disposed) return this.api.generatePreviewFrame(this.target, seconds, requestId)
    }).then(async result => {
      if (this.disposed || !result?.framePath) return ''
      return await this.api.getThumbnailUrl(result.framePath)
    }).then(imageUrl => {
      if (this.disposed) return
      if (imageUrl && imageUrl.length * 2 <= this.cacheBytes) {
        this.bytes -= (this.cache.get(seconds)?.length || 0) * 2
        this.cache.delete(seconds); this.cache.set(seconds, imageUrl); this.bytes += imageUrl.length * 2
        while (this.cache.size > this.cacheLimit || this.bytes > this.cacheBytes) {
          const oldest = this.cache.keys().next().value
          this.bytes -= this.cache.get(oldest).length * 2; this.cache.delete(oldest)
        }
      }
      if (this.state.visible && Math.max(0, Math.round(Number(this.state.time) || 0)) === seconds) {
        this.update({ imageUrl: imageUrl || '', loading: false })
      }
    }).catch(() => {
      if (this.state.visible && Math.round(Number(this.state.time) || 0) === seconds) this.update({ loading: false })
    }).finally(() => {
      if (this.flight !== flight) return
      this.flight = null; this.requestId = null
      const pending = this.pending; this.pending = null
      if (!this.disposed && pending !== null && this.state.visible) this.request(pending)
    })
    this.flight = flight
  }
  dispose() { this.disposed = true; this.cancelTimer(); this.cancelRequest(); this.pending = null; this.cache.clear(); this.bytes = 0 }
}

/** Owns only host geometry; the playback adapter owns the native window. */
export class MpvHostController {
  constructor(getElement, getAdapter, surface, page) {
    this.getElement = getElement; this.getAdapter = getAdapter; this.surface = surface; this.page = page
    this.frames = new Set(); this.timers = new Set(); this.last = null; this.active = false; this.observer = null
    this.onViewportChange = () => this.schedule(false)
  }
  readBounds() {
    const element = this.getElement()
    if (!element) return null
    const rect = element.getBoundingClientRect()
    const width = this.surface.innerWidth || this.page.documentElement.clientWidth || 0
    const height = this.surface.innerHeight || this.page.documentElement.clientHeight || 0
    if (rect.width < 8 || rect.height < 8 || rect.right <= 0 || rect.bottom <= 0 || rect.left >= width || rect.top >= height) return null
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
  }
  sync() {
    if (!this.active) return
    const adapter = this.getAdapter(), bounds = this.readBounds()
    if (!adapter?.bounds || !bounds) return
    if (this.last?.adapter === adapter && Object.keys(bounds).every(key => this.last.bounds[key] === bounds[key])) return
    const record = { adapter, bounds }; this.last = record
    Promise.resolve().then(() => {
      if (this.active && this.getAdapter() === adapter) return adapter.bounds(bounds)
    }).catch(() => { if (this.last === record) this.last = null })
  }
  clearJobs() {
    for (const id of this.frames) cancelAnimationFrame(id)
    for (const id of this.timers) clearTimeout(id)
    this.frames.clear(); this.timers.clear()
  }
  schedule(burst = false) {
    this.clearJobs()
    if (!this.active) return
    const chain = remaining => {
      const id = requestAnimationFrame(() => {
        this.frames.delete(id); this.sync()
        if (this.active && remaining > 0) chain(remaining - 1)
      })
      this.frames.add(id)
    }
    chain(burst ? 12 : 0)
    if (burst) for (const delay of [80, 180, 360, 700]) {
      const id = setTimeout(() => { this.timers.delete(id); this.sync() }, delay)
      this.timers.add(id)
    }
  }
  start(Observer) {
    this.active = true
    const element = this.getElement()
    if (element && Observer) { this.observer = new Observer(() => this.schedule(true)); this.observer.observe(element) }
    this.surface.addEventListener('resize', this.onViewportChange)
    this.surface.addEventListener('scroll', this.onViewportChange, true)
    this.schedule(true)
  }
  dispose() {
    this.active = false; this.clearJobs(); this.last = null
    this.surface.removeEventListener('resize', this.onViewportChange)
    this.surface.removeEventListener('scroll', this.onViewportChange, true)
    this.observer?.disconnect(); this.observer = null
  }
}
