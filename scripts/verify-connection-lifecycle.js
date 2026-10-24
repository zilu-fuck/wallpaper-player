const assert = require('assert'), http = require('http')
const { phone } = require('./mobile-module-harness')
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function until(predicate) {
  const deadline = Date.now() + 5000
  while (!predicate()) { if (Date.now() > deadline) throw new Error('connection lifecycle wait timed out'); await new Promise(resolve => setTimeout(resolve, 5)) }
}
async function peer(defaultId = 'pc_connection', modern = true) {
  const control = { id: defaultId, authorized: true, infoGate: null, delay: 0, requests: [], active: 0, maximum: 0, closed: 0, speedBytes: 0 }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'), pathname = url.pathname
    const actor = pathname.match(/^\/pc_(\d+)/)?.[1]
    const deviceId = actor === undefined ? control.id : 'pc_' + actor
    control.active++; control.maximum = Math.max(control.maximum, control.active)
    const record = { path: pathname, authorization: req.headers.authorization }; control.requests.push(record)
    let done = false
    const finish = () => { if (!done) { done = true; control.active-- } }
    res.once('finish', finish); res.once('close', () => { if (!done) control.closed++; finish() })
    const json = (status, value) => { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) } }
    try {
      if (pathname.endsWith('/v1/info')) {
        if (control.infoGate) await control.infoGate.promise
        if (control.delay) await new Promise(resolve => setTimeout(resolve, control.delay))
        json(200, { deviceId, deviceName: 'Connection PC', capabilities: modern ? { authProbe: true } : {} }); return
      }
      if (req.headers.authorization !== 'Bearer connection-secret' || !control.authorized) {
        json(401, { error: { code: 'unauthorized', message: 'revoked', retryable: false } }); return
      }
      if (pathname.endsWith('/v1/auth') && modern) { json(200, { authorized: true, deviceId }); return }
      if (pathname.endsWith('/v1/speed-test')) {
        const bytes = Number(url.searchParams.get('bytes')); control.speedBytes += bytes
        if (pathname.startsWith('/slow')) await new Promise(resolve => setTimeout(resolve, 80))
        if (!res.destroyed) { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(Buffer.alloc(bytes, 97)) }
        return
      }
      json(404, { error: { code: 'not_found', message: 'missing', retryable: false } })
    } catch (error) { json(500, { error: { code: 'test_failure', message: error.message } }) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { control, endpoint: 'http://127.0.0.1:' + server.address().port, async close() {
    control.infoGate?.resolve(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  } }
}
async function main() {
  const a = await peer(), b = await peer('other_pc'), legacy = await peer('legacy_pc', false)
  const client = phone(), devices = client.load('mobile/src/persistence/devices.ts'), connection = client.load('mobile/src/services/connection-manager.ts')
  let device = await devices.saveDevice({ id: 'pc_connection', name: 'Connection PC', endpoint: a.endpoint, token: 'connection-secret' })
  try {
    a.control.infoGate = deferred()
    const first = new AbortController(), second = new AbortController()
    const one = connection.testConnection(device, undefined, first.signal)
    const two = connection.checkDeviceAvailability(device, second.signal)
    await until(() => a.control.requests.length === 1)
    first.abort(); await assert.rejects(one, error => error.name === 'AbortError')
    assert.strictEqual(a.control.closed, 0, 'one departing consumer must not cancel the other')
    a.control.infoGate.resolve(); a.control.infoGate = null
    assert.strictEqual((await two).state, 'online')
    assert.strictEqual(a.control.requests.filter(req => req.path.endsWith('/v1/info')).length, 1)
    assert.strictEqual(a.control.requests.filter(req => req.path.endsWith('/v1/auth')).length, 1)
    assert.strictEqual(a.control.speedBytes, 0, 'healthy modern preferred endpoint needs no throughput download')

    a.control.infoGate = deferred()
    const baseline = a.control.requests.length, before = client.async.values.get('wallpaper-player.devices.v2')
    const controller = new AbortController()
    const cancelled = connection.testConnection(device, undefined, controller.signal)
    await until(() => a.control.requests.length > baseline)
    controller.abort(); await assert.rejects(cancelled, error => error.name === 'AbortError')
    await until(() => a.control.closed > 0 && connection.connectionDiagnostics().shared === 0)
    a.control.infoGate.resolve(); a.control.infoGate = null
    assert.strictEqual(a.control.requests.length, baseline + 1, 'cancelled discovery must not send credentials')
    assert.strictEqual(client.async.values.get('wallpaper-player.devices.v2'), before)

    a.control.infoGate = deferred()
    const removalBaseline = a.control.requests.length
    const removed = connection.checkDeviceAvailability(device)
    await until(() => a.control.requests.length > removalBaseline)
    await devices.removeDevice(device.id, device.bindingId)
    assert.strictEqual((await removed).state, 'offline')
    a.control.infoGate.resolve(); a.control.infoGate = null
    assert.strictEqual(a.control.requests.length, removalBaseline + 1)
    assert.strictEqual((await devices.loadDevices()).length, 0)

    device = await devices.saveDevice({ ...device, endpoint: b.endpoint, endpoints: [a.endpoint] })
    const restored = await connection.testConnection(device)
    assert.strictEqual(restored.endpoint, a.endpoint)
    assert.strictEqual(b.control.requests.length, 1)
    assert.ok(b.control.requests.every(req => !req.authorization), 'known mismatched endpoints must never receive the bearer credential')
    a.control.authorized = false
    await assert.rejects(connection.testConnection(restored), error => error.status === 401 && !error.retryable)
    a.control.authorized = true

    const old = await devices.saveDevice({ id: 'legacy_pc', name: 'Legacy', endpoint: legacy.endpoint, token: 'connection-secret' })
    await connection.testConnection(old)
    assert.strictEqual(legacy.control.speedBytes, 64 * 1024)
    assert.ok(!legacy.control.requests.some(req => req.path.endsWith('/v1/auth')))
    legacy.control.authorized = false
    assert.strictEqual((await connection.checkDeviceAvailability(old)).state, 'unauthorized', 'legacy authorization is checked again, not cached')

    const fallback = await devices.updateDevice(restored, { endpoint: b.endpoint, endpoints: [a.endpoint + '/fast', a.endpoint + '/slow'] })
    const samplesBefore = a.control.speedBytes
    await connection.testConnection(fallback)
    assert.strictEqual(a.control.speedBytes - samplesBefore, 512 * 1024)
    const reset = await devices.updateDevice(fallback, { endpoint: b.endpoint, endpoints: [a.endpoint + '/fast', a.endpoint + '/slow'] })
    await connection.testConnection(reset)
    assert.strictEqual(a.control.speedBytes - samplesBefore, 512 * 1024, 'fallback throughput samples have a short-lived binding-scoped cache')

    a.control.delay = 30; a.control.maximum = 0
    const batch = []
    for (let index = 0; index < 7; index++) batch.push(await devices.saveDevice({ id: 'pc_' + index, name: 'PC ' + index,
      endpoint: a.endpoint + '/pc_' + index, token: 'connection-secret' }))
    const results = await Promise.all(batch.map(device => connection.checkDeviceAvailability(device)))
    assert.ok(results.every(result => result.state === 'online'))
    assert.ok(a.control.maximum <= 2, 'global request budget must apply across devices')
    await until(() => connection.connectionDiagnostics().active === 0)
    assert.deepStrictEqual(JSON.parse(JSON.stringify(connection.connectionDiagnostics())), { active: 0, queued: 0, shared: 0, speedSamples: 2 })
    console.log('connection lifecycle passed: real HTTP, shared interests, cancellation closes sockets, removal aborts before credentials, mismatched identity isolation, fresh authorization, legacy probes, bounded global concurrency and fallback speed cache')
  } finally { await Promise.all([a.close(), b.close(), legacy.close()]) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
