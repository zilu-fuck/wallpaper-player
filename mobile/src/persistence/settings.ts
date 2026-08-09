import AsyncStorage from '@react-native-async-storage/async-storage'
import type { ThemeMode } from '../theme'

const SETTINGS_KEY = 'wallpaper-player.settings.v1'

export type MobilePlayerBackgroundMode = 'black' | 'cover'

export type MobileSettings = {
  themeMode: ThemeMode
  playerBackgroundMode: MobilePlayerBackgroundMode
}

const DEFAULT_SETTINGS: MobileSettings = {
  themeMode: 'dark',
  playerBackgroundMode: 'black'
}

function normalizeSettings(value: unknown): MobileSettings {
  const source = value && typeof value === 'object' ? value as Partial<MobileSettings> : {}
  return {
    themeMode: source.themeMode === 'light' ? 'light' : DEFAULT_SETTINGS.themeMode,
    playerBackgroundMode: source.playerBackgroundMode === 'cover' ? 'cover' : DEFAULT_SETTINGS.playerBackgroundMode
  }
}

export async function loadMobileSettings(): Promise<MobileSettings> {
  const raw = await AsyncStorage.getItem(SETTINGS_KEY)
  if (!raw) return DEFAULT_SETTINGS
  try {
    return normalizeSettings(JSON.parse(raw))
  } catch {
    return DEFAULT_SETTINGS
  }
}

export async function saveMobileSettings(settings: Partial<MobileSettings>) {
  const current = await loadMobileSettings()
  const next = normalizeSettings({ ...current, ...settings })
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(next))
  return next
}
