// A reply acknowledges only fields submitted by that operation and not edited since it started.
export class SettingsDraft {
  constructor(initial) { this.values = { ...initial }; this.confirmed = { ...initial }; this.dirty = new Map(); this.applied = new Map(); this.editId = 0; this.requestId = 0 }
  edit(patch) { for (const [key, value] of Object.entries(patch)) { this.values[key] = value; this.dirty.set(key, ++this.editId) } }
  ticket() { return { id: ++this.requestId, edits: new Map(this.dirty) } }
  merge(patch, ticket, acknowledged = []) {
    for (const [key, value] of Object.entries(patch)) {
      if ((this.applied.get(key) || 0) > ticket.id) continue
      this.confirmed[key] = value; this.applied.set(key, ticket.id)
      const dirty = this.dirty.has(key)
      if (dirty && !(acknowledged.includes(key) && this.dirty.get(key) === ticket.edits.get(key))) continue
      this.values[key] = value
      if (acknowledged.includes(key)) this.dirty.delete(key)
    }
  }
}

export class SettingsObserver {
  constructor(read, publish, failure, delay = 3000) {
    this.read = read; this.publish = publish; this.failure = failure; this.delay = delay
    this.active = false; this.disposed = false; this.generation = 0; this.current = null; this.timer = null; this.pending = false
  }
  setActive(active) {
    if (this.disposed || this.active === active) return
    this.active = active; this.generation++; clearTimeout(this.timer); this.timer = null
    if (active) { if (this.current) this.pending = true; else void this.refresh() }
  }
  invalidate(value) { this.generation++; if (value) this.publish(value); this.pending = true }
  refresh() {
    if (!this.active || this.disposed) return Promise.resolve(null)
    if (this.current) { this.pending = true; return this.current.promise }
    clearTimeout(this.timer); this.timer = null; this.pending = false
    const record = { generation: this.generation }; this.current = record
    record.promise = (async () => {
      try {
        const value = await this.read()
        if (this.disposed || !this.active || record.generation !== this.generation) return null
        this.publish(value); return value
      } catch (error) {
        if (!this.disposed && this.active && record.generation === this.generation) this.failure(error.message)
        return null
      } finally {
        if (this.current === record) this.current = null
        if (this.active && !this.disposed) this.timer = setTimeout(() => { this.timer = null; void this.refresh() }, this.pending ? 0 : this.delay)
      }
    })()
    return record.promise
  }
  dispose() { this.disposed = true; this.active = false; this.generation++; clearTimeout(this.timer); this.timer = null }
}
