/** One owner for a task's requests and polling timer. Cancelling observation never cancels server work. */
export class TaskObserver<T> {
  private controller = new AbortController()
  private generation = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private flight: Promise<T | undefined> | null = null
  private disposed = false
  stop() {
    this.generation++; this.controller.abort(); this.controller = new AbortController()
    if (this.timer) clearTimeout(this.timer)
    this.timer = null; this.flight = null
  }
  async request(run: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    if (this.disposed) return undefined
    if (this.flight) return this.flight
    const generation = this.generation, signal = this.controller.signal
    const flight = Promise.resolve().then(() => { if (signal.aborted) return undefined; return run(signal) })
      .then(value => this.valid(generation) ? value : undefined)
      .catch(error => { if (!this.valid(generation) || signal.aborted) return undefined; throw error })
      .finally(() => { if (this.valid(generation)) this.flight = null })
    this.flight = flight
    return flight
  }
  poll(run: (signal: AbortSignal) => Promise<T>, receive: (value: T) => boolean,
    failed: (error: unknown) => void, intervalMs: number) {
    if (this.disposed) return
    this.stop()
    const generation = this.generation
    if (this.timer) clearTimeout(this.timer)
    const tick = async () => {
      this.timer = null
      if (!this.valid(generation)) return
      try {
        const value = await this.request(run)
        if (value === undefined || !this.valid(generation) || !receive(value)) return
        if (this.valid(generation)) this.timer = setTimeout(tick, intervalMs)
      } catch (error) { if (this.valid(generation)) failed(error) }
    }
    void tick()
  }
  private valid(generation: number) { return !this.disposed && generation === this.generation }
  dispose() { this.stop(); this.disposed = true }
}
