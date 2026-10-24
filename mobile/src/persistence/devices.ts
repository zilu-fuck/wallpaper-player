import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import type { StoredDevice } from '../types'
import { clearDeviceCaches } from './device-caches'

const LEGACY_KEY = 'wallpaper-player.devices.v1'
const INDEX_KEY = 'wallpaper-player.devices.v2'
const CLIENT_ID_KEY = 'wallpaper-player.client-id.v1'
type Metadata = Omit<StoredDevice, 'token'> & { bindingId: string }
type DeviceIndex = { version: 2, devices: Metadata[], garbageTokens: string[], garbageCaches: string[] }
let writeChain: Promise<unknown> = Promise.resolve()
let clientIdPromise: Promise<string> | null = null
type DeviceChange = { deviceId: string, previousBindingId?: string, type: 'removed' | 'rebound' }
const deviceListeners = new Set<(change: DeviceChange) => void>()
export function subscribeDeviceChanges(listener: (change: DeviceChange) => void) {
  deviceListeners.add(listener); return () => { deviceListeners.delete(listener) }
}
function notifyDeviceChange(change: DeviceChange) { deviceListeners.forEach(listener => { try { listener(change) } catch {} }) }

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = writeChain.then(operation)
  writeChain = result.catch(() => {})
  return result
}
function newId() { return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}` }
function tokenKey(bindingId: string) { return `wallpaper-player.device-token.${bindingId}` }
function isDevice(value: unknown): value is StoredDevice {
  const item = value as StoredDevice
  return Boolean(item && typeof item.id === 'string' && item.id && typeof item.name === 'string' &&
    typeof item.endpoint === 'string' && item.endpoint && typeof item.token === 'string' && item.token &&
    (item.pairedDeviceId == null || typeof item.pairedDeviceId === 'string'))
}
function metadata(device: StoredDevice, bindingId: string): Metadata {
  const { token: _token, ...rest } = device
  return { ...rest, bindingId }
}
async function writeIndex(index: DeviceIndex) {
  await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(index))
}
async function cleanup(index: DeviceIndex) {
  if (!index.garbageTokens.length && !index.garbageCaches.length) return
  for (const key of index.garbageTokens) await SecureStore.deleteItemAsync(key)
  for (const id of index.garbageCaches) await clearDeviceCaches(id)
  index.garbageTokens = []
  index.garbageCaches = []
  await writeIndex(index)
}
async function readIndex(): Promise<DeviceIndex> {
  const raw = await AsyncStorage.getItem(INDEX_KEY)
  if (raw) {
    const index = JSON.parse(raw) as DeviceIndex
    if (index.version !== 2 || !Array.isArray(index.devices) || !Array.isArray(index.garbageTokens) ||
      !Array.isArray(index.garbageCaches) || index.devices.some(item => !item.bindingId || !isDevice({ ...item, token: 'validate' }))) {
      throw new Error('设备记录损坏，请重试或恢复设备记录')
    }
    await cleanup(index)
    return index
  }
  const legacy = await SecureStore.getItemAsync(LEGACY_KEY)
  const devices: unknown = legacy ? JSON.parse(legacy) : []
  if (!Array.isArray(devices) || !devices.every(isDevice)) throw new Error('旧设备记录损坏，原记录已保留')
  const index: DeviceIndex = { version: 2, devices: [], garbageTokens: legacy ? [LEGACY_KEY] : [], garbageCaches: [] }
  const created: string[] = []
  try {
    for (const device of devices) {
      const bindingId = newId()
      const key = tokenKey(bindingId)
      await SecureStore.setItemAsync(key, device.token)
      created.push(key)
      index.devices.push(metadata(device, bindingId))
    }
    await writeIndex(index)
  } catch (error) {
    // Legacy data remains authoritative until the index has committed.
    await Promise.allSettled(created.map(key => SecureStore.deleteItemAsync(key)))
    throw error
  }
  await cleanup(index)
  return index
}
async function materialize(item: Metadata): Promise<StoredDevice> {
  const token = await SecureStore.getItemAsync(tokenKey(item.bindingId))
  if (!token) throw new Error(`设备 ${item.name} 的凭证不可用，请重新绑定`)
  return { ...item, token }
}
export function getClientId(): Promise<string> {
  if (!clientIdPromise) {
    clientIdPromise = (async () => {
      const existing = await SecureStore.getItemAsync(CLIENT_ID_KEY)
      if (existing) return existing
      const clientId = `mobile_${newId()}`
      await SecureStore.setItemAsync(CLIENT_ID_KEY, clientId)
      return clientId
    })().catch(error => { clientIdPromise = null; throw error })
  }
  return clientIdPromise
}
export function loadDevices(): Promise<StoredDevice[]> {
  return serialize(async () => Promise.all((await readIndex()).devices.map(materialize)))
}
export function loadDevice(deviceId: string, bindingId: string): Promise<StoredDevice | null> {
  return serialize(async () => {
    const item = (await readIndex()).devices.find(device => device.id === deviceId && device.bindingId === bindingId)
    return item ? materialize(item) : null
  })
}
// Explicit pairing is the only operation allowed to add or replace credentials.
export function saveDevice(device: StoredDevice): Promise<StoredDevice> {
  return serialize(async () => {
    if (!isDevice(device)) throw new Error('设备信息无效')
    const index = await readIndex()
    const previous = index.devices.find(item => item.id === device.id)
    const bindingId = newId()
    const key = tokenKey(bindingId)
    await SecureStore.setItemAsync(key, device.token)
    const next = metadata(device, bindingId)
    const updated: DeviceIndex = { ...index,
      devices: [next, ...index.devices.filter(item => item.id !== device.id)],
      garbageTokens: previous ? [tokenKey(previous.bindingId)] : [],
      garbageCaches: previous ? [device.id] : [] }
    try { await writeIndex(updated) } catch (error) {
      await SecureStore.deleteItemAsync(key).catch(() => {})
      throw error
    }
    notifyDeviceChange({ deviceId: device.id, previousBindingId: previous?.bindingId, type: 'rebound' })
    await cleanup(updated)
    return { ...next, token: device.token }
  })
}
export function runWithCurrentDevice<T>(expected: StoredDevice, operation: (current: StoredDevice) => Promise<T>): Promise<T | null> {
  return serialize(async () => {
    const index = await readIndex()
    const item = index.devices.find(item => item.id === expected.id && item.bindingId === expected.bindingId)
    if (!item) return null
    const current = await materialize(item)
    if (current.token !== expected.token) return null
    return operation(current)
  })
}
export function updateDevice(expected: StoredDevice, patch: Partial<Pick<StoredDevice,
  'name' | 'endpoint' | 'endpoints' | 'capabilities' | 'lastConnectedAt'>>, signal?: AbortSignal): Promise<StoredDevice | null> {
  return runWithCurrentDevice(expected, async current => {
    const index = await readIndex()
    if (signal?.aborted) return null
    const next = { ...current, ...patch }
    await writeIndex({ ...index, devices: index.devices.map(item => item.id === current.id ? metadata(next, item.bindingId) : item) })
    return next
  })
}
export function removeDevice(deviceId: string, bindingId?: string) {
  return serialize(async () => {
    const index = await readIndex()
    const target = index.devices.find(item => item.id === deviceId && (!bindingId || item.bindingId === bindingId))
    if (!target) return
    const next: DeviceIndex = { ...index, devices: index.devices.filter(item => item !== target),
      garbageTokens: [tokenKey(target.bindingId)], garbageCaches: [deviceId] }
    await writeIndex(next)
    notifyDeviceChange({ deviceId, previousBindingId: target.bindingId, type: 'removed' })
    await cleanup(next)
  })
}
