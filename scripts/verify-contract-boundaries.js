const assert = require('assert')
const fs = require('fs')
const path = require('path')
const http = require('http')
const Module = require('module')
const contracts = require('../packages/contracts')
const { phone } = require('./mobile-module-harness')
const { claimDevice, requestJson, removeTempRootWithRetry } = require('./verify-helpers')
const projectRoot = path.resolve(__dirname, '..')
const fixtureParent = path.join(projectRoot, '.tmp/refactor-tests')
fs.mkdirSync(fixtureParent, { recursive: true })
const fixture = fs.mkdtempSync(path.join(fixtureParent, 'contracts-'))
process.chdir(fixture)
const settings = require(path.join(projectRoot, 'main/settings'))
const scanner = require(path.join(projectRoot, 'main/scanner'))
const { getVideoId } = require(path.join(projectRoot, 'main/remote/video-index'))
const { createRemoteServer } = require(path.join(projectRoot, 'main/remote/server'))
const identity = require(path.join(projectRoot, 'main/remote/identity'))
const servers = []
async function listen(server) {
  servers.push(server)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${server.address().port}`
}
function json(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(value))
}

async function main() {
  const libraryDir = path.join(fixture, 'library')
  fs.mkdirSync(libraryDir)
  const videoPath = path.join(libraryDir, 'sample.mp4')
  fs.writeFileSync(videoPath, 'contract-fixture')
  await settings.saveSettingsAndFlush({ directories: [libraryDir], defaultDirectory: libraryDir })
  const scan = await scanner.scanWithCache(libraryDir, true)
  const video = scan.videos[0]
  const id = getVideoId(videoPath)
  const endpoint = await listen(createRemoteServer({ port: 0 }))
  const paired = await claimDevice({ baseUrl: endpoint, clientId: 'contract-matrix-phone', ...identity })
  const client = phone()
  const api = client.load('mobile/src/services/api.ts')
  const info = await api.getInfo(endpoint)
  assert.strictEqual(info.protocolVersion, contracts.PROTOCOL_VERSION)
  assert.strictEqual(info.minClientProtocol, 1)
  const device = { id: info.deviceId, name: info.deviceName, token: paired.token, endpoint, capabilities: info.capabilities }
  assert.strictEqual((await api.getLibrary(device)).items[0].id, id)
  assert.strictEqual((await api.toggleFavorite(device, id, true)).favorite, true)
  assert.strictEqual((await api.toggleFavorite(device, id, true)).favorite, true)
  assert.strictEqual((await api.updateVideoTags(device, id, ['new-phone'])).customTags[0], 'new-phone')
  const bulk = await api.addTagsToVideos(device, [id, 'video_missing'], ['bulk'])
  assert.strictEqual(bulk.updatedCount, 1)
  assert.strictEqual(bulk.failed[0].id, 'video_missing')
  const headers = { Authorization: 'Bearer ' + paired.token }
  const oldFavorite = await requestJson(endpoint + '/v1/videos/' + id + '/favorite', { method: 'PUT', headers })
  assert.strictEqual(oldFavorite.data.favorite, false, 'old phone toggle remains supported')
  const oldProgress = await requestJson(endpoint + '/v1/playback/' + id, { method: 'PUT', headers, body: JSON.stringify({ position: 180 }) })
  assert.strictEqual(oldProgress.status, 200)
  let playback = await api.getPlaybackState(device, id)
  const saved = await api.savePlaybackState(device, id, 0, { baseRevision: playback.revision, session: 1, sequence: 1 })
  assert.strictEqual(saved.playback.position, 0)
  await assert.rejects(api.savePlaybackState(device, id, 30, { baseRevision: 0, session: 1, sequence: 2 }), error =>
    error.code === 'playback_conflict' && error.currentRevision === saved.playback.revision && !error.retryable)
  for (const [route, body] of [ ['/v1/videos/' + id + '/favorite', { favorite: 'true' }],
    ['/v1/videos/' + id + '/tags', { tags: [5] }], ['/v1/playback/' + id, { position: 1, session: 5 }],
    ['/v1/videos/tags/bulk', { videoIds: [id], tags: 'bad' }] ]) {
    const rejected = await requestJson(endpoint + route, { method: 'PUT', headers, body: JSON.stringify(body) })
    assert.strictEqual(rejected.status, 400)
    assert.strictEqual(rejected.data.error.retryable, false)
    assert.ok(!JSON.stringify(rejected.data).includes(videoPath))
  }
  assert.strictEqual((await requestJson(endpoint + '/v1/library?limit=bad', { headers })).status, 400)
  assert.strictEqual((await requestJson(endpoint + '/v1/videos/' + id + '/transcode?quality=unknown', { method: 'POST', headers })).status, 400)
  await assert.rejects(api.savePlaybackState(device, id, NaN), error => error.code === 'invalid_request')

  const handlers = new Map()
  const originalLoad = Module._load
  Module._load = function (name, parent, ...args) {
    if (name === 'electron' && /[\\/]main[\\/]ipc[\\/](media-data|files|media)\.js$/.test(parent?.filename || '')) {
      return { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } }
    }
    return originalLoad.call(this, name, parent, ...args)
  }
  try {
    const ipc = { handle: (channel, handler) => handlers.set(channel, handler) }
    require(path.join(projectRoot, 'main/ipc/media-data')).registerMediaDataIpc(ipc)
    require(path.join(projectRoot, 'main/ipc/files')).registerFileIpc(ipc)
    require(path.join(projectRoot, 'main/ipc/media')).registerMediaIpc(ipc)
  } finally { Module._load = originalLoad }
  let favoriteCalls = 0
  const window = { electronAPI: {
    setVideoFavorite: (...args) => { favoriteCalls++; return handlers.get('media-set-favorite')({}, ...args) },
    setVideoCustomTags: (...args) => handlers.get('media-set-tags')({}, ...args),
    appendVideoCustomTags: (...args) => handlers.get('media-append-tags')({}, ...args),
    getPlaybackState: (...args) => handlers.get('get-playback-state')({}, ...args),
    savePlaybackState: (...args) => handlers.get('save-playback-state')({}, ...args),
    scanDirectory: (...args) => handlers.get('scan-directory')({}, ...args)
  } }
  const desktop = phone()
  desktop.control.globals = { window }
  const media = desktop.load('src/api/media.ts')
  assert.strictEqual((await media.setVideoFavorite(video, true)).favorite, true)
  assert.strictEqual((await media.setVideoCustomTags(video, ['desktop'])).customTags[0], 'desktop')
  assert.strictEqual((await media.appendVideoCustomTags([video], ['append'])).updatedCount, 1)
  assert.strictEqual((await media.scanDirectory(libraryDir)).videos.length, 1)
  await media.savePlaybackState(videoPath, { position: 5, volume: 0 })
  assert.strictEqual((await media.getPlaybackState(videoPath)).volume, 0)
  assert.throws(() => media.setVideoFavorite({}, true), error => error.code === 'invalid_request')
  assert.throws(() => media.setVideoFavorite(video, 'true'), error => error.code === 'invalid_request')
  assert.strictEqual(favoriteCalls, 1, 'invalid target must be rejected before invoking IPC')
  const invalidIpc = await handlers.get('media-set-favorite')({}, video, 'true')
  assert.strictEqual(invalidIpc.success, false)
  assert.strictEqual(invalidIpc.code, 'invalid_request')
  window.electronAPI.setVideoFavorite = async () => ({ success: true, favorite: 'true' })
  await assert.rejects(media.setVideoFavorite(video, true), error => error.code === 'invalid_response')

  let legacyFavorite = false, legacyPosition = 50, variant = 'normal'
  const received = []
  const legacyEndpoint = await listen(http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : {}
    received.push({ method: req.method, url: req.url, body })
    if (req.url === '/v1/info') {
      if (variant === 'malformed') { res.end('{broken'); return }
      json(res, { deviceId: 'legacy-pc', deviceName: '旧电脑', version: 1,
        ...(variant === 'invalid-capability' ? { capabilities: { favoriteState: 'yes' } } : {}),
        ...(variant === 'future-minimum' ? { protocolVersion: 10, minClientProtocol: 10 } : {}) }); return
    }
    if (req.url.endsWith('/favorite')) { legacyFavorite = !legacyFavorite; json(res, { success: true, favorite: legacyFavorite }); return }
    if (req.url.startsWith('/v1/playback/')) {
      if (req.method === 'PUT') { legacyPosition = body.position; json(res, { success: true }); return }
      json(res, { position: legacyPosition, updatedAt: 1 }); return
    }
    if (req.url === '/v1/videos/tags/bulk') { json(res, { success: true, updatedCount: body.videoIds.length, tags: body.tags }); return }
    if (req.url === '/v1/library') { json(res, variant === 'invalid-library' ? { items: [ { id: 3 } ], count: 1 } : { items: [], count: 0 }); return }
    if (req.url === '/v1/pairing/claim') {
      json(res, { deviceId: 'legacy-pc', deviceName: '旧电脑', token: 'legacy-token' }); return
    }
    json(res, { error: { code: 'legacy_error', message: '旧版错误' } }, 503)
  }))
  const oldInfo = await api.getInfo(legacyEndpoint)
  assert.strictEqual(oldInfo.protocolVersion, 1)
  assert.strictEqual(oldInfo.capabilities.favoriteState, false)
  const independentInfo = contracts.infoSchema.parse({ deviceId: 'other-legacy', deviceName: '其他旧电脑' })
  independentInfo.capabilities.favoriteState = true
  assert.strictEqual(contracts.infoSchema.parse({ deviceId: 'untouched-legacy', deviceName: '另一台旧电脑' }).capabilities.favoriteState, false,
    'capability defaults must not share mutable state across devices')
  assert.strictEqual(contracts.isRetryableError(500, 'invalid_response'), false)
  const oldDevice = { ...device, id: 'legacy-pc', endpoint: legacyEndpoint, capabilities: oldInfo.capabilities }
  assert.strictEqual((await api.toggleFavorite(oldDevice, id, true)).favorite, true)
  await api.savePlaybackState(oldDevice, id, 0, { baseRevision: 9, session: 2, sequence: 1 })
  assert.strictEqual(legacyPosition, 0)
  const legacyPut = received.find(item => item.url.startsWith('/v1/playback/') && item.method === 'PUT')
  assert.deepStrictEqual(legacyPut.body, { position: 0 }, 'new phone must omit new progress fields for old desktop')
  assert.deepStrictEqual(received.find(item => item.url.endsWith('/favorite')).body, {}, 'new phone must preserve old toggle format')
  assert.strictEqual((await api.addTagsToVideos(oldDevice, [id], ['legacy'])).updatedCount, 1)
  assert.strictEqual((await api.claimPairing(legacyEndpoint, { pairingId: 'one', oneTimeSecret: 'secret' }, { clientId: 'mobile' })).token, 'legacy-token')
  for (const next of ['malformed', 'invalid-capability', 'future-minimum']) {
    variant = next
    await assert.rejects(api.getInfo(legacyEndpoint), error =>
      error.code === (next === 'future-minimum' ? 'unsupported_protocol' : 'invalid_response') && !error.retryable)
  }
  variant = 'invalid-library'
  await assert.rejects(api.getLibrary(oldDevice), error => error.code === 'invalid_response' && !error.retryable)
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(api.claimPairing(legacyEndpoint, { pairingId: 'one', oneTimeSecret: 'secret' }, { clientId: 'mobile' }, abort.signal),
    error => error.name === 'AbortError')
  assert.throws(() => contracts.librarySchema.parse({ items: [], count: -1 }), contracts.ContractError)
  assert.throws(() => contracts.playbackSchema.parse({ position: Infinity }), contracts.ContractError)
  console.log('contract boundaries passed: actual IPC adapters; new/new, old-phone/new-desktop and new-phone/old-desktop HTTP; malformed payload/response, capability downgrade, conflict metadata and cancellation')
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  await scanner.waitForBackgroundScanRefreshes()
  scanner.unwatchAllDirectories()
  await settings.flushSettingsWrites()
  process.chdir(projectRoot)
  assert.strictEqual(path.dirname(path.resolve(fixture)), fixtureParent)
  assert.ok(path.basename(fixture).startsWith('contracts-'))
  await removeTempRootWithRetry(fixture)
})
