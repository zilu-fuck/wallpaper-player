const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto')
const { createRequire } = require('node:module')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
fs.mkdirSync(parent, { recursive: true })
const fixture = fs.mkdtempSync(path.join(parent, 'identity-write-ownership-')), currentFile = path.join(root, 'main/remote/identity.js')
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const deadline = setTimeout(() => { console.error('Identity write ownership timed out'); process.exit(1) }, 15000)
let sequence = 0
function owner(source = currentFile, directory = path.join(fixture, 'case-' + (++sequence))) {
  fs.mkdirSync(directory, { recursive: true })
  const normal = createRequire(currentFile), module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), { module, exports: module.exports,
    require: name => name === 'electron' ? {} : name === '../user-data' ? { getUserDataDir: () => directory }
      : name === 'electron-log' ? { warn() {}, error() {} } : normal(name), JSON, Buffer, process, console, queueMicrotask, setTimeout, clearTimeout }, { filename: currentFile })
  return { api: module.exports, file: path.join(directory, 'remote-identity.json'), activity: path.join(directory, 'remote-device-activity.json'), directory }
}
async function paired(api) {
  await api.refreshIdentity(); const payload = api.createPairingCode().payload
  const input = { pairingId: payload.pairingId, oneTimeSecret: payload.oneTimeSecret, clientId: 'write-owner-phone' }
  const pending = await api.claimPairing(input); api.approvePairingRequest(pending.pairingRequestId)
  return api.claimPairing(input)
}
async function duringStagedWrite(store, operation, edit, atRename = false) {
  const original = fs.promises.writeFile, originalRename = fs.promises.rename, ready = deferred(), gate = deferred(); let held = false, task
  fs.promises.rename = async function (from, to, ...args) {
    if (atRename && !held && [store.file, store.activity].includes(to)) { held = true; ready.resolve(); await gate.promise }
    return originalRename.call(this, from, to, ...args)
  }
  fs.promises.writeFile = async function (file, ...args) {
    const result = await original.call(this, file, ...args)
    if (!atRename && !held && typeof file === 'string' && file.startsWith(store.file + '.') && file.endsWith('.tmp')) {
      held = true; ready.resolve(); await gate.promise
    }
    return result
  }
  try {
    task = Promise.resolve().then(operation).then(value => ({ value }), error => ({ error }))
    await ready.promise; await edit(original); gate.resolve()
    const result = await task; await store.api.flushIdentityWrites(); return result
  } finally { gate.resolve(); await task; await store.api.flushIdentityWrites(); fs.promises.writeFile = original; fs.promises.rename = originalRename }
}
async function telemetry(source) {
  const store = owner(source), phone = await paired(store.api); let foreign
  await duringStagedWrite(store, () => store.api.verifyAccessTokenWithType(phone.token, { remoteAddress: 'changed-address' }), async write => {
    const edited = JSON.parse(await fs.promises.readFile(store.file, 'utf8'))
    edited.pairedDevices[0].revokedAt = Date.now(); edited.foreignField = { keep: true }; foreign = JSON.stringify(edited)
    await write(store.file, foreign)
  }, true)
  await store.api.refreshIdentity()
  const actual = await fs.promises.readFile(store.file, 'utf8')
  return { bytesRetained: actual === foreign, revoked: !store.api.verifyAccessToken(phone.token), authorizationRevision: store.api.getAuthorizationRevision() }
}
async function main() {
  const baseline = process.env.WALLPAPER_IDENTITY_WRITE_BASELINE
  let comparison
  if (baseline) {
    const before = await telemetry(path.resolve(baseline)); assert.equal(before.bytesRetained, false); assert.equal(before.revoked, false)
    comparison = { before }
  }
  const current = await telemetry(); assert.equal(current.bytesRetained, true); assert.equal(current.revoked, true)
  if (comparison) comparison.after = current
  const store = owner(), phone = await paired(store.api); let foreign
  const attempted = await duringStagedWrite(store, () => store.api.rotateAccessToken(), async write => {
    const edited = JSON.parse(await fs.promises.readFile(store.file, 'utf8')); edited.schemaVersion = 999
    foreign = JSON.stringify(edited); await write(store.file, foreign)
  })
  assert.equal(attempted.error?.code, 'identity_unsupported_version'); assert.equal(attempted.error.status, 503)
  assert.equal(await fs.promises.readFile(store.file, 'utf8'), foreign); assert.equal(store.api.verifyAccessToken(phone.token), false)
  const valid = owner(), bound = await paired(valid.api)
  const [first, second] = await Promise.all([valid.api.rotateAccessToken(), valid.api.rotateAccessToken()])
  assert.notEqual(first.accessToken, second.accessToken); assert.equal(valid.api.loadIdentity().accessToken, second.accessToken)
  assert.equal(valid.api.verifyAccessToken(bound.token), true); await valid.api.flushIdentityWrites()
  const originalCredentials = await fs.promises.readFile(valid.file, 'utf8')
  valid.api.verifyAccessTokenWithType(bound.token, { remoteAddress: 'persisted-activity' }); await valid.api.flushIdentityWrites()
  assert.equal(await fs.promises.readFile(valid.file, 'utf8'), originalCredentials, 'activity writes must leave credential bytes untouched')
  const cold = owner(currentFile, valid.directory); await cold.api.refreshIdentity()
  assert.equal(cold.api.listPairedDevices()[0].lastAddress, 'persisted-activity')
  const activity = await fs.promises.readFile(valid.activity, 'utf8')
  assert.ok(!activity.includes(bound.token)); assert.ok(!activity.includes(valid.api.loadIdentity().machineSecret))
  await fs.promises.writeFile(valid.activity, 'invalid-optional-activity')
  const damaged = owner(currentFile, valid.directory); await damaged.api.refreshIdentity()
  assert.equal(damaged.api.verifyAccessToken(bound.token), true)
  damaged.api.verifyAccessTokenWithType(bound.token, { remoteAddress: 'unavailable-activity' }); await damaged.api.flushIdentityWrites()
  assert.equal(await fs.promises.readFile(valid.activity, 'utf8'), 'invalid-optional-activity')
  assert.equal(await fs.promises.readFile(valid.file, 'utf8'), originalCredentials)
  const result = { passed: true, fixture, comparison, cases: ['telemetry cannot replace a newer observed external revocation or unknown field',
    'a stale authoritative write rejects an externally replaced future-version file and invalidates cached authorization', 'ordinary queued credential mutations remain durable and preserve paired credentials',
    'activity survives a cold owner without storing plain credentials, and invalid optional metadata is retained without blocking authorization'],
    sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(currentFile)).digest('hex'),
    scope: 'Actual identity code with owned real files; telemetry pauses immediately before rename to prove it cannot overwrite the separate credential document. Credential writes retain a pre-commit content check, which is not a filesystem compare-and-swap or a cross-process lock.' }
  fs.writeFileSync(path.join(fixture, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result))
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => clearTimeout(deadline))
