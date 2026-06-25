const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { app } = require('electron')
const log = require('electron-log')

const IDENTITY_FILE = 'remote-identity.json'
const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000
const LAST_SEEN_WRITE_INTERVAL_MS = 60 * 1000
const fallbackUserDataDir = path.join(process.cwd(), '.tmp-wallpaper-player')
let identityCorruptedAt = 0
const pairingSessions = new Map()

function getIdentityPath() {
  const baseDir = app?.getPath
    ? app.getPath('userData')
    : fallbackUserDataDir
  return path.join(baseDir, IDENTITY_FILE)
}

function getAppName() {
  return app?.getName?.() || 'Wallpaper Player'
}

function getAppVersion() {
  return app?.getVersion?.() || '0.0.0'
}

function randomBase64Url(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url')
}

function normalizeString(value, fallback = '', maxLength = 120) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (!trimmed) return fallback
  return trimmed.slice(0, maxLength)
}

function normalizePairedDevices(devices) {
  if (!Array.isArray(devices)) return []

  const seen = new Set()
  return devices
    .filter(device => device && typeof device === 'object')
    .map(device => {
      const id = normalizeString(device.id, '', 80)
      const tokenHash = normalizeString(device.tokenHash, '', 128)
      if (!id || !tokenHash || seen.has(id)) return null
      seen.add(id)

      const createdAt = Number(device.createdAt)
      const lastSeenAt = Number(device.lastSeenAt)
      const revokedAt = Number(device.revokedAt)
      return {
        id,
        name: normalizeString(device.name, '手机端', 80),
        platform: normalizeString(device.platform, '', 40),
        tokenHash,
        createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
        lastSeenAt: Number.isFinite(lastSeenAt) ? lastSeenAt : 0,
        lastAddress: normalizeString(device.lastAddress, '', 80),
        revokedAt: Number.isFinite(revokedAt) ? revokedAt : 0
      }
    })
    .filter(Boolean)
    .slice(-100)
}

function createIdentity() {
  return {
    deviceId: `pc_${randomBase64Url(6)}`,
    deviceName: getAppName(),
    machineSecret: randomBase64Url(32),
    accessToken: randomBase64Url(32),
    pairedDevices: [],
    createdAt: Date.now()
  }
}

function normalizeIdentity(identity) {
  const current = identity && typeof identity === 'object' ? identity : {}
  return {
    deviceId: typeof current.deviceId === 'string' && current.deviceId.trim()
      ? current.deviceId
      : `pc_${randomBase64Url(6)}`,
    deviceName: typeof current.deviceName === 'string' && current.deviceName.trim()
      ? current.deviceName
      : getAppName(),
    machineSecret: typeof current.machineSecret === 'string' && current.machineSecret.trim()
      ? current.machineSecret
      : randomBase64Url(32),
    accessToken: typeof current.accessToken === 'string' && current.accessToken.trim()
      ? current.accessToken
      : randomBase64Url(32),
    pairedDevices: normalizePairedDevices(current.pairedDevices),
    createdAt: Number.isFinite(Number(current.createdAt)) ? Number(current.createdAt) : Date.now()
  }
}

function saveIdentity(identity) {
  const identityPath = getIdentityPath()
  const dir = path.dirname(identityPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(identityPath, JSON.stringify(identity, null, 2))
}

function loadIdentity() {
  try {
    if (!fs.existsSync(getIdentityPath())) {
      return loadFreshIdentity()
    }
    const raw = fs.readFileSync(getIdentityPath(), 'utf-8')
    if (!raw.trim()) throw new Error('identity file is empty')
    const parsed = JSON.parse(raw)
    const identity = normalizeIdentity(parsed)
    if (!identity.machineSecret || !identity.accessToken) {
      throw new Error('identity missing required fields')
    }
    saveIdentity(identity)
    return identity
  } catch (err) {
    const now = Date.now()
    if (identityCorruptedAt === 0) {
      identityCorruptedAt = now
      log.error('[identity] 身份文件损坏，已自动重建，旧配对将失效:', err.message)
    }
    return loadFreshIdentity()
  }
}

function loadFreshIdentity() {
  const identity = createIdentity()
  saveIdentity(identity)
  return identity
}

function getIdentityCorruptedAt() {
  return identityCorruptedAt
}

function rotateAccessToken() {
  const identity = loadIdentity()
  const next = {
    ...identity,
    accessToken: randomBase64Url(32)
  }
  saveIdentity(next)
  return next
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex')
}

function safeHashEqual(expectedHash, actualHash) {
  const expectedBuffer = Buffer.from(String(expectedHash || ''))
  const actualBuffer = Buffer.from(String(actualHash || ''))
  return expectedBuffer.length === actualBuffer.length && crypto.timingSafeEqual(expectedBuffer, actualBuffer)
}

function toPublicPairedDevice(device) {
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt || 0,
    lastAddress: device.lastAddress || ''
  }
}

