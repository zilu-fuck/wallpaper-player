const officialPluginIds = ['video-analysis', 'ai-search', 'agent-bridge']

function isOfficialPluginId(pluginId) {
  return officialPluginIds.includes(String(pluginId || '').trim().toLowerCase())
}

module.exports = {
  officialPluginIds,
  isOfficialPluginId
}
