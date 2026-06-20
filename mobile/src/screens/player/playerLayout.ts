import { Platform, StatusBar } from 'react-native'

export const DOUBLE_TAP_MS = 280
export const LONG_PRESS_DELAY_MS = 360
export const CONTROLS_HIDE_DELAY_MS = 3000
export const TOP_SAFE_OFFSET = Platform.OS === 'android' ? StatusBar.currentHeight || 0 : 44
export const BOTTOM_SAFE_OFFSET = Platform.OS === 'android' ? 18 : 34
export const HIT_SLOP = { top: 8, right: 8, bottom: 8, left: 8 }