function listPairedDevices() {
  const identity = loadIdentity()
  return identity.pairedDevices
    .filter(device => !device.revokedAt)
    .map(toPublicPairedDevice)
    .sort((a, b) => (b.lastSeenAt || b.createdAt || 0) - (a.lastSeenAt || a.createdAt || 0))
}

function updatePairedDeviceLastSeen(identity, deviceId, context = {}) {
  const now = Date.now()
  let changed = false
  const nextDevices = identity.pairedDevices.map(device => {
    if (device.id !== deviceId || device.revokedAt) return device
    const lastAddress = normalizeString(context.remoteAddress, device.lastAddress || '', 80)
    if ((now - (device.lastSeenAt || 0)) < LAST_SEEN_WRITE_INTERVAL_MS && lastAddress === device.lastAddress) {
      return device
    }
    changed = true
    return {
      ...device,
      lastSeenAt: now,
      lastAddress
    }
  })

  if (changed) {
    saveIdentity({ ...identity, pairedDevices: nextDevices })
  }
}

function verifyAccessToken(token, context = {}) {
  return Boolean(verifyAccessTokenWithType(token, context).authorized)
}

function verifyAccessTokenWithType(token, context = {}) {
  if (typeof token !== 'string' || !token.trim()) {
    return {
      authorized: false,
      type: '',
      deviceId: ''
    }
  }
  const identity = loadIdentity()
  const expected = hashToken(identity.accessToken)
  const actual = hashToken(token.trim())
  if (safeHashEqual(expected, actual)) {
    return {
      authorized: true,
      type: 'legacy',
      deviceId: ''
    }
  }

  const pairedDevice = identity.pairedDevices.find(device => (
    !device.revokedAt &&
    safeHashEqual(device.tokenHash, actual)
  ))
  if (!pairedDevice) {
    return {
      authorized: false,
      type: '',
      deviceId: ''
    }
  }

  updatePairedDeviceLastSeen(identity, pairedDevice.id, context)
  return {
    authorized: true,
    type: 'paired',
    deviceId: pairedDevice.id
  }
}

function getAccessTokenHashAuthorization(tokenHash) {
  const hash = normalizeString(tokenHash, '', 128)
  if (!hash) {
    return {
      authorized: false,
      type: '',
      deviceId: ''
    }
  }

  const identity = loadIdentity()
  if (safeHashEqual(hashToken(identity.accessToken), hash)) {
    return {
      authorized: true,
      type: 'legacy',
      deviceId: ''
    }
  }
  const pairedDevice = identity.pairedDevices.find(device => (
    !device.revokedAt &&
    safeHashEqual(device.tokenHash, hash)
  ))
  if (!pairedDevice) {
    return {
      authorized: false,
      type: '',
      deviceId: ''
    }
  }
  return {
    authorized: true,
    type: 'paired',
    deviceId: pairedDevice.id
  }
}

function isAccessTokenHashAuthorized(tokenHash) {
  return Boolean(getAccessTokenHashAuthorization(tokenHash).authorized)
}

function revokePairedDevice(deviceId) {
  const id = normalizeString(deviceId, '', 80)
  if (!id) return false

  const identity = loadIdentity()
  const nextDevices = identity.pairedDevices.filter(device => device.id !== id)
  if (nextDevices.length === identity.pairedDevices.length) return false
  saveIdentity({ ...identity, pairedDevices: nextDevices })
  return true
}

function revokePairedDeviceByToken(token) {
  if (typeof token !== 'string' || !token.trim()) return null
  const identity = loadIdentity()
  const actual = hashToken(token.trim())
  const target = identity.pairedDevices.find(device => !device.revokedAt && safeHashEqual(device.tokenHash, actual))
  if (!target) return null
  revokePairedDevice(target.id)
  return toPublicPairedDevice(target)
}

function cleanupPairingSessions() {
  const now = Date.now()
  for (const [pairingId, session] of pairingSessions.entries()) {
    if (!session || session.expiresAt < now) {
      pairingSessions.delete(pairingId)
    }
  }
}

