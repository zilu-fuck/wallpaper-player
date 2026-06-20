const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const projectRoot = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wallpaper-player-api-smoke-'))

function decodePairingPayload(pairingCode) {
  const data = new URL(pairingCode).searchParams.get('data')
  return JSON.parse(Buffer.from(data, 'base64url').toString('utf8'))
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options)
  const text = await response.text()
  return {
    status: response.status,
    data: text ? JSON.parse(text) : null
  }
}

async function requestBytes(url, options = {}) {
  const response = await fetch(url, options)
  const body = Buffer.from(await response.arrayBuffer())
  return {
    status: response.status,
    body
  }
}

process.chdir(tempRoot)

const { approvePairingRequest, createPairingCode, loadIdentity } = require(path.join(projectRoot, 'main', 'remote', 'identity'))
const { saveSettings } = require(path.join(projectRoot, 'main', 'settings'))
const { createRemoteServer } = require(path.join(projectRoot, 'main', 'remote', 'server'))

async function main() {
  let pairingRequestNotifications = 0
  const server = createRemoteServer({
    port: 0,
    onPairingRequest: () => {
      pairingRequestNotifications += 1
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object', 'server should expose a local address')
    const baseUrl = `http://127.0.0.1:${address.port}`

    const info = await requestJson(`${baseUrl}/v1/info`)
    assert.strictEqual(info.status, 200)
    assert.ok(info.data.deviceId, 'info should expose public device id')

    const unauthorized = await requestJson(`${baseUrl}/v1/library`)
    assert.strictEqual(unauthorized.status, 401)

    const legacyToken = loadIdentity().accessToken
    const legacyDenied = await requestJson(`${baseUrl}/v1/library`, {
      headers: { Authorization: `Bearer ${legacyToken}` }
    })
    assert.strictEqual(legacyDenied.status, 403)
    assert.strictEqual(legacyDenied.data.error.code, 'legacy_token_disabled')

    saveSettings({ remoteAccess: { enabled: true, port: 38127, keepRunningInTray: true, allowLegacyToken: true } })
    const legacyAllowed = await requestJson(`${baseUrl}/v1/library`, {
      headers: { Authorization: `Bearer ${legacyToken}` }
    })
    assert.notStrictEqual(legacyAllowed.status, 403)
    saveSettings({ remoteAccess: { enabled: true, port: 38127, keepRunningInTray: true, allowLegacyToken: false } })

    let rateLimited = null
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const result = await requestJson(`${baseUrl}/v1/library`, {
        headers: { Authorization: 'Bearer definitely-invalid-token' }
      })
      if (result.status === 429) {
        rateLimited = result
        break
      }
    }
    assert.ok(rateLimited, 'repeated invalid tokens should be rate limited')
    assert.strictEqual(rateLimited.data.error.code, 'auth_rate_limited')

    const pairing = createPairingCode({
      endpoint: baseUrl,
      endpoints: [baseUrl],
      ttlMs: 60 * 1000
    })
    const payload = decodePairingPayload(pairing.pairingCode)
    const pending = await requestJson(`${baseUrl}/v1/pairing/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pairingId: payload.pairingId,
        oneTimeSecret: payload.oneTimeSecret,
        clientId: 'mobile_api_smoke',
        clientName: 'API Smoke'
      })
    })
    assert.strictEqual(pending.status, 200)
    assert.strictEqual(pending.data.status, 'pending')
    assert.ok(pending.data.pairingRequestId)
    assert.ok(pairingRequestNotifications >= 1, 'pairing claim should notify desktop state immediately')
    approvePairingRequest(pending.data.pairingRequestId)
    const claimed = await requestJson(`${baseUrl}/v1/pairing/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pairingId: payload.pairingId,
        oneTimeSecret: payload.oneTimeSecret,
        clientId: 'mobile_api_smoke',
        clientName: 'API Smoke'
      })
    })
    assert.strictEqual(claimed.status, 200)
    assert.ok(claimed.data.token, 'pairing claim should return a token')

    const speed = await requestBytes(`${baseUrl}/v1/speed-test?bytes=65536`, {
      headers: { Authorization: `Bearer ${claimed.data.token}` }
    })
    assert.strictEqual(speed.status, 200)
    assert.strictEqual(speed.body.length, 65536)

    const unpair = await requestJson(`${baseUrl}/v1/devices/current`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${claimed.data.token}` }
    })
    assert.strictEqual(unpair.status, 200)

    const revokedSpeed = await requestBytes(`${baseUrl}/v1/speed-test?bytes=65536`, {
      headers: { Authorization: `Bearer ${claimed.data.token}` }
    })
    assert.strictEqual(revokedSpeed.status, 401)

    console.log('remote api smoke verification passed')
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

main()
  .finally(() => {
    process.chdir(projectRoot)
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
