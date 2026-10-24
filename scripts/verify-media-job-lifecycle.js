const assert = require('assert'), fs = require('fs'), path = require('path'), http = require('http'), Module = require('module')
const { EventEmitter } = require('events')
const { createFixtureVideo, claimDevice, requestRaw, removeTempRootWithRetry } = require('./verify-helpers')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
fs.mkdirSync(parent, { recursive: true })
const fixture = fs.mkdtempSync(path.join(parent, 'media-jobs-'))
const until = async condition => { const deadline = Date.now() + 10000
  while (!condition()) { if (Date.now() > deadline) throw new Error('media job condition timed out'); await new Promise(done => setTimeout(done, 4)) } }
async function main() {
  process.chdir(fixture)
  const ffmpeg = path.join(root, 'vendor/ffmpeg/bin/ffmpeg.exe'), ffprobe = path.join(root, 'vendor/ffmpeg/bin/ffprobe.exe')
  process.env.WALLPAPER_PLAYER_FFMPEG_PATH = ffmpeg; process.env.WALLPAPER_PLAYER_FFPROBE_PATH = ffprobe
  const library = path.join(fixture, 'library'), source = path.join(library, 'source.mp4'), shared = path.join(library, 'shared.mp4'), changed = path.join(library, 'changed.mp4')
  await createFixtureVideo({ ffmpeg, destPath: source, size: '640x360', rate: 30, duration: 2, vcodec: 'libx264', acodec: 'aac', extraArgs: ['-pix_fmt', 'yuv420p'] })
  fs.copyFileSync(source, shared); fs.copyFileSync(source, changed)
  const native = require('child_process'), records = [], handlers = new Map(), originalLoad = Module._load
  let active = 0, maximum = 0
  const fsp = require('fs/promises'), statGates = { thumbnail: null, metadata: null }, outstandingHolds = []
  const gateStat = name => {
    let entered, release
    const gate = { entered: new Promise(done => { entered = done }), wait: new Promise(done => { release = done }), release, used: false }
    gate.enter = entered; gate.release = release; statGates[name] = gate
    return gate
  }
  const holdMedia = async name => {
    const holds = await Promise.all([scheduler.acquire({ key: name + '-a' }), scheduler.acquire({ key: name + '-b' })])
    outstandingHolds.push(...holds); return holds
  }
  const makeSender = id => {
    const result = new EventEmitter(); result.id = id; result.closed = false; result.isDestroyed = () => result.closed
    result.destroy = () => { result.closed = true; result.emit('destroyed') }
    return result
  }
  const record = (child, file, args) => {
    const item = { child, file, args, closed: false }; records.push(item); active++; maximum = Math.max(maximum, active)
    child.once('close', () => { item.closed = true; active-- })
    return child
  }
  Module._load = function (name, owner, ...rest) {
    const file = owner?.filename.replace(/\\/g, '/') || ''
    const gateName = file.endsWith('/main/thumbnail.js') ? 'thumbnail' : file.endsWith('/main/video-metadata.js') ? 'metadata' : null
    if (name === 'fs/promises' && gateName) return { ...fsp, async stat(target, ...args) {
      const gate = statGates[gateName]
      if (target === source && gate && !gate.used) { gate.used = true; gate.enter(); await gate.wait }
      return fsp.stat(target, ...args)
    } }
    if (name === 'child_process' && file.endsWith('/main/exec.js')) return { ...native,
      execFile(executable, args, options, callback) { return record(native.execFile(executable, args, options, callback), executable, args) } }
    if (name === 'child_process' && file.endsWith('/main/remote/transcode.js')) return { ...native,
      spawn(executable, args, options) { return record(native.spawn(executable, args, options), executable, args) } }
    if (name === 'electron' && file.endsWith('/main/ipc/media.js')) return { ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) } }
    return originalLoad.call(this, name, owner, ...rest)
  }
  let thumbnail, metadata, transcodes, scheduler, createRemoteServer
  try {
    thumbnail = require('../main/thumbnail'); metadata = require('../main/video-metadata'); transcodes = require('../main/remote/transcode')
    scheduler = require('../main/application/resource-scheduler').mediaScheduler
    require('../main/ipc/media').registerMediaIpc({ handle: (channel, callback) => handlers.set(channel, callback) })
    ;({ createRemoteServer } = require('../main/remote/server'))
  } finally { Module._load = originalLoad }
  const settings = require('../main/settings'), index = require('../main/remote/video-index'), identity = require('../main/remote/identity')
  const streaming = require('../main/remote/streaming'), work = require('../main/application/media-work-service').mediaWorkService
  await settings.saveSettingsAndFlush({ directories: [library], privateDirectories: [], remoteAccess: { enabled: true } })
  const sender = new EventEmitter(); sender.id = 901
  let server
  try {
    const jobs = [thumbnail.generateThumbnail(source, { priority: 'visible' }), metadata.getVideoMetadata(source),
      thumbnail.generatePreviewFrame(source, 0), transcodes.startMobileTranscode('budget', source, '720p')]
    const [image, info, preview] = await Promise.all(jobs)
    assert.ok(fs.statSync(image).size > 0 && fs.statSync(preview).size > 0); assert.strictEqual(info.available, true)
    await until(() => transcodes.getMobileTranscodeStatus('budget', '720p')?.status === 'ready')
    await until(() => active === 0 && scheduler.diagnostics().running === 0)
    assert.ok(maximum <= 2, 'all real image/metadata/preparation/execution child processes share the two-process budget')
    const cached = JSON.parse(fs.readFileSync(metadata.getMetadataCachePath(), 'utf8'))
    assert.ok(Object.values(cached.entries).some(entry => entry.path === source))

    const id = index.getVideoId(shared); index.rememberVideos([{ fullPath: shared, fileName: 'shared.mp4', name: 'Shared' }])
    server = createRemoteServer({ port: 0 }); await new Promise(done => server.listen(0, '127.0.0.1', done))
    const baseUrl = 'http://127.0.0.1:' + server.address().port
    const bound = await claimDevice({ baseUrl, clientId: 'media-jobs', createPairingCode: identity.createPairingCode,
      approvePairingRequest: identity.approvePairingRequest, projectRoot: root })
    const leases = await Promise.all([scheduler.acquire({ key: 'hold-a' }), scheduler.acquire({ key: 'hold-b' })])
    const url = baseUrl + '/v1/videos/' + id + '/thumbnail'
    const abandoned = http.get(url, { headers: { Authorization: 'Bearer ' + bound.token } }); abandoned.on('error', () => {})
    const kept = requestRaw(url, { headers: { Authorization: 'Bearer ' + bound.token } })
    await until(() => scheduler.diagnostics().interests >= 4)
    abandoned.destroy(); await until(() => scheduler.diagnostics().interests === 3)
    const before = records.length; leases.forEach(lease => lease.release())
    const response = await kept
    assert.strictEqual(response.status, 200); assert.strictEqual(response.body.subarray(0, 2).toString('hex'), 'ffd8')
    assert.strictEqual(records.slice(before).filter(item => item.args.some(value => String(value).endsWith('.tmp.jpg'))).length, 1,
      'real HTTP consumers share one image process and abandoning one does not cancel the other')
    await until(() => scheduler.diagnostics().running === 0)

    const holds = await Promise.all([scheduler.acquire({ key: 'hold-c' }), scheduler.acquire({ key: 'hold-d' })])
    const queued = handlers.get('generate-preview-frame')({ sender }, changed, 0, 'queued-private')
    await until(() => scheduler.diagnostics().queued === 1)
    await settings.saveSettingsAndFlush({ privateDirectories: [library] })
    const beforePrivate = records.length; holds.forEach(lease => lease.release())
    assert.ok(!(await queued).framePath)
    assert.strictEqual(records.length, beforePrivate, 'queued image work rechecks private access before spawning')
    await settings.saveSettingsAndFlush({ privateDirectories: [] })

    const privacy = require('../main/security/media-access'), privateA = makeSender(902), privateB = makeSender(903)
    await settings.saveSettingsAndFlush({ privateDirectories: [library] })
    privacy.unlockDesktopPrivacy(privateA); privacy.unlockDesktopPrivacy(privateB)
    const privateHolds = await holdMedia('private-windows')
    const firstPrivate = handlers.get('generate-preview-frame')({ sender: privateA }, changed, 1, 'private-window-a')
    const secondPrivate = handlers.get('generate-preview-frame')({ sender: privateB }, changed, 1, 'private-window-b')
    await until(() => scheduler.diagnostics().queued === 2)
    privateA.destroy(); privateHolds.forEach(lease => lease.release())
    assert.ok(!(await firstPrivate).framePath)
    assert.ok((await secondPrivate).framePath, 'a surviving unlocked window owns independent private work')
    await until(() => scheduler.diagnostics().running === 0)

    const beforeCached = records.length, previewGate = gateStat('thumbnail')
    const cachedPreview = handlers.get('generate-preview-frame')({ sender: privateB }, source, 0, 'cached-preview-lock')
    await previewGate.entered; privacy.lockDesktopPrivacy(privateB); previewGate.release()
    assert.ok(!(await cachedPreview).framePath, 'cached preview rechecks a lock during asynchronous file inspection')
    privacy.unlockDesktopPrivacy(privateB)
    const metadataGate = gateStat('metadata')
    const cachedMetadata = handlers.get('get-video-metadata')({ sender: privateB }, source, { requestId: 'cached-metadata-lock' })
    await metadataGate.entered; privacy.lockDesktopPrivacy(privateB); metadataGate.release()
    assert.strictEqual((await cachedMetadata).success, false, 'cached metadata rechecks the current consumer before returning')
    assert.strictEqual(records.length, beforeCached, 'cached permission rechecks do not start native tools')
    privateB.destroy(); await settings.saveSettingsAndFlush({ privateDirectories: [] })

    const metadataA = makeSender(904), metadataB = makeSender(905), metadataHolds = await holdMedia('shared-metadata')
    const firstMetadata = handlers.get('get-video-metadata')({ sender: metadataA }, source, { force: true, requestId: 'shared-metadata-a' })
    const secondMetadata = handlers.get('get-video-metadata')({ sender: metadataB }, source, { force: true, requestId: 'shared-metadata-b' })
    await until(() => scheduler.diagnostics().interests === 4)
    metadataA.destroy(); await until(() => scheduler.diagnostics().interests === 3)
    const beforeMetadata = records.length; metadataHolds.forEach(lease => lease.release())
    assert.strictEqual((await firstMetadata).success, false)
    assert.strictEqual((await secondMetadata).media.available, true, 'shared metadata survives its first consumer leaving')
    assert.strictEqual(records.length - beforeMetadata, 1, 'public metadata callers share one actual ffprobe process')
    metadataB.destroy(); await until(() => scheduler.diagnostics().running === 0)

    const pidPath = path.join(fixture, 'aborted.pid'), abort = new AbortController()
    const execution = scheduler.enqueue({ key: 'real-abort', signal: abort.signal }, context => require('../main/exec').execFileAsync(process.execPath,
      ['-e', 'require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)', pidPath], { signal: context.signal }))
    await until(() => fs.existsSync(pidPath))
    const pid = Number(fs.readFileSync(pidPath, 'utf8')), rejected = assert.rejects(execution, error => error.code === 'task_cancelled')
    abort.abort(); await rejected
    await until(() => scheduler.diagnostics().running === 0)
    assert.ok(records.find(item => item.child.pid === pid)?.closed, 'a real aborted child closes before its resource lease is released')
    assert.throws(() => process.kill(pid, 0))
    assert.ok(maximum <= 2); assert.strictEqual(active, 0)
    console.log('media job lifecycle passed: actual FFmpeg/ffprobe and IPC handlers, two-process budget, authenticated shared HTTP cancellation, private window ownership, cached preview/metadata lock races and actual aborted-child cleanup')
  } finally {
    outstandingHolds.forEach(lease => lease.release()); Object.values(statGates).forEach(gate => gate?.release())
    if (server) { streaming.closeActiveFileStreams(server); server.closeAllConnections?.(); await new Promise(done => server.close(done)); await streaming.waitForFileStreams(server) }
    work.dispose(); await transcodes.disposeTranscodes(); await metadata.disposeVideoMetadata(); await scheduler.dispose()
    require('../main/scanner').unwatchAllDirectories()
  }
}
const deadline = setTimeout(() => { console.error('media job verification timed out'); process.exit(1) }, 30000)
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  clearTimeout(deadline); process.chdir(root); assert.strictEqual(path.dirname(path.resolve(fixture)), parent); await removeTempRootWithRetry(fixture)
})
