let requireCore = null

function setCoreResolver(resolver) {
  requireCore = typeof resolver === 'function' ? resolver : null
}

function core(name) {
  if (!requireCore) {
    throw new Error('Video analysis plugin core resolver is not initialized')
  }
  return requireCore(name)
}

module.exports = {
  setCoreResolver,
  core
}
