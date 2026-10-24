const path = require('node:path')
const crypto = require('node:crypto')
const { Worker } = require('node:worker_threads')
const { CURRENT_SCHEMA_VERSION } = require('../repositories/settings-file')

function createSettingsJson({ workerFile = path.join(__dirname, 'settings-json-worker.js'), maxBytes = Infinity,
  timeoutMs = 30000, idleTimeoutMs = 60000, resourceLimits } = {}) {
  let record = null, active = null, closed = false
  function finish(error, value) {
    const job = active
    if (!job) return
    active = null; clearTimeout(job.timer)
    if (record) {
      const current = record
      current.worker.unref(); clearTimeout(current.idleTimer)
      if (!closed && !current.retiring) {
        current.idleTimer = setTimeout(() => {
          if (record === current && !active) current.retiring = current.worker.terminate()
        }, idleTimeoutMs)
        current.idleTimer.unref()
      }
    }
    if (error) job.reject(error); else job.resolve(value)
  }
  function startWorker() {
    const current = { worker: new Worker(workerFile, { ...(resourceLimits ? { resourceLimits } : {}) }), lastId: null, error: null }
    record = current
    current.worker.on('message', message => {
      if (record !== current || !active) return
      if (message?.id !== active.id) {
        current.error = Error('Settings serializer returned an unexpected task'); void current.worker.terminate(); return
      }
      if (message.error) { finish(Object.assign(Error(message.error.message), { code: message.error.code,
        ...(Number.isSafeInteger(message.error.schemaVersion) ? { schemaVersion: message.error.schemaVersion } : {}) })); return }
      if (active.kind === 'prepare') {
        if (typeof message.text !== 'string' || Buffer.byteLength(message.text) > maxBytes ||
            !message.value || typeof message.value !== 'object' || Array.isArray(message.value) ||
            !message.sections || typeof message.sections !== 'object' || Array.isArray(message.sections) ||
            !Number.isSafeInteger(message.version) || message.version < 0 || message.version > CURRENT_SCHEMA_VERSION ||
            message.documentVersion !== CURRENT_SCHEMA_VERSION || message.value.schemaVersion !== CURRENT_SCHEMA_VERSION ||
            !Array.isArray(message.value.directories) || !Array.isArray(message.value.privateDirectories) || !Array.isArray(message.value.favorites) ||
            !message.value.privacy || typeof message.value.privacy !== 'object' || Object.hasOwn(message.value, '_settingsVersion')) {
          current.error = Object.assign(Error('Settings startup reader returned an invalid snapshot'), { code: 'settings_startup_invalid_reply' }); void current.worker.terminate(); return
        }
        current.lastId = message.id; finish(null, message); return
      }
      if (typeof message.text !== 'string' || !Array.isArray(message.fields) || !(message.bytes instanceof Uint8Array) ||
        Buffer.byteLength(message.text) > maxBytes || message.bytes.byteLength > maxBytes * 4) {
        current.error = Error('Settings serializer returned an invalid snapshot'); void current.worker.terminate(); return
      }
      current.lastId = message.id
      finish(null, { ...message, bytes: Buffer.from(message.bytes.buffer, message.bytes.byteOffset, message.bytes.byteLength) })
    })
    current.worker.on('error', error => { current.error = error })
    current.worker.on('exit', code => {
      if (record !== current) return
      clearTimeout(current.idleTimer)
      record = null
      finish(current.error || Object.assign(Error('Settings serializer stopped (' + code + ')'), { code: 'settings_serializer_stopped' }))
    })
    current.worker.unref()
    return current
  }
  function request(payload) {
    if (closed) return Promise.reject(Object.assign(Error('Settings serializer is closed'), { code: 'settings_serializer_closed' }))
    if (active) return Promise.reject(Object.assign(Error('Settings serializer is busy'), { code: 'settings_serializer_busy' }))
    if (record?.retiring) return record.retiring.then(() => request(payload))
    return new Promise((resolve, reject) => {
      try {
        const current = record || startWorker(), id = crypto.randomUUID()
        clearTimeout(current.idleTimer)
        active = { id, resolve, reject, kind: payload.op }
        current.worker.ref()
        active.timer = setTimeout(() => {
          current.error = Object.assign(Error(payload.op === 'prepare' ? '设置启动读取超时' : 'Settings serialization timed out'), { code: payload.op === 'prepare' ? 'settings_startup_timeout' : 'settings_serialization_timeout' })
          void current.worker.terminate()
        }, timeoutMs)
        const { base, baseId, ...body } = payload
        current.worker.postMessage({ id, ...body, maxBytes, ...(payload.op === 'prepare' ? {} : { baseId,
          ...(!baseId || current.lastId !== baseId ? { seed: base } : {}) }) })
      } catch (error) { if (active) finish(error); else reject(error) }
    })
  }
  const encode = ({ base, baseId, changes, mapDeltas = false }) => request({ op: 'encode', base, baseId, changes, mapDeltas })
  const prepare = (bytes, { sectionKeys = [], cwd = process.cwd() } = {}) => request({ op: 'prepare', input: bytes, sectionKeys, cwd })
  async function close({ cancel = false } = {}) {
    closed = true
    clearTimeout(record?.idleTimer)
    if (cancel && record) await record.worker.terminate()
    if (active) {
      const current = active
      await new Promise(resolve => {
        const ok = current.resolve, failed = current.reject
        current.resolve = value => { ok(value); resolve() }
        current.reject = error => { failed(error); resolve() }
      })
    }
    const current = record
    if (current) await current.worker.terminate()
  }
  return { encode, prepare, close, diagnostics: () => ({ worker: Boolean(record), active: Boolean(active), closed }) }
}

module.exports = { createSettingsJson }
