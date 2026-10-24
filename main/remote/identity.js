const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { app } = require('electron')
const log = require('electron-log')
const { getUserDataDir } = require('../user-data')
const { parseIdentityDocument } = require('../repositories/identity-document')
const { createDeviceActivity } = require('../repositories/device-activity')

const IDENTITY_FILE = 'remote-identity.json'
const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000
const LAST_SEEN_WRITE_INTERVAL_MS = 60 * 1000
const pairingSessions = new Map()
const authorizationListeners = new Set()
const identityStores = new Map()
let identityWriteCounter = 0
let authorizationRevision = 0
function getAuthorizationRevision() { return authorizationRevision }
function onAuthorizationChanged(listener) { authorizationListeners.add(listener); return () => authorizationListeners.delete(listener) }
function notifyAuthorizationChanged() { authorizationRevision++; queueMicrotask(() => { for (const listener of authorizationListeners) { try { listener() } catch {} } }) }

function getIdentityPath() {
  return path.join(getUserDataDir(), IDENTITY_FILE)
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
    ...current,
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

function identityStore() {
  const file = getIdentityPath()
  if (!identityStores.has(file)) identityStores.set(file, { file, identity: null, queue: Promise.resolve(),
    pending: 0, queuedRefresh: null, touches: new Map(), touchTask: null, readError: null, unavailableAt: 0, diskText: null,
    activity: createDeviceActivity(path.join(path.dirname(file), 'remote-device-activity.json')) })
  return identityStores.get(file)
}

const copyIdentity = identity => JSON.parse(JSON.stringify(identity))
function authorizationKey(identity) {
  return identity ? JSON.stringify([identity.deviceId, identity.machineSecret, identity.accessToken,
    identity.pairedDevices.map(device => [device.id, device.tokenHash, device.revokedAt])]) : ''
}

function publishIdentity(store, identity) {
  const changed = Boolean(store.readError) || authorizationKey(store.identity) !== authorizationKey(identity)
  if (store.identity && (store.identity.machineSecret !== identity.machineSecret || store.identity.deviceId !== identity.deviceId)) pairingSessions.clear()
  store.identity = copyIdentity(identity)
  store.readError = null; store.unavailableAt = 0
  if (changed) notifyAuthorizationChanged()
  if (store.touches.size) scheduleLastSeen(store)
}

function serializeIdentity(store, operation) {
  store.pending++
  const task = store.queue.then(operation)
  store.queue = task.catch(() => {}).finally(() => { store.pending-- })
  return task
}

function identityReadFailure(store, cause) {
  const code = cause.code === 'ENOENT' ? 'identity_missing' : cause.code || 'identity_unreadable'
  const message = code.startsWith('identity_') && cause.status === 503 ? cause.message
    : cause.code === 'ENOENT' ? '设备身份文件缺失，未自动重建；请修复后重试'
      : '设备身份文件无法读取，原文件未覆盖；请检查访问权限后重试'
  const error = Object.assign(new Error(message), { code, status: 503 })
  if (!store.readError) {
    store.unavailableAt = Date.now()
    for (const [key, session] of pairingSessions) if (session.identityPath === store.file) pairingSessions.delete(key)
    notifyAuthorizationChanged()
    log.error('[identity]', message)
  }
  store.readError = error
  return error
}

function readOrCreateIdentity(store, error) {
  if (error.code === 'ENOENT' && !store.identity && !store.readError) return createIdentity()
  throw identityReadFailure(store, error)
}

async function writeIdentity(store, identity) {
  const temporary = `${store.file}.${process.pid}.${++identityWriteCounter}.tmp`
  const expected = store.diskText, text = JSON.stringify(identity, null, 2)
  try {
    await fs.promises.mkdir(path.dirname(store.file), { recursive: true })
    await fs.promises.writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 })
    let latest = null
    try { latest = await fs.promises.readFile(store.file, 'utf8') }
    catch (error) { if (error.code !== 'ENOENT') throw identityReadFailure(store, error) }
    if (latest !== expected) rejectChangedIdentity(store, latest)
    await fs.promises.rename(temporary, store.file)
    store.diskText = text
  } catch (cause) {
    throw Object.assign(new Error(cause.code === 'identity_changed' ? '设备身份已变化，未覆盖新文件；请刷新后重试' : '设备身份保存失败，原文件未替换；请重试'),
      { code: cause.code || 'identity_write_failed', status: 503, retryable: cause.code === 'identity_changed' })
  } finally { await fs.promises.rm(temporary, { force: true }).catch(() => {}) }
}

