const assert = require('assert'), http = require('http')
const { readBody, sendError, sendJson, getBodyReaderDiagnostics } = require('../main/remote/http-utils')
const delay = ms => new Promise(done => setTimeout(done, ms))
const until = async predicate => { const deadline = Date.now() + 3000
  while (!predicate()) { if (Date.now() > deadline) throw new Error('body reader wait timed out'); await delay(5) } }
async function main() {
  const seen = [], server = http.createServer(async (req, res) => {
    req.remoteServer = server; seen.push(req)
    if (req.url === '/native-error') { sendError(req, res, 20, 20, undefined, { currentRevision: NaN, currentLibraryRevision: {} }); return }
    if (req.url === '/partial-error') { res.writeHead(200); res.write('partial'); sendError(req, res, 500, 'failed', 'failed'); return }
    try {
      const pending = readBody(req, { deadlineMs: 160, maxBytes: 64, maxReaders: 2 })
      assert.strictEqual(readBody(req), pending, 'one request owns one body reader')
      sendJson(req, res, 200, await pending)
    } catch (error) { sendError(req, res, error.status || 500, error.code || 'internal_error', error.message) }
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  function start() {
    let responseResolve, responseReject
    const response = new Promise((resolve, reject) => { responseResolve = resolve; responseReject = reject })
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, method: 'POST', path: '/body' }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk })
      res.on('end', () => responseResolve({ status: res.statusCode, data: JSON.parse(body), connection: res.headers.connection }))
      res.on('error', responseReject)
    })
    req.on('error', responseReject)
    return { req, response }
  }
  try {
    const nativeError = await fetch('http://127.0.0.1:' + server.address().port + '/native-error')
    assert.strictEqual(nativeError.status, 500)
    const nativeEnvelope = await nativeError.json()
    assert.strictEqual(nativeEnvelope.error.code, 'internal_error'); assert.strictEqual(nativeEnvelope.error.message, '服务错误')
    assert.ok(!('currentRevision' in nativeEnvelope.error))
    await assert.rejects(async () => { const response = await fetch('http://127.0.0.1:' + server.address().port + '/partial-error'); await response.text() })
    const normal = start(); normal.req.end(JSON.stringify({ value: '中文' }))
    assert.strictEqual((await normal.response).status, 200)
    const oversized = start(); oversized.req.end(JSON.stringify({ value: '中'.repeat(25) }))
    assert.strictEqual((await oversized.response).status, 413)
    const slow = start(); slow.req.write('{')
    const startedAt = Date.now(), trickle = setInterval(() => slow.req.write(' '), 25)
    let timed
    try { timed = await slow.response } finally { clearInterval(trickle) }
    assert.strictEqual(timed.status, 408); assert.strictEqual(timed.connection, 'close')
    assert.ok(Date.now() - startedAt < 1000, 'trickle traffic cannot reset the absolute deadline')
    await until(() => getBodyReaderDiagnostics(server).active === 0)
    const cancelled = start(); cancelled.req.write('{')
    const rejected = cancelled.response.catch(() => {})
    await until(() => getBodyReaderDiagnostics(server).active === 1)
    cancelled.req.destroy(); await rejected
    await until(() => getBodyReaderDiagnostics(server).active === 0)
    const a = start(), b = start(); a.req.write('{'); b.req.write('{')
    await until(() => getBodyReaderDiagnostics(server).active === 2)
    const excess = start(); excess.req.end('{}')
    const busy = await excess.response; assert.strictEqual(busy.status, 429); assert.strictEqual(busy.data.error.code, 'body_read_busy')
    assert.strictEqual((await a.response).status, 408); assert.strictEqual((await b.response).status, 408)
    await until(() => getBodyReaderDiagnostics(server).active === 0)
    server.closeAllConnections()
    await until(() => seen.every(req => req.closed))
    for (const req of seen) for (const event of ['data', 'end', 'error', 'aborted']) {
      assert.ok(!req.listeners(event).some(listener => ['onData', 'onEnd', 'onError', 'onAborted'].includes(listener.name)), event)
    }
    console.log('HTTP body lifecycle passed: actual sockets, byte limit, absolute trickle deadline, bounded readers, abort, single reader and listener cleanup')
  } finally { server.closeAllConnections(); await new Promise(done => server.close(done)) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
