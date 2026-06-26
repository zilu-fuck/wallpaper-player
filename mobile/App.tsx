import { StatusBar as ExpoStatusBar } from 'expo-status-bar'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, BackHandler, Platform, SafeAreaView, StatusBar as NativeStatusBar, StyleSheet, Text, View } from 'react-native'
import { AppNavigator, type AppRoute } from './src/AppNavigator'
import { loadDevices } from './src/stores/devices'
import { ThemeProvider, useTheme } from './src/theme-context'
import type { StoredDevice } from './src/types'

export default function App() {
  return (
    <ThemeProvider>
      <AppShell />
    </ThemeProvider>
  )
}

function AppShell() {
  const { colors, themeMode } = useTheme()
  const [navigationState, setNavigationState] = useState<{ route: AppRoute, previousRoute: AppRoute | null }>({
    route: { name: 'loading' },
    previousRoute: null
  })
  // 同步镜像 navigationState，供 back() 在 setNavigationState updater 外同步读取
  const navigationStateRef = useRef(navigationState)
  useEffect(() => {
    navigationStateRef.current = navigationState
  }, [navigationState])
  const [bootError, setBootError] = useState('')
  const { route, previousRoute } = navigationState
  const isImmersivePlayer = route.name === 'player'

  const boot = useCallback(async () => {
    setBootError('')
    try {
      const devices = await loadDevices()
      setNavigationState({
        route: devices.length > 0 ? { name: 'devices', devices } : { name: 'pair' },
        previousRoute: null
      })
    } catch (error) {
      setBootError(error instanceof Error ? error.message : '启动失败')
      setNavigationState({ route: { name: 'pair' }, previousRoute: null })
    }
  }, [])

  useEffect(() => {
    boot()
  }, [boot])

  const navigate = useCallback((next: AppRoute) => {
    setNavigationState(current => ({
      route: next,
      previousRoute: current.route.name === 'loading' ? null : current.route
    }))
  }, [])

  const replace = useCallback((next: AppRoute) => {
    setNavigationState(current => ({ ...current, route: next }))
  }, [])

  const back = useCallback(() => {
    // 在 updater 外读取当前状态决定返回值，避免 handled 在异步 updater 内赋值导致同步返回 false
    const current = navigationStateRef.current
    const previousRoute = current.previousRoute
    if (!previousRoute) return false
    // 直接返回新状态（不使用乐观锁），让 React 批处理按 updater 队列顺序应用
    // navigate/replace 也是 updater 形式，back 会排在它们之后，最终 state 以 back 为准
    setNavigationState({
      route: previousRoute,
      previousRoute: null
    })
    return true
  }, [])

  const refreshDevices = useCallback(async () => {
    const devices = await loadDevices()
    setNavigationState({
      route: devices.length > 0 ? { name: 'devices', devices } : { name: 'pair' },
      previousRoute: null
    })
  }, [])

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => back())
    return () => subscription.remove()
  }, [back])

  const value = useMemo(() => ({
    route,
    previousRoute,
    canGoBack: Boolean(previousRoute),
    navigate,
    replace,
    back,
    refreshDevices,
    boot
  }), [route, previousRoute, navigate, replace, back, refreshDevices, boot])

  const Shell = isImmersivePlayer ? View : SafeAreaView

  return (
    <Shell style={[
      styles.shell,
      { backgroundColor: isImmersivePlayer ? '#000000' : colors.background },
      !isImmersivePlayer && styles.safeShell
    ]}>
      <NativeStatusBar
        backgroundColor={isImmersivePlayer ? 'transparent' : colors.background}
        barStyle={isImmersivePlayer || themeMode === 'dark' ? 'light-content' : 'dark-content'}
        translucent={isImmersivePlayer}
      />
      <ExpoStatusBar style={isImmersivePlayer || themeMode === 'dark' ? 'light' : 'dark'} />
      {route.name === 'loading' ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.accent} />
          <Text style={[styles.loadingText, { color: colors.text }]}>正在准备手机端...</Text>
          {bootError ? <Text style={[styles.errorText, { color: colors.danger }]}>{bootError}</Text> : null}
        </View>
      ) : (
        <AppNavigator context={value} />
      )}
    </Shell>
  )
}

export type NavigationContext = {
  route: AppRoute
  previousRoute: AppRoute | null
  canGoBack: boolean
  navigate: (route: AppRoute) => void
  replace: (route: AppRoute) => void
  back: () => boolean
  refreshDevices: () => Promise<void>
  boot: () => Promise<void>
}

export type DeviceRoutePayload = {
  devices: StoredDevice[]
}

const styles = StyleSheet.create({
  shell: {
    flex: 1
  },
  safeShell: {
    paddingTop: Platform.OS === 'android' ? NativeStatusBar.currentHeight || 0 : 0
  },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 12
  },
  loadingText: {
    fontSize: 16
  },
  errorText: {
    textAlign: 'center'
  }
})
