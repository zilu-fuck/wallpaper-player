import AsyncStorage from '@react-native-async-storage/async-storage'
import type { ThemeMode } from '../theme'

const SETTINGS_KEY = 'wallpaper-player.settings.v1'

export type MobileSettings = {
  themeMode: ThemeMode
}

const DEFAULT_SETTINGS: MobileSettings = {
  themeMode: 'dark'
}

function normalizeSettings(value: unknown): MobileSettings {
  const source = value && typeof value === 'object' ? value as Partial<MobileSettings> : {}
  return {
    themeMode: source.themeMode === 'light' ? 'light' : DEFAULT_SETTINGS.themeMode
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

export async function saveMobileSettings(settings: MobileSettings) {
  const next = normalizeSettings(settings)
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(next))
  return next
}
