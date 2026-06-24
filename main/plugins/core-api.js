const modules = {
  paths: () => require('../paths'),
  settings: () => require('../settings'),
  scanner: () => require('../scanner'),
  window: () => require('../window'),
  'remote/http-utils': () => require('../remote/http-utils')
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
