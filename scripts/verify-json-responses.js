const assert = require('assert'), http = require('http'), fs = require('fs'), fsp = require('fs/promises'), path = require('path'), zlib = require('zlib'), crypto = require('crypto')
const { EventEmitter } = require('events'), { performance } = require('perf_hooks')
const { createJsonResponseService, responseEncoding, jsonResponses } = require('../main/remote/json-responses')
const { removeTempRootWithRetry, claimDevice } = require('./verify-helpers')
const delay = ms => new Promise(done => setTimeout(done, ms))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const until = async check => { const deadline = Date.now() + 4000; while (!check()) { if (Date.now() > deadline) throw Error('JSON response condition timed out'); await delay(5) } }
const deadline = setTimeout(() => { console.error('JSON response verification timed out'); process.exit(1) }, 45000)
function pair(owner = {}, header = 'gzip', method = 'GET', finish = true) {
  const req = Object.assign(new EventEmitter(), { method, headers: { 'accept-encoding': header }, remoteServer: owner })
  const res = Object.assign(new EventEmitter(), { writes: 0, chunks: [],
    writeHead(status, headers) { assert.ok(!this.headersSent); this.status = status; this.headers = headers; this.headersSent = true },
    write(body) { this.chunks.push(body); return true },
    end(body) { this.writes++; if (body) this.chunks.push(body); this.body = Buffer.concat(this.chunks); this.writableEnded = true; if (finish) { this.writableFinished = true; this.emit('finish') } },
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close') } }
  })
  return { req, res }
}
const idle = service => assert.deepStrictEqual(service.diagnostics(), { active: 0, reservedBytes: 0, compressing: 0, queued: 0 })
async function controlled() {
  assert.deepStrictEqual(responseEncoding('gzip;q=0, *;q=1'), { gzip: false, identity: true })
  assert.deepStrictEqual(responseEncoding('*;q=0'), { gzip: false, identity: false })
  assert.deepStrictEqual(responseEncoding('gzip;q=0.5,identity;q=1'), { gzip: false, identity: true })
  const native = [], service = createJsonResponseService({ concurrent: 1, maxResponses: 3, maxOwnerResponses: 3, maxResponseBytes: 16000,
    gzip(input, options, callback) { native.push({ input, callback }) } })
  const send = (item, value) => service.send(item.req, item.res, 200, () => JSON.stringify(value))
  const release = index => native[index].callback(null, zlib.gzipSync(native[index].input))
  const plain = pair({}, 'gzip;q=0'); await send(plain, { value: '中文🙂'.repeat(400) }); assert.ok(!plain.res.headers['Content-Encoding']); assert.strictEqual(native.length, 0)
  assert.strictEqual(Number(plain.res.headers['Content-Length']), plain.res.body.length); idle(service)
  const small = pair({}, 'gzip,identity;q=0'), compressed = send(small, { small: true }); assert.strictEqual(native.length, 1); release(0); await compressed
  assert.deepStrictEqual(JSON.parse(zlib.gunzipSync(small.res.body)), { small: true }); idle(service)
  const head = pair({}, '*', 'HEAD'), headed = send(head, { value: 'x'.repeat(2000) }); release(1); await headed
  assert.strictEqual(head.res.body.length, 0); assert.ok(head.res.headers['Content-Length'] > 0); assert.strictEqual(head.res.headers['Content-Encoding'], 'gzip')
  const refused = pair({}, '*;q=0'); await send(refused, { private: true }); assert.strictEqual(refused.res.status, 406); assert.strictEqual(refused.res.body.length, 0)
  const owner = {}, a = pair(owner), b = pair(owner), c = pair(owner), marker = { marker: 'private'.repeat(500) }
  const first = send(a, marker), second = send(b, marker), third = send(c, marker)
  assert.strictEqual(send(a, { other: true }), first, 'one response owns one publication')
  const excessive = pair(owner); let prepared = false
  await service.send(excessive.req, excessive.res, 200, () => { prepared = true; return '{}' }); assert.strictEqual(prepared, false); assert.strictEqual(excessive.res.status, 503)
  b.res.destroy(); await second; assert.strictEqual(service.diagnostics().queued, 1)
  release(2); await first; assert.strictEqual(native.length, 4); release(3); await third; idle(service)
  const closing = pair(owner), pending = send(closing, marker); let closed = false
  service.close(owner); const waited = service.wait(owner).then(() => { closed = true })
  await delay(10); assert.strictEqual(closed, false); assert.strictEqual(service.diagnostics().compressing, 1); assert.ok(service.diagnostics().reservedBytes > 0)
  release(4); await Promise.all([pending, waited]); idle(service)
  service.open(owner)
  let valid = true; const fence = pair(owner); fence.req.assertJsonResponseCurrent = () => { if (!valid) throw Object.assign(Error('scope changed'), { status: 409, code: 'media_policy_changed' }) }
  const gated = send(fence, marker); valid = false; release(5); await gated
  assert.strictEqual(fence.res.status, 409); assert.ok(!fence.res.body.toString().includes('private')); idle(service)
  const failure = pair({}), failed = send(failure, marker); native[6].callback(Error('must not expose internal input')); await failed
  assert.strictEqual(failure.res.status, 500); assert.ok(!failure.res.body.toString().includes('internal input')); idle(service)
  const large = pair({}, 'identity'); await send(large, { value: 'x'.repeat(16001) }); assert.strictEqual(large.res.status, 503); idle(service)
  const budget = createJsonResponseService({ maxBytes: 90000, gzip(input, options, callback) { native.push({ input, callback }) } })
  const held = pair({}), counted = budget.send(held.req, held.res, 200, () => JSON.stringify({ value: 'x'.repeat(10000) }))
  const over = pair({}); await budget.send(over.req, over.res, 200, () => JSON.stringify({ value: 'x'.repeat(10000) })); assert.strictEqual(over.res.status, 503)
  native[7].callback(null, zlib.gzipSync(native[7].input)); await counted; idle(budget)
  const timeout = createJsonResponseService({ timeoutMs: 25 }), slow = pair({}, 'identity', 'GET', false)
  await timeout.send(slow.req, slow.res, 200, () => '{}'); assert.strictEqual(slow.res.destroyed, true); idle(timeout)
  const blocked = pair({}, 'identity')
  await timeout.send(blocked.req, blocked.res, 200, () => { const end = performance.now() + 40; while (performance.now() < end) {} return '{}' })
  assert.strictEqual(blocked.res.status, 504, 'the absolute monotonic deadline is rechecked after synchronous preparation'); idle(timeout)
  let lateCallback
  const expires = createJsonResponseService({ timeoutMs: 25, gzip(input, options, callback) { lateCallback = () => callback(null, zlib.gzipSync(input)) } })
  const late = pair({}), lateReply = expires.send(late.req, late.res, 200, () => JSON.stringify(marker))
  await delay(40); assert.strictEqual(late.res.status, 504); assert.strictEqual(expires.diagnostics().compressing, 1)
  lateCallback(); await lateReply; assert.strictEqual(late.res.writes, 1); idle(expires)
  const stoppingOwner = {}, callbacks = [], stopping = createJsonResponseService({ concurrent: 1, gzip(input, options, callback) { callbacks.push(() => callback(null, zlib.gzipSync(input))) } })
  const beforeClose = pair(stoppingOwner), skipped = pair(stoppingOwner)
  beforeClose.res.once('finish', () => stopping.close(stoppingOwner))
  const finishing = stopping.send(beforeClose.req, beforeClose.res, 200, () => JSON.stringify(marker)), queued = stopping.send(skipped.req, skipped.res, 200, () => JSON.stringify(marker))
  callbacks[0](); await Promise.all([finishing, queued]); assert.strictEqual(callbacks.length, 1, 'a close from a response event cannot start queued work for the closing owner'); idle(stopping)
  const partialService = createJsonResponseService(), partial = pair({}, 'identity'); let scopeValid = true
  partial.req.assertJsonResponseCurrent = () => { if (!scopeValid) throw Object.assign(Error('scope changed'), { status: 409 }) }
  partial.res.write = body => { partial.res.chunks.push(body); return false }
  const writing = partialService.send(partial.req, partial.res, 200, () => JSON.stringify({ value: 'x'.repeat(200000) }))
  scopeValid = false; partial.res.emit('drain'); await writing
  assert.strictEqual(partial.res.chunks.length, 1, 'a scope change stops a partially written response before the next chunk'); assert.strictEqual(partial.res.destroyed, true); idle(partialService)
  for (const item of [plain, small, head, a, b, c, closing, fence, failure, large, slow]) {
    assert.strictEqual(item.req.listenerCount('aborted'), 0); assert.strictEqual(item.res.listenerCount('finish') + item.res.listenerCount('close') + item.res.listenerCount('error'), 0)
  }
}
async function backpressure() {
  const service = createJsonResponseService({ timeoutMs: 500 }), payload = JSON.stringify({ value: 'x'.repeat(31 * 1024 * 1024) })
  let response, client, activeAtControl = false
  const server = http.createServer((req, res) => {
    req.remoteServer = server
    if (req.url === '/control') { activeAtControl = service.diagnostics().active > 0; service.send(req, res, 200, () => '{}'); return }
    response = res; service.send(req, res, 200, () => payload)
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done)); const url = 'http://127.0.0.1:' + server.address().port
  try {
    client = http.get(url + '/slow', { highWaterMark: 1, headers: { 'Accept-Encoding': 'identity' } }, res => { res.on('error', () => {}); res.pause(); res.socket.pause() }); client.on('error', () => {})
    await until(() => response && service.diagnostics().active === 1)
    assert.strictEqual(response.writableFinished, false); assert.ok(service.diagnostics().reservedBytes >= 8 * 1024 * 1024)
    assert.strictEqual((await request(url + '/control', { 'Accept-Encoding': 'identity' })).status, 200); assert.strictEqual(activeAtControl, true)
    await until(() => service.diagnostics().active === 0); assert.strictEqual(response.destroyed, true); idle(service)
  } finally { client?.destroy(); service.close(server); server.closeAllConnections(); await new Promise(done => server.close(done)); await service.wait(server) }
}
function request(url, headers, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject)
      res.on('end', () => { const raw = Buffer.concat(chunks), body = res.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(raw) : raw
        resolve({ status: res.statusCode, headers: res.headers, raw, body, data: body.length ? JSON.parse(body) : null }) })
    }); req.on('error', reject); req.end()
  })
}
async function actual(fixture) {
  const settings = require('../main/settings'), identity = require('../main/remote/identity'), scanner = require('../main/scanner')
  const directory = path.join(fixture, 'library'); await fsp.mkdir(directory)
  await Promise.all(Array.from({ length: 24 }, (_, index) => fsp.writeFile(path.join(directory, 'json-fixture-' + index + '.mp4'), Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex'))))
  const customTags = Object.fromEntries(Array.from({ length: 24 }, (_, index) => [path.join(directory, 'json-fixture-' + index + '.mp4'),
    Array.from({ length: 30 }, (_, tag) => 'tag-' + index + '-' + tag + '-' + crypto.createHash('sha256').update(index + ':' + tag).digest('hex').repeat(2))]))
  await settings.saveSettingsAndFlush({ directories: [directory], defaultDirectory: directory, customTags })
  const server = require('../main/remote/server').createRemoteServer({ port: 0 }); await new Promise(done => server.listen(0, '127.0.0.1', done))
  const baseUrl = 'http://127.0.0.1:' + server.address().port, original = zlib.gzip
  let gate, release, hold = false
  zlib.gzip = (input, options, callback) => original(input, options, (error, output) => {
    if (hold) { hold = false; release = () => { const fn = release; release = null; if (fn) callback(error, output) }; gate.resolve() } else callback(error, output)
  })
  try {
    const phone = await claimDevice({ baseUrl, clientId: 'json-phone', ...identity })
    const headers = { Authorization: 'Bearer ' + phone.token, 'Accept-Encoding': 'identity' }
    const legacy = await request(baseUrl + '/v1/library', headers); assert.strictEqual(legacy.status, 200); assert.strictEqual(legacy.data.items.length, 24)
    const nativeRead = fs.readFileSync, identityFile = path.join(require('../main/user-data').getUserDataDir(), 'remote-identity.json'); let identityReads = 0
    fs.readFileSync = function (file, ...args) { if (typeof file === 'string' && path.resolve(file) === identityFile) identityReads++; return nativeRead.call(this, file, ...args) }
    try {
      const chunks = await request(baseUrl + '/v1/library', headers); assert.ok(chunks.body.length > 4 * 65536)
      assert.strictEqual(identityReads, 0, 'identity admission/header refresh must use async IO, including chunk guards')
    } finally { fs.readFileSync = nativeRead }
    const encoded = await request(baseUrl + '/v1/library', { ...headers, 'Accept-Encoding': 'gzip' }); assert.strictEqual(encoded.headers['content-encoding'], 'gzip')
    assert.strictEqual(encoded.raw.length, Number(encoded.headers['content-length'])); assert.deepStrictEqual(encoded.data.items.map(item => item.id), legacy.data.items.map(item => item.id))
    const deniedGzip = await request(baseUrl + '/v1/library', { ...headers, 'Accept-Encoding': 'gzip;q=0,*;q=1' }); assert.ok(!deniedGzip.headers['content-encoding'])
    gate = deferred(); hold = true
    const revoked = request(baseUrl + '/v1/library', { ...headers, 'Accept-Encoding': 'gzip' }); await gate.promise
    assert.strictEqual((await request(baseUrl + '/v1/auth', { ...headers, 'Accept-Encoding': 'gzip' })).status, 200, 'a control response can finish while another response holds a compressor')
    await identity.revokePairedDeviceByToken(phone.token); release(); assert.strictEqual((await revoked).status, 401)
    const other = await claimDevice({ baseUrl, clientId: 'json-other', clientName: '另一台手机', ...identity })
    const fresh = { Authorization: 'Bearer ' + other.token, 'Accept-Encoding': 'gzip' }
    gate = deferred(); hold = true
    const privateReply = request(baseUrl + '/v1/library', fresh); await gate.promise
    await settings.saveSettingsAndFlush({ privateDirectories: [directory] }); release()
    const changed = await privateReply; assert.strictEqual(changed.status, 409); assert.ok(!changed.body.toString().includes('json-fixture'))
    await settings.saveSettingsAndFlush({ privateDirectories: [] })
    gate = deferred(); hold = true
    const oldBinding = request(baseUrl + '/v1/library', fresh); await gate.promise
    const rebound = await claimDevice({ baseUrl, clientId: 'json-other', ...identity }); release(); assert.strictEqual((await oldBinding).status, 401)
    const unpaired = await request(baseUrl + '/v1/devices/current', { Authorization: 'Bearer ' + rebound.token, 'Accept-Encoding': 'gzip,identity;q=0' }, 'DELETE'); assert.strictEqual(unpaired.status, 200, 'an accepted unpair may acknowledge its own revocation')
    const edited = await claimDevice({ baseUrl, clientId: 'json-external', ...identity })
    gate = deferred(); hold = true
    const externalReply = request(baseUrl + '/v1/library', { Authorization: 'Bearer ' + edited.token, 'Accept-Encoding': 'gzip' }); await gate.promise
    const revision = identity.getAuthorizationRevision(), diskIdentity = identity.loadIdentity()
    diskIdentity.pairedDevices.find(device => device.id === 'json-external').revokedAt = Date.now()
    assert.strictEqual(path.dirname(identityFile), path.join(fixture, '.tmp-wallpaper-player'))
    fs.writeFileSync(identityFile, JSON.stringify(diskIdentity))
    assert.strictEqual(identity.getAuthorizationRevision(), revision, 'this fixture edit intentionally bypasses application notifications')
    release(); assert.strictEqual((await externalReply).status, 401, 'async header refresh checks the actual credential file even without an application notification')
    const final = await claimDevice({ baseUrl, clientId: 'json-final', ...identity })
    gate = deferred(); hold = true
    const pending = request(baseUrl + '/v1/library', { Authorization: 'Bearer ' + final.token, 'Accept-Encoding': 'gzip' }).catch(() => null); await gate.promise
    server.resourceClosing = true; const networkClosed = new Promise(done => server.close(done)); jsonResponses.close(server); server.closeAllConnections()
    let settled = false; const waited = jsonResponses.wait(server).then(() => { settled = true }); await networkClosed; await delay(10)
    assert.strictEqual(settled, false); assert.strictEqual(jsonResponses.diagnostics(server).compressing, 1)
    release(); await Promise.all([pending, waited]); assert.strictEqual(jsonResponses.diagnostics(server).active, 0)
  } finally {
    hold = false; release?.(); zlib.gzip = original; jsonResponses.close(server); server.closeAllConnections(); await new Promise(done => server.close(done)); await jsonResponses.wait(server)
    await scanner.waitForBackgroundScanRefreshes(); scanner.unwatchAllDirectories(); await settings.flushSettingsWrites()
  }
}
async function legacyAndTiming() {
  const { sendJson, sendError } = require('../main/remote/http-utils')
  const data = { count: 10000, directories: [], scannedAt: 1,
    items: Array.from({ length: 10000 }, (_, index) => ({ id: 'fixture-' + index, name: '中文视频-' + index, extension: '.mp4', size: index,
      tags: ['标签-' + index], thumbnailUrl: '/v1/videos/fixture-' + index + '/thumbnail', streamUrl: '/v1/videos/fixture-' + index + '/stream' })) }
  const preparation = []
  const server = http.createServer((req, res) => { req.remoteServer = server; const started = performance.now()
    try { sendJson(req, res, 200, data) } catch (error) { sendError(req, res, 500, 'failed', 'failed') }
    preparation.push({ encoding: req.headers['accept-encoding'], synchronousPrepareMs: performance.now() - started })
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done)); const url = 'http://127.0.0.1:' + server.address().port + '/v1/library'
  try {
    const plain = await request(url, { 'Accept-Encoding': 'identity' }), compressed = await request(url, { 'Accept-Encoding': 'gzip' })
    assert.strictEqual(plain.status, 200); assert.strictEqual(compressed.status, 200)
    assert.strictEqual(compressed.data.items.length, 10000); assert.deepStrictEqual(compressed.data, plain.data)
    assert.strictEqual(Number(compressed.headers['content-length']), compressed.raw.length)
    const body = JSON.stringify(data), service = createJsonResponseService()
    async function sample(operation) {
      const started = performance.now(), nextTurn = new Promise(done => setImmediate(() => done(performance.now() - started)))
      await operation(); return { firstTurnMs: await nextTurn, totalMs: performance.now() - started }
    }
    const before = await sample(() => { for (let index = 0; index < 8; index++) zlib.gzipSync(body) })
    const after = await sample(() => Promise.all(Array.from({ length: 8 }, () => { const item = pair({}); return service.send(item.req, item.res, 200, () => body) })))
    idle(service)
    return { operations: 8, bytes: Buffer.byteLength(body), before, after, legacyItems: 10000, gzipBytes: compressed.raw.length, preparation,
      conditions: 'Node production compressor/transport with controlled completing writable; prebuilt JSON excludes schema validation/serialization and network. Legacy equivalence separately uses actual HTTP and schema.' }
  } finally { jsonResponses.close(server); server.closeAllConnections(); await new Promise(done => server.close(done)); await jsonResponses.wait(server) }
}
async function main() {
  await controlled(); await backpressure()
  const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests'); await fsp.mkdir(parent, { recursive: true })
  const fixture = await fsp.mkdtemp(path.join(parent, 'json-responses-')); process.chdir(fixture)
  try { await actual(fixture); const evidence = await legacyAndTiming(); await fsp.writeFile(path.join(parent, 'json-response-timing.json'), JSON.stringify(evidence, null, 2) + '\n')
    console.log('JSON responses passed: async gzip/identity/HEAD and byte lengths, encoding exclusions, bounded work/bytes, duplicate and actual slow sockets, native lease cancellation, chunk-scope fences, scoped teardown and actual HTTP 10k legacy/token/privacy/unpair checks')
    console.log('JSON compression sample: ' + JSON.stringify(evidence)) }
  finally { process.chdir(root); assert.strictEqual(path.dirname(path.resolve(fixture)), parent); await removeTempRootWithRetry(fixture) }
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => clearTimeout(deadline))
