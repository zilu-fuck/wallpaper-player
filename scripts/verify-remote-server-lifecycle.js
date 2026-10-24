const assert = require('assert'), fs = require('fs'), path = require('path'), http = require('http'), Module = require('module')
const { removeTempRootWithRetry } = require('./verify-helpers')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp', 'refactor-tests')
fs.mkdirSync(parent, { recursive: true })
const fixture = fs.mkdtempSync(path.join(parent, 'server-lifecycle-'))
const deadline = setTimeout(() => { console.error('remote server lifecycle verification timed out'); process.exit(1) }, 45000)
const listen = server => new Promise((done, reject) => { server.once('error', reject); server.listen(0, '0.0.0.0', done) })
async function main() {
  process.chdir(fixture)
  const reservation = http.createServer(), occupied = http.createServer()
  await listen(reservation); const port = reservation.address().port
  await new Promise(done => reservation.close(done)); await listen(occupied)
  const unavailablePort = occupied.address().port
  const created = [], control = { active: 0, maximum: 0, trays: 0, menu: [], clipboardErrors: 0 }
  let writeClipboard = async () => {}
  const realCreate = require('../main/remote/server').createRemoteServer
  const original = Module._load
  Module._load = function (request, parentModule, ...rest) {
    if (parentModule?.filename.endsWith(path.join('remote', 'index.js'))) {
      if (request === './server') return { createRemoteServer: options => {
        const server = realCreate(options); created.push(server)
        server.on('listening', () => { control.active++; control.maximum = Math.max(control.maximum, control.active) })
        server.on('close', () => { control.active-- })
        return server
      } }
      if (request === 'electron') return {
        Tray: class { constructor() { control.trays++ } setToolTip() {} on() {} setContextMenu() {} destroy() { control.trays-- } },
        Menu: { buildFromTemplate: value => { control.menu = value; return value } }, nativeImage: { createFromDataURL: () => ({ resize() { return this } }) },
        clipboard: { writeText: value => writeClipboard(value) }, app: { quit() {} }
      }
      if (request === 'electron-log') return { info() {}, error() { control.clipboardErrors++ } }
    }
    return original.call(this, request, parentModule, ...rest)
  }
  let remote
  try { remote = require('../main/remote/index') } finally { Module._load = original }
  const settings = require('../main/settings')
  settings.saveSettings({ remoteAccess: { enabled: true, port } })
  try {
    const first = await Promise.all([remote.startRemoteAccess(), remote.startRemoteAccess(), remote.startRemoteAccess()])
    assert.ok(first.every(state => state.running)); assert.strictEqual(created.length, 1)
    assert.strictEqual(created[0].requestTimeout, 15000); assert.strictEqual(created[0].headersTimeout, 30000)
    const copy = control.menu.find(item => item.label === '复制访问地址')
    assert.ok(copy?.enabled)
    let releaseClipboard, copied = false
    writeClipboard = value => { assert.strictEqual(value, remote.getRemoteState().endpoint); return new Promise(done => { releaseClipboard = done }) }
    const copying = copy.click().then(() => { copied = true })
    await new Promise(done => setImmediate(done)); assert.strictEqual(copied, false)
    releaseClipboard(); await copying; assert.strictEqual(copied, true)
    const errorsBefore = control.clipboardErrors
    writeClipboard = async () => { throw Error('fixture clipboard unavailable') }
    await copy.click()
    assert.strictEqual(control.clipboardErrors, errorsBefore + 1, 'tray handles asynchronous clipboard rejection')
    writeClipboard = async () => {}
    await Promise.all([remote.startRemoteAccess({ forceRestart: true }), remote.stopRemoteAccess(), remote.startRemoteAccess()])
    assert.strictEqual(control.active, 1); assert.strictEqual(control.maximum, 1)
    assert.strictEqual(remote.getRemoteState().running, true)
    const failed = await remote.applyRemoteSettings({ enabled: true, port: unavailablePort })
    assert.strictEqual(failed.running, false); assert.ok(failed.error); assert.strictEqual(settings.loadSettings().remoteAccess.enabled, false)
    const restored = await remote.applyRemoteSettings({ enabled: true, port })
    assert.strictEqual(restored.running, true, 'a bind failure must not poison the lifecycle queue')
    const zlib = require('zlib'), nativeGzip = zlib.gzip, { jsonResponses } = require('../main/remote/json-responses')
    let release, ready; const entered = new Promise(done => { ready = done })
    zlib.gzip = (...args) => { const callback = args.pop(); nativeGzip(...args, (error, output) => { release = () => { const current = release; release = null; if (current) callback(error, output) }; ready() }) }
    try {
      const client = http.get('http://127.0.0.1:' + port + '/v1/info', { headers: { 'Accept-Encoding': 'gzip,identity;q=0' } }); client.on('error', () => {})
      await entered; let finished = false
      const stopping = remote.stopRemoteAccess().then(() => { finished = true })
      await new Promise(done => setTimeout(done, 20)); assert.strictEqual(finished, false); assert.strictEqual(jsonResponses.diagnostics().compressing, 1)
      release(); await stopping; client.destroy(); assert.strictEqual(jsonResponses.diagnostics().active, 0)
    } finally { zlib.gzip = nativeGzip; release?.() }
    await remote.startRemoteAccess()
    const identity = require('../main/remote/identity'), pairing = identity.createPairingCode().payload
    const input = { pairingId: pairing.pairingId, oneTimeSecret: pairing.oneTimeSecret, clientId: 'shutdown-phone' }
    const pending = await identity.claimPairing(input); identity.approvePairingRequest(pending.pairingRequestId)
    const phone = await identity.claimPairing(input), nativeRename = fs.promises.rename
    const activityFile = path.join(path.dirname(identity.getIdentityPath()), 'remote-device-activity.json')
    const credentialsBeforeActivity = fs.readFileSync(identity.getIdentityPath(), 'utf8')
    let releaseIdentity, enteredIdentity
    const identityHeld = new Promise(done => { releaseIdentity = done }), identityStarted = new Promise(done => { enteredIdentity = done })
    fs.promises.rename = async function (from, to, ...args) {
      if (to === activityFile) { enteredIdentity(); await identityHeld }
      return nativeRename.call(this, from, to, ...args)
    }
    try {
      assert(identity.verifyAccessTokenWithType(phone.token, { remoteAddress: 'shutdown-address' }).authorized)
      await identityStarted; let identityStopped = false
      const stopIdentity = remote.stopRemoteAccess().then(() => { identityStopped = true })
      await new Promise(done => setTimeout(done, 10)); assert.strictEqual(identityStopped, false)
      releaseIdentity(); await stopIdentity
      assert.strictEqual(JSON.parse(fs.readFileSync(activityFile, 'utf8')).devices.find(device => device.id === 'shutdown-phone').lastAddress, 'shutdown-address')
      assert.strictEqual(fs.readFileSync(identity.getIdentityPath(), 'utf8'), credentialsBeforeActivity)
    } finally { fs.promises.rename = nativeRename; releaseIdentity() }
    await remote.startRemoteAccess()
    const restarting = remote.startRemoteAccess({ forceRestart: true })
    const quitting = remote.disposeRemoteAccess()
    await assert.rejects(restarting, error => error.code === 'app_quitting')
    await quitting
    assert.strictEqual(control.active, 0); assert.strictEqual(control.trays, 0)
    await assert.rejects(remote.startRemoteAccess(), error => error.code === 'app_quitting')
    assert.strictEqual(control.active, 0)
    console.log('remote server lifecycle passed: actual listeners, shared starts, queued restart/stop, one live server, port failure recovery, pending identity/compressor ownership, disposal and finite incoming-request timeouts')
  } finally {
    await remote.disposeRemoteAccess()
    await settings.flushSettingsWrites()
    for (const server of created) { server.closeAllConnections(); if (server.listening) await new Promise(done => server.close(done)) }
    await new Promise(done => occupied.close(done))
  }
}
main().finally(async () => { clearTimeout(deadline); process.chdir(root); assert.strictEqual(path.dirname(path.resolve(fixture)), parent); await removeTempRootWithRetry(fixture) })
  .catch(error => { console.error(error); process.exitCode = 1 })
