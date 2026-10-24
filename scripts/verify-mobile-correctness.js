const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { claimDevice, removeTempRootWithRetry, requestJson } = require('./verify-helpers')
const projectRoot = path.resolve(__dirname, '..')
const { phone } = require('./mobile-module-harness')

function playbackRecord(client, device, videoId) {
  const raw = client.async.values.get(`wallpaper-player.playback.${device.id}.${videoId}`)
  return raw ? JSON.parse(raw) : null
}
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function verifyQueries() {
  const { filterLibrary } = phone().load('mobile/src/services/library-query.ts')
  const common = { extension: '.mp4', size: 1, streamUrl: '', thumbnailUrl: '' }
  const videos = [
    { ...common, id: 'a', name: '海边 2', favorite: true, directoryId: 'one', customTags: ['休息'], systemTags: ['动画'] },
    { ...common, id: 'b', name: '海边 10', favorite: true, directoryId: 'one', customTags: ['休息', '隐藏'], systemTags: ['动画'] },
    { ...common, id: 'c', name: '海边 3', favorite: false, directoryId: 'two', customTags: ['休息'], systemTags: ['动画'] },
    { ...common, id: 'd', name: '海边 4', favorite: true, directoryId: 'one', customTags: ['动画'], systemTags: [], tags: ['动画'] }
  ]
  const filters = [ { key: 'custom:休息', name: '休息', type: 'custom', state: 'include' },
    { key: 'system:动画', name: '动画', type: 'system', state: 'include' },
    { key: 'custom:隐藏', name: '隐藏', type: 'custom', state: 'exclude' } ]
  const ids = scope => [...filterLibrary(videos, scope, filters, '海边')].map(item => item.id)
  assert.deepStrictEqual(ids({ mode: 'favorites' }), ['a'])
  assert.deepStrictEqual(ids({ mode: 'directory', id: 'one' }), ['a'])
  assert.deepStrictEqual(ids({ mode: 'all' }), ['a', 'c'])
  assert.deepStrictEqual([...filterLibrary(videos, { mode: 'all' }, [filters[1]], '')].map(item => item.id), ['a', 'b', 'c'])
  assert.strictEqual(filterLibrary(videos, { mode: 'favorites' }, filters, '不存在').length, 0)
}
async function verifyDevices() {
  const p = phone()
  const repository = p.load('mobile/src/persistence/devices.ts')
  const legacy = { id: 'one', name: '旧设备', endpoint: 'http://127.0.0.1:1', token: 'legacy-secret' }
  p.secure.values.set('wallpaper-player.devices.v1', JSON.stringify([legacy]))
  p.async.failNextWrite(key => key === 'wallpaper-player.devices.v2')
  await assert.rejects(repository.loadDevices(), /storage failure/)
  assert.ok(p.secure.values.has('wallpaper-player.devices.v1'), 'failed migration must preserve the legacy source')
  let devices = await repository.loadDevices()
  assert.strictEqual(devices[0].token, legacy.token)
  assert.ok(devices[0].bindingId)
  assert.ok(!p.secure.values.has('wallpaper-player.devices.v1'), 'legacy secret is removed only after the metadata index is durable')
  assert.ok(!p.async.values.get('wallpaper-player.devices.v2').includes('legacy-secret'))
  const clientIds = await Promise.all(Array.from({ length: 12 }, () => repository.getClientId()))
  assert.strictEqual(new Set(clientIds).size, 1, 'concurrent first access must produce one client identity')
  await Promise.all(['two', 'three'].map(id => repository.saveDevice({ ...legacy, id, token: 'secret-' + id })))
  devices = await repository.loadDevices()
  assert.strictEqual(devices.length, 3, 'concurrent pairing must retain both new devices')
  await Promise.all(devices.map(device => repository.updateDevice(device, { lastConnectedAt: 123 })))
  assert.ok((await repository.loadDevices()).every(device => device.lastConnectedAt === 123))
  const original = devices.find(device => device.id === 'one')
  p.async.values.set('wallpaper-player.library.one', 'cache')
  p.async.values.set('wallpaper-player.playback.one.a', 'progress')
  await repository.removeDevice('one', original.bindingId)
  assert.strictEqual(await repository.updateDevice(original, { name: 'late-probe' }), null)
  assert.ok(!p.async.values.has('wallpaper-player.library.one'))
  assert.ok(!p.async.values.has('wallpaper-player.playback.one.a'))
  const rebound = await repository.saveDevice(legacy)
  assert.notStrictEqual(rebound.bindingId, original.bindingId)
  assert.strictEqual(await repository.updateDevice(original, { name: 'stale-same-token' }), null,
    'a new binding with the same token must reject probes from the deleted binding')
  p.async.failNextWrite(key => key === 'wallpaper-player.devices.v2')
  await assert.rejects(repository.saveDevice({ ...legacy, token: 'replacement-secret' }), /storage failure/)
  assert.strictEqual((await repository.loadDevices()).find(item => item.id === 'one').token, legacy.token)
  assert.ok(![...p.secure.values.values()].includes('replacement-secret'))
}

