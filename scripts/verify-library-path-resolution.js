const assert = require('assert')
const fs = require('fs'), fsp = require('fs/promises'), path = require('path')
const { performance } = require('perf_hooks')
const { requestJson, claimDevice, removeTempRootWithRetry } = require('./verify-helpers')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const delay = ms => new Promise(done => setTimeout(done, ms))
const until = async predicate => {
  const deadline = Date.now() + 10000
  while (!predicate()) { if (Date.now() > deadline) throw Error('path resolution condition timed out'); await delay(4) }
}
fs.mkdirSync(parent, { recursive: true })
const fixture = fs.mkdtempSync(path.join(parent, 'library-paths-'))
const nativeRealpath = fsp.realpath, nativeSync = fs.realpathSync.native
let server, scanner, metadata, settings, syncCalls = 0, countSync = false, gateFilter = () => false
const gates = new Map()
let issued = 0, active = 0, maxActive = 0
fsp.realpath = async function (input, ...args) {
  if (!gateFilter(String(input))) return nativeRealpath.call(this, input, ...args)
  const gate = deferred(); gates.set(++issued, gate); active++; maxActive = Math.max(maxActive, active)
  try { await gate.promise; return await nativeRealpath.call(this, input, ...args) } finally { active-- }
}
fs.realpathSync.native = function (...args) { if (countSync) syncCalls++; return nativeSync.apply(this, args) }
function releaseGates() { gateFilter = () => false; for (const gate of gates.values()) gate.resolve(); gates.clear() }

