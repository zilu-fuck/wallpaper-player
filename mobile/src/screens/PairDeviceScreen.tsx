import * as Clipboard from 'expo-clipboard'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { Camera, QrCode } from 'lucide-react-native'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, BackHandler, Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native'
import type { NavigationContext } from '../../App'
import { MobileUpdateCard } from '../components/MobileUpdateCard'
import { PrimaryButton } from '../components/PrimaryButton'
import { createDeviceFromPairingPayload, createManualDevice, parsePairingCode } from '../services/pairing'
import { saveDevice } from '../persistence/devices'
import { colors as fixedColors } from '../theme'
import { useTheme } from '../theme-context'
import { usePageActivity } from '../hooks/usePageActivity'

type Props = {
  navigation: NavigationContext
}

export function PairDeviceScreen({ navigation }: Props) {
  const pageActive = usePageActivity()
  const { fontScale = 1 } = useWindowDimensions()
  const largeText = fontScale >= 1.5
  const { colors } = useTheme()
  const styles = createStyles(colors)
  const [endpoint, setEndpoint] = useState('')
  const [token, setToken] = useState('')
  const [pairingCode, setPairingCode] = useState('')
  const [error, setError] = useState('')
  const [loadingText, setLoadingText] = useState('')
  const [loading, setLoading] = useState(false)
  const [scannerOpen, setScannerOpen] = useState(false)
  const [legacyOpen, setLegacyOpen] = useState(false)
  const [inputPending, setInputPending] = useState(false)
  const [permission, requestPermission] = useCameraPermissions()
  const barcodeHandledRef = useRef(true)
  const requestRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)
  const pageActiveRef = useRef(pageActive)
  pageActiveRef.current = pageActive
  const scannerRequestRef = useRef<{ granted: boolean } | null>(null)
  const inputGeneration = useRef(0)
  const busy = loading || inputPending

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      scannerRequestRef.current = null
      inputGeneration.current++
      requestRef.current?.abort()
    }
  }, [])

  const saveAndContinue = useCallback(async (
    create: (signal: AbortSignal) => Promise<ReturnType<typeof createManualDevice> extends Promise<infer T> ? T : never>,
    options: { loadingText?: string } = {}
  ) => {
    scannerRequestRef.current = null
    inputGeneration.current++
    setInputPending(false)
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    setLoading(true)
    setLoadingText(options.loadingText || '')
    setError('')
    try {
      const device = await create(controller.signal)
      if (controller.signal.aborted || !mountedRef.current) return
      const savedDevice = await saveDevice(device)
      if (controller.signal.aborted || !mountedRef.current) return
      navigation.navigate({ name: 'library', device: savedDevice })
    } catch (err) {
      if (!mountedRef.current || controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) return
      setError(err instanceof Error ? err.message : '绑定失败')
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null
        if (mountedRef.current) {
          setLoading(false)
          setLoadingText('')
        }
      }
    }
  }, [navigation])

  const abortPairingWork = useCallback(() => {
    inputGeneration.current++
    requestRef.current?.abort()
    requestRef.current = null
    setLoading(false)
    setLoadingText('')
  }, [])

  const cancelPairing = useCallback(() => {
    scannerRequestRef.current = null
    setInputPending(false)
    abortPairingWork()
  }, [abortPairingWork])

  const closeScanner = useCallback(() => {
    scannerRequestRef.current = null
    inputGeneration.current++
    barcodeHandledRef.current = true
    setInputPending(false)
    setScannerOpen(false)
  }, [])

  const openGrantedScanner = useCallback(() => {
    const request = scannerRequestRef.current
    if (!request?.granted || !mountedRef.current || !pageActiveRef.current || (AppState.currentState && AppState.currentState !== 'active')) return
    scannerRequestRef.current = null
    barcodeHandledRef.current = false
    setInputPending(false)
    setScannerOpen(true)
  }, [])

  useEffect(() => {
    if (!pageActive) {
      barcodeHandledRef.current = true
      setScannerOpen(false)
      abortPairingWork()
      // A system permission prompt may background the app. Keep only this
      // explicit camera request; clipboard and pairing work still expire.
      setInputPending(Boolean(scannerRequestRef.current))
    } else openGrantedScanner()
  }, [pageActive, abortPairingWork, openGrantedScanner])

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (scannerOpen) { closeScanner(); return true }
      if (busy) { cancelPairing(); return true }
      return false
    })
    return () => subscription.remove()
  }, [busy, scannerOpen, closeScanner, cancelPairing])

  const handleManualPair = useCallback(() => {
    Keyboard.dismiss()
    saveAndContinue(() => createManualDevice(endpoint, token))
  }, [endpoint, token, saveAndContinue])

  const handlePairingCode = useCallback((value: string) => {
    Keyboard.dismiss()
    const payload = parsePairingCode(value)
    if (!payload) {
      setError('绑定码不是 Wallpaper Player 绑定码')
      return
    }
    saveAndContinue((signal) => createDeviceFromPairingPayload(payload, token, signal), {
      loadingText: payload.pairingId ? '已提交绑定请求，等待电脑端允许绑定...' : ''
    })
  }, [saveAndContinue, token])

  const handlePastePairingCode = useCallback(async () => {
    scannerRequestRef.current = null
    const generation = ++inputGeneration.current
    setInputPending(true)
    setError('')
    try {
      const value = (await Clipboard.getStringAsync()).trim()
      if (!mountedRef.current || generation !== inputGeneration.current) return
      setPairingCode(value)
      handlePairingCode(value)
    } catch {
      if (mountedRef.current && generation === inputGeneration.current) setError('无法读取剪贴板，请手动粘贴绑定码')
    } finally {
      if (mountedRef.current && generation === inputGeneration.current) setInputPending(false)
    }
  }, [handlePairingCode])

  const handleOpenScanner = useCallback(async () => {
    if (!mountedRef.current || !pageActiveRef.current || (AppState.currentState && AppState.currentState !== 'active')) return
    inputGeneration.current++
    const request = { granted: false }
    scannerRequestRef.current = request
    setInputPending(true)
    setError('')
    try {
      const result = permission?.granted ? permission : await requestPermission()
      if (!mountedRef.current || scannerRequestRef.current !== request) return
      if (!result.granted) {
        scannerRequestRef.current = null
        setInputPending(false)
        setError('需要相机权限才能扫描二维码')
        return
      }
      request.granted = true
      openGrantedScanner()
    } catch {
      if (mountedRef.current && scannerRequestRef.current === request) {
        scannerRequestRef.current = null
        setInputPending(false)
        setError('无法打开相机，请使用绑定码')
      }
    }
  }, [permission?.granted, requestPermission, openGrantedScanner])

  const handleBarcode = useCallback((result: { data?: string; raw?: string; nativeEvent?: { data?: string; raw?: string } }) => {
    if (!mountedRef.current || barcodeHandledRef.current) return
    barcodeHandledRef.current = true
    setScannerOpen(false)
    const data = result.data || result.raw || result.nativeEvent?.data || result.nativeEvent?.raw || ''
    const payload = parsePairingCode(data)
    if (!payload) {
      setError('二维码不是 Wallpaper Player 绑定码')
      return
    }
    saveAndContinue((signal) => createDeviceFromPairingPayload(payload, token, signal), {
      loadingText: payload.pairingId ? '已扫码，等待电脑端允许绑定...' : ''
    })
  }, [saveAndContinue, token])

  if (scannerOpen && pageActive) {
    return (
      <View style={styles.scannerShell} onAccessibilityEscape={closeScanner}>
        <CameraView
          style={StyleSheet.absoluteFill}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={handleBarcode}
        />
        <ScrollView style={styles.scannerTop} contentContainerStyle={styles.scannerInstructions}>
          <Text accessibilityRole="header" style={styles.scannerTitle}>扫描电脑端二维码</Text>
          <Text style={styles.scannerHint}>在电脑端“手机访问”里生成二维码，扫码后会自动完成一次性绑定。</Text>
        </ScrollView>
        <Pressable accessibilityRole="button" accessibilityLabel="取消扫描" style={styles.scannerClose} onPress={closeScanner}>
          <Text style={styles.scannerCloseText}>取消</Text>
        </Pressable>
      </View>
    )
  }

  return (
    <KeyboardAvoidingView style={styles.shell} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.headerIcon}>
          <QrCode color={colors.accent} size={34} />
        </View>
        <Text accessibilityRole="header" style={styles.title}>连接电脑</Text>
        <Text style={styles.subtitle}>
          推荐扫描电脑端“手机访问”里的二维码；如果 Expo Go 扫不了，也可以复制绑定码后在这里粘贴。
        </Text>

        <PrimaryButton
          label="扫描二维码"
          variant="secondary"
          icon={<Camera color={colors.text} size={20} />}
          disabled={busy}
          onPress={handleOpenScanner}
        />

        <View style={styles.form}>
          <View style={styles.labelRow}>
            <Text style={styles.label}>绑定码</Text>
            {pairingCode ? (
              <Pressable accessibilityRole="button" accessibilityLabel="清空绑定码" style={styles.clearFieldButton} disabled={busy} accessibilityState={{ disabled: busy }} onPress={() => setPairingCode('')}>
                <Text style={styles.clearFieldText}>清空</Text>
              </Pressable>
            ) : null}
          </View>
          <TextInput
            accessibilityLabel="绑定码"
            editable={!busy}
            value={pairingCode}
            onChangeText={setPairingCode}
            placeholder="从电脑端复制绑定码后粘贴"
            placeholderTextColor={colors.subtle}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            style={[styles.input, styles.codeInput]}
          />
          <View style={[styles.inlineActions, largeText && styles.stackedActions]}>
            <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy, busy: inputPending }} style={[styles.secondaryAction, largeText && styles.stackedAction, busy && styles.actionDisabled]} onPress={handlePastePairingCode} disabled={busy}>
              <Text style={styles.secondaryActionText}>粘贴并绑定</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} style={[styles.secondaryAction, largeText && styles.stackedAction, busy && styles.actionDisabled]} onPress={() => handlePairingCode(pairingCode)} disabled={busy}>
              <Text style={styles.secondaryActionText}>使用绑定码</Text>
            </Pressable>
          </View>
        </View>

        <Pressable accessibilityRole="button" accessibilityState={{ expanded: legacyOpen }} style={styles.legacyToggle} onPress={() => setLegacyOpen(value => !value)}>
          <Text style={styles.legacyToggleText}>
            {legacyOpen ? '收起旧版手动连接' : '旧版手动连接'}
          </Text>
        </Pressable>

        {legacyOpen ? (
          <View style={styles.form}>
            <Text style={styles.sectionHint}>仅用于已在电脑端开启“兼容旧版手动 Token”的情况。</Text>
            <View style={styles.labelRow}>
              <Text style={styles.label}>电脑访问地址</Text>
              {endpoint ? (
                <Pressable accessibilityRole="button" accessibilityLabel="清空电脑访问地址" disabled={busy} accessibilityState={{ disabled: busy }} style={styles.clearFieldButton} onPress={() => setEndpoint('')}>
                  <Text style={styles.clearFieldText}>清空</Text>
                </Pressable>
              ) : null}
            </View>
            <TextInput
              accessibilityLabel="电脑访问地址"
              editable={!busy}
              value={endpoint}
              onChangeText={setEndpoint}
              placeholder="例如 192.168.1.105:38127"
              placeholderTextColor={colors.subtle}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              style={styles.input}
            />

            <View style={styles.labelRow}>
              <Text style={styles.label}>访问 token</Text>
              {token ? (
                <Pressable accessibilityRole="button" accessibilityLabel="清空访问 token" disabled={busy} accessibilityState={{ disabled: busy }} style={styles.clearFieldButton} onPress={() => setToken('')}>
                  <Text style={styles.clearFieldText}>清空</Text>
                </Pressable>
              ) : null}
            </View>
            <TextInput
              accessibilityLabel="访问 token"
              editable={!busy}
              value={token}
              onChangeText={setToken}
              placeholder="从电脑端设置页复制"
              placeholderTextColor={colors.subtle}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              style={styles.input}
            />
            <PrimaryButton label="使用旧版 Token 连接" disabled={busy} loading={loading} onPress={handleManualPair} />
          </View>
        ) : null}

        {error ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.error}>{error}</Text> : null}

        {loadingText ? <Text accessibilityLiveRegion="polite" style={styles.loadingText}>{loadingText}</Text> : null}

        {busy ? (
          <Pressable accessibilityRole="button" style={styles.cancelPairingButton} onPress={cancelPairing}>
            <Text style={styles.cancelPairingText}>取消绑定</Text>
          </Pressable>
        ) : null}

        <MobileUpdateCard />

        <Pressable
          accessibilityRole="button"
          onPress={() => {
            cancelPairing()
            navigation.refreshDevices()
          }}
          style={styles.footerLink}
        >
          <Text style={styles.footerLinkText}>查看已保存电脑</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const createStyles = (colors: ReturnType<typeof useTheme>['colors']) => StyleSheet.create({
  shell: {
    flex: 1,
    backgroundColor: colors.background
  },
  content: {
    flexGrow: 1,
    padding: 24,
    justifyContent: 'center',
    gap: 16
  },
  headerIcon: {
    width: 72,
    height: 72,
    borderRadius: 20,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center'
  },
  title: {
    color: colors.text,
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: 0.4
  },
  subtitle: {
    color: colors.muted,
    fontSize: 15,
    lineHeight: 22
  },
  form: {
    gap: 8,
    marginTop: 8
  },
  label: {
    flexShrink: 1,
    color: colors.text,
    fontSize: 14,
    fontWeight: '700'
  },
  labelRow: {
    minHeight: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12
  },
  clearFieldButton: {
    minHeight: 48,
    minWidth: 48,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center'
  },
  clearFieldText: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: '700'
  },
  input: {
    minHeight: 48,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.text,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    marginBottom: 8
  },
  codeInput: {
    minHeight: 86,
    textAlignVertical: 'top',
    paddingTop: 12
  },
  inlineActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10
  },
  secondaryAction: {
    flexGrow: 1,
    flexBasis: 128,
    minHeight: 48,
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center'
  },
  stackedActions: { flexDirection: 'column' },
  stackedAction: { flexBasis: 'auto', flexGrow: 0 },
  secondaryActionText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '700'
  },
  actionDisabled: {
    opacity: 0.55
  },
  sectionHint: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 19
  },
  legacyToggle: {
    alignSelf: 'flex-start',
    minHeight: 48,
    justifyContent: 'center',
    paddingVertical: 12
  },
  legacyToggleText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: '700'
  },
  error: {
    color: colors.danger,
    fontSize: 14,
    lineHeight: 20
  },
  loadingText: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20
  },
  cancelPairingButton: {
    alignSelf: 'flex-start',
    minHeight: 48,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center'
  },
  cancelPairingText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '700'
  },
  footerLink: {
    alignSelf: 'center',
    minHeight: 48,
    justifyContent: 'center',
    padding: 12
  },
  footerLinkText: {
    color: colors.accent,
    fontWeight: '700'
  },
  scannerShell: {
    flex: 1,
    backgroundColor: fixedColors.black
  },
  scannerTop: {
    position: 'absolute',
    left: 24,
    right: 24,
    top: 16,
    maxHeight: '60%',
    borderRadius: 16,
    backgroundColor: colors.overlay
  },
  scannerInstructions: { padding: 16 },
  scannerTitle: {
    color: fixedColors.text,
    fontSize: 20,
    fontWeight: '800'
  },
  scannerHint: {
    color: fixedColors.muted,
    marginTop: 6,
    lineHeight: 20
  },
  scannerClose: {
    position: 'absolute',
    left: 24,
    right: 24,
    bottom: 40,
    minHeight: 48,
    borderRadius: 14,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center'
  },
  scannerCloseText: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '700'
  }
})