function createPairingCode({ endpoint, endpoints, ttlMs = DEFAULT_PAIRING_TTL_MS } = {}) {
  cleanupPairingSessions()

  const identity = loadIdentity()
  const pairingId = `pair_${randomBase64Url(8)}`
  const oneTimeSecret = randomBase64Url(24)
  const expiresAt = Date.now() + Math.max(30 * 1000, Number(ttlMs) || DEFAULT_PAIRING_TTL_MS)
  const payload = {
    version: 1,
    deviceId: identity.deviceId,
    deviceName: identity.deviceName,
    endpoint: normalizeString(endpoint, '', 200),
    endpoints: Array.isArray(endpoints) ? endpoints.filter(item => typeof item === 'string' && item.trim()).slice(0, 8) : [],
    pairingId,
    oneTimeSecret,
    expiresAt
  }

  pairingSessions.set(pairingId, {
    pairingId,
    oneTimeSecretHash: hashToken(oneTimeSecret),
    endpoint: payload.endpoint,
    endpoints: payload.endpoints,
    expiresAt,
    createdAt: Date.now()
  })

  const data = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return {
    pairingCode: `wallpaper-player://pair?data=${data}`,
    payload,
    expiresAt
  }
}

function createPairingError(status, code, message) {
  return Object.assign(new Error(message), { status, code })
}

function createPendingPairingResult(session) {
  const identity = loadIdentity()
  return {
    status: 'pending',
    pairingRequestId: session.request.id,
    deviceId: identity.deviceId,
    deviceName: identity.deviceName,
    endpoint: session.endpoint,
    endpoints: session.endpoints,
    expiresAt: session.expiresAt
  }
}

function createApprovedPairingResult(session) {
  const identity = loadIdentity()
  const request = session.request || {}
  const token = randomBase64Url(32)
  const pairedDeviceId = normalizeString(request.clientId, '', 80) || `mobile_${randomBase64Url(6)}`
  const now = Date.now()
  const pairedDevice = {
    id: pairedDeviceId,
    name: normalizeString(request.clientName, '手机端', 80),
    platform: normalizeString(request.platform, '', 40),
    tokenHash: hashToken(token),
    createdAt: now,
    lastSeenAt: now,
    lastAddress: '',
    revokedAt: 0
  }
  const nextDevices = [
    ...identity.pairedDevices.filter(device => device.id !== pairedDevice.id),
    pairedDevice
  ]
  saveIdentity({
    ...identity,
    pairedDevices: normalizePairedDevices(nextDevices)
  })

  return {
    status: 'approved',
    deviceId: identity.deviceId,
    deviceName: identity.deviceName,
    endpoint: session.endpoint,
    endpoints: session.endpoints,
    token,
    pairedDeviceId,
    serverVersion: getAppVersion()
  }
}

function toPublicPairingRequest(session) {
  const request = session.request
  if (!request || request.approvedAt || request.rejectedAt) return null
  return {
    id: request.id,
    pairingId: session.pairingId,
    clientId: request.clientId,
    clientName: request.clientName,
    platform: request.platform,
    createdAt: request.createdAt,
    expiresAt: session.expiresAt
  }
}

function listPendingPairingRequests() {
  cleanupPairingSessions()
  return [...pairingSessions.values()]
    .map(toPublicPairingRequest)
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt)
}

function findSessionByPairingRequestId(pairingRequestId) {
  const id = normalizeString(pairingRequestId, '', 80)
  if (!id) return null
  cleanupPairingSessions()
  for (const session of pairingSessions.values()) {
    if (session.request?.id === id) return session
  }
  return null
}

function approvePairingRequest(pairingRequestId) {
  const session = findSessionByPairingRequestId(pairingRequestId)
  if (!session || !session.request) {
    throw createPairingError(404, 'pairing_request_not_found', '绑定请求不存在或已过期')
  }
  if (session.request.rejectedAt) {
    throw createPairingError(409, 'pairing_rejected', '绑定请求已拒绝')
  }
  if (!session.request.approvedAt) {
    session.request.approvedAt = Date.now()
  }
  return toPublicPairingRequest({ ...session, request: { ...session.request, approvedAt: 0 } })
}

function rejectPairingRequest(pairingRequestId) {
  const session = findSessionByPairingRequestId(pairingRequestId)
  if (!session || !session.request) {
    throw createPairingError(404, 'pairing_request_not_found', '绑定请求不存在或已过期')
  }
  session.request.rejectedAt = Date.now()
  return true
}

