import AsyncStorage from '@react-native-async-storage/async-storage'
import type { LibraryResponse } from '../types'

const keyForDevice = (deviceId: string) => `wallpaper-player.library.${deviceId}`

export async function loadCachedLibrary(deviceId: string): Promise<LibraryResponse | null> {
  const raw = await AsyncStorage.getItem(keyForDevice(deviceId))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed?.items)) return null
    return parsed as LibraryResponse
  } catch {
    return null
  }
}

export async function saveLibraryResponse(deviceId: string, response: LibraryResponse) {
  await AsyncStorage.setItem(keyForDevice(deviceId), JSON.stringify({
    ...response,
    count: response.count ?? response.items.length,
    scannedAt: response.scannedAt ?? Date.now()
  }))
}