const fixtureParent = path.join(projectRoot, '.tmp/refactor-tests')
fs.mkdirSync(fixtureParent, { recursive: true })
const fixture = fs.mkdtempSync(path.join(fixtureParent, 'mobile-correctness-'))
process.chdir(fixture)
const settings = require(path.join(projectRoot, 'main/settings'))
const scanner = require(path.join(projectRoot, 'main/scanner'))
const { getVideoId } = require(path.join(projectRoot, 'main/remote/video-index'))
const { savePlaybackRecord } = require(path.join(projectRoot, 'main/application/media-mutations'))
const { createRemoteServer } = require(path.join(projectRoot, 'main/remote/server'))
const identity = require(path.join(projectRoot, 'main/remote/identity'))
let server

async function verifyPlayback() {
  const library = path.join(fixture, 'library')
  fs.mkdirSync(library)
  const file = path.join(library, 'fixture.mp4')
  fs.writeFileSync(file, 'progress-fixture')
  await settings.saveSettingsAndFlush({ directories: [library], defaultDirectory: library })
  await scanner.scanWithCache(library, true)
  const id = getVideoId(file)
  server = createRemoteServer({ port: 0 })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  const info = await requestJson(endpoint + '/v1/info')
  assert.strictEqual(info.data.capabilities.playbackRevision, true)
  const a = await claimDevice({ baseUrl: endpoint, clientId: 'progress-phone-a', ...identity })
  const b = await claimDevice({ baseUrl: endpoint, clientId: 'progress-phone-b', ...identity })
  const pa = phone(), pb = phone()
  const da = await pa.load('mobile/src/persistence/devices.ts').saveDevice({ id: info.data.deviceId, name: 'PC', endpoint,
    token: a.token, capabilities: info.data.capabilities })
  const db = await pb.load('mobile/src/persistence/devices.ts').saveDevice({ id: info.data.deviceId, name: 'PC', endpoint,
    token: b.token, capabilities: info.data.capabilities })
  let progressA = pa.load('mobile/src/persistence/playback.ts')
  const progressB = pb.load('mobile/src/persistence/playback.ts')
  assert.strictEqual(progressA.choosePlayback({ position: 180, updatedAt: 1 }, { position: 30, updatedAt: 2 }).position, 30)
  assert.strictEqual(progressA.choosePlayback({ position: 180, updatedAt: 1 }, { position: 0, updatedAt: 2 }).position, 0)
  assert.strictEqual(progressA.choosePlayback({ position: 180, updatedAt: 99999, revision: 1 }, { position: 0, updatedAt: 2, revision: 2 }).position, 0)
  const sa = await progressA.openPlaybackSession(da, id)
  const sb = await progressB.openPlaybackSession(db, id)
  await progressA.recordPlayback(sa, 180)
  assert.strictEqual((await progressA.syncPendingPlayback(da, id)).state, 'synced')
  await progressB.recordPlayback(sb, 30)
  assert.strictEqual((await progressB.syncPendingPlayback(db, id)).state, 'conflict')
  assert.strictEqual(settings.getPlaybackState(settings.loadSettings().playbackStates, file).position, 180)
  assert.ok(playbackRecord(pb, db, id).conflict, 'conflicted intent must remain recoverable locally')
  await progressB.recordPlayback(sb, 30, true)
  assert.strictEqual((await progressB.syncPendingPlayback(db, id)).state, 'synced')
  assert.strictEqual(settings.getPlaybackState(settings.loadSettings().playbackStates, file).position, 30)
  const freshA = await progressA.openPlaybackSession(da, id)
  assert.strictEqual(freshA.position, 30)
  await progressA.recordPlayback(freshA, 0, true)
  await progressA.syncPendingPlayback(da, id)
  assert.strictEqual(settings.getPlaybackState(settings.loadSettings().playbackStates, file).position, 0)
  const state = settings.getPlaybackState(settings.loadSettings().playbackStates, file)
  const late = await requestJson(endpoint + '/v1/playback/' + id, { method: 'PUT', headers: { Authorization: 'Bearer ' + a.token },
    body: JSON.stringify({ position: 180, baseRevision: state.revision, session: sa.session, sequence: 2 }) })
  assert.strictEqual(late.status, 409, 'an old session must fail even if it knows the new revision')
  const invalid = await requestJson(endpoint + '/v1/playback/' + id, { method: 'PUT', headers: { Authorization: 'Bearer ' + a.token },
    body: JSON.stringify({ position: -1, baseRevision: state.revision, session: freshA.session, sequence: 3 }) })
  assert.strictEqual(invalid.status, 400)
  const legacy = await requestJson(endpoint + '/v1/playback/' + id, { method: 'PUT', headers: { Authorization: 'Bearer ' + a.token }, body: JSON.stringify({ position: 5 }) })
  assert.strictEqual(legacy.status, 200, 'old clients must keep their unversioned write behavior')
  assert.ok(!JSON.stringify(legacy.data).includes('writers'), 'HTTP must not expose other device writer cursors')

  const offlineSession = await progressA.openPlaybackSession(da, id)
  pa.control.online = false
  await progressA.recordPlayback(offlineSession, 0, true)
  assert.strictEqual((await progressA.syncPendingPlayback(da, id)).state, 'pending')
  assert.strictEqual(playbackRecord(pa, da, id).pending.position, 0)
  progressA.closePlaybackSession(offlineSession)
  pa.rebootPlayback()
  progressA = pa.load('mobile/src/persistence/playback.ts')
  const restarted = await progressA.openPlaybackSession(da, id)
  assert.strictEqual(restarted.position, 0, 'zero intent must survive an offline restart')
  assert.ok(restarted.session > offlineSession.session)
  pa.control.online = true
  assert.strictEqual((await progressA.syncPendingPlayback(da, id)).state, 'synced')
  assert.ok(!playbackRecord(pa, da, id).pending)
  assert.strictEqual(settings.getPlaybackState(settings.loadSettings().playbackStates, file).position, 0)

  const lost = await progressA.openPlaybackSession(da, id)
  pa.control.loseNextPut = true
  await progressA.recordPlayback(lost, 12, true)
  await progressA.syncPendingPlayback(da, id)
  assert.ok(playbackRecord(pa, da, id).pending)
  const revisionBeforeRetry = settings.getPlaybackState(settings.loadSettings().playbackStates, file).revision
  assert.strictEqual((await progressA.syncPendingPlayback(da, id)).state, 'synced')
  assert.strictEqual(settings.getPlaybackState(settings.loadSettings().playbackStates, file).revision, revisionBeforeRetry,
    'a lost acknowledgement retry must not create a second commit')

  const coalesced = await progressA.openPlaybackSession(da, id)
  const entered = deferred(), release = deferred()
  pa.control.hold = async (url, options) => {
    if (options?.method === 'PUT') { entered.resolve(); await release.promise }
  }
  await progressA.recordPlayback(coalesced, 20)
  await entered.promise
  await progressA.recordPlayback(coalesced, 0, true)
  release.resolve()
  assert.strictEqual((await progressA.syncPendingPlayback(da, id)).state, 'synced')
  pa.control.hold = null
  assert.strictEqual(settings.getPlaybackState(settings.loadSettings().playbackStates, file).position, 0,
    'a delayed older acknowledgement must rebase and preserve the newer zero checkpoint')

  const successor = await progressA.openPlaybackSession(da, id)
  await progressA.recordPlayback(successor, 0)
  await progressA.syncPendingPlayback(da, id)
  await progressA.recordPlayback(coalesced, 444)
  await progressA.syncPendingPlayback(da, id)
  assert.strictEqual(playbackRecord(pa, da, id).position, 0)
  assert.ok(!playbackRecord(pa, da, id).pending, 'an acknowledged newer session must reject late older local callbacks')

  pa.async.failNextWrite(key => key.includes('wallpaper-player.playback.'))
  await assert.rejects(progressA.recordPlayback(successor, 99), /storage failure/)
  assert.strictEqual(settings.getPlaybackState(settings.loadSettings().playbackStates, file).position, 0)
  await savePlaybackRecord(file, { position: 7, volume: 0 })
  await progressA.recordPlayback(successor, 88)
  assert.strictEqual((await progressA.syncPendingPlayback(da, id)).state, 'conflict', 'desktop updates must invalidate stale phone checkpoints')
  assert.strictEqual(settings.getPlaybackState(settings.loadSettings().playbackStates, file).position, 7)
  assert.strictEqual(settings.getPlaybackState(settings.loadSettings().playbackStates, file).volume, 0)

  await require('./verify-mobile-player-behavior').verifyPlayerBehavior({ phone: pb, device: db, videoId: id,
    setRemotePosition: position => savePlaybackRecord(file, { position }),
    getRemotePosition: () => settings.getPlaybackState(settings.loadSettings().playbackStates, file).position })

  const connection = pa.load('mobile/src/services/connection-manager.ts')
  const probeEntered = deferred(), probeRelease = deferred()
  pa.control.hold = async url => { if (String(url).endsWith('/v1/info')) { probeEntered.resolve(); await probeRelease.promise } }
  const lateProbe = connection.checkDeviceAvailability(da)
  await probeEntered.promise
  await pa.load('mobile/src/persistence/devices.ts').removeDevice(da.id, da.bindingId)
  probeRelease.resolve()
  await lateProbe
  assert.strictEqual((await pa.load('mobile/src/persistence/devices.ts').loadDevices()).length, 0)
  assert.strictEqual(playbackRecord(pa, da, id), null, 'device removal must delete the pending outbox')
  await progressA.recordPlayback(coalesced, 100)
  assert.strictEqual(playbackRecord(pa, da, id), null, 'old progress callbacks must not recreate removed device caches')
}

async function main() {
  await verifyQueries()
  await verifyDevices()
  await verifyPlayback()
  console.log('mobile correctness passed: composed filters; credential migration/concurrency/deletion; actual two-phone HTTP revisions; offline restart, zero/rewind, lost ACK, checkpoint coalescing, disk failure, stale probes; production player readiness, metadata edits and source retry')
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  await scanner.waitForBackgroundScanRefreshes()
  scanner.unwatchAllDirectories()
  await settings.flushSettingsWrites()
  process.chdir(projectRoot)
  assert.strictEqual(path.dirname(path.resolve(fixture)), fixtureParent)
  assert.ok(path.basename(fixture).startsWith('mobile-correctness-'))
  await removeTempRootWithRetry(fixture)
})
