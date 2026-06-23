const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const projectRoot = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wallpaper-player-multi-device-'))
const libraryA = path.join(tempRoot, 'library-a')
const libraryB = path.join(tempRoot, 'library-b')

function clearProjectModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(path.join(projectRoot, 'main'))) {
      delete require.cache[key]
    }
  }
}

function decodePairingPayload(pairingCode) {
  const data = new URL(pairingCode).searchParams.get('data')
  assert.ok(data, 'pairing code should include encoded payload')
  return JSON.parse(Buffer.from(data, 'base64url').toString('utf8'))
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body == null ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers || {})
    }
  })
  const text = await response.text()
  return {
    status: response.status,
    data: text ? JSON.parse(text) : null
  }
}

function createFixture(dir, fileName) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, fileName), Buffer.alloc(2048, 7))
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function removeTempRoot() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true })
      return
    } catch (error) {
      if (error?.code !== 'EBUSY' && error?.code !== 'ENOTEMPTY' && error?.code !== 'EPERM') throw error
      sleepSync(100)
    }
  }
  fs.rmSync(tempRoot, { recursive: true, force: true })
}

async function startDesktop(name, userDataDir, libraryDir) {
  clearProjectModules()
  process.chdir(userDataDir)
  const { saveSettings, sessionAllowedDirectories } = require(path.join(projectRoot, 'main', 'settings'))
  const { unwatchAllDirectories } = require(path.join(projectRoot, 'main', 'scanner'))
  const { approvePairingRequest, createPairingCode, listPairedDevices } = require(path.join(projectRoot, 'main', 'remote', 'identity'))
  const { createRemoteServer } = require(path.join(projectRoot, 'main', 'remote', 'server'))

  sessionAllowedDirectories.add(libraryDir)
  saveSettings({
    directories: [libraryDir],
    defaultDirectory: libraryDir,
    remoteAccess: { enabled: true, port: 38127, keepRunningInTray: true, allowLegacyToken: false }
  })

  const server = createRemoteServer({ port: 0 })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}`

  return {
    name,
    baseUrl,
    approvePairingRequest,
    createPairingCode,
    listPairedDevices,
    close: () => {
      unwatchAllDirectories()
      return new Promise(resolve => server.close(resolve))
    }
  }
}

async function claimDevice(desktop, clientId) {
  const pairing = desktop.createPairingCode({
    endpoint: desktop.baseUrl,
    endpoints: [desktop.baseUrl],
    ttlMs: 60 * 1000
  })
  const payload = decodePairingPayload(pairing.pairingCode)
  const pending = await requestJson(`${desktop.baseUrl}/v1/pairing/claim`, {
    method: 'POST',
    body: JSON.stringify({
      pairingId: payload.pairingId,
      oneTimeSecret: payload.oneTimeSecret,
      clientId,
      clientName: clientId,
      platform: 'verify'
    })
  })
  assert.strictEqual(pending.status, 200)
  assert.strictEqual(pending.data.status, 'pending')
  desktop.approvePairingRequest(pending.data.pairingRequestId)
  const claimed = await requestJson(`${desktop.baseUrl}/v1/pairing/claim`, {
    method: 'POST',
    body: JSON.stringify({
      pairingId: payload.pairingId,
      oneTimeSecret: payload.oneTimeSecret,
      clientId,
      clientName: clientId,
      platform: 'verify'
    })
  })
  assert.strictEqual(claimed.status, 200)
  assert.ok(claimed.data.token)
  return {
    desktopId: claimed.data.deviceId,
    token: claimed.data.token,
    endpoint: desktop.baseUrl
  }
}

async function main() {
  createFixture(libraryA, 'desktop-a.mp4')
  createFixture(libraryB, 'desktop-b.mp4')
  const userDataA = path.join(tempRoot, 'desktop-a-profile')
  const userDataB = path.join(tempRoot, 'desktop-b-profile')
  fs.mkdirSync(userDataA, { recursive: true })
  fs.mkdirSync(userDataB, { recursive: true })

  const desktopA = await startDesktop('A', userDataA, libraryA)
  const desktopB = await startDesktop('B', userDataB, libraryB)

  try {
    const deviceA = await claimDevice(desktopA, 'phone_for_desktop_a')
    const deviceB = await claimDevice(desktopB, 'phone_for_desktop_b')
    assert.notStrictEqual(deviceA.desktopId, deviceB.desktopId, 'two desktops should expose different identities')

    const libraryFromA = await requestJson(`${desktopA.baseUrl}/v1/library`, {
      headers: { Authorization: `Bearer ${deviceA.token}` }
    })
    const libraryFromB = await requestJson(`${desktopB.baseUrl}/v1/library`, {
      headers: { Authorization: `Bearer ${deviceB.token}` }
    })
    assert.strictEqual(libraryFromA.status, 200)
    assert.strictEqual(libraryFromB.status, 200)
    assert.strictEqual(libraryFromA.data.count, 1)
    assert.strictEqual(libraryFromB.data.count, 1)
    assert.ok(libraryFromA.data.items.some(item => item.fileName === 'desktop-a'))
    assert.ok(libraryFromB.data.items.some(item => item.fileName === 'desktop-b'))

    const wrongDesktop = await requestJson(`${desktopB.baseUrl}/v1/library`, {
      headers: { Authorization: `Bearer ${deviceA.token}` }
    })
    assert.strictEqual(wrongDesktop.status, 401, 'desktop A token should not access desktop B')

    const unpairA = await requestJson(`${desktopA.baseUrl}/v1/devices/current`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${deviceA.token}` }
    })
    assert.strictEqual(unpairA.status, 200)
    assert.ok(!desktopA.listPairedDevices().some(device => device.id === 'phone_for_desktop_a'))
    assert.ok(desktopB.listPairedDevices().some(device => device.id === 'phone_for_desktop_b'))

    const revokedA = await requestJson(`${desktopA.baseUrl}/v1/library`, {
      headers: { Authorization: `Bearer ${deviceA.token}` }
    })
    const stillB = await requestJson(`${desktopB.baseUrl}/v1/library`, {
      headers: { Authorization: `Bearer ${deviceB.token}` }
    })
    assert.strictEqual(revokedA.status, 401)
    assert.strictEqual(stillB.status, 200)

    console.log('mobile multi-device verification passed')
  } finally {
    await Promise.all([desktopA.close(), desktopB.close()])
  }
}

main()
  .finally(() => {
    process.chdir(projectRoot)
    removeTempRoot()
  })
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
