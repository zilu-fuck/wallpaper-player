import type { ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { loadMobileSettings, saveMobileSettings } from './stores/settings'
import type { ThemeColors, ThemeMode } from './theme'
import { themeColors } from './theme'

type ThemeContextValue = {
  colors: ThemeColors
  themeMode: ThemeMode
  setThemeMode: (mode: ThemeMode) => Promise<void>
}

const ThemeContext = createContext<ThemeContextValue>({
  colors: themeColors.dark,
  themeMode: 'dark',
  setThemeMode: async () => {}
})

type Props = {
  children: ReactNode
}

export function ThemeProvider({ children }: Props) {
  const [themeMode, setThemeModeState] = useState<ThemeMode>('dark')

  useEffect(() => {
    let mounted = true
    loadMobileSettings().then((settings) => {
      if (mounted) setThemeModeState(settings.themeMode)
    })
    return () => {
      mounted = false
    }
  }, [])

  const setThemeMode = useCallback(async (mode: ThemeMode) => {
    const nextMode = mode === 'light' ? 'light' : 'dark'
    setThemeModeState(nextMode)
    await saveMobileSettings({ themeMode: nextMode })
  }, [])

  const value = useMemo(() => ({
    colors: themeColors[themeMode],
    themeMode,
    setThemeMode
  }), [setThemeMode, themeMode])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  return useContext(ThemeContext)
}
