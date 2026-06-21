import * as Clipboard from 'expo-clipboard'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { Camera, QrCode } from 'lucide-react-native'
import { useCallback, useRef, useState } from 'react'
import { Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import type { NavigationContext } from '../../App'
import { PrimaryButton } from '../components/PrimaryButton'
import { createDeviceFromPairingPayload, createManualDevice, parsePairingCode } from '../services/pairing'
import { saveDevice } from '../stores/devices'
import { colors as fixedColors } from '../theme'
import { useTheme } from '../theme-context'

type Props = {
  navigation: NavigationContext
}

export function PairDeviceScreen({ navigation }: Props) {
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
  const [permission, requestPermission] = useCameraPermissions()
  const barcodeHandledRef = useRef(false)

  const saveAndContinue = useCallback(async (
    create: () => Promise<ReturnType<typeof createManualDevice> extends Promise<infer T> ? T : never>,
    options: { loadingText?: string } = {}
  ) => {
    setLoading(true)
    setLoadingText(options.loadingText || '')
    setError('')
    try {
      const device = await create()
      await saveDevice(device)
      navigation.navigate({ name: 'library', device })
    } catch (err) {
      setError(err instanceof Error ? err.message : '绑定失败')
    } finally {
      setLoading(false)
      setLoadingText('')
    }
  }, [navigation])

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
    saveAndContinue(() => createDeviceFromPairingPayload(payload, token), {
      loadingText: payload.pairingId ? '已提交绑定请求，等待电脑端允许绑定...' : ''
    })
  }, [saveAndContinue, token])

  const handlePastePairingCode = useCallback(async () => {
    setError('')
    const value = (await Clipboard.getStringAsync()).trim()
    setPairingCode(value)
    handlePairingCode(value)
  }, [handlePairingCode])

  const handleOpenScanner = useCallback(async () => {
    setError('')
    if (!permission?.granted) {
      const result = await requestPermission()
      if (!result.granted) {
        setError('需要相机权限才能扫描二维码')
        return
      }
    }
    barcodeHandledRef.current = false
    setScannerOpen(true)
  }, [permission?.granted, requestPermission])

  const handleBarcode = useCallback((result: { data?: string; raw?: string; nativeEvent?: { data?: string; raw?: string } }) => {
    if (barcodeHandledRef.current) return
    barcodeHandledRef.current = true
    setScannerOpen(false)
    const data = result.data || result.raw || result.nativeEvent?.data || result.nativeEvent?.raw || ''
    const payload = parsePairingCode(data)
    if (!payload) {
      setError('二维码不是 Wallpaper Player 绑定码')
      barcodeHandledRef.current = false
      return
    }
    saveAndContinue(() => createDeviceFromPairingPayload(payload, token), {
      loadingText: payload.pairingId ? '已扫码，等待电脑端允许绑定...' : ''
    })
  }, [saveAndContinue, token])

  if (scannerOpen) {
    return (
      <View style={styles.scannerShell}>
        <CameraView
          style={StyleSheet.absoluteFill}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={handleBarcode}
        />
        <View style={styles.scannerTop}>
          <Text style={styles.scannerTitle}>扫描电脑端二维码</Text>
          <Text style={styles.scannerHint}>在电脑端“手机访问”里生成二维码，扫码后会自动完成一次性绑定。</Text>
        </View>
        <Pressable style={styles.scannerClose} onPress={() => setScannerOpen(false)}>
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
        <Text style={styles.title}>连接电脑</Text>
        <Text style={styles.subtitle}>
          推荐扫描电脑端“手机访问”里的二维码；如果 Expo Go 扫不了，也可以复制绑定码后在这里粘贴。
        </Text>

        <PrimaryButton
          label="扫描二维码"
          variant="secondary"
          icon={<Camera color={colors.text} size={20} />}
          onPress={handleOpenScanner}
        />

        <View style={styles.form}>
          <View style={styles.labelRow}>
            <Text style={styles.label}>绑定码</Text>
            {pairingCode ? (
              <Pressable style={styles.clearFieldButton} onPress={() => setPairingCode('')}>
                <Text style={styles.clearFieldText}>清空</Text>
              </Pressable>
            ) : null}
          </View>
          <TextInput
            value={pairingCode}
            onChangeText={setPairingCode}
            placeholder="从电脑端复制绑定码后粘贴"
            placeholderTextColor={colors.subtle}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            style={[styles.input, styles.codeInput]}
          />
          <View style={styles.inlineActions}>
            <Pressable style={styles.secondaryAction} onPress={handlePastePairingCode}>
              <Text style={styles.secondaryActionText}>粘贴并绑定</Text>
            </Pressable>
            <Pressable style={styles.secondaryAction} onPress={() => handlePairingCode(pairingCode)}>
              <Text style={styles.secondaryActionText}>使用绑定码</Text>
            </Pressable>
          </View>
        </View>

        <Pressable style={styles.legacyToggle} onPress={() => setLegacyOpen(value => !value)}>
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
                <Pressable style={styles.clearFieldButton} onPress={() => setEndpoint('')}>
                  <Text style={styles.clearFieldText}>清空</Text>
                </Pressable>
              ) : null}
            </View>
            <TextInput
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
                <Pressable style={styles.clearFieldButton} onPress={() => setToken('')}>
                  <Text style={styles.clearFieldText}>清空</Text>
                </Pressable>
              ) : null}
            </View>
            <TextInput
              value={token}
              onChangeText={setToken}
              placeholder="从电脑端设置页复制"
              placeholderTextColor={colors.subtle}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              style={styles.input}
            />
            <PrimaryButton label="使用旧版 Token 连接" loading={loading} onPress={handleManualPair} />
          </View>
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {loadingText ? <Text style={styles.loadingText}>{loadingText}</Text> : null}

        <Pressable onPress={navigation.refreshDevices} style={styles.footerLink}>
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
    borderRadius: 16,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center'
  },
  title: {
    color: colors.text,
    fontSize: 32,
    fontWeight: '800'
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
    minHeight: 28,
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
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.text,
    paddingHorizontal: 14,
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
    gap: 10
  },
  secondaryAction: {
    flex: 1,
    minHeight: 44,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center'
  },
  secondaryActionText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '700'
  },
  sectionHint: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 19
  },
  legacyToggle: {
    alignSelf: 'flex-start',
    paddingVertical: 8
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
  footerLink: {
    alignSelf: 'center',
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
    top: 64,
    padding: 16,
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.62)'
  },
  scannerTitle: {
    color: colors.text,
    fontSize: 20,
    fontWeight: '800'
  },
  scannerHint: {
    color: colors.muted,
    marginTop: 6,
    lineHeight: 20
  },
  scannerClose: {
    position: 'absolute',
    left: 24,
    right: 24,
    bottom: 40,
    minHeight: 48,
    borderRadius: 8,
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