function claimPairing({ pairingId, oneTimeSecret, clientId, clientName, platform } = {}) {
  cleanupPairingSessions()

  const id = normalizeString(pairingId, '', 80)
  const secret = normalizeString(oneTimeSecret, '', 200)
  const normalizedClientId = normalizeString(clientId, '', 80)
  const session = id ? pairingSessions.get(id) : null
  if (!session || session.expiresAt < Date.now()) {
    throw createPairingError(410, 'pairing_expired', '绑定二维码已过期，请在电脑端重新生成')
  }
  if (session.claimedAt) {
    throw createPairingError(409, 'pairing_used', '绑定二维码已被使用，请重新生成')
  }
  if (!secret || !safeHashEqual(session.oneTimeSecretHash, hashToken(secret))) {
    throw createPairingError(401, 'pairing_secret_invalid', '绑定二维码无效')
  }

  if (session.request?.rejectedAt) {
    throw createPairingError(403, 'pairing_rejected', '电脑端已拒绝本次绑定')
  }

  if (session.request?.approvedAt) {
    const requestClientId = normalizeString(session.request?.clientId, '', 80)
    if (requestClientId && normalizedClientId && requestClientId !== normalizedClientId) {
      throw createPairingError(409, 'pairing_in_progress', '二维码正在被另一台设备绑定')
    }
    const result = session.approvedResult || createApprovedPairingResult(session)
    session.approvedResult = result
    session.claimedAt = Date.now()
    pairingSessions.delete(id)
    return result
  }

  if (session.request) {
    const requestClientId = normalizeString(session.request.clientId, '', 80)
    if (requestClientId && normalizedClientId && requestClientId !== normalizedClientId) {
      throw createPairingError(409, 'pairing_in_progress', '二维码正在被另一台设备绑定')
    }
    return createPendingPairingResult(session)
  }

  session.request = {
    id: `bind_${randomBase64Url(8)}`,
    clientId: normalizedClientId,
    clientName: normalizeString(clientName, '手机端', 80),
    platform: normalizeString(platform, '', 40),
    createdAt: Date.now(),
    approvedAt: 0,
    rejectedAt: 0
  }
  return createPendingPairingResult(session)
}

function signScopedToken(scope, subject, expiresAt) {
  const identity = loadIdentity()
  const payload = [
    String(scope || ''),
    String(subject || ''),
    String(expiresAt || 0)
  ].join('\n')
  return crypto
    .createHmac('sha256', identity.machineSecret)
    .update(payload)
    .digest('base64url')
}

function createScopedToken(scope, subject, ttlMs) {
  const expiresAt = Date.now() + Math.max(1000, Number(ttlMs) || 0)
  return `${expiresAt}.${signScopedToken(scope, subject, expiresAt)}`
}

function verifyScopedToken(scope, subject, token) {
  if (typeof token !== 'string' || !token.trim()) return false
  const [expiresAtText, signature] = token.split('.')
  const expiresAt = Number(expiresAtText)
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now() || !signature) return false

  const expected = signScopedToken(scope, subject, expiresAt)
  const expectedBuffer = Buffer.from(expected)
  const actualBuffer = Buffer.from(signature)
  return expectedBuffer.length === actualBuffer.length && crypto.timingSafeEqual(expectedBuffer, actualBuffer)
}

function createBoundScopedToken(scope, subject, accessToken, ttlMs) {
  const tokenHash = hashToken(accessToken)
  const expiresAt = Date.now() + Math.max(1000, Number(ttlMs) || 0)
  const signature = signScopedToken(scope, `${subject}\n${tokenHash}`, expiresAt)
  return `${tokenHash}.${expiresAt}.${signature}`
}

function verifyBoundScopedToken(scope, subject, token, options = {}) {
  if (typeof token !== 'string' || !token.trim()) return false
  const [tokenHash, expiresAtText, signature] = token.split('.')
  const expiresAt = Number(expiresAtText)
  if (!tokenHash || !Number.isFinite(expiresAt) || expiresAt < Date.now() || !signature) return false
  const authorization = getAccessTokenHashAuthorization(tokenHash)
  if (!authorization.authorized) return false
  if (authorization.type === 'legacy' && !options.allowLegacyToken) return false

  const expected = signScopedToken(scope, `${subject}\n${tokenHash}`, expiresAt)
  const expectedBuffer = Buffer.from(expected)
  const actualBuffer = Buffer.from(signature)
  return expectedBuffer.length === actualBuffer.length && crypto.timingSafeEqual(expectedBuffer, actualBuffer)
}

function getPublicIdentity() {
  const identity = loadIdentity()
  return {
    deviceId: identity.deviceId,
    deviceName: identity.deviceName,
    serverVersion: getAppVersion()
  }
}

module.exports = {
  getIdentityPath,
  getIdentityCorruptedAt,
  loadIdentity,
  rotateAccessToken,
  verifyAccessToken,
  verifyAccessTokenWithType,
  listPairedDevices,
  revokePairedDevice,
  revokePairedDeviceByToken,
  createPairingCode,
  claimPairing,
  listPendingPairingRequests,
  approvePairingRequest,
  rejectPairingRequest,
  createScopedToken,
  verifyScopedToken,
  createBoundScopedToken,
  verifyBoundScopedToken,
  getPublicIdentity
}
