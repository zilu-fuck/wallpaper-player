import { StatusBar as ExpoStatusBar } from 'expo-status-bar'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Animated, BackHandler, Easing, Pressable, StyleSheet, Text, View } from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { AppNavigator } from './src/AppNavigator'
import { NavigationStore, type AppRoute, type NavigationTarget } from './src/services/navigation-store'
import { loadDevices, subscribeDeviceChanges } from './src/persistence/devices'
import { subscribeToVideoLibraryUpdates } from './src/services/library-events'
import { lockOrientation } from './src/services/orientation'
import { ThemeProvider, useTheme } from './src/theme-context'
import { useAccessibilityPreferences } from './src/hooks/useAccessibilityPreferences'

// 原生测试环境可能没有 Animated（模块桩），此时退化为静态视图，不启动任何动画。
const hasAnimated = typeof Animated?.timing === 'function'
const AnimatedView = Animated?.View ?? View
const AnimatedText = Animated?.Text ?? Text

// 开屏至少完整播一轮；启动更快也不会被截断。
const SPLASH_MIN_MS = 680
const SPLASH_FADE_MS = 260

export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <AppShell />
      </ThemeProvider>
    </SafeAreaProvider>
  )
}

export function AppShell() {
  const { colors, themeMode } = useTheme()
  const [resources] = useState(() => new NavigationStore())
  const [stack, setStack] = useState(resources.getSnapshot)
  const bootGeneration = useRef(0)
  const [bootError, setBootError] = useState('')
  const [splashPhase, setSplashPhase] = useState<'visible' | 'leaving' | 'hidden'>('visible')
  const mountedAt = useRef(Date.now())
  const { reduceMotion } = useAccessibilityPreferences()
  const route = stack[stack.length - 1]
  const isImmersivePlayer = route.name === 'player'
  const booting = route.name === 'loading'

  useEffect(() => resources.subscribe(() => setStack(resources.getSnapshot())), [resources])
  useEffect(() => subscribeDeviceChanges(change => {
    resources.invalidateDevice(change.deviceId, change.previousBindingId)
  }), [resources])
  useEffect(() => subscribeToVideoLibraryUpdates(update => {
    resources.updateVideo(update.deviceId, update.bindingId, update.videoId, update.patch)
  }), [resources])

  const boot = useCallback(async () => {
    const generation = ++bootGeneration.current
    setBootError('')
    resources.reset({ name: 'loading' })
    try {
      const devices = await loadDevices()
      if (generation !== bootGeneration.current) return
      resources.setDevices(devices)
      resources.reset({ name: devices.length ? 'devices' : 'pair' })
    } catch (error) {
      if (generation === bootGeneration.current) setBootError(error instanceof Error ? error.message : '启动失败')
    }
  }, [resources])

  useEffect(() => {
    void boot()
    return () => { bootGeneration.current++ }
  }, [boot])

  // 开屏只在「启动完成」后收场；出错时留在原地，让重试按钮可点。
  useEffect(() => {
    if (splashPhase !== 'visible' || booting || bootError) return undefined
    const remaining = Math.max(0, SPLASH_MIN_MS - (Date.now() - mountedAt.current))
    const timer = setTimeout(() => setSplashPhase('leaving'), remaining)
    return () => clearTimeout(timer)
  }, [bootError, booting, splashPhase])

  useEffect(() => {
    if (splashPhase !== 'leaving') return undefined
    const timer = setTimeout(() => setSplashPhase('hidden'), reduceMotion ? 120 : SPLASH_FADE_MS)
    return () => clearTimeout(timer)
  }, [reduceMotion, splashPhase])

  const navigate = useCallback((next: NavigationTarget) => {
    bootGeneration.current++; resources.navigate(next)
  }, [resources])
  const replace = useCallback((next: NavigationTarget) => {
    bootGeneration.current++; resources.replace(next)
  }, [resources])
  const back = resources.back
  const refreshDevices = useCallback(async () => {
    const generation = ++bootGeneration.current
    const devices = await loadDevices()
    if (generation !== bootGeneration.current) return
    resources.setDevices(devices)
    resources.reset({ name: devices.length ? 'devices' : 'pair' })
  }, [resources])

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => back())
    return () => subscription.remove()
  }, [back])

  useEffect(() => {
    if (route.name === 'player') return
    lockOrientation('portrait').catch(() => {})
  }, [route.name])

  const value = useMemo(() => ({
    route, stack, resources, canGoBack: stack.length > 1,
    navigate, replace, back, refreshDevices, boot
  }), [route, stack, resources, navigate, replace, back, refreshDevices, boot])

  return (
    <SafeAreaView
      edges={isImmersivePlayer ? [] : ['top', 'right', 'bottom', 'left']}
      style={[
      styles.shell,
      { backgroundColor: isImmersivePlayer ? '#000000' : colors.background }
    ]}>
      <ExpoStatusBar style={isImmersivePlayer || themeMode === 'dark' ? 'light' : 'dark'} />
      {!booting ? <AppNavigator context={value} /> : null}
      {splashPhase !== 'hidden' ? (
        <View pointerEvents={splashPhase === 'leaving' ? 'none' : 'auto'} style={styles.splashLayer}>
          <Splash colors={colors} error={bootError} boot={boot} />
        </View>
      ) : null}
    </SafeAreaView>
  )
}

