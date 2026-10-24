import AsyncStorage from '@react-native-async-storage/async-storage'

export async function clearDeviceCaches(deviceId: string) {
  const prefixes = [`wallpaper-player.playback.${deviceId}.`, `wallpaper-player.playback-outbox.${deviceId}.`]
  const keys = await AsyncStorage.getAllKeys()
  const matching = keys.filter(key => key === `wallpaper-player.library.${deviceId}` || key === `wallpaper-player.library-pages.${deviceId}` ||
    prefixes.some(prefix => key.startsWith(prefix)))
  if (matching.length) await AsyncStorage.multiRemove(matching)
}
