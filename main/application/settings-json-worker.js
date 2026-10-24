const { parentPort } = require('node:worker_threads')
const { SETTINGS_MAP_FIELDS, diffSettingsMap } = require('../../packages/contracts/dist/settings-feed')
const { parseDocument } = require('../repositories/settings-file')
const { createSettingsNormalizer } = require('../repositories/settings-normalize')

let snapshot = null, snapshotId = null
parentPort.on('message', message => {
  try {
    if (message.op === 'prepare') {
      const input = Buffer.from(message.input)
      if (input.byteLength > message.maxBytes * 4) throw Object.assign(Error('设置文件超过读取大小上限'), { code: 'settings_too_large' })
      const parsed = parseDocument(input), normalizer = createSettingsNormalizer({ cwd: () => message.cwd })
      const text = JSON.stringify(normalizer.normalizeSettings(parsed.value))
      if (Buffer.byteLength(text) > message.maxBytes) throw Object.assign(Error('设置数据超过 JSON 大小上限'), { code: 'settings_too_large' })
      const canonical = JSON.parse(text), sections = Object.fromEntries(message.sectionKeys.filter(key => Object.hasOwn(parsed.value, key)).map(key => [key, parsed.value[key]]))
      parentPort.postMessage({ id: message.id, text, value: canonical, version: parsed.version, sections, documentVersion: canonical.schemaVersion })
      snapshot = canonical; snapshotId = message.id; return
    }
    const base = Object.hasOwn(message, 'seed') ? message.seed : snapshotId === message.baseId ? snapshot : null
    if (!base || typeof base !== 'object' || Array.isArray(base)) throw Error('Settings serializer base is unavailable')
    const next = { ...base }
    for (const [key, value] of message.changes) Object.defineProperty(next, key, { value, enumerable: true, writable: true, configurable: true })
    delete next._settingsVersion
    const text = JSON.stringify(next)
    if (Buffer.byteLength(text) > message.maxBytes) throw Object.assign(Error('设置数据超过 JSON 大小上限'), { code: 'settings_too_large' })
    const canonical = JSON.parse(text)
    const pretty = JSON.stringify(canonical, null, 2)
    if (Buffer.byteLength(pretty) > message.maxBytes * 4) throw Object.assign(Error('设置文件超过输出大小上限'), { code: 'settings_too_large' })
    const bytes = Buffer.allocUnsafeSlow(Buffer.byteLength(pretty)); bytes.write(pretty)
    const fields = message.changes.map(([key]) => {
      const mapDelta = message.mapDeltas && SETTINGS_MAP_FIELDS.includes(key) ? diffSettingsMap(base[key], canonical[key]) : null
      return { key, present: Object.hasOwn(canonical, key), ...(mapDelta ? { mapDelta } : { value: canonical[key] }) }
    })
    parentPort.postMessage({ id: message.id, text, fields, bytes, documentVersion: canonical.schemaVersion }, [bytes.buffer])
    snapshot = canonical; snapshotId = message.id
  } catch (error) {
    parentPort.postMessage({ id: message.id, error: { code: error.code || 'settings_serialization_failed', message: error.message,
      ...(Number.isSafeInteger(error.schemaVersion) ? { schemaVersion: error.schemaVersion } : {}) } })
  }
})
