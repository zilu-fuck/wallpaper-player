export type ThemeMode = 'dark' | 'light'

export const darkColors = {
  background: '#0b0f14',
  surface: '#121821',
  surfaceElevated: '#18212d',
  border: '#263241',
  text: '#edf3f8',
  muted: '#9aa8b5',
  subtle: '#6f7d89',
  accent: '#4fb6ff',
  accentStrong: '#2593e6',
  onAccent: '#ffffff',
  success: '#58d68d',
  warning: '#f5c542',
  danger: '#ff6b6b',
  black: '#000000'
}

export const lightColors = {
  background: '#f6f8fb',
  surface: '#ffffff',
  surfaceElevated: '#eef3f8',
  border: '#d8e1ea',
  text: '#111827',
  muted: '#536273',
  subtle: '#8492a3',
  accent: '#1976d2',
  accentStrong: '#155fb4',
  onAccent: '#ffffff',
  success: '#168a4a',
  warning: '#b7791f',
  danger: '#d64545',
  black: '#000000'
}

export type ThemeColors = typeof darkColors

export const themeColors: Record<ThemeMode, ThemeColors> = {
  dark: darkColors,
  light: lightColors
}

export const colors = darkColors

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24
}
