const path = require('node:path')
const crypto = require('node:crypto')
const { Worker } = require('node:worker_threads')

function createSettingsReader({ workerFile = path.join(__dirname, 'settings-read-worker.js'),
  maxPending = 8, maxBytes = Infinity, timeoutMs = 30000, idleTimeoutMs = 60000 } = {}) {
  if (!Number.isSafeInteger(maxPending) || maxPending < 1) throw new TypeError('Invalid settings read capacity')
  const jobs = new Map(), queue = []
  let record = null, active = null, cached = null, closed = false, closePromise = null
  let started = 0, completed = 0, cacheHits = 0
  const failure = (code, message) => Object.assign(Error(message), { code, retryable: true })

  function settle(error, value) {
    const job = active
    if (!job) return
    active = null
    clearTimeout(job.timer)
    jobs.delete(job.key)
    if (error) job.reject(error)
    else { cached = { key: job.key, source: job.text, value }; completed++; job.resolve(value) }
  }

  function retire(current, error) {
    current.error ||= error
    if (!current.retiring) current.retiring = current.worker.terminate()
  }

  function startWorker() {
    const current = { worker: new Worker(workerFile), idleTimer: null, retiring: null, error: null }
    record = current
    current.worker.on('message', message => {
      if (record !== current || current.retiring || !active) return
      const same = message?.version?.epoch === active.version.epoch && message?.version?.revision === active.version.revision
      if (message?.id !== active.id || (!message.error && (typeof message.text !== 'string' || !same ||
          (Number.isFinite(maxBytes) && message.text.length > maxBytes)))) {
        retire(current, failure('settings_read_invalid_reply', '设置读取线程返回无效结果'))
        return
      }
      if (message.error) settle(failure(message.error.code || 'settings_read_failed', '设置快照读取失败，请重试'))
      else settle(null, Object.freeze({ kind: 'settings-json-v1', text: message.text }))
      pump()
    })
    current.worker.on('error', error => { current.error = error })
    current.worker.on('exit', () => {
      if (record !== current) return
      clearTimeout(current.idleTimer)
      record = null
      settle(current.error || failure('settings_reader_stopped', '设置读取线程已停止，请重试'))
      pump()
    })
    current.worker.unref()
    return current
  }

  function pump() {
    if (active || record?.retiring) return
    if (!queue.length) {
      if (record) {
        const current = record
        current.worker.unref()
        clearTimeout(current.idleTimer)
        current.idleTimer = setTimeout(() => { if (record === current && !active) retire(current) }, idleTimeoutMs)
        current.idleTimer.unref()
      }
      return
    }
    const job = queue.shift()
    let current
    try { current = record || startWorker() }
    catch (error) { jobs.delete(job.key); job.reject(error); queueMicrotask(pump); return }
    active = job
    clearTimeout(current.idleTimer)
    current.worker.ref()
    job.timer = setTimeout(() => retire(current, failure('settings_read_timeout', '设置快照读取超时，请重试')), timeoutMs)
    try { started++; current.worker.postMessage({ id: job.id, text: job.text, version: job.version, maxBytes }) }
    catch (error) { retire(current, error) }
  }

  function read(text, version) {
    if (closed) return Promise.reject(failure('settings_reader_closed', '设置读取服务已关闭'))
    if (typeof text !== 'string' || !version || typeof version.epoch !== 'string' || !version.epoch || version.epoch.length > 128 ||
        !Number.isSafeInteger(version.revision) || version.revision < 0) return Promise.reject(failure('settings_read_invalid_input', '设置快照无效'))
    const key = version.epoch + ':' + version.revision
    const existing = jobs.get(key)
    if (existing || cached?.key === key) {
      if ((existing?.text ?? cached.source) !== text) return Promise.reject(failure('settings_read_version_conflict', '设置快照版本冲突'))
      cacheHits++
      return existing ? existing.promise : Promise.resolve(cached.value)
    }
    if (jobs.size >= maxPending) return Promise.reject(failure('settings_read_busy', '设置读取请求过多，请稍后重试'))
    const job = { key, id: crypto.randomUUID(), text, version: { epoch: version.epoch, revision: version.revision } }
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject })
    jobs.set(key, job); queue.push(job); pump()
    return job.promise
  }

  function close({ cancel = false } = {}) {
    closed = true; cached = null
    if (cancel) {
      for (const job of queue.splice(0)) { jobs.delete(job.key); job.reject(failure('settings_reader_closed', '设置读取服务已关闭')) }
      if (record) retire(record, failure('settings_reader_closed', '设置读取服务已关闭'))
    }
    if (!closePromise) closePromise = (async () => {
      await Promise.allSettled([...jobs.values()].map(job => job.promise))
      if (record) { const current = record; clearTimeout(current.idleTimer); await (current.retiring || current.worker.terminate()) }
      cached = null
    })()
    return closePromise
  }

  return { read, close, diagnostics: () => ({ closed, active: Boolean(active), queued: queue.length,
    worker: Boolean(record), started, completed, cacheHits }) }
}

module.exports = { createSettingsReader }
