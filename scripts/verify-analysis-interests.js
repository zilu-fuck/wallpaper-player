const assert = require('assert'), fs = require('fs'), path = require('path'), http = require('http'), Module = require('module')
const { EventEmitter } = require('events'), { PassThrough } = require('stream')
const { claimDevice, requestJson, removeTempRootWithRetry } = require('./verify-helpers')
const { phone } = require('./mobile-module-harness')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
fs.mkdirSync(parent, { recursive: true })
const fixture = fs.mkdtempSync(path.join(parent, 'analysis-interests-'))
const delay = ms => new Promise(done => setTimeout(done, ms))
const until = async predicate => { const deadline = Date.now() + 6000
  while (!predicate()) { if (Date.now() > deadline) throw new Error('analysis interests condition timed out'); await delay(4) } }
async function main() {
  process.chdir(fixture)
  const project = path.join(fixture, 'runtime'), video = path.join(fixture, 'source.mp4')
  fs.mkdirSync(path.join(project, 'video_comprehension'), { recursive: true })
  for (const [name, content] of [['pyproject.toml', 'project'], ['video_comprehension/cli.py', 'VIDEO_COMPREHENSION_ENV'],
    ['video_comprehension/config.py', 'VIDEO_COMPREHENSION_OUTPUT_DIR'], ['video_comprehension/pipeline.py', 'pipeline']]) fs.writeFileSync(path.join(project, name), content)
  fs.writeFileSync(video, Buffer.alloc(512))
  const settings = require('../main/settings'), actualPaths = require('../main/paths'), actualCore = require('../main/plugins/core-api')
  await settings.saveSettingsAndFlush({ directories: [fixture], privateDirectories: [], videoAnalysis: { enabled: true }, remoteAccess: { enabled: true } })
  const ipc = new Map(), children = [], senders = []
  let holdPermission = null, permissionEntered = false, authorizationListeners = 0
  const resolveCore = name => {
    const actual = actualCore.requireCoreModule(name)
    if (name === 'paths') return { ...actual, getResourcePath: (...segments) => segments[0] === 'video comprehension' ? project : actualPaths.getResourcePath(...segments) }
    if (name === 'scanner') return { ...actual, assertAllowedVideoPath: async (...args) => {
      if (holdPermission) { permissionEntered = true; await holdPermission }
      return actual.assertAllowedVideoPath(...args)
    } }
    if (name === 'remote/authorization') return { ...actual, onChanged: listener => { authorizationListeners++; const remove = actual.onChanged(listener); return () => { authorizationListeners--; remove() } } }
    return actual
  }
  const original = Module._load
  Module._load = function (name, owner, ...rest) {
    const filename = owner?.filename.replace(/\\/g, '/') || ''
    if (filename.endsWith('/main/plugins/registry.js')) {
      if (name === '../security/ipc') return { ipcMain: { handle: (channel, handler) => ipc.set(channel, handler), removeHandler: channel => ipc.delete(channel) } }
      if (name === './core-api') return { requireCoreModule: resolveCore }
    }
    if (filename.endsWith('/main/plugins/video-analysis/service.js')) {
      if (name === 'electron') return { BrowserWindow: { getAllWindows: () => senders.filter(sender => !sender.destroyed).map(webContents => ({ webContents })) } }
      if (name === 'child_process') return { spawn(_file, args) {
        const child = new EventEmitter(); child.args = args; child.stdout = new PassThrough(); child.stderr = new PassThrough()
        child.kill = () => { child.kills = (child.kills || 0) + 1; return true }
        child.finish = code => { if (child.closed) return; child.closed = true; child.emit('close', code) }
        children.push(child); return child
      } }
    }
    return original.call(this, name, owner, ...rest)
  }
  let registry, service, createRemoteServer
  try {
    registry = require('../main/plugins').pluginRegistry
    await registry.register({ ...require('../main/plugins/video-analysis'), publisher: 'official', executable: true, enabled: true })
    service = require('../main/plugins/video-analysis/service')
    ;({ createRemoteServer } = require('../main/remote/server'))
  } finally { Module._load = original }
  await service.saveVideoAnalysisRuntimeConfig({ llmProvider: 'api', vlmProvider: 'api', llmBaseUrl: 'http://127.0.0.1:1/v1', vlmBaseUrl: 'http://127.0.0.1:1/v1' })
  const identity = require('../main/remote/identity'), index = require('../main/remote/video-index'), scheduler = require('../main/application/resource-scheduler').mediaScheduler
  const videoId = index.getVideoId(video); index.rememberVideos([{ fullPath: video, fileName: 'source.mp4', name: 'source' }])
  const server = createRemoteServer({ port: 0 }); await new Promise(done => server.listen(0, '127.0.0.1', done))
  const endpoint = 'http://127.0.0.1:' + server.address().port
  const bind = clientId => claimDevice({ baseUrl: endpoint, clientId, createPairingCode: identity.createPairingCode, approvePairingRequest: identity.approvePairingRequest, projectRoot: root })
  const a = await bind('analysis-a'), b = await bind('analysis-b'), c = await bind('analysis-c')
  const api = phone().load('mobile/src/services/api.ts'), capabilities = (await api.getInfo(endpoint)).capabilities
  assert.strictEqual(capabilities.analysisInterests, true)
  const device = token => ({ id: 'pc', endpoint, token, capabilities }), A = device(a.token), B = device(b.token), C = device(c.token)
  const makeSender = id => { const sender = new EventEmitter(); sender.id = id; sender.send = () => {}; sender.isDestroyed = () => Boolean(sender.destroyed)
    sender.destroy = () => { sender.destroyed = true; sender.emit('destroyed') }; senders.push(sender); return sender }
  const firstWindow = makeSender(701), secondWindow = makeSender(702)
  try {
    const [first, second] = await Promise.all([api.startVideoAnalysis(A, videoId, undefined, 'a1'), api.startVideoAnalysis(B, videoId, undefined, 'b1')])
    assert.strictEqual(first.accepted, true, JSON.stringify({ accepted: first.accepted, reason: first.reason, error: first.error })); assert.strictEqual(second.accepted, true, JSON.stringify({ accepted: second.accepted, reason: second.reason, error: second.error }))
    await until(() => children.length === 1)
    const desktop = await ipc.get('video-analysis-start')({ sender: firstWindow }, video, 'w1')
    assert.strictEqual(desktop.accepted, true); assert.strictEqual(desktop.job.interestedClients, 3)
    assert.strictEqual((await api.cancelVideoAnalysis(C, videoId, 'a1')).released, false)
    await api.startVideoAnalysis(A, videoId, undefined, 'a2')
    assert.strictEqual((await api.cancelVideoAnalysis(A, videoId, 'a1')).shared, true)
    await assert.rejects(api.startVideoAnalysis(A, videoId, undefined, 'a1'), error => error.code === 'task_interest_closed')
    assert.strictEqual((await api.getVideoAnalysis(A, videoId, undefined, 'a1')).job.interestCancelled, true)
    assert.strictEqual((await api.cancelVideoAnalysis(B, videoId, 'b1')).shared, true)
    firstWindow.destroy(); await until(() => service.analysisTaskService.diagnostics().windows === 0)
    assert.ok(!children[0].kills, 'closing the first window leaves the remaining phone interest running')
    const last = await api.cancelVideoAnalysis(A, videoId, 'a2')
    assert.strictEqual(last.taskCancelled, true); await until(() => children[0].kills === 1)
    assert.strictEqual(service.getActiveAnalysisJob().running, true)
    assert.strictEqual((await api.startVideoAnalysis(B, videoId, undefined, 'b2')).reason, 'stopping')
    children[0].finish(0); await until(() => !service.getActiveAnalysisJob().running)
    assert.strictEqual(service.getRecentAnalysisEvent(video).status, 'cancelled')

    await api.cancelVideoAnalysis(B, videoId, 'before-post')
    await assert.rejects(api.startVideoAnalysis(B, videoId, undefined, 'before-post'), error => error.code === 'task_interest_closed')
    await api.startVideoAnalysis(A, videoId, undefined, 'a3'); await until(() => children.length === 2)
    await api.startVideoAnalysis(B, videoId, undefined, 'b3')
    assert.strictEqual((await api.cancelVideoAnalysis(A, videoId, 'a3', first.job.jobId)).reason, 'job_mismatch')
    assert.strictEqual((await api.getVideoAnalysis(A, videoId, undefined, 'a3')).job.canCancel, true, 'an old job ID cannot retire the new job interest')
    const old = await api.cancelVideoAnalysis(A, videoId, 'a2', first.job.jobId)
    assert.strictEqual(old.taskCancelled, false); assert.ok(!children[1].kills)
    await identity.revokePairedDeviceByToken(a.token)
    await until(() => service.analysisTaskService.diagnostics().actors === 1)
    assert.ok(!children[1].kills, 'revoking one pairing cannot stop another paired owner')
    await identity.revokePairedDeviceByToken(b.token)
    await until(() => children[1].kills === 1)
    children[1].finish(0); await until(() => !service.getActiveAnalysisJob().running)

    let releasePermission
    holdPermission = new Promise(done => { releasePermission = done })
    const pending = ipc.get('video-analysis-start')({ sender: secondWindow }, video, 'late-window')
    await until(() => permissionEntered); secondWindow.destroy(); releasePermission(); holdPermission = null
    assert.strictEqual((await pending).accepted, false); assert.strictEqual(children.length, 2)
    const thirdWindow = makeSender(703)
    const windowStart = await ipc.get('video-analysis-start')({ sender: thirdWindow }, video, 'w3')
    assert.strictEqual(windowStart.accepted, true); await until(() => children.length === 3)
    thirdWindow.emit('did-start-navigation', {}, 'http://fixture', false, false); await delay(10)
    assert.ok(!children[2].kills, 'a subframe navigation does not release a main window owner')
    thirdWindow.emit('did-start-navigation', {}, 'http://fixture', false, true)
    await until(() => children[2].kills === 1)
    children[2].finish(0); await until(() => !service.getActiveAnalysisJob().running)
    assert.strictEqual(thirdWindow.listenerCount('destroyed'), 0); assert.strictEqual(thirdWindow.listenerCount('did-start-navigation'), 0)
    const oldDevice = { ...C, capabilities: { ...capabilities, analysisInterests: false } }
    const legacy = await api.startVideoAnalysis(oldDevice, videoId)
    assert.strictEqual(legacy.accepted, true); await until(() => children.length === 4)
    const legacyStatus = await api.getVideoAnalysis(C, videoId)
    assert.strictEqual(legacyStatus.job.canCancel, true); assert.strictEqual(legacyStatus.job.interestId, 'legacy')
    await api.cancelVideoAnalysis(C, videoId, 'legacy'); await until(() => children[3].kills === 1)
    children[3].finish(0); await until(() => !service.getActiveAnalysisJob().running)

    const privateVideo = path.join(project, 'private.mp4'); fs.writeFileSync(privateVideo, Buffer.alloc(512))
    await settings.saveSettingsAndFlush({ directories: [fixture, project], privateDirectories: [project] })
    const privacy = require('../main/security/media-access'), privateA = makeSender(704), privateB = makeSender(705), locked = makeSender(706)
    privacy.unlockDesktopPrivacy(privateA); privacy.unlockDesktopPrivacy(privateB)
    await ipc.get('video-analysis-start')({ sender: privateA }, privateVideo, 'private-a'); await until(() => children.length === 5)
    await ipc.get('video-analysis-start')({ sender: privateB }, privateVideo, 'private-b')
    const hidden = await ipc.get('video-analysis-job')({ sender: locked })
    assert.strictEqual(hidden.running, true); assert.ok(!hidden.videoPath && !hidden.jobId, 'locked windows cannot discover another private analysis: ' + JSON.stringify(hidden))
    const rejectedPublic = await ipc.get('video-analysis-start')({ sender: locked }, video, 'public-during-private')
    assert.strictEqual(rejectedPublic.accepted, false); assert.ok(!rejectedPublic.job.videoPath && !rejectedPublic.job.jobId)
    privacy.lockDesktopPrivacy(privateA)
    await until(() => service.analysisTaskService.diagnostics().actors === 1)
    assert.ok(!children[4].kills, 'locking the initial window retains a separately authorized window')
    privacy.lockDesktopPrivacy(privateB); await until(() => children[4].kills === 1)
    children[4].finish(0); await until(() => !service.getActiveAnalysisJob().running)
    await settings.saveSettingsAndFlush({ privateDirectories: [] })
    assert.strictEqual(scheduler.diagnostics().used.media, 0)
    await ipc.get('video-analysis-start')({ sender: locked }, video, 'dispose-live')
    await until(() => children.length === 6)
    let disposed = false
    const disposal = registry.dispose().then(() => { disposed = true })
    await until(() => children[5].kills === 1)
    assert.strictEqual(disposed, false)
    const model = await require('../main/plugins/video-analysis/vlm-service').downloadVlmModel()
    assert.strictEqual(model.success, false); assert.match(model.error, /正在关闭/, 'model admission stops immediately while analysis disposal is still waiting')
    assert.strictEqual((await ipc.get('video-analysis-start')({ sender: makeSender(707) }, video, 'during-dispose')).accepted, false)
    children[5].finish(0); await disposal
    assert.strictEqual(authorizationListeners, 0); assert.strictEqual(service.analysisTaskService.diagnostics().windows, 0)
    assert.strictEqual((await requestJson(endpoint + '/v1/videos/' + videoId + '/analysis', { headers: { Authorization: 'Bearer ' + c.token } })).status, 404)
    console.log('analysis interests passed: production plugin/IPC/HTTP and actual phone API, one shared worker, actor/nonce cancellation, stale/cancel-before-start isolation, window/navigation teardown, revoked pairings, native-close ownership, legacy clients and plugin subscription cleanup')
  } finally { for (const child of children) child.finish(1); await registry.dispose(); server.closeAllConnections(); await new Promise(done => server.close(done)); await scheduler.dispose() }
}
async function verifyBounds() {
  let active = null, sequence = 0, authorization
  const worker = { getActiveAnalysisJob: () => active || { running: false },
    startVideoAnalysis: async (videoPath, _sender, options) => { authorization = options.authorize; active = { running: true, jobId: 'job-' + ++sequence, videoPath }; return { accepted: true, job: active } },
    cancelVideoAnalysis: () => { active = null; return { cancelled: true } } }
  const service = require('../main/plugins/video-analysis/task-interests').createAnalysisTaskService(worker, { maxInterests: 2, maxWindows: 1, receiptLimit: 2, receiptMs: 5 })
  const allowed = { authorize: async () => true }, source = path.join(fixture, 'bounds.mp4')
  await service.start(source, 'first', 'one', allowed)
  await service.start(source, 'second', 'two', allowed)
  await assert.rejects(service.start(source, 'third', 'three', allowed), error => error.code === 'task_interests_full')
  await service.cancel('first', active.jobId, 'one'); await authorization()
  for (const interest of ['receipt-a', 'receipt-b', 'receipt-c']) await service.cancel('outsider', undefined, interest)
  assert.strictEqual(service.diagnostics().receipts, 2)
  const sender = new EventEmitter(); sender.id = 8; sender.isDestroyed = () => false
  service.windowOwner(sender)
  assert.throws(() => service.windowOwner({ id: 9 }), error => error.code === 'analysis_owners_full')
  await service.cancel('second', active.jobId, 'two')
  await service.cancel('first', undefined, 'expired'); await delay(10)
  assert.strictEqual((await service.start(source, 'first', 'expired', allowed)).accepted, true, 'expired receipts do not reject a fresh operation forever')
  await service.dispose(); assert.strictEqual(sender.listenerCount('destroyed'), 0)
}
async function verifyProtocolDowngrade() {
  let requests = 0, malformed = false
  const base = { enabled: true, analysis: null, recent: null, checkedAt: 1, job: { running: true, currentVideo: true } }
  const server = http.createServer((_req, res) => {
    requests++; res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ...base, job: malformed ? { ...base.job, interestId: 'one', canCancel: true, interestedClients: 0, interestCancelled: false } : base.job }))
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const api = phone().load('mobile/src/services/api.ts'), device = { id: 'pc', endpoint: 'http://127.0.0.1:' + server.address().port, token: 'test', capabilities: { analysisInterests: true } }
  try {
    await assert.rejects(api.getVideoAnalysis(device, 'one'), error => error.code === 'invalid_response')
    assert.strictEqual((await api.getVideoAnalysis({ ...device, capabilities: { analysisInterests: false } }, 'one')).job.running, true)
    malformed = true
    await assert.rejects(api.getVideoAnalysis(device, 'one'), error => error.code === 'invalid_response')
    const before = requests
    await assert.rejects(api.cancelVideoAnalysis({ ...device, capabilities: { analysisInterests: false } }, 'one', 'one'), error => error.code === 'unsupported_capability')
    assert.strictEqual(requests, before)
  } finally { server.closeAllConnections(); await new Promise(done => server.close(done)) }
}
const deadline = setTimeout(() => { console.error('analysis interests verification timed out'); process.exit(1) }, 25000)
main().then(verifyBounds).then(verifyProtocolDowngrade).catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  clearTimeout(deadline); process.chdir(root); assert.strictEqual(path.dirname(path.resolve(fixture)), parent); await removeTempRootWithRetry(fixture)
})
