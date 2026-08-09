const officialPluginIds = ['video-analysis', 'ai-search', 'agent-bridge']
let packageIntegrity = { version: 1, packages: {} }

try {
  packageIntegrity = require('./official-package-integrity.json')
} catch {}

function isOfficialPluginId(pluginId) {
  return officialPluginIds.includes(String(pluginId || '').trim().toLowerCase())
}

function getOfficialPackageIntegrity(pluginId) {
  const id = String(pluginId || '').trim().toLowerCase()
  const entry = packageIntegrity?.packages?.[id]
  if (!entry || typeof entry.sha256 !== 'string') return null
  return {
    version: String(entry.version || ''),
    sha256: entry.sha256.trim().toLowerCase(),
    payloadSha256: String(entry.payloadSha256 || '').trim().toLowerCase()
  }
}

module.exports = {
  officialPluginIds,
  isOfficialPluginId,
  getOfficialPackageIntegrity
}