function rejectChangedIdentity(store, text) {
  if (text === null) throw identityReadFailure(store, { code: 'ENOENT' })
  let identity
  try { identity = normalizeIdentity(parseIdentityDocument(text)) }
  catch (error) { throw identityReadFailure(store, error) }
  store.diskText = text
  publishIdentity(store, identity)
  throw Object.assign(new Error('设备身份已变化，未覆盖新文件；请刷新后重试'), { code: 'identity_changed', status: 503, retryable: true })
}

async function readIdentity(store) {
  let parsed, identity, text = null
  try { text = await fs.promises.readFile(store.file, 'utf8'); parsed = parseIdentityDocument(text); identity = normalizeIdentity(parsed) }
  catch (error) { identity = readOrCreateIdentity(store, error) }
  store.diskText = text
  if (JSON.stringify(identity) !== JSON.stringify(parsed)) await writeIdentity(store, identity)
  publishIdentity(store, await store.activity.read(identity))
  return store.identity
}

// Production boundaries refresh asynchronously. The synchronous bridge remains
// for installed plugins and cold local callers; it cannot race queued IO.
function refreshIdentitySync() {
  const store = identityStore()
  if (store.pending) throw Object.assign(new Error('身份仓库正在提交，请重试'), { status: 503, code: 'identity_busy' })
  let parsed, identity, text = null
  try { text = fs.readFileSync(store.file, 'utf8'); parsed = parseIdentityDocument(text); identity = normalizeIdentity(parsed) }
  catch (error) { identity = readOrCreateIdentity(store, error) }
  store.diskText = text
  if (JSON.stringify(identity) !== JSON.stringify(parsed)) {
    const temporary = `${store.file}.${process.pid}.${++identityWriteCounter}.tmp`
    try {
      fs.mkdirSync(path.dirname(store.file), { recursive: true }); const nextText = JSON.stringify(identity, null, 2)
      fs.writeFileSync(temporary, nextText, { mode: 0o600 })
      let latest = null
      try { latest = fs.readFileSync(store.file, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw identityReadFailure(store, error) }
      if (latest !== text) rejectChangedIdentity(store, latest)
      fs.renameSync(temporary, store.file); store.diskText = nextText
    }
    catch (cause) { throw Object.assign(new Error('设备身份保存失败，原文件未替换；请重试'), { code: cause.code || 'identity_write_failed', status: 503 }) }
    finally { fs.rmSync(temporary, { force: true }) }
  }
  publishIdentity(store, store.activity.readSync(identity))
}

function loadIdentity() {
  const store = identityStore()
  if (store.readError) throw store.readError
  if (!store.identity) refreshIdentitySync()
  return copyIdentity(store.identity)
}

function refreshIdentity() {
  const store = identityStore()
  if (!store.queuedRefresh) {
    store.queuedRefresh = serializeIdentity(store, async () => {
      // Only share a read that has not started: a later boundary must not join a
      // read issued before an external revocation or a preceding commit.
      store.queuedRefresh = null
      await readIdentity(store)
    })
  }
  return store.queuedRefresh
}

function currentIdentity() {
  const store = identityStore()
  if (store.readError) throw store.readError
  if (!store.identity) loadIdentity()
  return store.identity
}

function mutateIdentity(update) {
  const store = identityStore()
  return serializeIdentity(store, async () => {
    const current = await readIdentity(store)
    const mutation = update(copyIdentity(current))
    if (mutation.next) { await writeIdentity(store, mutation.next); publishIdentity(store, mutation.next) }
    return mutation.value
  })
}

async function flushIdentityWrites() {
  for (const store of identityStores.values()) {
    do { await store.queue; await store.touchTask } while (store.pending || store.touchTask)
  }
}

function getIdentityCorruptedAt() {
  return identityStore().unavailableAt
}

function getIdentityReadError() {
  const store = identityStore()
  return store.readError ? { code: store.readError.code, message: store.readError.message, at: store.unavailableAt } : null
}

function rotateAccessToken() {
  return mutateIdentity(identity => {
    const next = { ...identity, accessToken: randomBase64Url(32) }
    return { next, value: copyIdentity(next) }
  })
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
  const identity = currentIdentity()
  return identity.pairedDevices
    .filter(device => !device.revokedAt)
    .map(toPublicPairedDevice)
    .sort((a, b) => (b.lastSeenAt || b.createdAt || 0) - (a.lastSeenAt || a.createdAt || 0))
}

function updatePairedDeviceLastSeen(identity, deviceId, context = {}) {
  const now = Date.now()
  const device = identity.pairedDevices.find(device => device.id === deviceId && !device.revokedAt)
  if (!device) return
  const lastAddress = normalizeString(context.remoteAddress, device.lastAddress || '', 80)
  if (now - (device.lastSeenAt || 0) < LAST_SEEN_WRITE_INTERVAL_MS && lastAddress === device.lastAddress) return
  const store = identityStore()
  store.touches.set(deviceId, { tokenHash: device.tokenHash, lastSeenAt: now, lastAddress })
  scheduleLastSeen(store)
}

function scheduleLastSeen(store) {
  if (store.touchTask || !store.touches.size || store.readError) return
  const task = serializeIdentity(store, async () => {
    const identity = await readIdentity(store), touches = new Map(store.touches)
    store.touches.clear()
    let changed = false
    const pairedDevices = identity.pairedDevices.map(device => {
      const touch = touches.get(device.id)
      if (!touch || device.revokedAt || device.tokenHash !== touch.tokenHash) return device
      if (touch.lastSeenAt - device.lastSeenAt < LAST_SEEN_WRITE_INTERVAL_MS && touch.lastAddress === device.lastAddress) return device
      changed = true
      return { ...device, lastSeenAt: Math.max(device.lastSeenAt, touch.lastSeenAt), lastAddress: touch.lastAddress }
    })
    if (changed) { const next = { ...identity, pairedDevices }; await store.activity.save(next); publishIdentity(store, next) }
  })
  store.touchTask = task.catch(error => { log.warn('[identity] 设备最近访问记录写入失败:', error.message) })
    .finally(() => { store.touchTask = null; scheduleLastSeen(store) })
}

function verifyAccessToken(token, context = {}) {
  return Boolean(verifyAccessTokenWithType(token, context).authorized)
}

function verifyAccessTokenWithType(token, context = {}) {
  if (identityStore().readError || typeof token !== 'string' || !token.trim()) {
    return {
      authorized: false,
      type: '',
      deviceId: ''
    }
  }
  const identity = currentIdentity()
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
  if (!hash || identityStore().readError) {
    return {
      authorized: false,
      type: '',
      deviceId: ''
    }
  }

  const identity = currentIdentity()
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
  if (!id) return Promise.resolve(false)
  return mutateIdentity(identity => {
    const nextDevices = identity.pairedDevices.filter(device => device.id !== id)
    return nextDevices.length === identity.pairedDevices.length ? { value: false }
      : { next: { ...identity, pairedDevices: nextDevices }, value: true }
  })
}

function revokePairedDeviceByToken(token) {
  if (typeof token !== 'string' || !token.trim()) return Promise.resolve(null)
  const actual = hashToken(token.trim())
  return mutateIdentity(identity => {
    const target = identity.pairedDevices.find(device => !device.revokedAt && safeHashEqual(device.tokenHash, actual))
    return target ? { next: { ...identity, pairedDevices: identity.pairedDevices.filter(device => device.id !== target.id) },
      value: toPublicPairedDevice(target) } : { value: null }
  })
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

  const identity = currentIdentity()
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
    identityPath: getIdentityPath(),
    machineSecret: identity.machineSecret,
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
  const identity = currentIdentity()
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
  return mutateIdentity(identity => {
    if (pairingSessions.get(session.pairingId) !== session || session.machineSecret !== identity.machineSecret) throw createPairingError(410, 'pairing_expired', '绑定二维码已过期，请重新生成')
    if (session.request?.rejectedAt) throw createPairingError(403, 'pairing_rejected', '电脑端已拒绝本次绑定')
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
    const next = { ...identity, pairedDevices: normalizePairedDevices([
      ...identity.pairedDevices.filter(device => device.id !== pairedDevice.id), pairedDevice
    ]) }
    return { next, value: {
      status: 'approved',
      deviceId: identity.deviceId,
      deviceName: identity.deviceName,
      endpoint: session.endpoint,
      endpoints: session.endpoints,
      token,
      pairedDeviceId,
      serverVersion: getAppVersion()
    } }
  })
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
  if (session.claimPromise) throw createPairingError(409, 'pairing_in_progress', '绑定凭证正在提交，请完成后移除设备')
  session.request.rejectedAt = Date.now()
  return true
}

async function claimPairing({ pairingId, oneTimeSecret, clientId, clientName, platform } = {}) {
  cleanupPairingSessions()

  const id = normalizeString(pairingId, '', 80)
  const secret = normalizeString(oneTimeSecret, '', 200)
  const normalizedClientId = normalizeString(clientId, '', 80)
  const session = id ? pairingSessions.get(id) : null
  if (!session || session.expiresAt < Date.now() || session.identityPath !== getIdentityPath()) {
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
    if (!session.claimPromise) {
      session.claimPromise = createApprovedPairingResult(session).then(result => {
        session.approvedResult = result
        session.claimedAt = Date.now()
        pairingSessions.delete(id)
        return result
      }).catch(error => { session.claimPromise = null; throw error })
    }
    return session.claimPromise
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
  const identity = currentIdentity()
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
  if (identityStore().readError || typeof token !== 'string' || !token.trim()) return false
  const [expiresAtText, signature] = token.split('.')
  const expiresAt = Number(expiresAtText)
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now() || !signature) return false

  const expected = signScopedToken(scope, subject, expiresAt)
  const expectedBuffer = Buffer.from(expected)
  const actualBuffer = Buffer.from(signature)
  return expectedBuffer.length === actualBuffer.length && crypto.timingSafeEqual(expectedBuffer, actualBuffer)
}

function createBoundScopedToken(scope, subject, accessToken, ttlMs) {
  return createBoundScopedTokenSigner(scope, accessToken, ttlMs)(subject)
}

function createBoundScopedTokenSigner(scope, accessToken, ttlMs) {
  const { machineSecret } = currentIdentity()
  const tokenHash = hashToken(accessToken)
  const expiresAt = Date.now() + Math.max(1000, Number(ttlMs) || 0)
  return subject => {
    const signature = crypto.createHmac('sha256', machineSecret)
      .update([String(scope || ''), `${subject}\n${tokenHash}`, String(expiresAt)].join('\n')).digest('base64url')
    return `${tokenHash}.${expiresAt}.${signature}`
  }
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
  const identity = currentIdentity()
  return {
    deviceId: identity.deviceId,
    deviceName: identity.deviceName,
    serverVersion: getAppVersion()
  }
}

module.exports = {
  getAccessTokenHashAuthorization,
  onAuthorizationChanged,
  getIdentityPath,
  getIdentityCorruptedAt,
  getIdentityReadError,
  loadIdentity,
  refreshIdentity,
  refreshIdentitySync,
  flushIdentityWrites,
  rotateAccessToken,
  verifyAccessToken,
  verifyAccessTokenWithType,
  getAuthorizationRevision,
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
  createBoundScopedTokenSigner,
  verifyBoundScopedToken,
  hashToken,
  signScopedToken,
  getPublicIdentity
}
