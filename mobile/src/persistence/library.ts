import AsyncStorage from '@react-native-async-storage/async-storage'
import type { LibraryResponse, StoredDevice } from '../types'
import { librarySchema } from '../../../packages/contracts'
import { runWithCurrentDevice } from './devices'

const keyForDevice = (deviceId: string) => `wallpaper-player.library.${deviceId}`
const MAX_LEGACY_CACHE_BYTES = 4 * 1024 * 1024

export async function loadCachedLibrary(device: StoredDevice): Promise<LibraryResponse | null> {
  return runWithCurrentDevice(device, async () => {
    const raw = await AsyncStorage.getItem(keyForDevice(device.id))
    if (!raw || raw.length * 2 > MAX_LEGACY_CACHE_BYTES) return null
    try {
      const parsed = JSON.parse(raw)
      if (parsed.bindingId && parsed.bindingId !== device.bindingId) return null
      return librarySchema.parse(parsed)
    } catch { return null }
  })
}

export async function saveLibraryResponse(device: StoredDevice, response: LibraryResponse) {
  const raw = JSON.stringify({
    ...response,
    bindingId: device.bindingId,
    count: response.count ?? response.items.length,
    scannedAt: response.scannedAt ?? Date.now()
  })
  if (raw.length * 2 <= MAX_LEGACY_CACHE_BYTES) await runWithCurrentDevice(device, () => AsyncStorage.setItem(keyForDevice(device.id), raw))
}
export async function clearCachedLibrary(device: StoredDevice) {
  await runWithCurrentDevice(device, () => AsyncStorage.removeItem(keyForDevice(device.id)))
}
