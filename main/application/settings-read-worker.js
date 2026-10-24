const { parentPort } = require('node:worker_threads')
const { sanitizeRendererSettings } = require('../repositories/settings-renderer')

parentPort.on('message', message => {
  try {
    const value = JSON.parse(message.text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid settings document')
    const text = JSON.stringify(sanitizeRendererSettings(value, message.version))
    if (Number.isFinite(message.maxBytes) && Buffer.byteLength(text) > message.maxBytes) {
      throw Object.assign(Error('Snapshot exceeds read limit'), { code: 'settings_read_too_large' })
    }
    parentPort.postMessage({ id: message.id, version: message.version, text })
  } catch (error) {
    // Parser errors may contain private document fragments. Keep them in this worker.
    parentPort.postMessage({ id: message.id, error: { code: error.code || 'settings_read_failed', message: '设置快照读取失败，请重试' } })
  }
})
