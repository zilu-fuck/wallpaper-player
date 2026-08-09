import * as SecureStore from 'expo-secure-store'
import type { StoredDevice } from '../types'

const DEVICES_KEY = 'wallpaper-player.devices.v1'
const CLIENT_ID_KEY = 'wallpaper-player.client-id.v1'

export async function getClientId() {
  const existing = await SecureStore.getItemAsync(CLIENT_ID_KEY)
  if (existing) return existing

  const randomPart = Math.random().toString(36).slice(2, 12)
  const clientId = `mobile_${Date.now().toString(36)}_${randomPart}`
  await SecureStore.setItemAsync(CLIENT_ID_KEY, clientId)
  return clientId
}

export async function loadDevices(): Promise<StoredDevice[]> {
  const raw = await SecureStore.getItemAsync(DEVICES_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isStoredDevice) : []
  } catch {
    return []
  }
}

export async function saveDevices(devices: StoredDevice[]) {
  await SecureStore.setItemAsync(DEVICES_KEY, JSON.stringify(devices))
}

export async function saveDevice(device: StoredDevice) {
  const devices = await loadDevices()
  const index = devices.findIndex(item => item.id === device.id)
  const next = index >= 0
    ? devices.map(item => item.id === device.id ? device : item)
    : [device, ...devices]
  await saveDevices(next)
}

export async function removeDevice(deviceId: string) {
  const devices = await loadDevices()
  await saveDevices(devices.filter(item => item.id !== deviceId))
}

function isStoredDevice(value: unknown): value is StoredDevice {
  const item = value as StoredDevice
  return Boolean(
    item &&
    typeof item.id === 'string' &&
    typeof item.name === 'string' &&
    typeof item.endpoint === 'string' &&
    typeof item.token === 'string' &&
    (item.pairedDeviceId == null || typeof item.pairedDeviceId === 'string')
  )
}