async function main() {
  process.chdir(fixture)
  settings = require('../main/settings'); scanner = require('../main/scanner'); metadata = require('../main/video-metadata')
  const paths = require('../main/paths'), library = require('../main/application/library-service')
  const identity = require('../main/remote/identity'), { createRemoteServer } = require('../main/remote/server')
  const directory = path.join(fixture, 'library'), privateDir = path.join(directory, 'private')
  const alias = path.join(fixture, 'legacy-alias')
  fs.mkdirSync(privateDir, { recursive: true })
  const files = Array.from({ length: 48 }, (_, index) => path.join(directory, 'clip-' + index + '.mp4'))
  const header = Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex')
  for (const file of files) fs.writeFileSync(file, header)
  const secret = path.join(privateDir, 'secret.mp4'); fs.writeFileSync(secret, header)
  fs.symlinkSync(directory, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const tags = Object.fromEntries(files.map((file, index) => [path.join(alias, path.basename(file)), ['Legacy-' + index]]))
  await settings.saveSettingsAndFlush({ directories: [directory, privateDir], customTags: tags, privateDirectories: [] })
  identity.loadIdentity(); metadata.setVideoMetadataWarmPaused(true)

  gateFilter = input => files.includes(input)
  let cancelled = false, settled = false
  const work = paths.resolvePathsForAccess(files, () => { if (cancelled) throw Error('batch-cancelled') })
    .catch(error => error).finally(() => { settled = true })
  await until(() => active === 8)
  await new Promise(done => setImmediate(done))
  cancelled = true; gates.values().next().value.resolve(); await delay(15)
  assert.strictEqual(settled, false, 'a cancelled batch waits for every issued filesystem operation')
  assert.strictEqual(issued, 8, 'cancellation does not admit the remaining paths')
  releaseGates(); assert.match((await work).message, /batch-cancelled/)
  assert.strictEqual(active, 0); assert.strictEqual(maxActive, 8)
  const batchMaximum = maxActive

  countSync = true
  const cold = await scanner.scanWithCache(directory, true, { audience: 'remote' })
  assert.strictEqual(cold.count, 49)
  assert.ok(cold.videos.every(video => scanner.getScanCanonicalPathKey(video)))
  assert.strictEqual((await scanner.scanWithCache(directory, false, { audience: 'remote' })).cached, true)
  scanner.directoryScanCache.clear()
  const indexed = await scanner.scanWithCache(directory, false, { audience: 'remote' })
  assert.strictEqual(indexed.indexed, true)
  await scanner.waitForBackgroundScanRefreshes()
  const page = await library.queryLibrary({ limit: 100 }, '')
  assert.strictEqual(page.count, 49)
  for (let index = 0; index < files.length; index++) {
    assert.deepStrictEqual(page.items.find(item => item.name === 'clip-' + index).customTags, ['Legacy-' + index])
  }
  await metadata.getCachedVideoMetadataForPath(path.join(alias, path.basename(files[0])))
  assert.strictEqual(syncCalls, 0, 'cold scan, cache hit, persisted index, metadata lookup and tagged snapshot use no synchronous realpath')
  countSync = false

  server = createRemoteServer({ port: 0 }); await new Promise(done => server.listen(0, '127.0.0.1', done))
  const baseUrl = 'http://127.0.0.1:' + server.address().port
  const phone = await claimDevice({ baseUrl, clientId: 'async-path-phone', ...identity })
  const headers = { Authorization: 'Bearer ' + phone.token }
  const query = () => requestJson(baseUrl + '/v1/library/query', { method: 'POST', headers, body: JSON.stringify({ limit: 100 }) })
  library.clearLibrarySnapshotCache()
  issued = 0; gateFilter = input => input.startsWith(alias + path.sep)
  const waiting = query(), shared = query()
  await until(() => active === 8)
  const controlStarted = performance.now()
  assert.strictEqual((await requestJson(baseUrl + '/v1/auth', { headers })).status, 200)
  const controlWhileBlockedMs = performance.now() - controlStarted
  assert.strictEqual(active, 8, 'the control request completes while library path IO is still held')
  await settings.saveSettingsAndFlush({ privateDirectories: [privateDir] })
  releaseGates()
  const replies = await Promise.all([waiting, shared])
  for (const reply of replies) {
    assert.strictEqual(reply.status, 200)
    assert.strictEqual(reply.data.count, 48)
    assert.ok(reply.data.items.every(item => item.name !== 'secret'))
    assert.deepStrictEqual(reply.data.items.find(item => item.name === 'clip-0').customTags, ['Legacy-0'])
  }

  library.clearLibrarySnapshotCache(); issued = 0
  gateFilter = input => input.startsWith(alias + path.sep)
  const tagRace = query(); await until(() => active === 8)
  await settings.saveSettingsAndFlush({ customTags: { ...tags, [path.join(alias, path.basename(files[0]))]: ['Latest'] } })
  releaseGates()
  const latest = await tagRace
  assert.strictEqual(latest.status, 200)
  assert.deepStrictEqual(latest.data.items.find(item => item.name === 'clip-0').customTags, ['Latest'])

  issued = 0; gateFilter = input => input === files[0]
  const changedScan = scanner.scanWithCache(directory, false, { audience: 'remote' }).catch(error => error)
  await until(() => active > 0)
  await settings.saveSettingsAndFlush({ privateDirectories: [directory] })
  releaseGates()
  assert.strictEqual((await changedScan).status, 404, 'a root made private during file IO is denied before publishing the cache')
  assert.strictEqual(scanner.directoryScanCache.has(paths.pathKey(directory)), false)

  const lateFile = path.join(fixture, 'delayed.mp4'); fs.writeFileSync(lateFile, header)
  issued = 0; gateFilter = input => input === lateFile
  const warming = metadata.warmVideoMetadataCache([lateFile]); await until(() => active === 1)
  const excessWarm = Array.from({ length: 1024 }, (_, index) => metadata.warmVideoMetadataCache([path.join(fixture, 'excess-' + index + '.mp4')]))
  const queued = metadata.getVideoMetadataDiagnostics()
  const warmAdmitted = queued.warmQueued + queued.warmPreparing + queued.warmCanonicalQueued + queued.warmActive
  assert.strictEqual(warmAdmitted, 512, 'raw paths, issued realpaths and canonical warm work share the existing finite budget')
  let stopped = false
  const stopping = metadata.disposeVideoMetadata().then(() => { stopped = true })
  await delay(15); assert.strictEqual(stopped, false, 'shutdown waits for already-issued warm preparation realpath')
  releaseGates(); await Promise.all([warming, stopping, ...excessWarm])
  assert.strictEqual(active, 0)
  const stoppedState = metadata.getVideoMetadataDiagnostics()
  assert.strictEqual(stoppedState.warmQueued + stoppedState.warmPreparing + stoppedState.warmCanonicalQueued + stoppedState.warmActive, 0)
  const afterStop = issued; await metadata.warmVideoMetadataCache([lateFile]); assert.strictEqual(issued, afterStop)

  const evidence = { date: new Date().toISOString(), files: 49, legacyAliases: 48, batchMaximum, warmAdmitted,
    syncRealpathCalls: syncCalls, controlWhileBlockedMs,
    conditions: 'Real 24-byte local MP4 headers, junction on Windows, production scanner/index/library/metadata and authenticated HTTP. Async realpath gates prove control progress, bounded batches, privacy/tag invalidation and shutdown ownership. Metadata background scheduler intentionally paused; no decoder performance claim.' }
  fs.writeFileSync(path.join(parent, 'library-path-resolution-evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
  console.log('library path resolution passed: zero synchronous realpath in cold/cache/index/tagged query, actual junction legacy tags, eight-call batch and join, control HTTP during blocked IO, stale privacy/tag rebuild, scan publication fence and metadata shutdown wait')
}

const deadline = setTimeout(() => { console.error('library path resolution verification timed out'); process.exit(1) }, 45000)
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  releaseGates(); countSync = false
  fsp.realpath = nativeRealpath; fs.realpathSync.native = nativeSync
  if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)) }
  await scanner?.waitForBackgroundScanRefreshes(); scanner?.unwatchAllDirectories()
  await metadata?.disposeVideoMetadata(); await settings?.flushSettingsWrites()
  process.chdir(root); assert.strictEqual(path.dirname(path.resolve(fixture)), parent)
  assert.ok(path.basename(fixture).startsWith('library-paths-')); await removeTempRootWithRetry(fixture)
  clearTimeout(deadline)
})
