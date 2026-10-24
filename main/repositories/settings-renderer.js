const { normalizePrivacy } = require('../security/privacy-password')

// Shared by synchronous compatibility replies and the isolated read worker.
function sanitizeRendererSettings(settings, version, { partial = false } = {}) {
  const privacy = normalizePrivacy(settings?.privacy)
  const { tagMutationReceipts: _receipts, _settingsVersion: _ignoredVersion, ...publicSettings } = settings || {}
  return {
    ...publicSettings,
    ...(version ? { _settingsVersion: { ...version } } : {}),
    ...(!partial || Object.hasOwn(settings || {}, 'privacy') ? { privacy: { passwordSet: privacy.passwordSet } } : {})
  }
}

module.exports = { sanitizeRendererSettings }
