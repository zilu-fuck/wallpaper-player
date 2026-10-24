const { createAnalysisHandlers } = require('./remote-handlers')

function registerVideoAnalysisRemoteRoutes(ctx) {
  const handlersByResolver = new WeakMap()

  function getHandlers(resolveVideoPath, authorizeRequest) {
    if (!handlersByResolver.has(resolveVideoPath)) {
      handlersByResolver.set(resolveVideoPath, createAnalysisHandlers({ resolveVideoPath, authorizeRequest }))
    }
    return handlersByResolver.get(resolveVideoPath)
  }

  ctx.remote.route('GET', '/v1/videos/:videoId/analysis', async (req, res, routeContext) => {
    const { handleGetVideoAnalysis } = getHandlers(routeContext.resolveVideoPath, routeContext.authorizeMediaAsync || routeContext.authorizeMedia)
    await handleGetVideoAnalysis(req, res, routeContext.params.videoId)
  })

  ctx.remote.route('POST', '/v1/videos/:videoId/analysis', async (req, res, routeContext) => {
    const { handleStartVideoAnalysis } = getHandlers(routeContext.resolveVideoPath, routeContext.authorizeMediaAsync || routeContext.authorizeMedia)
    await handleStartVideoAnalysis(req, res, routeContext.params.videoId)
  })

  ctx.remote.route('DELETE', '/v1/videos/:videoId/analysis', async (req, res, routeContext) => {
    const { handleCancelVideoAnalysis } = getHandlers(routeContext.resolveVideoPath, routeContext.authorizeMediaAsync || routeContext.authorizeMedia)
    await handleCancelVideoAnalysis(req, res, routeContext.params.videoId)
  })
}

module.exports = {
  registerVideoAnalysisRemoteRoutes
}
