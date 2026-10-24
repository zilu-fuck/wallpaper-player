const { taskError } = require('../application/resource-scheduler')

async function withRequestSignal(req, res, operation) {
  const controller = new AbortController()
  const abort = () => controller.abort(taskError('task_cancelled', '请求已断开', 499))
  const close = () => { if (!res.writableFinished) abort() }
  req.once('aborted', abort); res.once('close', close)
  if (req.aborted || res.destroyed) abort()
  try { return await operation(controller.signal) } finally { req.off('aborted', abort); res.off('close', close) }
}
module.exports = { withRequestSignal }
