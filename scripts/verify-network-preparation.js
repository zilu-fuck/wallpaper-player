const assert = require('assert'), fs = require('fs'), path = require('path'), http = require('http'), Module = require('module')
const { EventEmitter } = require('events')
const { claimDevice, removeTempRootWithRetry } = require('./verify-helpers')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
fs.mkdirSync(parent, { recursive: true })
const fixture = fs.mkdtempSync(path.join(parent, 'network-preparation-'))
const delay = ms => new Promise(done => setTimeout(done, ms))
const until = async predicate => { const deadline = Date.now() + 6000
  while (!predicate()) { if (Date.now() > deadline) throw new Error('network preparation condition timed out'); await delay(4) } }
async function main() {
  process.chdir(fixture)
  const ytdlp = require('../main/ytdlp-service'), initialLoader = Module._load
  let parser, fallbackCalls = 0
  Module._load = function (name, owner, ...rest) {
    if (name === './ytdlp-service' && owner?.filename.replace(/\\/g, '/').endsWith('/main/network-resource-parser.js')) return {
      ...ytdlp, parseWithYtDlp: (...args) => { fallbackCalls++; return ytdlp.parseWithYtDlp(...args) }
    }
    return initialLoader.call(this, name, owner, ...rest)
  }
  try { parser = require('../main/network-resource-parser') } finally { Module._load = initialLoader }
  const scheduler = require('../main/application/resource-scheduler').mediaScheduler
  const pending = new Map(), hits = new Map(), timers = new Set()
  let active = 0, crossHeaders
  const second = http.createServer((req, res) => { crossHeaders = req.headers; res.end('ok') })
  await new Promise(done => second.listen(0, '127.0.0.1', done))
  const origin = http.createServer((req, res) => {
    active++; hits.set(req.url, (hits.get(req.url) || 0) + 1); res.once('close', () => { active--; if (pending.get(req.url) === res) pending.delete(req.url) })
    if (req.url.startsWith('/hold')) { pending.set(req.url, res); res.writeHead(200, { 'Content-Type': 'text/html' }); res.write('<html>'); return }
    if (req.url.startsWith('/redirect')) {
      const timer = setTimeout(() => { timers.delete(timer); res.writeHead(302, { Location: '/redirect/' + (Number(req.url.split('/').at(-1)) + 1) }); res.end() }, 35)
      timers.add(timer); return
    }
    if (req.url === '/cross') { res.writeHead(302, { Location: 'http://127.0.0.1:' + second.address().port }); res.end(); return }
    if (req.url === '/broken') { res.writeHead(200, { 'Content-Length': 1000 }); res.write('partial'); setImmediate(() => res.destroy()); return }
    if (req.url === '/large') { res.writeHead(200, { 'Content-Length': 2000 }); res.end(Buffer.alloc(2000)); return }
    if (req.url === '/chunks') { res.writeHead(200); res.write(Buffer.alloc(512)); res.end(Buffer.alloc(512)); return }
    res.end('<html><title>fixture</title><video src="/video.mp4"></video></html>')
  })
  await new Promise(done => origin.listen(0, '127.0.0.1', done))
  const base = 'http://127.0.0.1:' + origin.address().port
  let server
  const finish = url => { const response = pending.get(url); assert.ok(response, url + ' must be waiting'); response.end('<video src="/video.mp4"></video></html>') }
  try {
    assert.strictEqual(await parser.fetchText(base + '/cross', 0, { headers: { Authorization: 'Bearer fixture', Cookie: 'fixture=1' } }), 'ok')
    assert.ok(!crossHeaders.authorization && !crossHeaders.cookie)
    const start = Date.now()
    await assert.rejects(parser.fetchText(base + '/redirect/0', 0, { timeoutMs: 70 }), /超时/)
    assert.ok(Date.now() - start < 500, 'redirects share one absolute fetch deadline')
    await assert.rejects(parser.fetchText(base + '/broken'))
    await assert.rejects(parser.fetchText(base + '/large', 0, { maxBodyBytes: 1000 }), /过大/)
    await assert.rejects(parser.fetchText(base + '/chunks', 0, { maxBodyBytes: 1000 }), /过大/)

    const a = new AbortController(), url = '/hold-shared'
    const first = parser.parseNetworkResourcePage(base + url, { signal: a.signal }).catch(error => error)
    const secondRead = parser.parseNetworkResourcePage(base + url)
    await until(() => pending.has(url)); assert.strictEqual(hits.get(url), 1)
    a.abort(new Error('left-first')); assert.match((await first).message, /left-first/)
    assert.ok(pending.has(url), 'one caller leaving does not close another caller\'s parse')
    finish(url); assert.strictEqual((await secondRead).playbackUrl, base + '/video.mp4')

    const early = parser.parseNetworkResourcePage(base + '/hold-timeout', { timeoutMs: 80 }).catch(error => error)
    const survivor = parser.parseNetworkResourcePage(base + '/hold-timeout', { timeoutMs: 2000 })
    await until(() => pending.has('/hold-timeout'))
    assert.strictEqual((await early).code, 'task_timeout')
    assert.ok(pending.has('/hold-timeout')); finish('/hold-timeout'); assert.ok((await survivor).playbackUrl)
    const last = new AbortController(), abandoned = parser.parseNetworkResourcePage(base + '/hold-last', { signal: last.signal }).catch(error => error)
    await until(() => pending.has('/hold-last')); last.abort(new Error('left-last'))
    const replacement = parser.parseNetworkResourcePage(base + '/hold-last')
    await abandoned; await until(() => hits.get('/hold-last') === 2 && pending.has('/hold-last'))
    finish('/hold-last'); assert.ok((await replacement).playbackUrl)
    await scheduler.waitForIdle(['network-parse']); assert.strictEqual(scheduler.diagnostics().used.parser, 0)

    const settings = require('../main/settings'), ipc = new Map(), original = Module._load
    await settings.saveSettingsAndFlush({ directories: [fixture], networkResources: [], remoteAccess: { enabled: true } })
    Module._load = function (name, owner, ...rest) {
      if (name === 'electron' && owner?.filename.replace(/\\/g, '/').endsWith('/main/ipc/network-resources.js')) return { ipcMain: { handle: (channel, handler) => ipc.set(channel, handler) } }
      return original.call(this, name, owner, ...rest)
    }
    try { require('../main/ipc/network-resources').registerNetworkResourceIpc({ handle: (channel, handler) => ipc.set(channel, handler) }) } finally { Module._load = original }
    const sender = new EventEmitter(); sender.id = 901; sender.isDestroyed = () => false
    const event = { sender }, work = require('../main/application/media-work-service').mediaWorkService
    const input = { url: base + '/hold-ipc', kind: 'webpage', requestId: 'network-ipc-one' }
    const adding = ipc.get('network-resource-add')(event, input)
    await until(() => pending.has('/hold-ipc'))
    work.cancel(event, input.requestId)
    assert.strictEqual((await adding).success, false)
    await scheduler.waitForIdle(['network-operation', 'network-parse'])
    assert.ok(!settings.loadSettings().networkResources.some(resource => resource.url === input.url), 'a cancelled parser cannot publish a delayed settings mutation')
    work.cancel(event, 'before-post')
    assert.strictEqual((await ipc.get('network-resource-add')(event, { ...input, requestId: 'before-post' })).success, false)
    assert.strictEqual(hits.get('/hold-ipc'), 1)

    await settings.saveSettingsAndFlush({ networkResources: [{ id: 'web', kind: 'webpage', url: base + '/hold-remote', title: 'web' }] })
    const identity = require('../main/remote/identity'), network = require('../main/remote/handlers/network-resources'), streaming = require('../main/remote/streaming')
    server = require('../main/remote/server').createRemoteServer({ port: 0 })
    await new Promise(done => server.listen(0, '127.0.0.1', done))
    const endpoint = 'http://127.0.0.1:' + server.address().port
    const bound = await claimDevice({ baseUrl: endpoint, clientId: 'network-preparation', createPairingCode: identity.createPairingCode, approvePairingRequest: identity.approvePairingRequest, projectRoot: root })
    const item = network.listRemoteNetworkItems()[0], streamUrl = endpoint + '/v1/network-resources/' + item.id + '/stream'
    const request = http.get(streamUrl, { headers: { Authorization: 'Bearer ' + bound.token } }); request.on('error', () => {})
    await until(() => pending.has('/hold-remote'))
    assert.strictEqual(network.getNetworkProxyDiagnostics().active, 1, 'proxy admission includes the preparation phase')
    request.destroy()
    await until(() => !pending.has('/hold-remote') && network.getNetworkProxyDiagnostics().active === 0)
    assert.strictEqual(streaming.getStreamDiagnostics().active, 0)
    const stopping = http.get(streamUrl, { headers: { Authorization: 'Bearer ' + bound.token } }); stopping.on('error', () => {})
    await until(() => pending.has('/hold-remote'))
    streaming.closeActiveFileStreams(server); await streaming.waitForFileStreams(server)
    await until(() => !pending.has('/hold-remote') && network.getNetworkProxyDiagnostics().active === 0)
    stopping.destroy(); await scheduler.waitForIdle(['network-parse'])
    assert.strictEqual(scheduler.diagnostics().used.parser, 0)
    assert.strictEqual(fallbackCalls, 0, 'cancellation never enters a fallback parser')
    console.log('network preparation passed: actual HTTP redirect/body limits and credentials, shared per-caller cancellation/deadlines, last-owner cleanup/replacement, production IPC cancel-before-commit, authenticated remote preparation admission/disconnect/server stop and no fallback after cancellation')
  } finally {
    if (server) { require('../main/remote/streaming').closeActiveFileStreams(server); server.closeAllConnections(); await new Promise(done => server.close(done)) }
    for (const response of pending.values()) response.destroy()
    origin.closeAllConnections(); second.closeAllConnections()
    await Promise.all([new Promise(done => origin.close(done)), new Promise(done => second.close(done))])
    timers.forEach(clearTimeout); await scheduler.dispose(); require('../main/scanner').unwatchAllDirectories()
  }
}
const deadline = setTimeout(() => { console.error('network preparation verification timed out'); process.exit(1) }, 20000)
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  clearTimeout(deadline); process.chdir(root); assert.strictEqual(path.dirname(path.resolve(fixture)), parent); await removeTempRootWithRetry(fixture)
})