export type NavigationContext = {
  route: AppRoute
  stack: readonly AppRoute[]
  resources: NavigationStore
  canGoBack: boolean
  navigate: (route: NavigationTarget) => void
  replace: (route: NavigationTarget) => void
  back: () => boolean
  refreshDevices: () => Promise<void>
  boot: () => Promise<void>
}

type SplashProps = {
  colors: ReturnType<typeof useTheme>['colors']
  error?: string
  boot?: () => void
}

/**
 * 开屏：只用 transform / opacity，走原生驱动，一次性播放，不循环跑满帧。
 * 结构只有「图标 + 标题 + 一根进度条」，避免任何图片资源与模糊滤镜。
 */
function Splash({ colors, error, boot }: SplashProps) {
  const { reduceMotion } = useAccessibilityPreferences()
  const entrance = useRef<Animated.Value | null>(hasAnimated ? new Animated.Value(0) : null).current
  const progress = useRef<Animated.Value | null>(hasAnimated ? new Animated.Value(0) : null).current

  useEffect(() => {
    if (!entrance || !progress || reduceMotion || !hasAnimated) return undefined
    const easing = Easing?.out?.(Easing?.cubic) ?? undefined
    const animation = Animated.parallel([
      Animated.timing(entrance, { toValue: 1, duration: 460, easing, useNativeDriver: true }),
      Animated.timing(progress, { toValue: 1, duration: 760, delay: 120, easing, useNativeDriver: false })
    ])
    animation.start()
    return () => animation.stop()
  }, [entrance, progress, reduceMotion])

  const styles = createSplashStyles(colors)
  const animated = Boolean(entrance && progress && !reduceMotion)
  const markStyle = entrance && animated ? {
    opacity: entrance,
    transform: [{ translateY: entrance.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) },
      { scale: entrance.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) }]
  } : undefined
  const copyStyle = entrance && animated ? {
    opacity: entrance,
    transform: [{ translateY: entrance.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }]
  } : undefined
  const barStyle = progress && animated ? {
    transform: [{ scaleX: progress.interpolate({ inputRange: [0, 1], outputRange: [0.04, 1] }) }]
  } : undefined

  return (
    <View style={styles.splash} accessibilityLabel="正在启动" accessibilityRole="progressbar">
      <AnimatedView style={[styles.mark, markStyle]}>
        <View style={styles.triangle} />
      </AnimatedView>
      <AnimatedView style={[styles.copy, copyStyle]}>
        <AnimatedText style={styles.title}>视频画廊</AnimatedText>
        <AnimatedText style={styles.caption}>WALLPAPER PLAYER</AnimatedText>
      </AnimatedView>
      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText} accessibilityRole="alert">{error}</Text>
          <Pressable style={styles.retryButton} accessibilityRole="button" accessibilityLabel="重试" onPress={boot}>
            <Text style={styles.retryText}>重试</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.track}>
          {animated ? <AnimatedView style={[styles.fill, barStyle]} /> : <View style={[styles.fill, styles.fillStatic]} />}
        </View>
      )}
    </View>
  )
}

const createSplashStyles = (colors: ReturnType<typeof useTheme>['colors']) => StyleSheet.create({
  splash: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32
  },
  mark: {
    width: 74,
    height: 74,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border
  },
  triangle: {
    width: 0,
    height: 0,
    marginLeft: 5,
    borderTopWidth: 12,
    borderBottomWidth: 12,
    borderLeftWidth: 20,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    borderLeftColor: colors.accent
  },
  copy: {
    alignItems: 'center',
    marginTop: 24
  },
  title: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 6
  },
  caption: {
    marginTop: 8,
    color: colors.subtle,
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 3
  },
  track: {
    marginTop: 30,
    width: 116,
    height: 2,
    borderRadius: 2,
    overflow: 'hidden',
    backgroundColor: colors.border
  },
  fill: {
    width: '100%',
    height: '100%',
    borderRadius: 2,
    backgroundColor: colors.accent
  },
  fillStatic: {
    width: '100%'
  },
  errorBox: {
    marginTop: 28,
    width: '100%',
    maxWidth: 320,
    alignItems: 'center',
    gap: 12
  },
  errorText: {
    color: colors.danger,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center'
  },
  retryButton: {
    minWidth: 132,
    minHeight: 48,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
    backgroundColor: colors.accentStrong
  },
  retryText: {
    color: colors.onAccent,
    fontSize: 15,
    fontWeight: '800'
  }
})

const styles = StyleSheet.create({
  shell: {
    flex: 1
  },
  splashLayer: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0
  }
})