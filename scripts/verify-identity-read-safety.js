const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto'), http = require('node:http'), Module = require('node:module')
const { createRequire } = require('node:module')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
fs.mkdirSync(parent, { recursive: true })
const fixture = fs.mkdtempSync(path.join(parent, 'identity-read-safety-')), owners = [], cases = []
const timeout = setTimeout(() => { console.error('Identity read safety verification timed out'); process.exit(1) }, 60000)
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async check => { const end = Date.now() + 5000; while (!await check()) { if (Date.now() > end) throw Error('Identity safety condition timed out'); await wait(5) } }
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
let sequence = 0
function owner(sourceRoot = root) {
  let directory = path.join(fixture, 'case-' + (++sequence)), logs = []
  fs.mkdirSync(directory)
  const filename = path.join(root, 'main/remote/identity.js'), normal = createRequire(filename), module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(sourceRoot, 'main/remote/identity.js'), 'utf8'), {
    module, exports: module.exports, require: name => name === 'electron' ? {} : name === '../user-data' ? { getUserDataDir: () => directory }
      : name === 'electron-log' ? Object.fromEntries(['error', 'warn', 'info'].map(level => [level, (...args) => logs.push(args.map(String).join(' '))])) : normal(name),
    JSON, SyntaxError, Buffer, process, console, queueMicrotask, setTimeout, clearTimeout
  }, { filename })
  const value = { api: module.exports, directory, file: path.join(directory, 'remote-identity.json'), logs, move(next) { directory = next } }
  owners.push(value); return value
}
async function paired(api) {
  const payload = api.createPairingCode().payload, input = { pairingId: payload.pairingId, oneTimeSecret: payload.oneTimeSecret, clientId: 'phone-fixture' }
  const request = await api.claimPairing(input); api.approvePairingRequest(request.pairingRequestId); return api.claimPairing(input)
}
async function preservation() {
  const current = owner(), { api } = current
  await api.refreshIdentity(); const original = fs.readFileSync(current.file), identity = api.loadIdentity(), phone = await paired(api)
  const repaired = fs.readFileSync(current.file), scoped = api.createScopedToken('fixture', 'item', 60000), bound = api.createBoundScopedToken('fixture', 'item', phone.token, 60000)
  const pending = api.createPairingCode().payload, revision = api.getAuthorizationRevision(), corrupt = Buffer.from('RAW_SECRET_CREDENTIAL_TOKEN')
  fs.writeFileSync(current.file, corrupt)
  await assert.rejects(api.refreshIdentity(), { code: 'identity_corrupt', status: 503 })
  assert.deepEqual(fs.readFileSync(current.file), corrupt)
  assert.equal(api.getAuthorizationRevision(), revision + 1); assert.ok(api.getIdentityCorruptedAt())
  assert.throws(() => api.loadIdentity(), { code: 'identity_corrupt' }); assert.throws(() => api.getPublicIdentity(), { code: 'identity_corrupt' })
  assert.equal(api.verifyAccessToken(identity.accessToken), false); assert.equal(api.verifyAccessToken(phone.token), false)
  assert.equal(api.getAccessTokenHashAuthorization(api.hashToken(phone.token)).authorized, false)
  assert.equal(api.verifyScopedToken('fixture', 'item', scoped), false); assert.equal(api.verifyBoundScopedToken('fixture', 'item', bound), false)
  await assert.rejects(api.claimPairing({ pairingId: pending.pairingId, oneTimeSecret: pending.oneTimeSecret, clientId: 'late' }), { code: 'pairing_expired' })
  const notice = api.getIdentityReadError(); notice.message = 'outside mutation'
  await assert.rejects(api.refreshIdentity(), { code: 'identity_corrupt' }); assert.equal(api.getAuthorizationRevision(), revision + 1)
  assert.ok(!current.logs.join('\n').includes('RAW_SECRET')); assert.ok(!api.getIdentityReadError().message.includes('outside'))
  fs.writeFileSync(current.file, repaired); await api.refreshIdentity()
  assert.equal(api.getIdentityReadError(), null); assert.equal(api.getIdentityCorruptedAt(), 0)
  assert.equal(api.loadIdentity().machineSecret, identity.machineSecret); assert.equal(api.verifyAccessToken(phone.token), true)
  assert.equal(api.getAuthorizationRevision(), revision + 2)
  cases.push('corrupt bytes are retained, cached bearer/scoped credentials and pairing fail closed once, parser fragments stay private and explicit valid repair restores the same identity')

  const baseline = path.join(parent, 'r8-identity-read-safety/baseline')
  let before = null
  if (fs.existsSync(path.join(baseline, 'main/remote/identity.js'))) {
    const old = owner(baseline); await old.api.refreshIdentity(); const previous = old.api.loadIdentity()
    fs.writeFileSync(old.file, corrupt); await old.api.refreshIdentity()
    before = { damagedBytesOverwritten: !fs.readFileSync(old.file).equals(corrupt), identityReplaced: old.api.loadIdentity().machineSecret !== previous.machineSecret,
      parserFragmentLogged: old.logs.join('\n').includes('RAW_SECRET') }
    assert.equal(before.damagedBytesOverwritten, true); assert.equal(before.identityReplaced, true)
  }
  return { before, after: { damagedBytesOverwritten: false, identityReplaced: false, parserFragmentLogged: false }, initialBytes: original.length }
}
async function documentsAndMissing() {
  const template = owner(); await template.api.refreshIdentity(); const valid = template.api.loadIdentity()
  const malformed = ['null', '[]', '0', '"text"', '{}', JSON.stringify({ ...valid, machineSecret: '' }), JSON.stringify({ ...valid, accessToken: null }),
    JSON.stringify({ ...valid, pairedDevices: [{}] }), JSON.stringify({ ...valid, schemaVersion: -1 }), JSON.stringify({ ...valid, schemaVersion: '1' }),
    JSON.stringify({ ...valid, pairedDevices: [{ id: 'same', tokenHash: 'one' }, { id: 'same', tokenHash: 'two' }] })]
  for (const raw of malformed) {
    const item = owner(); fs.writeFileSync(item.file, raw)
    await assert.rejects(item.api.refreshIdentity(), { code: 'identity_corrupt' }); assert.equal(fs.readFileSync(item.file, 'utf8'), raw)
    assert.throws(() => item.api.refreshIdentitySync(), { code: 'identity_corrupt' })
  }
  const future = owner(), bytes = JSON.stringify({ ...valid, schemaVersion: 2, futureCredentialState: { untouched: true } })
  fs.writeFileSync(future.file, bytes); await assert.rejects(future.api.refreshIdentity(), { code: 'identity_unsupported_version' }); assert.equal(fs.readFileSync(future.file, 'utf8'), bytes)
  const bom = owner(), good = { ...valid, schemaVersion: 1, privateExtension: { keep: ['fixture'] } }, bomBytes = Buffer.from('\uFEFF' + JSON.stringify(good))
  fs.writeFileSync(bom.file, bomBytes); await bom.api.refreshIdentity(); assert.deepEqual(fs.readFileSync(bom.file), bomBytes)
  assert.equal(bom.api.loadIdentity().machineSecret, valid.machineSecret); assert.equal(bom.api.loadIdentity().privateExtension.keep[0], 'fixture')
  cases.push('invalid root/credential/peer/version shapes and future documents are not normalized into new identities; valid BOM/known-version documents retain credentials and unknown fields without rewriting')

  fs.unlinkSync(template.file)
  await assert.rejects(template.api.refreshIdentity(), { code: 'identity_missing' }); assert.equal(fs.existsSync(template.file), false)
  assert.throws(() => template.api.refreshIdentitySync(), { code: 'identity_missing' })
  fs.writeFileSync(template.file, JSON.stringify(valid)); template.api.refreshIdentitySync(); assert.equal(template.api.loadIdentity().deviceId, valid.deviceId)
  const other = owner(); template.move(other.directory); await template.api.refreshIdentity(); assert.notEqual(template.api.loadIdentity().deviceId, valid.deviceId)
  cases.push('a missing warm identity is not silently recreated, explicit sync repair works and independent fresh/profile owners still initialize normally')
}
async function readAndWriteErrors() {
  const item = owner(), { api } = item; await api.refreshIdentity()
  const before = fs.readFileSync(item.file), token = api.loadIdentity().accessToken, read = fs.promises.readFile, rename = fs.promises.rename
  try {
    fs.promises.readFile = async function (file, ...args) { if (file === item.file) throw Object.assign(Error('RAW_SECRET_PATH_FRAGMENT'), { code: 'EACCES' }); return read.call(this, file, ...args) }
    await assert.rejects(api.refreshIdentity(), { code: 'EACCES', status: 503 }); assert.equal(api.verifyAccessToken(token), false)
    assert.ok(!api.getIdentityReadError().message.includes('RAW_SECRET')); assert.deepEqual(fs.readFileSync(item.file), before)
  } finally { fs.promises.readFile = read }
  await api.refreshIdentity(); assert.equal(api.verifyAccessToken(token), true)
  const revision = api.getAuthorizationRevision()
  try {
    fs.promises.rename = async function (from, to, ...args) { if (to === item.file) throw Object.assign(Error('RAW_SECRET_WRITE_PATH'), { code: 'EACCES' }); return rename.call(this, from, to, ...args) }
    await assert.rejects(api.rotateAccessToken(), error => error.code === 'EACCES' && !error.message.includes('RAW_SECRET'))
    assert.equal(api.getAuthorizationRevision(), revision); assert.equal(api.verifyAccessToken(token), true); assert.deepEqual(fs.readFileSync(item.file), before)
  } finally { fs.promises.rename = rename }
  const rotated = await api.rotateAccessToken(); assert.equal(api.verifyAccessToken(token), false); assert.equal(api.verifyAccessToken(rotated.accessToken), true)
  cases.push('read permission errors invalidate cached authorization without overwriting bytes; failed writes preserve the last committed authorization and retry without leaking raw error details')
}
async function suspendedTouches() {
  const item = owner(), { api } = item; await api.refreshIdentity(); const phone = await paired(api)
  const read = fs.promises.readFile; let reads = 0
  try {
    fs.promises.readFile = async function (file, ...args) {
      if (file === item.file) { reads++; throw Object.assign(Error('expected touch read failure'), { code: 'EIO' }) }
      return read.call(this, file, ...args)
    }
    assert.equal(api.verifyAccessTokenWithType(phone.token, { remoteAddress: 'changed-fixture-address' }).authorized, true)
    await until(() => Boolean(api.getIdentityReadError())); await api.flushIdentityWrites(); await wait(30)
    assert.equal(reads, 1, 'failed last-seen reads must suspend instead of immediately requeueing forever')
  } finally { fs.promises.readFile = read }
  await api.refreshIdentity(); await api.flushIdentityWrites(); assert.ok(api.listPairedDevices()[0].lastSeenAt > 0)
  cases.push('last-seen work suspends after a failed identity read, does not spin/requeue or prevent shutdown, and flushes its owned telemetry after explicit repair')
}
async function nativeUi() {
  const directory = path.join(fixture, 'native-中文 空格'); fs.mkdirSync(directory)
  const reservation = http.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve)); const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve))
  const env = { ...process.env, WALLPAPER_IDENTITY_READ_FIXTURE: directory, WALLPAPER_IDENTITY_READ_PORT: String(port) }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawnSync(require('electron'), [path.join(__dirname, 'verify-identity-read-electron.js')], { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 35000, maxBuffer: 1024 * 1024 })
  fs.writeFileSync(path.join(directory, 'process-output.json'), JSON.stringify({ status: child.status, error: child.error?.message, stdout: child.stdout, stderr: child.stderr }, null, 2))
  assert.ifError(child.error); assert.equal(child.status, 0, child.stderr)
  const result = JSON.parse(fs.readFileSync(path.join(directory, 'result.json'), 'utf8')); assert.equal(result.passed, true, JSON.stringify(result))
  cases.push('actual Electron complete main/IPC/frontend displays preserved identity failure, keeps retry available, blocks credential mutations and restarts valid repaired identity/QR flow without always-on-top')
  return result
}
async function liveHttp() {
  const cwd = process.cwd(), live = path.join(fixture, 'live'); fs.mkdirSync(live); process.chdir(live)
  const loader = Module._load, events = []
  Module._load = function (name, parentModule, ...args) {
    if (name === 'electron-log') return Object.fromEntries(['error', 'warn', 'info', 'debug'].map(level => [level, (...values) => events.push(values.map(String).join(' '))]))
    if (name === 'electron' && parentModule?.filename.endsWith(path.join('remote', 'index.js'))) return {
      Tray: class { setToolTip() {} on() {} setContextMenu() {} destroy() {} }, Menu: { buildFromTemplate: value => value },
      nativeImage: { createFromDataURL: () => ({ resize() { return this } }) }, clipboard: {}, app: {}
    }
    if (name === '../window' && parentModule?.filename.endsWith(path.join('remote', 'index.js'))) return { getMainWindow: () => null }
    return loader.call(this, name, parentModule, ...args)
  }
  let remote, identity, settings, standalone, stream
  try {
    identity = require('../main/remote/identity'); settings = require('../main/settings'); remote = require('../main/remote/index')
  } finally { Module._load = loader }
  try {
    const library = path.join(live, 'media'); fs.mkdirSync(library); const media = path.join(library, 'opaque.mp4'); fs.writeFileSync(media, Buffer.alloc(32 * 1024 * 1024))
    const reservation = http.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve)); const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve))
    await settings.saveSettingsAndFlush({ directories: [library], remoteAccess: { enabled: true, port, keepRunningInTray: false, allowLegacyToken: true } })
    await remote.startRemoteAccess(); const original = fs.readFileSync(identity.getIdentityPath()), token = identity.loadIdentity().accessToken
    const index = require('../main/remote/video-index'); index.rememberVideos([{ fullPath: media, fileName: 'opaque.mp4' }]); const id = index.getVideoId(media)
    stream = await new Promise((resolve, reject) => { const req = http.get({ host: '127.0.0.1', port, path: '/v1/videos/' + id + '/stream', headers: { Authorization: 'Bearer ' + token } }, response => { response.pause(); response.on('error', () => {}); resolve({ request: req, response }) }); req.on('error', reject) })
    assert.equal(stream.response.statusCode, 200)
    const streaming = require('../main/remote/streaming'); await until(() => streaming.getStreamDiagnostics().active > 0)
    fs.writeFileSync(identity.getIdentityPath(), 'RAW_SECRET_BROKEN_IDENTITY')
    await assert.rejects(identity.refreshIdentity(), { code: 'identity_corrupt' })
    await until(() => !remote.getRemoteState().running && streaming.getStreamDiagnostics().active === 0)
    const state = remote.getRemoteState(); assert.equal(state.accessToken, ''); assert.equal(state.endpoint, ''); assert.equal(state.pairedDevices.length, 0)
    assert.equal(remote.shouldKeepRunningInTray(), false); assert.equal(fs.readFileSync(identity.getIdentityPath(), 'utf8'), 'RAW_SECRET_BROKEN_IDENTITY')
    await assert.rejects(remote.startRemoteAccess(), { code: 'identity_corrupt' })
    standalone = require('../main/remote/server').createRemoteServer({ port: 0 }); await new Promise(resolve => standalone.listen(0, '127.0.0.1', resolve))
    const endpoint = 'http://127.0.0.1:' + standalone.address().port
    const phone = require('./mobile-module-harness').phone(), deviceStore = phone.load('mobile/src/persistence/devices.ts')
    const device = await deviceStore.saveDevice({ id: 'desktop-fixture', name: 'fixture', endpoint, token })
    const storageBefore = JSON.stringify([...phone.async.values, ...phone.secure.values])
    await assert.rejects(phone.load('mobile/src/services/api.ts').getLibrary(device), error => error.status === 503 && error.code === 'identity_corrupt')
    assert.equal(JSON.stringify([...phone.async.values, ...phone.secure.values]), storageBefore)
    fs.writeFileSync(identity.getIdentityPath(), original); await identity.refreshIdentity(); await remote.startRemoteAccess()
    assert.equal(remote.getRemoteState().running, true); assert.equal(identity.verifyAccessToken(token), true)
    assert.equal((await deviceStore.loadDevices())[0].bindingId, device.bindingId)
    assert.ok(!events.join('\n').includes('RAW_SECRET'))
    cases.push('actual HTTP identity failure closes a paused file stream/listener, emits a redacted desktop state and returns retryable 503 to the production mobile API without deleting its stored binding; valid repair restarts with the same token')
    return { originalStreamStatus: 200, activeStreamsAfterFailure: 0, mobileFailureStatus: 503, mobileBindingPreserved: true, recoveredIdentityMatches: true }
  } finally {
    stream?.request.destroy(); stream?.response.destroy()
    if (standalone) await new Promise(resolve => { standalone.close(resolve); standalone.closeAllConnections?.() })
    await remote?.disposeRemoteAccess(); await settings?.flushSettingsWrites(); await settings?.disposeSettingsSerialization({ cancel: true }); await identity?.flushIdentityWrites()
    process.chdir(cwd)
  }
}
async function main() {
  const comparison = await preservation(); await documentsAndMissing(); await readAndWriteErrors(); await suspendedTouches(); const http = await liveHttp(); const native = await nativeUi()
  const files = ['main/repositories/identity-document.js', 'main/remote/identity.js', 'main/remote/index.js', 'main/ipc/remote.js', 'src/components/settings/RemoteAccessSection.jsx', 'scripts/verify-identity-read-safety.js', 'scripts/verify-identity-read-electron.js']
  const result = { date: new Date().toISOString(), passed: true, fixture, cases, comparison, http, native,
    sourceDigests: Object.fromEntries(files.map(file => [file, hash(fs.readFileSync(path.join(root, file)))])),
    scope: 'Actual identity code in isolated VM owners and real files; captured old module is an optional positive control. Real loopback server/file-stream shutdown, production mobile API and secure/index storage doubles. Complete source main/preload/IPC/frontend in Electron using an isolated Chinese/space profile, with native rendering/QR and explicit repair; hardware acceleration disabled, no always-on-top. No physical phone, backup restore or cross-file crash-recovery acceptance.' }
  fs.writeFileSync(path.join(fixture, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result))
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => { for (const item of owners) await item.api.flushIdentityWrites(); clearTimeout(timeout) })
