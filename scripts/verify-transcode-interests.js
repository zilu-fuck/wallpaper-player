const assert = require('assert'), fs = require('fs'), path = require('path'), http = require('http'), Module = require('module')
const { EventEmitter } = require('events'), { PassThrough } = require('stream')
const { claimDevice, requestJson, removeTempRootWithRetry } = require('./verify-helpers')
const { phone } = require('./mobile-module-harness')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp', 'refactor-tests')
fs.mkdirSync(parent, { recursive: true })
const fixture = fs.mkdtempSync(path.join(parent, 'transcode-interests-'))
const until = async predicate => { const deadline = Date.now() + 5000
  while (!predicate()) { if (Date.now() > deadline) throw new Error('transcode interests wait timed out'); await new Promise(done => setTimeout(done, 5)) } }
async function main() {
  process.chdir(fixture)
  const children = [], original = Module._load
  Module._load = function (request, parentModule, ...rest) {
    if (parentModule?.filename.replace(/\\/g, '/').endsWith('/main/remote/transcode.js')) {
      if (request === '../thumbnail') return { findFfmpeg: async () => 'fake-ffmpeg' }
      if (request === '../exec') return { execFileAsync: async () => ({ stdout: JSON.stringify({ format: { duration: 60 },
        streams: [{ codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 640, height: 360 }, { codec_type: 'audio', codec_name: 'aac' }] }) }) }
      if (request === 'child_process') return { spawn(_exe, args) {
        const child = new EventEmitter(); child.stderr = new PassThrough(); child.args = args; child.closed = false
        child.finish = code => { if (child.closed) return; child.closed = true; child.emit('close', code) }
        child.kill = () => { child.killed = true; setTimeout(() => child.finish(0), 40); return true }
        children.push(child); return child
      } }
    }
    return original.call(this, request, parentModule, ...rest)
  }
  let createRemoteServer, worker, service
  try {
    ({ createRemoteServer } = require('../main/remote/server'))
    worker = require('../main/remote/transcode')
    service = require('../main/application/transcode-service')
  } finally { Module._load = original }
  const settings = require('../main/settings'), index = require('../main/remote/video-index'), identity = require('../main/remote/identity')
  const file = path.join(fixture, 'source.mp4'); fs.writeFileSync(file, Buffer.alloc(1024))
  settings.saveSettings({ directories: [fixture], privateDirectories: [], remoteAccess: { enabled: true } })
  const id = index.getVideoId(file); index.rememberVideos([{ fullPath: file, fileName: 'source.mp4', name: 'source' }])
  const server = createRemoteServer({ port: 0 }); await new Promise(done => server.listen(0, '127.0.0.1', done))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const bind = clientId => claimDevice({ baseUrl, clientId, createPairingCode: identity.createPairingCode,
    approvePairingRequest: identity.approvePairingRequest, projectRoot: root })
  const a = await bind('phone-a'), b = await bind('phone-b'), c = await bind('phone-c')
  const api = phone().load('mobile/src/services/api.ts'), capabilities = (await api.getInfo(baseUrl)).capabilities
  assert.strictEqual(capabilities.taskInterests, true)
  const deviceA = { id: 'pc_fixture', endpoint: baseUrl, token: a.token, capabilities }, deviceB = { ...deviceA, token: b.token }
  const send = (token, method, interestId, quality = 'compatible') => requestJson(baseUrl + `/v1/videos/${id}/transcode?quality=${quality}` +
    (interestId ? '&interestId=' + interestId : ''), { method, headers: { Authorization: 'Bearer ' + token } })
  try {
    await Promise.all([api.startTranscode(deviceA, id, 'compatible', undefined, 'a1'), api.startTranscode(deviceB, id, 'compatible', undefined, 'b1')])
    await until(() => children.length === 1)
    assert.strictEqual(children.length, 1)
    assert.strictEqual((await api.getTranscodeStatus(deviceA, id, 'compatible', undefined, 'a1')).interestedClients, 2)
    const released = await api.cancelTranscode(deviceA, id, 'compatible', 'a1')
    assert.strictEqual(released.shared, true); assert.ok(!children[0].killed)
    assert.strictEqual((await api.getTranscodeStatus(deviceA, id, 'compatible', undefined, 'a1')).status, 'cancelled')
    assert.strictEqual((await send(c.token, 'DELETE', 'b1')).data.released, false, 'another actor cannot release the same interest ID')
    await api.startTranscode(deviceB, id, 'compatible', undefined, 'b2')
    await api.cancelTranscode(deviceB, id, 'compatible', 'b1'); assert.ok(!children[0].killed, 'old screen cannot cancel a newer interest')
    assert.strictEqual((await send(b.token, 'POST', 'b1')).status, 409, 'cancelled POST retries cannot reattach')
    fs.writeFileSync(children[0].args.at(-1), Buffer.alloc(512, 1))
    const cancelled = await api.cancelTranscode(deviceB, id, 'compatible', 'b2')
    assert.strictEqual(cancelled.taskCancelled, true)
    await api.startTranscode(deviceB, id, 'compatible', undefined, 'b3')
    await until(() => children.length === 2)
    assert.notStrictEqual(children[0].args.at(-1), children[1].args.at(-1), 'each execution owns a distinct temporary output')
    assert.strictEqual(worker.getTranscodedPath(id, 'compatible'), '', 'late successful exit of a cancelled process cannot publish output')
    fs.writeFileSync(children[1].args.at(-1), Buffer.alloc(512, 2)); children[1].finish(0)
    await until(() => worker.getMobileTranscodeStatus(id, 'compatible')?.status === 'ready')
    const output = worker.getTranscodedPath(id, 'compatible')
    await api.cancelTranscode(deviceB, id, 'compatible', 'b3')
    assert.ok(fs.existsSync(output), 'terminal cancellation cannot delete reusable cached output')
    await send(a.token, 'POST', null, '720p'); await send(b.token, 'POST', null, '720p')
    await until(() => children.at(-1)?.args.includes('libx264') && !children.at(-1).closed)
    const legacyChild = children.at(-1)
    assert.strictEqual((await send(a.token, 'DELETE', null, '720p')).data.shared, true); assert.ok(!legacyChild.killed)
    await send(b.token, 'DELETE', null, '720p'); await until(() => legacyChild.closed)
    assert.strictEqual((await send(b.token, 'POST', null, '720p')).status, 202, 'old clients can restart without a nonce')
    await send(b.token, 'DELETE', null, '720p'); await until(() => children.every(child => child.closed))
    assert.strictEqual((await send(a.token, 'POST', '!')).status, 400)
    assert.strictEqual(service.transcodeService.diagnostics().tasks, 0)
    const privateDirectory = path.join(fixture, 'later-private'); fs.mkdirSync(privateDirectory)
    settings.saveSettings({ directories: [fixture, privateDirectory] })
    const later = path.join(privateDirectory, 'later.mp4'); fs.writeFileSync(later, Buffer.alloc(1024))
    index.rememberVideos([{ fullPath: later, fileName: 'later.mp4', name: 'later' }])
    const laterId = index.getVideoId(later)
    await api.startTranscode(deviceB, id, '720p', undefined, 'hold')
    await until(() => worker.getMobileTranscodeStatus(id, '720p')?.status === 'running')
    const beforePrivate = children.length
    const queued = await api.startTranscode(deviceB, laterId, '720p', undefined, 'later')
    assert.strictEqual(queued.status, 'queued')
    settings.saveSettings({ privateDirectories: [privateDirectory] })
    await api.cancelTranscode(deviceB, id, '720p', 'hold')
    await until(() => worker.getMobileTranscodeStatus(laterId, '720p')?.status === 'error')
    assert.strictEqual(children.length, beforePrivate, 'queued work must recheck current public policy before spawning')
    await verifyLimits(service.createTranscodeService)
    await verifyCache(worker)
    console.log('transcode interests passed: actual authenticated HTTP and phone API, shared start, separate actors/nonce interests, legacy clients, stale cancellation/POST, generation-owned output, terminal cache preservation, bounded task interests and byte/active-stream cache budget')
  } finally {
    for (const child of children) child.finish(1)
    server.closeAllConnections(); await new Promise(done => server.close(done))
    await settings.flushSettingsWrites(); await worker.cleanupTranscodeCache({ force: true })
  }
}
async function verifyLimits(create) {
  const tasks = new Map(), normalizeQuality = quality => quality || 'compatible'
  const service = create({ normalizeQuality, getMobileTranscodeStatus: id => tasks.get(id),
    async startMobileTranscode(id) { tasks.set(id, { id, status: 'queued', progress: 0 }) },
    cancelMobileTranscode: id => tasks.delete(id), listMobileTranscodeTasks: () => [...tasks.values()]
  }, { maxTasks: 2, maxInterests: 2, receiptLimit: 2 })
  await service.start('one', '/one', 'compatible', 'a', 'a1'); await service.start('one', '/one', 'compatible', 'b', 'b1')
  await assert.rejects(service.start('one', '/one', 'compatible', 'c', 'c1'), error => error.code === 'task_interests_full')
  await service.start('two', '/two', 'compatible', 'a', 'a2')
  await assert.rejects(service.start('three', '/three', 'compatible', 'a', 'a3'), error => error.code === 'transcode_queue_full')
  await service.cancel('one', 'compatible', 'a', 'a1'); await service.cancel('one', 'compatible', 'b', 'b1')
  await service.cancel('two', 'compatible', 'a', 'a2')
  assert.strictEqual(service.diagnostics().tasks, 0); assert.ok(service.diagnostics().receipts <= 2)
}
async function verifyCache(worker) {
  await worker.cleanupTranscodeCache({ force: true })
  const directory = path.join(fixture, '.tmp-wallpaper-player', 'remote-transcodes')
  const files = ['old', 'middle', 'new'].map(name => path.join(directory, name + '.mobile.mp4'))
  const write = () => files.forEach((file, index) => { fs.writeFileSync(file, Buffer.alloc(1024)); const time = new Date(Date.now() - (3 - index) * 1000); fs.utimesSync(file, time, time) })
  write()
  const limited = await worker.cleanupTranscodeCache({ maxBytes: 1500 })
  assert.strictEqual(limited.totalBytes, 1024); assert.strictEqual(limited.totalFiles, 1)
  assert.ok(fs.existsSync(files[2]) && !fs.existsSync(files[0]), 'oldest idle files are evicted first')
  write()
  const { streamFileWithRange, getActiveFilePaths } = require('../main/remote/streaming'), { sendError } = require('../main/remote/http-utils')
  let release; const gate = new Promise(done => { release = done })
  const server = http.createServer((req, res) => { void streamFileWithRange(req, res, files[0], 'video/mp4', sendError, 'missing', { owner: server, beforeHeaders: () => gate }) })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const response = new Promise((done, fail) => { http.get(`http://127.0.0.1:${server.address().port}`, res => { res.resume(); res.on('end', done); res.on('error', fail) }).on('error', fail) })
  try {
    await until(() => getActiveFilePaths().includes(files[0]))
    const held = await worker.cleanupTranscodeCache({ force: true, maxBytes: 1 })
    assert.ok(fs.existsSync(files[0])); assert.strictEqual(held.totalBytes, 1024); assert.strictEqual(held.overBudget, true)
    release(); await response
    const cleared = await worker.cleanupTranscodeCache({ force: true, maxBytes: 1 }); assert.strictEqual(cleared.totalBytes, 0)
  } finally { release(); server.closeAllConnections(); await new Promise(done => server.close(done)) }
}
main().finally(async () => { process.chdir(root); assert.strictEqual(path.dirname(path.resolve(fixture)), parent); await removeTempRootWithRetry(fixture) })
  .catch(error => { console.error(error); process.exitCode = 1 })
