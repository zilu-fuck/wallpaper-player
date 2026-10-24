const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const crypto = require('node:crypto')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
fs.mkdirSync(parent, { recursive: true })
const fixture = fs.mkdtempSync(path.join(parent, 'identity-lifecycle-'))
let profile = path.join(fixture, 'profile')
const userData = require('../main/user-data'), originalUserData = userData.getUserDataDir
userData.getUserDataDir = () => profile
const identity = require('../main/remote/identity')
const originals = { readFile: fs.promises.readFile, rename: fs.promises.rename }
const passed = [], deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const file = () => path.join(profile, 'remote-identity.json')
const activityFile = () => path.join(profile, 'remote-device-activity.json')
const readDisk = async () => JSON.parse(await originals.readFile.call(fs.promises, file(), 'utf8'))
const readActivity = async () => JSON.parse(await originals.readFile.call(fs.promises, activityFile(), 'utf8'))
const deadline = setTimeout(() => { console.error('identity lifecycle timed out'); process.exit(1) }, 45000)
function holdRename(fail = false, target = file()) {
  const started = deferred(), gate = deferred()
  fs.promises.rename = async function (from, to, ...args) {
    if (to !== target) return originals.rename.call(this, from, to, ...args)
    started.resolve(); await gate.promise
    fs.promises.rename = originals.rename
    if (fail) throw Object.assign(Error('controlled rename denied'), { code: 'EACCES' })
    return originals.rename.call(this, from, to, ...args)
  }
  return { started: started.promise, release: gate.resolve }
}
async function approved(clientId) {
  const payload = identity.createPairingCode().payload
  const input = { pairingId: payload.pairingId, oneTimeSecret: payload.oneTimeSecret, clientId }
  const pending = await identity.claimPairing(input)
  identity.approvePairingRequest(pending.pairingRequestId)
  return input
}
async function main() {
  let syncReads = 0
  const originalReadSync = fs.readFileSync
  fs.readFileSync = function (name, ...args) { if (name === file()) syncReads++; return originalReadSync.call(this, name, ...args) }
  try { await identity.refreshIdentity(); identity.getPublicIdentity(); identity.loadIdentity(); assert.equal(syncReads, 0) }
  finally { fs.readFileSync = originalReadSync }
  passed.push('asynchronous cold initialization and detached snapshots')
  const leaked = identity.loadIdentity(), token = leaked.accessToken
  leaked.accessToken = 'mutated'; leaked.pairedDevices.push({ id: 'injected' })
  assert(identity.verifyAccessToken(token)); assert.equal(identity.listPairedDevices().length, 0)

  const a = await approved('phone-a'), b = await approved('phone-b')
  const [phoneA, phoneB] = await Promise.all([identity.claimPairing(a), identity.claimPairing(b)])
  assert.deepEqual(identity.listPairedDevices().map(x => x.id).sort(), ['phone-a', 'phone-b'])
  assert.equal((await readDisk()).pairedDevices.length, 2)
  passed.push('concurrent approved claims preserve both durable pairings')

  const duplicate = await approved('duplicate'), barrier = holdRename()
  const first = identity.claimPairing(duplicate), repeated = identity.claimPairing(duplicate)
  await barrier.started
  assert.throws(() => identity.refreshIdentitySync(), { status: 503, code: 'identity_busy' })
  passed.push('legacy synchronous bridge fails busy while queued identity IO owns the file')
  await assert.rejects(identity.claimPairing({ ...duplicate, clientId: 'intruder' }), { code: 'pairing_in_progress' })
  assert(!identity.listPairedDevices().some(x => x.id === 'duplicate'))
  assert(!(await readDisk()).pairedDevices.some(x => x.id === 'duplicate'))
  let heartbeat = false; await new Promise(resolve => setTimeout(() => { heartbeat = true; resolve() }, 5)); assert(heartbeat)
  barrier.release(); assert.equal((await first).token, (await repeated).token)
  passed.push('one durable token for duplicate claims and no publication before rename')

  const retry = await approved('retry'), failing = holdRename(true), before = identity.getAuthorizationRevision()
  const failed = assert.rejects(identity.claimPairing(retry), { code: 'EACCES' })
  await failing.started; failing.release(); await failed
  assert.equal(identity.getAuthorizationRevision(), before)
  assert(!identity.listPairedDevices().some(x => x.id === 'retry'))
  assert(!(await readDisk()).pairedDevices.some(x => x.id === 'retry'))
  const retried = await identity.claimPairing(retry); assert(identity.verifyAccessToken(retried.token))
  passed.push('atomic write failure preserves cache/disk/approval and permits retry')

  const oldBound = identity.createBoundScopedToken('thumbnail', 'video-a', phoneA.token, 60000)
  const revoking = holdRename(), removed = identity.revokePairedDevice('phone-a')
  await revoking.started; assert(identity.verifyAccessToken(phoneA.token)); assert(identity.verifyBoundScopedToken('thumbnail', 'video-a', oldBound))
  revoking.release(); assert.equal(await removed, true)
  assert(!identity.verifyAccessToken(phoneA.token)); assert(!identity.verifyBoundScopedToken('thumbnail', 'video-a', oldBound))
  assert(!(await readDisk()).pairedDevices.some(x => x.id === 'phone-a'))
  passed.push('durable revocation invalidates bearer and signed resources immediately after commit')

  const rebind = await approved('phone-b'), rebindGate = holdRename(), rebinding = identity.claimPairing(rebind)
  await rebindGate.started
  assert(identity.verifyAccessTokenWithType(phoneB.token, { remoteAddress: 'old-binding-address' }).authorized)
  rebindGate.release(); const rebound = await rebinding; await identity.flushIdentityWrites()
  assert(!identity.verifyAccessToken(phoneB.token)); assert(identity.verifyAccessToken(rebound.token))
  assert.equal((await readDisk()).pairedDevices.find(x => x.id === 'phone-b').lastAddress, '')
  passed.push('late last-seen update cannot overwrite a rebound device')

  let writes = 0; const renameBeforeCount = fs.promises.rename, credentialsBeforeActivity = await originals.readFile(file(), 'utf8')
  fs.promises.rename = async function (...args) { if (args[1] === activityFile()) writes++; return renameBeforeCount.apply(this, args) }
  for (let i = 0; i < 25; i++) assert(identity.verifyAccessTokenWithType(rebound.token, { remoteAddress: 'new-address' }).authorized)
  await identity.flushIdentityWrites(); fs.promises.rename = renameBeforeCount
  assert.equal(writes, 1); assert.equal((await readActivity()).devices.find(x => x.id === 'phone-b').lastAddress, 'new-address')
  assert.equal(await originals.readFile(file(), 'utf8'), credentialsBeforeActivity)
  passed.push('last-seen writes coalesce and flush owns actual completion')

  const telemetryFailure = holdRename(true, activityFile())
  assert(identity.verifyAccessTokenWithType(rebound.token, { remoteAddress: 'retry-address' }).authorized)
  await telemetryFailure.started; telemetryFailure.release(); await identity.flushIdentityWrites()
  assert.equal((await readActivity()).devices.find(x => x.id === 'phone-b').lastAddress, 'new-address')
  assert(identity.verifyAccessTokenWithType(rebound.token, { remoteAddress: 'retry-address' }).authorized)
  await identity.flushIdentityWrites()
  assert.equal((await readActivity()).devices.find(x => x.id === 'phone-b').lastAddress, 'retry-address')
  passed.push('failed last-seen write is nonfatal and retries without publishing failed state')

  const started = deferred(), gate = deferred(); let reads = 0
  fs.promises.readFile = async function (name, ...args) {
    if (name !== file()) return originals.readFile.call(this, name, ...args)
    reads++; const raw = await originals.readFile.call(this, name, ...args)
    if (reads === 1) { started.resolve(); await gate.promise }
    return raw
  }
  const earlier = identity.refreshIdentity(); await started.promise
  const edited = await readDisk(); edited.pairedDevices.find(x => x.id === 'phone-b').revokedAt = Date.now()
  await fs.promises.writeFile(file(), JSON.stringify(edited))
  const later = Array.from({ length: 30 }, () => identity.refreshIdentity())
  assert(later.every(x => x === later[0])); assert.notEqual(earlier, later[0])
  gate.resolve(); await Promise.all([earlier, ...later]); fs.promises.readFile = originals.readFile
  assert.equal(reads, 2); assert(!identity.verifyAccessToken(rebound.token))
  passed.push('only unstarted refreshes coalesce; later external revocation is reread')

  const previous = identity.loadIdentity(), revision = identity.getAuthorizationRevision()
  fs.promises.readFile = async function (name, ...args) {
    if (name === file()) throw Object.assign(Error('controlled unreadable identity'), { code: 'EACCES' })
    return originals.readFile.call(this, name, ...args)
  }
  await assert.rejects(identity.refreshIdentity(), { code: 'EACCES' })
  fs.promises.readFile = originals.readFile
  assert.equal(identity.getAuthorizationRevision(), revision + 1)
  assert.throws(() => identity.loadIdentity(), { code: 'EACCES' }); assert.equal(identity.verifyAccessToken(previous.accessToken), false)
  await identity.refreshIdentity(); assert.deepEqual(identity.loadIdentity(), previous)
  passed.push('unreadable identity preserves disk, invalidates cached authorization and recovers only after a successful explicit refresh')

  const legacyBound = identity.createBoundScopedToken('thumbnail', 'legacy', token, 60000)
  const rotated = await identity.rotateAccessToken()
  assert(!identity.verifyAccessToken(token)); assert(identity.verifyAccessToken(rotated.accessToken))
  assert(!identity.verifyBoundScopedToken('thumbnail', 'legacy', legacyBound, { allowLegacyToken: true }))
  assert(identity.verifyAccessToken(retried.token)); assert.equal((await readDisk()).accessToken, rotated.accessToken)
  passed.push('durable legacy rotation invalidates its resources and preserves paired devices')

  const pending = await approved('old-identity')
  const beforeCorrupt = await originals.readFile.call(fs.promises, file())
  await fs.promises.writeFile(file(), '{corrupted')
  await assert.rejects(identity.refreshIdentity(), { code: 'identity_corrupt', status: 503 })
  assert(identity.getIdentityCorruptedAt()); assert(!identity.verifyAccessToken(token))
  assert.equal(await originals.readFile.call(fs.promises, file(), 'utf8'), '{corrupted')
  assert.throws(() => identity.loadIdentity(), { code: 'identity_corrupt' })
  await assert.rejects(identity.claimPairing(pending), { code: 'pairing_expired' })
  await fs.promises.writeFile(file(), beforeCorrupt); await identity.refreshIdentity()
  assert.equal(identity.loadIdentity().machineSecret, previous.machineSecret)
  passed.push('corrupt identity is retained without replacement, old credentials/pairing fail closed and repaired bytes preserve the original computer identity')

  const crossProfilePairing = await approved('cross-profile')
  const firstProfile = profile, firstIdentity = identity.loadIdentity()
  profile = path.join(fixture, 'other-profile'); await identity.refreshIdentity()
  const other = identity.loadIdentity(); assert.notEqual(firstIdentity.deviceId, other.deviceId)
  await assert.rejects(identity.claimPairing(crossProfilePairing), { code: 'pairing_expired' })
  profile = firstProfile; await identity.refreshIdentity(); assert.equal(identity.loadIdentity().deviceId, firstIdentity.deviceId)
  passed.push('profile ownership prevents credentials crossing user-data paths')

  const { createJsonResponseService } = require('../main/remote/json-responses')
  const service = createJsonResponseService(), owner = {}, refresh = deferred(), entered = deferred()
  const req = Object.assign(new EventEmitter(), { method: 'GET', headers: {}, remoteServer: owner,
    refreshJsonResponseAuthorization: async () => { entered.resolve(); await refresh.promise } })
  const res = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false, headersSent: false,
    writeHead() { this.headersSent = true }, end() { this.writableEnded = true; this.writableFinished = true; this.emit('finish') },
    destroy() { this.destroyed = true; this.emit('close') } })
  const reply = service.send(req, res, 200, () => '{}'); await entered.promise
  service.close(owner); let stopped = false; const closed = service.wait(owner).then(() => { stopped = true })
  await new Promise(resolve => setImmediate(resolve)); assert(!stopped); assert.equal(service.diagnostics(owner).active, 1)
  refresh.resolve(); await Promise.all([reply, closed]); assert(!res.headersSent); assert.equal(service.diagnostics(owner).active, 0)
  passed.push('response teardown retains its lease until asynchronous authorization settles')

  const evidence = { date: new Date().toISOString(), fixture: path.relative(root, fixture), passed,
    sourceDigests: Object.fromEntries(['main/remote/identity.js', 'main/remote/json-responses.js'].map(name =>
      [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex')])),
    conditions: 'Production identity repository, real atomic files, controlled async read/rename failure/delay, production JSON response ownership. No device, media decoding or crash recovery acceptance claim.' }
  fs.writeFileSync(path.join(parent, 'identity-lifecycle.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence))
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  clearTimeout(deadline); fs.promises.readFile = originals.readFile; fs.promises.rename = originals.rename
  await identity.flushIdentityWrites(); userData.getUserDataDir = originalUserData
})
