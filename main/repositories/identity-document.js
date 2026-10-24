const CURRENT_IDENTITY_VERSION = 1
const corrupt = () => Object.assign(new Error('设备身份文件损坏，原文件已保留；请修复后重试'), { status: 503, code: 'identity_corrupt' })
const text = value => typeof value === 'string' && value.trim().length > 0

// Missing credentials are not defaults: generating them while reading an
// existing document would silently replace the computer and invalidate peers.
function parseIdentityDocument(source) {
  let value
  try { value = JSON.parse(String(source).replace(/^\uFEFF/, '')) } catch { throw corrupt() }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw corrupt()
  const version = Object.hasOwn(value, 'schemaVersion') ? value.schemaVersion : 0
  if (Number.isSafeInteger(version) && version > CURRENT_IDENTITY_VERSION) {
    throw Object.assign(new Error('设备身份来自较新版本，原文件已保留；请使用支持该格式的应用'), { status: 503, code: 'identity_unsupported_version' })
  }
  if (!Number.isSafeInteger(version) || version < 0 || !['deviceId', 'machineSecret', 'accessToken'].every(key => text(value[key]))) throw corrupt()
  if (Object.hasOwn(value, 'pairedDevices')) {
    if (!Array.isArray(value.pairedDevices) || value.pairedDevices.length > 100) throw corrupt()
    const ids = new Set()
    for (const item of value.pairedDevices) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || !text(item.id) || !text(item.tokenHash) ||
          item.id.trim().length > 80 || item.tokenHash.trim().length > 128 || ids.has(item.id.trim())) throw corrupt()
      ids.add(item.id.trim())
    }
  }
  return value
}

module.exports = { parseIdentityDocument, CURRENT_IDENTITY_VERSION }
