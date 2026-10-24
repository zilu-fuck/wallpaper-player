import { ApiError, getInfo, getUpdateServerInfo, measureDownloadSpeed, probeAuthorization } from './api'
import { runWithCurrentDevice, subscribeDeviceChanges, updateDevice } from '../persistence/devices'
import type { StoredDevice } from '../types'
import { uniqueEndpoints } from '../utils/url'

type ConnectionProgress = { progress: number, title: string, detail: string }
type ProgressCallback = (progress: ConnectionProgress) => void
export type DeviceAvailability = { state: 'online' | 'offline' | 'unauthorized' | 'mismatch', text: string, endpoint?: string }
type Candidate = { endpoint: string, info: Awaited<ReturnType<typeof getInfo>> }
type ConnectionResult = { device: StoredDevice, serverProtocol: number, minClientProtocol: number }
type ConnectionMode = 'connect' | 'update'
type Flight = { controller: AbortController, token: string, consumers: Map<symbol, ProgressCallback | undefined>, promise: Promise<ConnectionResult> }
const flights = new Map<string, Flight>()
const speeds = new Map<string, { at: number, mbps: number }>()
const SPEED_TTL_MS = 60000
const MAX_PROBES = 2
let running = 0
const queue: Array<{ priority: number, signal: AbortSignal, start: () => void, cancel: () => void }> = []
const abortError = () => Object.assign(new Error('连接检查已取消'), { name: 'AbortError' })
const throwIfAborted = (signal: AbortSignal) => { if (signal.aborted) throw abortError() }
const isAuthError = (error: unknown) => error instanceof ApiError && [401, 403].includes(error.status)
function drain() {
  while (running < MAX_PROBES && queue.length) {
    queue.sort((a, b) => b.priority - a.priority)
    const item = queue.shift()!
    item.signal.removeEventListener('abort', item.cancel)
    if (item.signal.aborted) { item.cancel(); continue }
    running++; item.start()
  }
}
function probe<T>(signal: AbortSignal, priority: number, run: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return }
    if (queue.length >= 64) { reject(new ApiError('连接检查繁忙，请稍后重试', 503, 'connection_queue_full')); return }
    const item = { signal, priority, cancel() {
      const index = queue.indexOf(item); if (index >= 0) queue.splice(index, 1)
      signal.removeEventListener('abort', item.cancel); reject(abortError())
    }, start() {
      Promise.resolve().then(() => { throwIfAborted(signal); return run() }).then(resolve, reject)
        .finally(() => { running--; drain() })
    } }
    queue.push(item); signal.addEventListener('abort', item.cancel, { once: true }); drain()
  })
}
function notify(flight: Flight, progress: ConnectionProgress) {
  flight.consumers.forEach(callback => { try { callback?.(progress) } catch {} })
}
async function discover(device: StoredDevice, flight: Flight, priority: number, mode: ConnectionMode) {
  const signal = flight.controller.signal, candidates = uniqueEndpoints(device.endpoint, device.endpoints).slice(0, 8)
  let mismatch = false
  const inspect = async (endpoint: string): Promise<Candidate | null> => {
    try {
      const info = await probe(signal, priority, () => mode === 'update' ? getUpdateServerInfo(endpoint, signal) : getInfo(endpoint, signal)); throwIfAborted(signal)
      if (info.deviceId !== device.id) { mismatch = true; return null }
      return { endpoint, info }
    } catch (error) {
      throwIfAborted(signal)
      if (error instanceof ApiError && !error.retryable) throw error
      return null
    }
  }
  const authorize = async (candidate: Candidate) => {
    if (!await runWithCurrentDevice(device, async () => true)) throw new ApiError('设备已移除或重新绑定。', 409, 'device_binding_changed', false)
    throwIfAborted(signal)
    await probe(signal, priority, () => probeAuthorization(candidate.endpoint, device.token, candidate.info, signal))
    throwIfAborted(signal)
    return candidate
  }
  notify(flight, { progress: .22, title: '正在连接电脑', detail: '正在检查上次可用地址与授权…' })
  const preferred = candidates[0] ? await inspect(candidates[0]) : null
  if (preferred) {
    try { return await authorize(preferred) } catch (error) {
      throwIfAborted(signal)
      if (isAuthError(error) || error instanceof ApiError && !error.retryable) throw error
    }
  }
  notify(flight, { progress: .4, title: '正在查找电脑', detail: '正在检查备用局域网地址…' })
  const matches = (await Promise.all(candidates.slice(1).map(inspect))).filter((item): item is Candidate => Boolean(item))
    .sort((a, b) => a.info.latencyMs - b.info.latencyMs)
  const valid: Candidate[] = []
  for (const candidate of matches) {
    try { valid.push(await authorize(candidate)) } catch (error) {
      throwIfAborted(signal)
      if (isAuthError(error) || error instanceof ApiError && !error.retryable) throw error
    }
    if (valid.length === 2 || mode === 'update') break
  }
  if (!valid.length) throw new ApiError(mismatch ? '保存的地址属于另一台电脑，请重新绑定。' : '无法连接电脑，请检查局域网地址。',
    mismatch ? 409 : 0, mismatch ? 'device_mismatch' : 'network_error', !mismatch)
  if (valid.length === 1 || mode === 'update') return valid[0]
  notify(flight, { progress: .55, title: '正在选择备用线路', detail: '仅比较已验证身份的可用线路…' })
  const measured = await Promise.all(valid.map(async candidate => {
    const key = device.id + '|' + device.bindingId + '|' + candidate.endpoint
    let speed = speeds.get(key)
    if (!speed || Date.now() - speed.at > SPEED_TTL_MS) {
      const result = await probe(signal, priority, () => measureDownloadSpeed(candidate.endpoint, device.token, 256 * 1024, signal))
      throwIfAborted(signal); speed = { at: Date.now(), mbps: result.mbps }; speeds.delete(key); speeds.set(key, speed)
      while (speeds.size > 32) speeds.delete(speeds.keys().next().value!)
    }
    return { ...candidate, mbps: speed.mbps }
  }))
  return measured.sort((a, b) => b.mbps - a.mbps)[0]
}
function connect(device: StoredDevice, onProgress: ProgressCallback | undefined, signal: AbortSignal | undefined, priority: number, mode: ConnectionMode = 'connect'): Promise<ConnectionResult> {
  device = { ...device, endpoints: device.endpoints?.slice() }
  if (signal?.aborted) return Promise.reject(abortError())
  const key = JSON.stringify([device.id, device.bindingId, device.endpoint, device.endpoints, mode])
  let flight = device.bindingId ? flights.get(key) : undefined
  if (!flight || flight.controller.signal.aborted || flight.token !== device.token) {
    const owned: Flight = { controller: new AbortController(), token: device.token, consumers: new Map(), promise: null! }
    let timedOut = false, bindingChanged = false
    const unsubscribe = subscribeDeviceChanges(change => {
      if (change.deviceId === device.id && change.previousBindingId === device.bindingId) {
        bindingChanged = true; owned.controller.abort()
      }
    })
    const timer = setTimeout(() => { timedOut = true; owned.controller.abort() }, 15000)
    owned.promise = Promise.resolve().then(async () => {
      const current = await runWithCurrentDevice(device, async value => value)
      if (!current) throw new ApiError('设备已移除或重新绑定。', 409, 'device_binding_changed', false)
      throwIfAborted(owned.controller.signal)
      const selected = await discover(current, owned, priority, mode); throwIfAborted(owned.controller.signal)
      const next = mode === 'update' ? await runWithCurrentDevice(current, async value => value) : await updateDevice(current, { name: selected.info.deviceName || device.name, capabilities: selected.info.capabilities,
        endpoint: selected.endpoint, endpoints: uniqueEndpoints(selected.endpoint, selected.info.endpoint, selected.info.endpoints, device.endpoints),
        lastConnectedAt: Date.now() }, owned.controller.signal)
      throwIfAborted(owned.controller.signal)
      if (!next) throw new ApiError('设备已移除或重新绑定，请返回设备列表。', 409, 'device_binding_changed', false)
      notify(owned, { progress: .7, title: '连接已建立', detail: '当前电脑身份和授权已验证。' })
      return { device: next, serverProtocol: selected.info.protocolVersion, minClientProtocol: selected.info.minClientProtocol }
    }).catch(error => {
      if (bindingChanged) throw new ApiError('设备已移除或重新绑定。', 409, 'device_binding_changed', false)
      if (timedOut) throw new ApiError('连接检查超时，请重试。', 408, 'timeout', true)
      if (isAuthError(error)) throw new ApiError('电脑已取消授权或关闭旧 Token 入口，请重新扫码绑定。', error.status, error.code, false)
      throw error
    }).finally(() => { clearTimeout(timer); unsubscribe(); if (flights.get(key) === owned) flights.delete(key) })
    flight = owned
    if (device.bindingId) flights.set(key, owned)
  }
  const shared = flight, consumer = Symbol('connection')
  shared.consumers.set(consumer, onProgress)
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (result?: ConnectionResult, error?: unknown) => {
      if (settled) return; settled = true; signal?.removeEventListener('abort', cancel)
      shared.consumers.delete(consumer)
      if (error) reject(error); else resolve(result!)
    }
    const cancel = () => { finish(undefined, abortError()); if (!shared.consumers.size) shared.controller.abort() }
    signal?.addEventListener('abort', cancel, { once: true })
    shared.promise.then(result => finish(result), error => finish(undefined, error))
  })
}
export function testConnection(device: StoredDevice, onProgress?: ProgressCallback, signal?: AbortSignal) {
  return connect(device, onProgress, signal, 10).then(result => result.device)
}
export async function confirmUpdateServerProtocol(device: StoredDevice, signal?: AbortSignal) {
  const result = await connect(device, undefined, signal, 10, 'update')
  return { deviceId: result.device.id, bindingId: result.device.bindingId, serverProtocol: result.serverProtocol, minClientProtocol: result.minClientProtocol }
}
export async function checkDeviceAvailability(device: StoredDevice, signal?: AbortSignal): Promise<DeviceAvailability> {
  try {
    const connected = await connect(device, undefined, signal, 0)
    return { state: 'online', text: '在线', endpoint: connected.device.endpoint }
  } catch (error) {
    if (signal?.aborted || error instanceof Error && error.name === 'AbortError') throw error
    if (isAuthError(error)) return { state: 'unauthorized', text: '授权已失效' }
    if (error instanceof ApiError && error.code === 'device_mismatch') return { state: 'mismatch', text: '地址属于另一台电脑' }
    return { state: 'offline', text: error instanceof ApiError && error.code === 'device_binding_changed' ? '设备已移除或重新绑定' : '离线' }
  }
}
export function connectionDiagnostics() { return { active: running, queued: queue.length, shared: flights.size, speedSamples: speeds.size } }
