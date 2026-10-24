const assert = require('assert'), fs = require('fs'), path = require('path'), Module = require('module')
const { EventEmitter } = require('events'), { PassThrough } = require('stream')
const { claimDevice, requestJson, removeTempRootWithRetry } = require('./verify-helpers')
const { phone } = require('./mobile-module-harness')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
fs.mkdirSync(parent, { recursive: true })
const fixture = fs.mkdtempSync(path.join(parent, 'transcode-preparation-'))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const delay = ms => new Promise(done => setTimeout(done, ms))
const until = async predicate => { const end = Date.now() + 5000
  while (!predicate()) { if (Date.now() > end) throw new Error('preparation condition timed out'); await delay(4) } }
async function main() {
  process.chdir(fixture)
  const preparations = [], children = [], original = Module._load
  let probes = 0
  Module._load = function (name, owner, ...rest) {
    if (owner?.filename.replace(/\\/g, '/').endsWith('/main/remote/transcode.js')) {
      if (name === '../thumbnail') return { findFfmpeg: async ({ signal }) => { const pending = deferred(); preparations.push({ signal, ...pending }); await pending.promise; return 'fake-ffmpeg' } }
      if (name === '../exec') return { execFileAsync: async (_file, args) => { if (!args.includes('-version')) probes++
        return { stdout: JSON.stringify({ format: { duration: 60 }, streams: [{ codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 640, height: 360 }] }) } } }
      if (name === 'child_process') return { spawn(_file, args) { const child = new EventEmitter(); child.stderr = new PassThrough(); child.args = args
        child.finish = () => { if (child.closed) return; child.closed = true; child.emit('close', 0) }
        child.kill = () => { child.kills = (child.kills || 0) + 1; setTimeout(child.finish, 20); return true }
        children.push(child); return child } }
    }
    return original.call(this, name, owner, ...rest)
  }
  let worker, createRemoteServer
  try { worker = require('../main/remote/transcode'); ({ createRemoteServer } = require('../main/remote/server')) } finally { Module._load = original }
  const scheduler = require('../main/application/resource-scheduler').mediaScheduler
  const settings = require('../main/settings'), identity = require('../main/remote/identity'), index = require('../main/remote/video-index')
  const source = path.join(fixture, 'source.mp4'); fs.writeFileSync(source, Buffer.alloc(512))
  await settings.saveSettingsAndFlush({ directories: [fixture], privateDirectories: [], remoteAccess: { enabled: true } })
  const id = index.getVideoId(source); index.rememberVideos([{ fullPath: source, fileName: 'source.mp4', name: 'Source' }])
  const server = createRemoteServer({ port: 0 }); await new Promise(done => server.listen(0, '127.0.0.1', done))
  const endpoint = 'http://127.0.0.1:' + server.address().port
  const bind = clientId => claimDevice({ baseUrl: endpoint, clientId, createPairingCode: identity.createPairingCode,
    approvePairingRequest: identity.approvePairingRequest, projectRoot: root })
  const a = await bind('prepare-a'), b = await bind('prepare-b'), api = phone().load('mobile/src/services/api.ts')
  const capabilities = (await api.getInfo(endpoint)).capabilities
  const deviceA = { id: 'pc', endpoint, token: a.token, capabilities }, deviceB = { ...deviceA, token: b.token }
  try {
    const start = Date.now()
    const first = await api.startTranscode(deviceA, id, 'compatible', undefined, 'a1')
    assert.strictEqual(first.status, 'queued'); assert.ok(Date.now() - start < 1000, 'HTTP admission cannot wait for tool preparation')
    await until(() => preparations.length === 1)
    await api.startTranscode(deviceB, id, 'compatible', undefined, 'b1')
    assert.strictEqual((await api.getTranscodeStatus(deviceB, id, 'compatible', undefined, 'b1')).interestedClients, 2)
    assert.strictEqual((await api.cancelTranscode(deviceA, id, 'compatible', 'a1')).shared, true)
    assert.strictEqual(preparations[0].signal.aborted, false)
    assert.strictEqual((await api.cancelTranscode(deviceB, id, 'compatible', 'b1')).taskCancelled, true)
    assert.strictEqual(preparations[0].signal.aborted, true)
    assert.strictEqual(children.length, 0)
    const newer = await api.startTranscode(deviceB, id, 'compatible', undefined, 'b2')
    assert.notStrictEqual(newer.taskId, first.taskId)
    assert.strictEqual(newer.status, 'queued'); await delay(20)
    assert.strictEqual(preparations.length, 1, 'an ignored abort keeps the preparation resource slot until actual completion')
    preparations[0].resolve(); await until(() => preparations.length === 2)
    assert.strictEqual(probes, 0, 'obsolete preparation cannot proceed to probe media')
    preparations[1].resolve(); await until(() => children.length === 1)
    assert.strictEqual(worker.getMobileTranscodeStatus(id)?.taskId, newer.taskId)
    await api.cancelTranscode(deviceB, id, 'compatible', 'b2'); await until(() => children[0].closed)
    assert.strictEqual(children[0].kills, 1)
    await api.cancelTranscode(deviceB, id, 'compatible', 'before-post')
    await assert.rejects(api.startTranscode(deviceB, id, 'compatible', undefined, 'before-post'), error => error.code === 'task_interest_closed')

    await api.startTranscode(deviceB, id, 'compatible', undefined, 'private')
    await until(() => preparations.length === 3)
    const beforePrivate = probes
    await settings.saveSettingsAndFlush({ privateDirectories: [fixture] }); preparations[2].resolve()
    await until(() => worker.getMobileTranscodeStatus(id)?.status === 'error')
    assert.strictEqual(probes, beforePrivate, 'private access is checked again after tool discovery and before media IO')
    assert.strictEqual(children.length, 1)
    await settings.saveSettingsAndFlush({ privateDirectories: [] })

    await api.startTranscode(deviceB, id, 'compatible', undefined, 'shutdown')
    await until(() => preparations.length === 4)
    let finished = false
    const shutdown = worker.disposeTranscodes().then(() => { finished = true })
    await delay(20); assert.strictEqual(preparations[3].signal.aborted, true); assert.strictEqual(finished, false)
    preparations[3].resolve(); await shutdown
    assert.strictEqual(scheduler.diagnostics().running, 0); assert.strictEqual(children.length, 1)
    await assert.rejects(worker.startMobileTranscode('after', source), error => error.code === 'transcode_stopping')
    console.log('transcode preparation passed: actual authenticated HTTP/phone API, early queued admission, queryable shared preparation, last-interest cancellation, retained cleanup lease, no stale probe/spawn, cancel-before-POST, private policy recheck and disposal waiting for actual preparation')
  } finally {
    preparations.forEach(value => value.resolve()); children.forEach(value => value.finish())
    await worker.disposeTranscodes(); await scheduler.dispose()
    server.closeAllConnections(); await new Promise(done => server.close(done)); require('../main/scanner').unwatchAllDirectories()
  }
}
const deadline = setTimeout(() => { console.error('transcode preparation verification timed out'); process.exit(1) }, 15000)
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  clearTimeout(deadline); process.chdir(root); assert.strictEqual(path.dirname(path.resolve(fixture)), parent); await removeTempRootWithRetry(fixture)
})
