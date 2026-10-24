const { getMediaPressure, onMediaPressureChanged } = require('../media-pressure')

function taskError(code, message, status = 503, retryable = false) {
  return Object.assign(new Error(message), { code, status, retryable })
}

/** A cancelled worker retains its resource lease until its process/IO actually settles. */
class ResourceScheduler {
  constructor({ limits = { media: 2, transfer: 4, prepare: 4, parser: 2, installer: 1, control: 4 }, queueLimit = 240, backgroundLimit = 120, interestLimit = 128,
    getPressure = getMediaPressure, subscribe = onMediaPressureChanged } = {}) {
    this.limits = limits; this.queueLimit = queueLimit; this.backgroundLimit = backgroundLimit; this.interestLimit = interestLimit
    this.getPressure = getPressure; this.jobs = new Map(); this.queue = []; this.running = new Set(); this.used = {}; this.pausedBackgroundTypes = new Set()
    this.sequence = 0; this.closing = false; this.unsubscribe = subscribe(() => this.drain())
  }
  enqueue(options, task) {
    if (this.closing) return Promise.reject(taskError('task_stopping', '媒体任务服务正在关闭'))
    if (options.signal?.aborted) return Promise.reject(taskError('task_cancelled', '媒体任务已取消', 499))
    const key = options.key || Symbol(options.type || 'media')
    let job = this.jobs.get(key)
    if (job?.controller.signal.aborted) return Promise.reject(taskError('task_cancelling', '媒体任务正在结束，请稍后再试', 409, true))
    if (!job) {
      const background = Boolean(options.background)
      if (this.queue.length >= this.queueLimit || (background && this.queue.filter(item => item.background).length >= this.backgroundLimit)) {
        return Promise.reject(taskError('task_queue_full', '媒体任务过多，请稍后再试', 429, true))
      }
      const resources = options.resources || { media: 1 }
      for (const [name, count] of Object.entries(resources)) {
        if (!Number.isInteger(count) || count < 1 || count > (this.limits[name] || 0)) {
          return Promise.reject(taskError('invalid_task_budget', '媒体任务资源预算无效', 500))
        }
      }
      job = { key, type: options.type || 'media', resources, background, priority: Number(options.priority) || 0,
        groupLimit: options.groupLimit || Infinity, sequence: ++this.sequence, task, consumers: new Set(), controller: new AbortController() }
      const timeout = Math.max(1, Number(options.timeoutMs) || 45000)
      job.deadlineAt = Date.now() + timeout
      job.timer = setTimeout(() => this.cancel(job, taskError('task_timeout', '媒体任务超过最长等待时间', 504, true)), timeout)
      job.timer.unref?.()
      this.jobs.set(key, job); this.queue.push(job)
    } else {
      job.priority = Math.max(job.priority, Number(options.priority) || 0)
      if (!options.background) job.background = false
    }
    if (job.consumers.size >= this.interestLimit) return Promise.reject(taskError('task_interest_limit', '媒体任务订阅过多', 429, true))
    return new Promise((resolve, reject) => {
      const consumer = { resolve, reject, signal: options.signal }
      consumer.abort = () => {
        this.finishConsumer(job, consumer, taskError('task_cancelled', '媒体任务已取消', 499))
        if (!job.consumers.size) this.cancel(job, taskError('task_cancelled', '媒体任务已取消', 499))
      }
      job.consumers.add(consumer)
      consumer.signal?.addEventListener('abort', consumer.abort, { once: true })
      if (consumer.signal?.aborted) consumer.abort()
      this.drain()
    })
  }
  finishConsumer(job, consumer, error, result) {
    if (!job.consumers.delete(consumer)) return
    consumer.signal?.removeEventListener('abort', consumer.abort)
    if (error) consumer.reject(error); else consumer.resolve(result)
  }
  cancel(job, error) {
    if (job.finished || job.controller.signal.aborted) return
    clearTimeout(job.timer)
    job.controller.abort(error)
    for (const consumer of [...job.consumers]) this.finishConsumer(job, consumer, error)
    if (!this.running.has(job)) {
      this.queue = this.queue.filter(item => item !== job); job.finished = true
      if (this.jobs.get(job.key) === job) this.jobs.delete(job.key)
      this.drain()
    }
  }
  drain() {
    if (this.closing) return
    this.queue.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence)
    while (true) {
      const pressure = this.getPressure().active
      const index = this.queue.findIndex(job => !job.controller.signal.aborted && (!job.background || (!pressure && !this.pausedBackgroundTypes.has(job.type))) &&
        Object.entries(job.resources).every(([name, count]) => (this.used[name] || 0) + count <= this.limits[name]) &&
        [...this.running].filter(item => item.type === job.type).length < job.groupLimit)
      if (index < 0) return
      const [job] = this.queue.splice(index, 1)
      this.running.add(job)
      for (const [name, count] of Object.entries(job.resources)) this.used[name] = (this.used[name] || 0) + count
      const context = { signal: job.controller.signal, deadlineAt: job.deadlineAt,
        throwIfAborted: () => {
          if (!job.controller.signal.aborted && Date.now() >= job.deadlineAt) this.cancel(job, taskError('task_timeout', '媒体任务超过最长等待时间', 504, true))
          if (job.controller.signal.aborted) throw job.controller.signal.reason
        } }
      job.completion = Promise.resolve().then(() => { context.throwIfAborted(); return job.task(context) }).then(result => {
        context.throwIfAborted()
        for (const consumer of [...job.consumers]) this.finishConsumer(job, consumer, null, result)
      }, error => { for (const consumer of [...job.consumers]) this.finishConsumer(job, consumer, error) }).catch(() => {}).finally(() => {
        job.finished = true; clearTimeout(job.timer); this.running.delete(job)
        for (const [name, count] of Object.entries(job.resources)) this.used[name] -= count
        if (this.jobs.get(job.key) === job) this.jobs.delete(job.key)
        this.drain()
      })
    }
  }
  diagnostics() {
    return { queued: this.queue.length, running: this.running.size, interests: [...this.jobs.values()].reduce((sum, job) => sum + job.consumers.size, 0),
      used: { ...this.used }, closing: this.closing }
  }
  setBackgroundPaused(type, paused) {
    if (paused) this.pausedBackgroundTypes.add(type); else this.pausedBackgroundTypes.delete(type)
    this.drain()
  }
  acquire(options) {
    let grant, rejectGrant, release
    const granted = new Promise((resolve, reject) => { grant = resolve; rejectGrant = reject })
    const released = new Promise(resolve => { release = resolve })
    this.enqueue(options, async context => {
      grant({ signal: context.signal, deadlineAt: context.deadlineAt, release })
      await released
    }).catch(rejectGrant)
    return granted
  }
  async waitForIdle(types) {
    while (true) {
      const jobs = [...this.running].filter(job => !types || types.includes(job.type))
      if (!jobs.length) return
      await Promise.allSettled(jobs.map(job => job.completion))
    }
  }
  async waitForKey(key, { signal, deadlineAt = Date.now() + 45000 } = {}) {
    const job = this.jobs.get(key)
    if (!job?.completion) return
    await new Promise((resolve, reject) => {
      let settled = false, timer
      const finish = error => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve() }
      const abort = () => finish(signal.reason || taskError('task_cancelled', '准备操作已取消', 499))
      signal?.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => finish(taskError('task_timeout', '准备清理超过最长等待时间', 504, true)), Math.max(1, deadlineAt - Date.now()))
      timer.unref?.(); if (signal?.aborted) abort()
      job.completion.then(() => finish(), finish)
    })
  }
  async waitForCancelledKey(key) {
    const job = this.jobs.get(key)
    if (job?.controller.signal.aborted && job.completion) await job.completion
  }
  beginShutdown({ preserveTypes = [] } = {}) {
    this.closing = true; this.unsubscribe?.(); this.unsubscribe = null
    const preserved = new Set(preserveTypes)
    for (const job of [...this.jobs.values()]) if (!preserved.has(job.type)) this.cancel(job, taskError('task_stopping', '媒体任务服务正在关闭'))
  }
  async dispose() {
    this.beginShutdown()
    await Promise.allSettled([...this.running].map(job => job.completion))
  }
}

const mediaScheduler = new ResourceScheduler()
module.exports = { ResourceScheduler, mediaScheduler, taskError }
