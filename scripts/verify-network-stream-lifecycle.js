const assert = require('assert'), fs = require('fs'), path = require('path'), http = require('http')
const { Readable } = require('stream')
const { pipeline } = require('stream/promises')
const { claimDevice, requestRaw, requestJson, removeTempRootWithRetry } = require('./verify-helpers')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
fs.mkdirSync(parent, { recursive: true })
const fixture = fs.mkdtempSync(path.join(parent, 'network-streams-'))
const delay = ms => new Promise(done => setTimeout(done, ms))
const until = async condition => { const end = Date.now() + 8000
  while (!condition()) { if (Date.now() > end) throw new Error('network stream condition timed out'); await delay(4) } }
async function main() {
  process.chdir(fixture)
  const settings = require('../main/settings'), identity = require('../main/remote/identity')
  const { createRemoteServer } = require('../main/remote/server')
  const network = require('../main/remote/handlers/network-resources'), streaming = require('../main/remote/streaming')
  const pressure = require('../main/media-pressure'), { enqueueThumbnailJob } = require('../main/thumbnail')
  const held = [], timers = new Set(), delayed = new Map()
  let upstreamActive = 0
  const origin = http.createServer(async (req, res) => {
    upstreamActive++; res.once('close', () => { upstreamActive-- })
    const pathname = new URL(req.url, 'http://localhost').pathname
    if (pathname.startsWith('/r')) {
      const step = Number(pathname.slice(2)) || 0
      const id = setTimeout(() => { timers.delete(id); if (!res.destroyed) { res.writeHead(302, { Location: step < 3 ? '/r' + (step + 1) : '/small.mp4' }); res.end() } }, 70)
      timers.add(id); res.once('close', () => { clearTimeout(id); timers.delete(id) }); return
    }
    if (pathname === '/delayed.m3u8') {
      delayed.set(pathname, () => { if (!res.destroyed) { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); res.end('#EXTM3U\n/segment.ts\n') } }); return
    }
    if (pathname === '/slow.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); res.write('#EXTM3U\n')
      const id = setInterval(() => { if (!res.destroyed) res.write('# keepalive\n') }, 20)
      timers.add(id); res.once('close', () => { clearInterval(id); timers.delete(id) }); return
    }
    if (pathname === '/many.m3u8') { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); res.end('#EXTM3U\n' + '/segment.ts\n'.repeat(10001)); return }
    if (pathname === '/huge.m3u8') { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': 6 * 1024 * 1024 }); res.end(Buffer.alloc(6 * 1024 * 1024, 32)); return }
    if (pathname === '/index.m3u8') { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); res.end('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="/key"\n#EXTINF:2,\n/segment.ts\n'); return }
    if (pathname.startsWith('/hold')) {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': 64 * 1024 * 1024 })
      const body = Readable.from((async function* () { for (let index = 0; index < 1024 && !res.destroyed; index++) { yield Buffer.alloc(64 * 1024, 1); await delay(4) } })())
      try { await pipeline(body, res) } catch {} return
    }
    const bytes = Buffer.alloc(512, 7), range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '')
    const start = range ? Number(range[1]) : 0, end = range ? Number(range[2]) : bytes.length - 1
    res.writeHead(range ? 206 : 200, { 'Content-Type': pathname === '/key' ? 'application/octet-stream' : 'video/mp2t',
      'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': 'bytes ' + start + '-' + end + '/' + bytes.length } : {}) })
    res.end(req.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1))
  })
  await new Promise(done => origin.listen(0, '127.0.0.1', done))
  const upstreamBase = 'http://127.0.0.1:' + origin.address().port
  const paths = ['/small.mp4', '/index.m3u8', '/slow.m3u8', '/r0', '/many.m3u8', '/huge.m3u8', '/delayed.m3u8', '/hold1.mp4', '/hold2.mp4', '/hold3.mp4']
  await settings.saveSettingsAndFlush({ directories: [fixture], privateDirectories: [], remoteAccess: { enabled: true },
    networkResources: paths.map((pathname, index) => ({ id: 'fixture-' + index, kind: 'direct', url: upstreamBase + pathname, title: pathname })) })
  const server = createRemoteServer({ port: 0, networkTimeouts: { headers: 180, playlist: 180 } })
  const secondServer = createRemoteServer({ port: 0 })
  await Promise.all([new Promise(done => server.listen(0, '127.0.0.1', done)), new Promise(done => secondServer.listen(0, '127.0.0.1', done))])
  const baseUrl = 'http://127.0.0.1:' + server.address().port, secondBase = 'http://127.0.0.1:' + secondServer.address().port
  const bound = await claimDevice({ baseUrl, clientId: 'network-streams', createPairingCode: identity.createPairingCode,
    approvePairingRequest: identity.approvePairingRequest, projectRoot: root })
  const authorization = { Authorization: 'Bearer ' + bound.token }
  const item = pathname => network.listRemoteNetworkItems().find(value => value.url === upstreamBase + pathname)
  const streamPath = pathname => '/v1/network-resources/' + item(pathname).id + '/stream'
  const get = (pathname, options = {}) => requestRaw(baseUrl + streamPath(pathname), { ...options, headers: { ...authorization, ...options.headers } })
  const hold = (base, pathname) => new Promise((resolve, reject) => {
    const request = http.get(base + streamPath(pathname), { headers: authorization }, response => { response.pause(); held.push({ request, response }); resolve(response) })
    request.on('error', reject)
  })
  try {
    const range = await get('/small.mp4', { headers: { Range: 'bytes=10-99' } })
    assert.strictEqual(range.status, 206); assert.strictEqual(range.body.length, 90); assert.strictEqual(range.headers.get('content-range'), 'bytes 10-99/512')
    assert.strictEqual((await get('/small.mp4', { method: 'HEAD' })).body.length, 0)
    const playlist = await get('/index.m3u8'), text = playlist.body.toString('utf8')
    assert.strictEqual(playlist.status, 200); assert.ok(text.includes('networkToken=')); assert.strictEqual(playlist.headers.get('accept-ranges'), 'none')
    const segment = text.split('\n').find(value => value.startsWith('/v1/'))
    assert.strictEqual((await requestRaw(baseUrl + segment)).body.length, 512)
    const key = /URI="([^"]+)"/.exec(text)[1]; assert.strictEqual((await requestRaw(baseUrl + key)).status, 200)
    const slow = await get('/slow.m3u8'); assert.strictEqual(slow.status, 504, 'playlist progress cannot renew the absolute body deadline')
    assert.strictEqual((await get('/r0')).status, 504, 'redirects share one header deadline')
    assert.strictEqual((await get('/many.m3u8')).status, 502); assert.strictEqual((await get('/huge.m3u8')).status, 502)
    await until(() => network.getNetworkProxyDiagnostics().active === 0 && pressure.getMediaPressure().remoteStreams === 0)

    await Promise.all([hold(baseUrl, '/hold1.mp4'), hold(baseUrl, '/hold2.mp4')])
    await until(() => pressure.getMediaPressure().remoteStreams === 2)
    let warmed = false
    const background = enqueueThumbnailJob(async () => { warmed = true; return 'warm' })
    assert.strictEqual(await enqueueThumbnailJob(async () => 'visible', { priority: 'visible' }), 'visible')
    await delay(30); assert.strictEqual(warmed, false, 'actual network playback pauses background images')
    held[0].response.destroy(); held[0].request.destroy(); await until(() => pressure.getMediaPressure().remoteStreams === 1)
    await hold(secondBase, '/hold3.mp4'); await until(() => pressure.getMediaPressure().remoteStreams === 2)
    streaming.closeActiveFileStreams(server); await streaming.waitForFileStreams(server)
    assert.strictEqual(pressure.getMediaPressure().remoteStreams, 1, 'closing one server cannot cancel another server stream')
    streaming.closeActiveFileStreams(secondServer); await streaming.waitForFileStreams(secondServer)
    assert.strictEqual(await background, 'warm')
    held.forEach(({ request, response }) => { request.destroy(); response.destroy() }); held.length = 0
    await until(() => upstreamActive === 0 && network.getNetworkProxyDiagnostics().active === 0)

    for (let index = 0; index < 6; index++) await hold(baseUrl, '/hold1.mp4')
    const capped = await get('/hold1.mp4'); assert.strictEqual(capped.status, 429)
    held.forEach(({ request, response }) => { request.destroy(); response.destroy() }); held.length = 0
    await until(() => network.getNetworkProxyDiagnostics().active === 0)
    for (const [pathname, count] of [['/hold1.mp4', 6], ['/hold2.mp4', 6], ['/hold3.mp4', 4]]) {
      for (let index = 0; index < count; index++) await hold(baseUrl, pathname)
    }
    assert.strictEqual(network.getNetworkProxyDiagnostics().active, 16)
    assert.strictEqual((await get('/hold3.mp4')).status, 429, 'the global proxy limit also applies across resources')
    held.forEach(({ request, response }) => { request.destroy(); response.destroy() }); held.length = 0
    await until(() => network.getNetworkProxyDiagnostics().active === 0)
    const delayedResponse = get('/delayed.m3u8')
    await until(() => delayed.has('/delayed.m3u8'))
    assert.ok(await identity.revokePairedDeviceByToken(bound.token)); delayed.get('/delayed.m3u8')()
    assert.strictEqual((await delayedResponse).status, 401, 'authorization is checked again after reading a playlist')
    assert.strictEqual((await requestRaw(baseUrl + key)).status, 401, 'a revoked phone cannot reuse a derived HLS key token')
    await until(() => pressure.getMediaPressure().remoteStreams === 0 && upstreamActive === 0)
    assert.strictEqual(streaming.getStreamDiagnostics().active, 0)
    console.log('network stream lifecycle passed: actual authenticated HTTP ranges/HEAD, HLS segments/keys, absolute redirect/playlist deadlines, bounded playlist size/lines, two-client pressure, disconnect/server ownership, per-resource limits, revoked authorization and upstream cleanup')
  } finally {
    held.forEach(({ request, response }) => { request.destroy(); response.destroy() })
    streaming.closeActiveFileStreams(server); streaming.closeActiveFileStreams(secondServer)
    for (const current of [server, secondServer, origin]) { current.closeAllConnections?.(); await new Promise(done => current.close(done)) }
    await streaming.waitForFileStreams()
    timers.forEach(id => { clearTimeout(id); clearInterval(id) })
    require('../main/scanner').unwatchAllDirectories()
  }
}
const deadline = setTimeout(() => { console.error('network stream verification timed out'); process.exit(1) }, 20000)
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  clearTimeout(deadline); process.chdir(root); assert.strictEqual(path.dirname(path.resolve(fixture)), parent); await removeTempRootWithRetry(fixture)
})
