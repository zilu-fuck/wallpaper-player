const path = require('path')
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)
// Expo 56 export trims watchFolders in on-demand mode; app.json disables that mode for sibling contracts.
// Keep the mobile project root so Hermes and native dependencies resolve from the mobile app.
config.watchFolders = [...new Set([...(config.watchFolders || []), path.resolve(__dirname, '../packages')])]
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, 'node_modules'),
  path.join(path.dirname(require.resolve('expo/package.json')), 'node_modules')
]
module.exports = config
