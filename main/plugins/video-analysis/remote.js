const { createAnalysisHandlers } = require('./remote-handlers')

function registerVideoAnalysisRemoteRoutes(ctx) {
  const handlersByResolver = new WeakMap()

  function getHandlers(resolveVideoPath) {
    if (!handlersByResolver.has(resolveVideoPath)) {
      handlersByResolver.set(resolveVideoPath, createAnalysisHandlers({ resolveVideoPath }))
    }
    return handlersByResolver.get(resolveVideoPath)
  }

  ctx.remote.route('GET', '/v1/videos/:videoId/analysis', async (req, res, routeContext) => {
    const { handleGetVideoAnalysis } = getHandlers(routeContext.resolveVideoPath)
    await handleGetVideoAnalysis(req, res, routeContext.params.videoId)
  })

  ctx.remote.route('POST', '/v1/videos/:videoId/analysis', async (req, res, routeContext) => {
    const { handleStartVideoAnalysis } = getHandlers(routeContext.resolveVideoPath)
    await handleStartVideoAnalysis(req, res, routeContext.params.videoId)
  })
}

module.exports = {
  registerVideoAnalysisRemoteRoutes
}
