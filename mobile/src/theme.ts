export type ThemeMode = 'dark' | 'light'

// 与桌面端同一套视觉语言的移动端配色：
// - 深色：冷调近黑 + 低饱和玻璃面，避免「纯黑 OLED + 亮蓝」的廉价感
// - 浅色：偏冷的纸白，层级靠极淡的蓝灰而不是粗边框
// 语义色对比度均由 verify-mobile-accessibility 校验（正文 ≥ 4.5）。
export const darkColors = {
  background: '#070b12',
  surface: '#0f1724',
  surfaceElevated: '#172233',
  border: '#243247',
  text: '#f2f6fb',
  muted: '#a3b2c6',
  subtle: '#93a2b6',
  accent: '#4cc9f0',
  accentStrong: '#1d5fd0',
  onAccent: '#ffffff',
  success: '#58d68d',
  warning: '#f5c542',
  danger: '#ff6b6b',
  black: '#000000',
  overlay: 'rgba(4, 8, 14, 0.72)',
  scrim: 'rgba(3, 6, 12, 0.55)'
}

export const lightColors = {
  background: '#f4f7fb',
  surface: '#ffffff',
  surfaceElevated: '#eaf0f8',
  border: '#d7e0ec',
  text: '#0f1724',
  muted: '#4a5a6e',
  subtle: '#546476',
  accent: '#0e7fa8',
  accentStrong: '#1558b8',
  onAccent: '#ffffff',
  success: '#0f7a43',
  warning: '#9a5b00',
  danger: '#c0392b',
  black: '#000000',
  overlay: 'rgba(16, 24, 40, 0.42)',
  scrim: 'rgba(16, 24, 40, 0.32)'
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
