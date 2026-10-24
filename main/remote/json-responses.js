const zlib = require('zlib')
const { performance } = require('perf_hooks')
const { errorDetails } = require('../../packages/contracts')

// RFC 9110 12.5.3: an explicit q=0 overrides '*'; identity remains acceptable unless excluded.
function responseEncoding(header) {
  const values = new Map()
  for (const part of String(header || '').toLowerCase().split(',')) {
    const [coding, ...parameters] = part.trim().split(';').map(value => value.trim())
    if (!coding) continue
    const weight = parameters.find(value => value.startsWith('q='))
    const quality = weight === undefined ? 1 : /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(weight.slice(2)) ? Number(weight.slice(2)) : 0
    values.set(coding, values.has(coding) ? Math.min(values.get(coding), quality) : quality)
  }
  const gzip = values.get('gzip') ?? values.get('*') ?? 0
  const identity = values.get('identity') ?? (values.get('*') === 0 ? 0 : 1)
  return { gzip: gzip > 0 && (!values.has('identity') || gzip >= identity), identity: identity > 0 }
}

function createJsonResponseService({ maxResponses = 32, maxOwnerResponses = 16, maxBytes = 128 * 1024 * 1024,
  maxResponseBytes = 32 * 1024 * 1024, concurrent = 2, timeoutMs = 15000, gzip = (...args) => zlib.gzip(...args) } = {}) {
  const active = new Set(), byResponse = new WeakMap(), owners = new WeakMap(), closed = new WeakSet(), defaultOwner = {}, queue = []
  let reservedBytes = 0, compressing = 0, pumping = false
  const ownerState = owner => { if (!owners.has(owner)) owners.set(owner, { active: 0, reservedBytes: 0 }); return owners.get(owner) }
  const terminal = res => res.destroyed || res.writableEnded
  function frame(req, res, status, body, compressed = false, item) {
    if (terminal(res)) return
    if (res.headersSent) { res.destroy(); return }
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length,
      'Cache-Control': 'no-store', Vary: 'Accept-Encoding', ...(compressed ? { 'Content-Encoding': 'gzip' } : {}) })
    if (item && req.method !== 'HEAD' && body.length > 65536) {
      item.output = body; item.offset = 0; writeBody(item)
    } else res.end(req.method === 'HEAD' ? undefined : body)
  }
  function failureFrame(req, res, status, payload) {
    // This bounded emergency path never queues another compressor behind the failed operation.
    frame(req, res, status, responseEncoding(req.headers?.['accept-encoding']).identity ? Buffer.from(JSON.stringify(payload)) : Buffer.alloc(0))
  }
  function errorPayload(error) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500
    const code = typeof error.code === 'string' ? error.code.slice(0, 128) : 'response_failed'
    const message = status < 500 ? String(error.message || '请求失败').slice(0, 16384) : ({
      response_busy: '响应任务过多，请稍后重试', response_too_large: '响应内容过大，请使用分页读取',
      response_timeout: '响应处理超时，请重试', response_compression_failed: '响应压缩失败，请重试', server_stopping: '服务正在关闭'
    }[code] || '远程服务错误')
    return { status, payload: { error: errorDetails(status, code, message) } }
  }
  function cleanup(item) {
    if (item.finished || item.nativePending || item.authorizationPending || item.queued || !item.responseDone) return
    item.finished = true; clearTimeout(item.timer)
    clearImmediate(item.writeTurn)
    item.req.off('aborted', item.aborted); item.res.off('finish', item.done); item.res.off('close', item.onClose); item.res.off('error', item.onError)
    if (item.drain) item.res.off('drain', item.drain)
    active.delete(item); byResponse.delete(item.res)
    reservedBytes -= item.bytes; const state = ownerState(item.owner); state.active--; state.reservedBytes -= item.bytes
    item.body = item.output = null; item.resolve()
  }
  function cancel(item, error, reply = true, payload) {
    if (item.finished) return item.promise
    item.cancelled = true
    if (item.queued) { const index = queue.indexOf(item); if (index >= 0) queue.splice(index, 1); item.queued = false }
    if (reply && !terminal(item.res) && !item.res.headersSent) {
      const failure = errorPayload(error)
      failureFrame(item.req, item.res, failure.status, payload || failure.payload)
    } else if (!item.res.destroyed && !item.res.writableFinished) item.res.destroy()
    cleanup(item); pump(); return item.promise
  }
  async function publish(item, body, compressed) {
    if (item.cancelled || terminal(item.res)) return
    if (timedOut(item)) return
    item.authorizationPending = true
    try {
      if (item.status < 400 && item.req.refreshJsonResponseAuthorization) await item.req.refreshJsonResponseAuthorization()
      if (item.cancelled || terminal(item.res) || timedOut(item)) return
      if (closed.has(item.owner) || item.owner.resourceClosing) throw Object.assign(Error('服务正在关闭'), { status: 503, code: 'server_stopping' })
      if (item.status < 400) item.req.assertJsonResponseCurrent?.({ beforeHeaders: true })
      frame(item.req, item.res, item.status, body, compressed, item)
    } catch (error) { cancel(item, error) }
    finally { item.authorizationPending = false; cleanup(item) }
  }
  function writeBody(item) {
    if (item.cancelled || item.finished || terminal(item.res)) return
    if (timedOut(item)) return
    try {
      for (let batch = 0; batch < 4 && item.offset < item.output.length; batch++) {
        if (closed.has(item.owner) || item.owner.resourceClosing || item.req.aborted) { cancel(item, {}, false); return }
        if (item.status < 400) item.req.assertJsonResponseCurrent?.()
        const next = Math.min(item.output.length, item.offset + 65536), chunk = item.output.subarray(item.offset, next); item.offset = next
        if (!item.res.write(chunk)) {
          item.drain ||= () => writeBody(item)
          item.res.once('drain', item.drain); return
        }
      }
      if (item.offset === item.output.length) item.res.end()
      else item.writeTurn = setImmediate(() => { item.writeTurn = null; writeBody(item) })
    } catch (error) { cancel(item, error) }
  }
  function pump() {
    if (pumping) return
    pumping = true
    try {
      while (queue.length && compressing < concurrent) {
        const item = queue.shift(); item.queued = false
        if (item.cancelled) { cleanup(item); continue }
        if (timedOut(item)) continue
        if (closed.has(item.owner) || item.owner.resourceClosing || item.req.aborted || terminal(item.res)) { cancel(item, {}, false); continue }
        try { if (item.status < 400) item.req.assertJsonResponseCurrent?.() } catch (error) { cancel(item, error); continue }
        compressing++; item.nativePending = true
        const completed = (error, output) => {
          if (!item.nativePending) return
          item.nativePending = false; compressing--
          if (item.cancelled) { cleanup(item); pump(); return }
          if (error || !Buffer.isBuffer(output) || output.length > item.body.length + 65536) {
            cancel(item, { status: 500, code: 'response_compression_failed' })
          } else if (!item.cancelled) publish(item, output, true)
          cleanup(item); pump()
        }
        try { gzip(item.body, { maxOutputLength: item.body.length + 65536 }, completed) }
        catch (error) { completed(error) }
      }
    } finally { pumping = false }
  }
  function timedOut(item) {
    if (performance.now() < item.deadlineAt) return false
    cancel(item, { status: 504, code: 'response_timeout' }); return true
  }
  function send(req, res, status, prepare) {
    if (terminal(res)) return Promise.resolve()
    if (byResponse.has(res)) return byResponse.get(res).promise
    const owner = req.remoteServer || defaultOwner, state = ownerState(owner), encoding = responseEncoding(req.headers?.['accept-encoding'])
    if (!encoding.gzip && !encoding.identity) { frame(req, res, 406, Buffer.alloc(0)); return Promise.resolve() }
    if (closed.has(owner) || owner.resourceClosing || active.size >= maxResponses || state.active >= maxOwnerResponses) {
      const failure = errorPayload({ status: 503, code: closed.has(owner) || owner.resourceClosing ? 'server_stopping' : 'response_busy' }); failureFrame(req, res, failure.status, failure.payload); return Promise.resolve()
    }
    const item = { req, res, owner, status, bytes: 0, body: null, responseDone: false, cancelled: false, deadlineAt: performance.now() + timeoutMs }
    item.promise = new Promise(resolve => { item.resolve = resolve })
    item.done = () => { item.responseDone = true; cleanup(item) }
    item.onClose = () => { item.responseDone = true; if (!res.writableFinished) cancel(item, {}, false); else cleanup(item) }
    item.onError = () => cancel(item, {}, false)
    item.aborted = () => cancel(item, {}, false)
    active.add(item); state.active++; byResponse.set(res, item)
    req.once('aborted', item.aborted); res.once('finish', item.done); res.once('close', item.onClose); res.once('error', item.onError)
    item.timer = setTimeout(() => cancel(item, { status: 504, code: 'response_timeout' }), timeoutMs); item.timer.unref?.()
    try {
      if (status < 400) req.assertJsonResponseCurrent?.()
      const text = prepare()
      if (item.finished || item.cancelled || terminal(res)) return item.promise
      if (timedOut(item)) return item.promise
      if (typeof text !== 'string') throw Error('Invalid JSON response')
      const length = text.length <= maxResponseBytes ? Buffer.byteLength(text) : Infinity
      if (length > maxResponseBytes) { cancel(item, { status: 503, code: 'response_too_large' }); return item.promise }
      const compressed = encoding.gzip && (length >= 1024 || !encoding.identity)
      const bytes = length * (compressed ? 2 : 1) + (compressed ? 65536 : 0)
      if (reservedBytes + bytes > maxBytes) { cancel(item, { status: 503, code: 'response_busy' }); return item.promise }
      item.bytes = bytes; reservedBytes += bytes; state.reservedBytes += bytes; item.body = Buffer.from(text)
      if (req.aborted || res.destroyed) { cancel(item, {}, false); return item.promise }
      if (compressed) { item.queued = true; queue.push(item); pump() } else publish(item, item.body, false)
      return item.promise
    } catch (error) {
      // Contract/JSON errors remain synchronous so existing server error boundaries handle them.
      item.responseDone = true; cleanup(item); throw error
    }
  }
  return {
    send,
    replace(req, res, status, payload) {
      const item = byResponse.get(res)
      return item ? cancel(item, { status }, true, payload) : null
    },
    diagnostics(owner) { return owner ? { ...ownerState(owner), compressing: [...active].filter(item => item.owner === owner && item.nativePending).length,
      queued: queue.filter(item => item.owner === owner).length } : { active: active.size, reservedBytes, compressing, queued: queue.length } },
    close(owner) { closed.add(owner); for (const item of [...active]) if (item.owner === owner) cancel(item, {}, false) },
    open(owner) { closed.delete(owner) },
    async wait(owner) { await Promise.all([...active].filter(item => item.owner === owner).map(item => item.promise)) }
  }
}

const jsonResponses = createJsonResponseService()
module.exports = { responseEncoding, createJsonResponseService, jsonResponses }
