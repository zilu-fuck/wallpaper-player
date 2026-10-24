let pluginSettings
const modules = {
  paths: () => require('../paths'),
  settings: () => {
    if (!pluginSettings) {
      const { recoverSettingsBackup: _startupOnly, initializeSettings: _startupRead, registerSettingsSectionAsync: _sectionOwner, ...publicSettings } = require('../settings')
      pluginSettings = publicSettings
    }
    return pluginSettings
  },
  scanner: () => require('../scanner'),
  window: () => require('../window'),
  'remote/http-utils': () => require('../remote/http-utils'),
  'application/resource-scheduler': () => require('../application/resource-scheduler'),
  'application/download-service': () => require('../application/download-service'),
  'process-lifecycle': () => require('../process-lifecycle'),
  'remote/authorization': () => ({
    refresh: () => require('../remote/identity').refreshIdentity(),
    isAuthorized: tokenHash => {
      const authorization = require('../remote/identity').getAccessTokenHashAuthorization(tokenHash)
      return authorization.authorized && (authorization.type !== 'legacy' || Boolean(require('../settings').loadSettingsFields(['remoteAccess']).remoteAccess?.allowLegacyToken))
    },
    onChanged: listener => require('../remote/identity').onAuthorizationChanged(listener)
  }),
  'media-access': () => ({ canReadPath: (filePath, senderId) => require('../security/media-access').createMediaAccessPolicy({ senderId }).canReadPath(filePath),
    onChanged: listener => require('../security/media-access').onPrivacyStateChanged(listener) })
}

function requireCoreModule(name) {
  const key = String(name || '').trim()
  const loader = modules[key]
  if (!loader) {
    throw new Error(`Core module is not exposed to plugins: ${key}`)
  }
  return loader()
}

module.exports = {
  requireCoreModule
}
