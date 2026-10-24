const assert = require('node:assert/strict'), http = require('node:http'), fs = require('node:fs/promises'), path = require('node:path')
const { phone } = require('./mobile-module-harness')
const root = path.resolve(__dirname, '..'), cases = []
const plain = value => JSON.parse(JSON.stringify(value))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function until(predicate) { const end = Date.now() + 5000; while (!predicate()) { if (Date.now() > end) throw new Error('update context wait timed out'); await new Promise(resolve => setTimeout(resolve, 5)) } }
const nativeEnvironment = { platform: 'android', applicationId: 'com.wallpaperplayer.mobile', version: '0.1.4', versionCode: 5,
  supportedAbis: ['arm64-v8a'], sdkVersion: 36, certificateSha256: ['a'.repeat(64)] }
const api = 'https://api.github.com/repos/zilu-fuck/wallpaper-player/releases', web = 'https://github.com/zilu-fuck/wallpaper-player/releases'
function candidate(protocol = 2, clientProtocol = 2) {
  const file = 'wallpaper-player-mobile-0.2.0-arm64-release.apk', url = web + '/download/v1.9.0/' + file
  const manifest = { schemaVersion: 1, tag: 'v1.9.0', desktopVersion: '1.9.0', mode: 'desktop-and-android', sourceCommit: 'c'.repeat(40),
    platforms: [{ platform: 'android', applicationId: nativeEnvironment.applicationId, version: '0.2.0', versionCode: 6, abi: ['arm64-v8a'], minSdk: 24, targetSdk: 36,
      certificateSha256: nativeEnvironment.certificateSha256[0], signatureVerified: true, minServerProtocol: protocol, clientProtocol }],
    assets: [{ file, url, role: 'android-apk', platform: 'android', bytes: 512, sha256: 'b'.repeat(64) }] }
  const release = { draft: false, prerelease: false, tag_name: manifest.tag, name: 'Context fixture', published_at: '2026-10-23T00:00:00Z', assets: [
    { name: file, size: 512, digest: 'sha256:' + 'b'.repeat(64), state: 'uploaded', browser_download_url: url },
    { name: 'release-manifest.json', size: Buffer.byteLength(JSON.stringify(manifest)), state: 'uploaded', browser_download_url: web + '/download/v1.9.0/release-manifest.json' }] }
  return { manifest, release }
}
async function scenario() {
  const control = { a: { id: 'pc_a', protocol: 2, minClient: 1, token: 'qa-a', authorized: true, modern: true },
    b: { id: 'pc_b', protocol: 1, minClient: 1, token: 'qa-b', authorized: true, modern: true },
    requests: [], closed: [], infoGates: new Map(), manifestGate: null, minProtocol: 2, clientProtocol: 2, active: 0, maximum: 0 }
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname, peerName = pathname.split('/')[1], peer = control[peerName]
    control.requests.push({ path: pathname, authorized: Boolean(req.headers.authorization) })
    control.active++; control.maximum = Math.max(control.maximum, control.active)
    let finished = false
    const finish = () => { if (!finished) { finished = true; control.active-- } }
    res.once('finish', finish); res.once('close', () => { if (!finished) control.closed.push(pathname); finish() })
    const json = (status, value) => { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) } }
    try {
      if (pathname.startsWith('/catalog/')) {
        assert.equal(req.headers.authorization, undefined); assert.equal(req.headers.cookie, undefined)
        if (pathname === '/catalog/manifest' && control.manifestGate) await control.manifestGate.promise
        const fixture = candidate(control.minProtocol, control.clientProtocol)
        if (control.omitClientProtocol) delete fixture.manifest.platforms[0].clientProtocol
        json(200, pathname === '/catalog/list' ? [fixture.release] : fixture.manifest); return
      }
      if (!peer) { json(404, {}); return }
      if (pathname.endsWith('/v1/info')) {
        if (control.infoGates.has(peerName)) await control.infoGates.get(peerName).promise
        if (peer.offline) { json(503, { error: { code: 'server_stopping', message: 'offline', retryable: true } }); return }
        json(200, { deviceId: peer.id, deviceName: 'PC ' + peerName, protocolVersion: peer.protocol, minClientProtocol: peer.minClient,
          capabilities: peer.modern ? { authProbe: true } : {} }); return
      }
      if (req.headers.authorization !== 'Bearer ' + peer.token || !peer.authorized) { json(401, { error: { code: 'unauthorized', message: 'revoked', retryable: false } }); return }
      if (pathname.endsWith('/v1/auth')) { json(200, { authorized: true, deviceId: peer.authId || peer.id }); return }
      if (pathname.endsWith('/v1/speed-test')) { res.writeHead(200); res.end(Buffer.alloc(64 * 1024)); return }
      json(404, {})
    } catch (error) { json(500, { error: { code: 'fixture_error', message: error.message, retryable: false } }) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const endpoint = 'http://127.0.0.1:' + server.address().port, client = phone()
  client.stubs.expo = { requireOptionalNativeModule: () => ({ getEnvironment: async () => plain(nativeEnvironment) }) }
  const catalogFetch = (url, options) => fetch(endpoint + (url.startsWith(api) ? '/catalog/list' : '/catalog/manifest'), options)
  client.stubs['expo/fetch'] = { fetch: catalogFetch }
  client.control.globals = { TextDecoder, Uint8Array }
  const repository = client.load('mobile/src/persistence/devices.ts'), { NavigationStore } = client.load('mobile/src/services/navigation-store.ts')
  const connection = client.load('mobile/src/services/connection-manager.ts'), updates = client.load('mobile/src/services/updates.ts'), focus = client.load('mobile/src/services/active-device-context.ts')
  let a = await repository.saveDevice({ id: 'pc_a', name: 'A', endpoint: endpoint + '/a', token: 'qa-a' })
  const b = await repository.saveDevice({ id: 'pc_b', name: 'B', endpoint: endpoint + '/b', token: 'qa-b' })
  const store = new NavigationStore(), subscriptions = []
  store.setDevices([a, b]); store.reset({ name: 'library', device: a }); subscriptions.push(store.subscribe(() => {}))
  const check = updates.createMobileUpdateChecker({ fetch: catalogFetch, environment: async () => plain(nativeEnvironment) })
  const count = suffix => control.requests.filter(item => item.path.endsWith(suffix)).length
  return { control, client, repository, connection, updates, focus, store, subscriptions, check, a, b, count, endpoint,
    async close() {
      subscriptions.forEach(unsubscribe => unsubscribe())
      for (const gate of control.infoGates.values()) gate.resolve(); control.manifestGate?.resolve()
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
      await until(() => connection.connectionDiagnostics().active === 0 && connection.connectionDiagnostics().shared === 0)
      assert.deepEqual(plain(focus.activeDeviceContextDiagnostics()), { owners: 0, listeners: 0, kind: 'none' })
    } }
}
async function test(name, run) {
  const fixture = await scenario()
  try { await run(fixture); cases.push(name) } finally { await fixture.close() }
}
async function main() {
  await test('focused navigation automatically confirms protocol2 using public info then fresh authorization', async s => {
    const before = s.client.async.values.get('wallpaper-player.devices.v2'), result = await s.updates.checkMobileUpdate('0.1.4')
    assert.equal(result.available, true); assert.equal(result.serverProtocol, 2); assert.equal(result.serverContext, 'device'); assert.equal(result.serverDeviceId, 'pc_a')
    assert.deepEqual(s.control.requests.map(item => item.path), ['/a/v1/info', '/a/v1/auth', '/catalog/list', '/catalog/manifest'])
    assert.equal(s.client.async.values.get('wallpaper-player.devices.v2'), before, 'update context must not persist endpoint, protocol or lastConnectedAt')
    assert.ok(!JSON.stringify(result).includes('qa-a') && !JSON.stringify(s.focus.getActiveDeviceContext()).includes(s.endpoint))
  })
  await test('DeviceList/global context uses protocol1 even after other devices report protocol2', async s => {
    await s.connection.checkDeviceAvailability(s.a)
    s.store.reset({ name: 'devices' })
    const before = s.control.requests.length
    await assert.rejects(s.check('0.1.4'), /兼容/)
    assert.ok(s.control.requests.slice(before).every(item => item.path.startsWith('/catalog/')))
    s.control.minProtocol = 1
    const result = await s.check('0.1.4'); assert.equal(result.serverProtocol, 1); assert.equal(result.serverContext, 'global')
  })
  await test('each check revalidates the current protocol and explicit values cannot override a focused computer', async s => {
    assert.equal((await s.check('0.1.4')).serverProtocol, 2)
    s.control.a.protocol = 1
    await assert.rejects(s.check('0.1.4'), /兼容/)
    await assert.rejects(s.check('0.1.4', { serverProtocol: 2 }), /不一致/)
    assert.equal(s.count('/a/v1/auth'), 3)
  })
  await test('newer required client protocol blocks playback connection but allows an authenticated update discovery', async s => {
    s.control.a.protocol = 3; s.control.a.minClient = 3; s.control.minProtocol = 3
    s.control.clientProtocol = 3
    await assert.rejects(s.connection.testConnection(s.a), error => error.code === 'unsupported_protocol')
    assert.equal(s.count('/a/v1/auth'), 0)
    const result = await s.check('0.1.4'); assert.equal(result.available, true); assert.equal(result.serverProtocol, 3)
    assert.equal(s.count('/a/v1/auth'), 1)
  })
  await test('a candidate client protocol below the server minimum cannot be recommended or overridden', async s => {
    s.control.a.protocol = 3; s.control.a.minClient = 3; s.control.minProtocol = 1; s.control.clientProtocol = 2
    await assert.rejects(s.check('0.1.4'), /兼容/)
    await assert.rejects(s.check('0.1.4', { serverMinClientProtocol: 1 }), /不一致/)
    s.control.clientProtocol = 3
    const result = await s.check('0.1.4'); assert.equal(result.clientProtocol, 3); assert.equal(result.serverMinClientProtocol, 3)
    s.control.omitClientProtocol = true; s.control.a.minClient = 2
    await assert.rejects(s.check('0.1.4'), /兼容/)
    s.control.a.minClient = 1
    assert.equal((await s.check('0.1.4')).clientProtocol, 1, 'missing metadata must only grant legacy protocol1')
  })
  await test('route change during native environment lookup cancels the originally captured device before any LAN request', async s => {
    const environment = deferred(), check = s.updates.createMobileUpdateChecker({ fetch, environment: () => environment.promise })
    const pending = check('0.1.4'); s.store.reset({ name: 'library', device: s.b }); environment.resolve(plain(nativeEnvironment))
    await assert.rejects(pending, /已变化/); assert.equal(s.control.requests.length, 0)
  })
  await test('switching computer aborts held info before credentials and a late response cannot be reused', async s => {
    const gate = deferred(); s.control.infoGates.set('a', gate)
    const pending = s.check('0.1.4'); await until(() => s.count('/a/v1/info') === 1)
    s.store.reset({ name: 'library', device: s.b })
    await assert.rejects(pending, /已变化/); await until(() => s.control.closed.includes('/a/v1/info'))
    gate.resolve(); s.control.infoGates.clear()
    assert.equal(s.count('/a/v1/auth'), 0); assert.equal(s.count('/catalog/list'), 0)
    s.control.minProtocol = 1
    const result = await s.check('0.1.4'); assert.equal(result.serverDeviceId, 'pc_b'); assert.equal(result.serverProtocol, 1)
  })
  await test('switching away and back during a manifest transfer invalidates the earlier scope and closes its socket', async s => {
    s.control.manifestGate = deferred()
    const pending = s.check('0.1.4'); await until(() => s.count('/catalog/manifest') === 1)
    s.store.reset({ name: 'library', device: s.b }); s.store.reset({ name: 'library', device: s.a })
    await assert.rejects(pending, /已变化/); await until(() => s.control.closed.includes('/catalog/manifest'))
    s.control.manifestGate.resolve(); s.control.manifestGate = null
    assert.equal((await s.check('0.1.4')).serverDeviceId, 'pc_a')
  })
  await test('same-device player/search transitions and media updates do not cancel the current computer scope', async s => {
    s.control.manifestGate = deferred()
    const pending = s.check('0.1.4'); await until(() => s.count('/catalog/manifest') === 1)
    const video = { id: 'v', name: 'video', size: 1, extension: '.mp4' }
    s.store.navigate({ name: 'player', device: s.a, video, videos: [video] }); s.store.updateVideo(s.a.id, s.a.bindingId, 'v', { favorite: true }); s.store.back()
    s.control.manifestGate.resolve(); s.control.manifestGate = null
    assert.equal((await pending).available, true)
  })
  await test('removal or re-pairing cancels the old binding even before navigation processes device changes', async s => {
    s.control.manifestGate = deferred()
    const pending = s.check('0.1.4'); await until(() => s.count('/catalog/manifest') === 1)
    const rebound = await s.repository.saveDevice({ ...s.a, token: 'qa-new' })
    await assert.rejects(pending, /已变化/)
    s.control.manifestGate.resolve(); s.control.manifestGate = null
    const before = s.control.requests.length
    await assert.rejects(s.check('0.1.4'), /已移除或重新绑定/)
    assert.equal(s.control.requests.length, before, 'stale route binding cannot send old or new credentials')
    s.control.a.token = 'qa-new'; s.store.setDevices([rebound, s.b]); s.store.reset({ name: 'library', device: rebound })
    assert.equal((await s.check('0.1.4')).available, true)
  })
  await test('a lost binding notification still cannot publish an update after the repository identity changes', async s => {
    s.control.manifestGate = deferred()
    const pending = s.check('0.1.4'); await until(() => s.count('/catalog/manifest') === 1)
    const key = 'wallpaper-player.devices.v2', index = JSON.parse(s.client.async.values.get(key))
    index.devices.find(item => item.id === s.a.id).bindingId = 'externally-replaced-binding'
    s.client.async.values.set(key, JSON.stringify(index))
    s.control.manifestGate.resolve(); s.control.manifestGate = null
    await assert.rejects(pending, /已移除或重新绑定/)
  })
  await test('unrelated removal and unavailable unrelated credentials do not affect the selected computer', async s => {
    const unrelatedTokenKey = [...s.client.secure.values].find(([, token]) => token === 'qa-b')[0]
    s.client.secure.values.delete(unrelatedTokenKey)
    assert.equal((await s.check('0.1.4')).serverDeviceId, 'pc_a')
    s.control.manifestGate = deferred()
    const pending = s.check('0.1.4'); await until(() => s.count('/catalog/manifest') === 2)
    await s.repository.removeDevice(s.b.id, s.b.bindingId)
    s.control.manifestGate.resolve(); s.control.manifestGate = null
    assert.equal((await pending).available, true)
  })
  await test('offline, revoked authorization or mismatched identity do not fall back to an assumed protocol', async s => {
    s.control.a.offline = true
    await assert.rejects(s.check('0.1.4'), /无法连接/); assert.equal(s.count('/catalog/list'), 0)
    s.control.a.offline = false
    s.control.a.authorized = false
    await assert.rejects(s.check('0.1.4'), /取消授权|授权|revoked/); assert.equal(s.count('/catalog/list'), 0)
    s.control.a.authorized = true; s.control.a.id = 'different_pc'
    await assert.rejects(s.check('0.1.4'), /另一台电脑/); assert.equal(s.count('/catalog/list'), 0)
    s.control.a.id = 'pc_a'; s.control.a.authId = 'different_pc'
    await assert.rejects(s.check('0.1.4'), /另一台电脑/); assert.equal(s.count('/catalog/list'), 0)
  })
  await test('removing the focused binding while discovery is pending closes info without sending credentials', async s => {
    const gate = deferred(); s.control.infoGates.set('a', gate)
    const pending = s.check('0.1.4'); await until(() => s.count('/a/v1/info') === 1)
    await s.repository.removeDevice(s.a.id, s.a.bindingId)
    await assert.rejects(pending, /已变化/); await until(() => s.control.closed.includes('/a/v1/info'))
    gate.resolve(); s.control.infoGates.clear()
    assert.equal(s.count('/a/v1/auth'), 0); assert.equal(s.count('/catalog/list'), 0)
    await assert.rejects(s.check('0.1.4'), /已移除或重新绑定/)
  })
  await test('one departing update interest does not cancel another shared confirmation and respects the request budget', async s => {
    const gate = deferred(); s.control.infoGates.set('a', gate)
    const controller = new AbortController(), first = s.check('0.1.4', { signal: controller.signal }), second = s.check('0.1.4')
    await until(() => s.count('/a/v1/info') === 1)
    controller.abort(); await assert.rejects(first, { name: 'AbortError' })
    assert.equal(s.control.closed.length, 0)
    gate.resolve(); s.control.infoGates.clear()
    assert.equal((await second).available, true); assert.equal(s.count('/a/v1/info'), 1); assert.equal(s.count('/a/v1/auth'), 1)
    assert.ok(s.control.maximum <= 2)
  })
  await test('legacy authorization retains the explicit protocol1 fallback and uses only its existing 64KiB probe', async s => {
    s.control.a.modern = false; s.control.a.protocol = 1; s.control.minProtocol = 1
    const result = await s.check('0.1.4'); assert.equal(result.available, true); assert.equal(result.serverProtocol, 1)
    assert.equal(s.count('/v1/auth'), 0); assert.equal(s.count('/v1/speed-test'), 1)
  })
  await test('ambiguous live navigators are rejected and the last subscription releases context on unmount', async s => {
    const { NavigationStore } = s.client.load('mobile/src/services/navigation-store.ts'), another = new NavigationStore()
    another.reset({ name: 'library', device: s.b }); const unsubscribe = another.subscribe(() => {}); s.subscriptions.push(unsubscribe)
    await assert.rejects(s.check('0.1.4'), /无法确定当前电脑/); assert.equal(s.control.requests.length, 0)
    unsubscribe(); assert.equal((await s.check('0.1.4')).serverDeviceId, 'pc_a')
    s.control.manifestGate = deferred()
    const pending = s.check('0.1.4'); await until(() => s.count('/catalog/manifest') === 2)
    s.subscriptions[0](); await assert.rejects(pending, /已变化/)
    assert.deepEqual(plain(s.focus.activeDeviceContextDiagnostics()), { owners: 0, listeners: 0, kind: 'none' })
  })
  await test('whole-check deadline includes context discovery and cancels the only remaining info reader', async s => {
    const gate = deferred(); s.control.infoGates.set('a', gate)
    const check = s.updates.createMobileUpdateChecker({ fetch, environment: async () => plain(nativeEnvironment), timeoutMs: 80 })
    await assert.rejects(check('0.1.4'), /超时/)
    await until(() => s.control.closed.includes('/a/v1/info')); assert.equal(s.count('/catalog/list'), 0); assert.equal(s.count('/a/v1/auth'), 0)
    gate.resolve(); s.control.infoGates.clear()
  })
  const parent = path.join(root, '.tmp/refactor-tests'), fixture = await fs.mkdtemp(path.join(parent, 'update-context-'))
  const report = { passed: true, cases, fixture, scope: 'Production navigation, persistence, connection and update TS modules with synthetic credentials and real localhost HTTP; no production server, APK download or device data used.' }
  await fs.writeFile(path.join(fixture, 'result.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}
main().catch(error => { console.error(error); process.exitCode = 1 })
