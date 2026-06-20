const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const projectRoot = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wallpaper-player-remote-verify-'))

function decodePairingPayload(pairingCode) {
  const url = new URL(pairingCode)
  const data = url.searchParams.get('data')
  assert.ok(data, 'pairing code should include encoded data')
  return JSON.parse(Buffer.from(data, 'base64url').toString('utf8'))
}

function expectPairingFailure(fn, code) {
  try {
    fn()
  } catch (error) {
    assert.strictEqual(error.code, code)
    return
  }
  throw new Error(`expected ${code}`)
}

process.chdir(tempRoot)

const {
  approvePairingRequest,
  claimPairing,
  createBoundScopedToken,
  createPairingCode,
  listPendingPairingRequests,
  listPairedDevices,
  rejectPairingRequest,
  revokePairedDeviceByToken,
  verifyAccessToken,
  verifyBoundScopedToken
} = require(path.join(projectRoot, 'main', 'remote', 'identity'))

try {
  const pairing = createPairingCode({
    endpoint: 'http://127.0.0.1:38127',
    endpoints: ['http://127.0.0.1:38127'],
    ttlMs: 60 * 1000
  })
  const payload = decodePairingPayload(pairing.pairingCode)

  assert.strictEqual(payload.endpoint, 'http://127.0.0.1:38127')
  assert.ok(payload.pairingId, 'pairing payload should include pairingId')
  assert.ok(payload.oneTimeSecret, 'pairing payload should include oneTimeSecret')
  assert.ok(payload.expiresAt > Date.now(), 'pairing payload should not be expired')

  const pending = claimPairing({
    pairingId: payload.pairingId,
    oneTimeSecret: payload.oneTimeSecret,
    clientId: 'mobile_verify',
    clientName: 'Verify Phone',
    platform: 'test'
  })
  assert.strictEqual(pending.status, 'pending', 'first claim should wait for desktop approval')
  assert.ok(pending.pairingRequestId, 'pending claim should expose request id')
  assert.strictEqual(listPendingPairingRequests().length, 1, 'pending request should be listed for desktop confirmation')
  assert.strictEqual(listPairedDevices().length, 0, 'pending request should not create a paired device before approval')
  approvePairingRequest(pending.pairingRequestId)
  assert.strictEqual(listPairedDevices().length, 0, 'approval should not create a paired device until the phone receives its token')
  const claimed = claimPairing({
    pairingId: payload.pairingId,
    oneTimeSecret: payload.oneTimeSecret,
    clientId: 'mobile_verify',
    clientName: 'Verify Phone',
    platform: 'test'
  })

  assert.ok(claimed.token, 'claim should return a device token')
  assert.strictEqual(claimed.pairedDeviceId, 'mobile_verify')
  assert.strictEqual(verifyAccessToken(claimed.token), true, 'claimed token should be accepted')
  const thumbnailToken = createBoundScopedToken('thumbnail', 'video_verify', claimed.token, 60 * 1000)
  assert.strictEqual(
    verifyBoundScopedToken('thumbnail', 'video_verify', thumbnailToken),
    true,
    'bound thumbnail token should be accepted before revocation'
  )

  const devices = listPairedDevices()
  assert.strictEqual(devices.length, 1, 'one paired device should be listed')
  assert.strictEqual(devices[0].id, 'mobile_verify')

  expectPairingFailure(() => claimPairing({
    pairingId: payload.pairingId,
    oneTimeSecret: payload.oneTimeSecret,
    clientId: 'mobile_second'
  }), 'pairing_expired')

  const rejectedPairing = createPairingCode({
    endpoint: 'http://127.0.0.1:38127',
    endpoints: ['http://127.0.0.1:38127'],
    ttlMs: 60 * 1000
  })
  const rejectedPayload = decodePairingPayload(rejectedPairing.pairingCode)
  const rejectedPending = claimPairing({
    pairingId: rejectedPayload.pairingId,
    oneTimeSecret: rejectedPayload.oneTimeSecret,
    clientId: 'mobile_rejected',
    clientName: 'Rejected Phone'
  })
  rejectPairingRequest(rejectedPending.pairingRequestId)
  expectPairingFailure(() => claimPairing({
    pairingId: rejectedPayload.pairingId,
    oneTimeSecret: rejectedPayload.oneTimeSecret,
    clientId: 'mobile_rejected',
    clientName: 'Rejected Phone'
  }), 'pairing_rejected')

  const revoked = revokePairedDeviceByToken(claimed.token)
  assert.ok(revoked, 'revocation by token should find the paired device')
  assert.strictEqual(verifyAccessToken(claimed.token), false, 'revoked token should be rejected')
  assert.strictEqual(
    verifyBoundScopedToken('thumbnail', 'video_verify', thumbnailToken),
    false,
    'bound thumbnail token should be rejected after revocation'
  )
  assert.strictEqual(listPairedDevices().length, 0, 'revoked device should not be listed')

  console.log('remote/mobile pairing verification passed')
} finally {
  process.chdir(projectRoot)
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
