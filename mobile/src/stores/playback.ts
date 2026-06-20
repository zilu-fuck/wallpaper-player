import AsyncStorage from '@react-native-async-storage/async-storage'

const keyForPlayback = (deviceId: string, videoId: string) => `wallpaper-player.playback.${deviceId}.${videoId}`

export async function loadLocalPlayback(deviceId: string, videoId: string) {
  const raw = await AsyncStorage.getItem(keyForPlayback(deviceId, videoId))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    const position = Number(parsed?.position)
    return Number.isFinite(position) ? { position, updatedAt: Number(parsed?.updatedAt) || 0 } : null
  } catch {
    return null
  }
}

export async function saveLocalPlayback(deviceId: string, videoId: string, position: number) {
  await AsyncStorage.setItem(keyForPlayback(deviceId, videoId), JSON.stringify({
    position: Math.max(0, position),
    updatedAt: Date.now()
  }))
}
