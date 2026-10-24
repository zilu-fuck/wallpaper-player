const { jsonResponses } = require('./json-responses')
const { getHttpContract, errorEnvelopeSchema, errorDetails, ContractError } = require('../../packages/contracts')

const MAX_BODY_LENGTH = 1024 * 1024
const BODY_DEADLINE_MS = 10000
const MAX_BODY_READERS = 16
const bodyReads = new WeakMap()
const bodyOwners = new WeakMap()
const defaultBodyOwner = {}

function sendJson(req, res, status, data) {
  if (res.destroyed || res.writableEnded) return
  return jsonResponses.send(req, res, status, () => {
    const contract = getRequestContract(req)
    if (status < 400 && contract) {
      try { data = contract.response.parse(data, 'response') } catch (error) {
        error.status = 500
        error.code = 'invalid_response'
        throw error
      }
    } else if (status >= 400) {
      data = errorEnvelopeSchema.parse(data, 'response')
    }
    return JSON.stringify(data)
  })
}

function sendError(req, res, status, code, message, details = {}) {
  if (res.destroyed || res.writableEnded) return
  if (res.headersSent) { res.destroy(); return }
  status = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500
  code = typeof code === 'string' && code.trim() ? code.trim().slice(0, 128) : 'internal_error'
  message = typeof message === 'string' ? message.slice(0, 16384) : '服务错误'
  details ||= {}
  if (req.bodyReadRejected && !res.headersSent) {
    res.setHeader('Connection', 'close')
    req.resume()
    // Let the error response flush before closing the unread IncomingMessage.
    const closed = () => { if (!req.destroyed) req.destroy() }
    if (req.socket.destroyed) closed()
    else req.socket.once('close', closed)
  }
  const payload = { error: errorDetails(status, code, message,
    Number.isSafeInteger(details.currentRevision) && details.currentRevision >= 0 ? details.currentRevision : undefined,
    typeof details.currentLibraryRevision === 'string' && details.currentLibraryRevision.length > 0 && details.currentLibraryRevision.length <= 120 ? details.currentLibraryRevision : undefined) }
  return jsonResponses.replace(req, res, status, payload) || sendJson(req, res, status, payload)
}

function getRequestContract(req) {
  return getHttpContract(req.method, new URL(req.url || '/', 'http://localhost').pathname)
}

function validateRequestBody(req, body) {
  return getRequestContract(req)?.request?.parse(body, 'request') ?? body
}

function readBody(req, options = {}) {
  if (bodyReads.has(req)) return bodyReads.get(req)
  const owner = req.remoteServer || defaultBodyOwner
  const pending = bodyOwners.get(owner) || 0
  const maximum = options.maxReaders || MAX_BODY_READERS
  if (pending >= maximum) {
    req.bodyReadRejected = true
    const rejected = Promise.reject(Object.assign(new Error('正在处理的请求过多，请稍后再试'), { status: 429, code: 'body_read_busy' }))
    bodyReads.set(req, rejected)
    return rejected
  }
  bodyOwners.set(owner, pending + 1)
  const result = new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0, finished = false
    const timer = setTimeout(() => fail(408, 'body_timeout', '请求体读取超时'), options.deadlineMs || BODY_DEADLINE_MS)
    timer.unref?.()
    const cleanup = () => {
      clearTimeout(timer)
      req.off('data', onData); req.off('end', onEnd); req.off('aborted', onAborted)
      // An aborted IncomingMessage emits error after aborted. Keep its listener until close.
      if (req.closed) req.off('error', onError)
      else req.once('close', () => req.off('error', onError))
      bodyOwners.set(owner, Math.max(0, (bodyOwners.get(owner) || 1) - 1))
    }
    const settle = (error, body) => {
      if (finished) return
      finished = true; cleanup(); chunks.length = 0
      if (error) { req.bodyReadRejected = true; reject(error) }
      else resolve(body)
    }
    const fail = (status, code, message) => settle(Object.assign(new Error(message), { status, code }))
    const onData = chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')
      bytes += buffer.length
      if (bytes > (options.maxBytes || MAX_BODY_LENGTH)) { fail(413, 'payload_too_large', '请求体过大'); return }
      chunks.push(buffer)
    }
    const onEnd = () => {
      try { settle(null, validateRequestBody(req, bytes ? JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) : {})) }
      catch (error) {
        settle(error instanceof ContractError ? error : Object.assign(new Error('请求 JSON 无效'), { status: 400, code: 'invalid_json' }))
      }
    }
    const onError = error => settle(error)
    const onAborted = () => fail(400, 'request_aborted', '请求已取消')
    req.on('data', onData); req.once('end', onEnd); req.once('error', onError); req.once('aborted', onAborted)
    if (req.aborted || req.destroyed) onAborted()
    else if (req.readableEnded) onEnd()
  })
  bodyReads.set(req, result)
  return result
}

function getBodyReaderDiagnostics(owner = defaultBodyOwner) { return { active: bodyOwners.get(owner) || 0 } }

module.exports = {
  sendJson,
  sendError,
  readBody,
  getBodyReaderDiagnostics
}
