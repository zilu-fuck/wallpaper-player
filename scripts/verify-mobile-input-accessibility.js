const assert = require('assert')
const fs = require('fs'), path = require('path')
const { phone } = require('./mobile-module-harness')
const { createHookHarness } = require('./verify-mobile-player-behavior')
const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)]
const text = tree => nodes(tree).map(node => node.type === 'Text' ? node.props.children : '').flat(Infinity).join('')
const styles = input => Array.isArray(input) ? Object.assign({}, ...input.map(styles)) : input || {}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function views(client) {
  Object.assign(client.stubs['react-native'], { Text: 'Text', Pressable: 'Pressable', ScrollView: 'ScrollView',
    TextInput: 'TextInput', KeyboardAvoidingView: 'KeyboardAvoidingView', Keyboard: { dismiss() {} } })
  client.stubs['lucide-react-native'] = new Proxy({}, { get: (_, name) => name })
  client.override('mobile/src/theme-context.tsx', { useTheme: () => ({ colors: client.load('mobile/src/theme.ts').darkColors }) })
  client.override('mobile/src/components/MobileUpdateCard.tsx', { MobileUpdateCard: 'MobileUpdateCard' })
}
async function deviceTargets() {
  const client = phone(), harness = createHookHarness(client); views(client)
  const { DeviceCard } = client.load('mobile/src/components/DeviceCard.tsx')
  const device = { id: 'fixture', name: '一台名称很长的工作电脑', endpoint: 'http://192.168.100.100:38127' }
  let opened = 0, removed = 0
  harness.mount(() => DeviceCard({ device, availability: { state: 'online', text: '在线' }, onOpen() { opened++ }, onRemove() { removed++ } }))
  const targets = nodes(harness.tree()).filter(node => node.type === 'Pressable')
  assert.strictEqual(targets.length, 2)
  assert.ok(!nodes(targets[0].props.children).some(node => node.type === 'Pressable'), 'remove must be reachable independently of opening the device')
  assert.ok(targets[0].props.accessibilityLabel.includes(device.endpoint))
  assert.strictEqual(targets[1].props.accessibilityLabel, `移除 ${device.name}`)
  targets[1].props.onPress(); assert.strictEqual(opened, 0); assert.strictEqual(removed, 1)
  targets[0].props.onPress(); assert.strictEqual(opened, 1)
  assert.ok(styles(targets[1].props.style).width >= 48)
  client.override('mobile/src/services/connection-manager.ts', { checkDeviceAvailability: async () => ({ state: 'online', text: '在线' }) })
  client.override('mobile/src/services/api.ts', { unpairCurrentDevice: async () => {} })
  harness.unmount()
  const listHarness = createHookHarness(client); views(client)
  const { DeviceListScreen } = client.load('mobile/src/screens/DeviceListScreen.tsx')
  listHarness.mount(() => DeviceListScreen({ devices: [device], navigation: { navigate() {} } }))
  const list = nodes(listHarness.tree()).find(node => node.type === 'FlatList')
  assert.ok(list.props.ListHeaderComponent, 'the heading must scroll away with the list on a short screen or large font')
  assert.ok(nodes(list.props.ListHeaderComponent).some(node => node.props?.accessibilityRole === 'header'))
  await listHarness.settle(); listHarness.unmount()
}
async function pairingInputOwnership() {
  const client = phone(), harness = createHookHarness(client); views(client)
  let back, permission, clipboard, pairing, saved = 0, navigated = 0, claimed = 0, signal
  const appListeners = new Set()
  client.stubs['react-native'].AppState.addEventListener = (_, listener) => {
    appListeners.add(listener); return { remove() { appListeners.delete(listener) } }
  }
  client.stubs['react-native'].BackHandler.addEventListener = (_, listener) => { back = listener; return { remove() { back = null } } }
  client.stubs['expo-camera'] = { CameraView: 'CameraView', useCameraPermissions: () => [{ granted: false }, () => permission.promise] }
  client.stubs['expo-clipboard'].getStringAsync = () => clipboard.promise
  client.override('mobile/src/components/PrimaryButton.tsx', { PrimaryButton: 'PrimaryButton' })
  client.override('mobile/src/services/pairing.ts', {
    parsePairingCode: value => value === 'valid' ? { endpoint: 'http://fixture', pairingId: 'fixture' } : null,
    createDeviceFromPairingPayload: (_payload, _token, currentSignal) => { claimed++; signal = currentSignal; return pairing.promise },
    createManualDevice: async () => ({ id: 'manual' })
  })
  client.override('mobile/src/persistence/devices.ts', { saveDevice: async value => { saved++; return value } })
  const { PairDeviceScreen } = client.load('mobile/src/screens/PairDeviceScreen.tsx')
  const navigation = { navigate() { navigated++ }, refreshDevices: async () => {} }
  const mount = () => harness.mount(() => PairDeviceScreen({ navigation }))
  const button = label => nodes(harness.tree()).find(node => node.type === 'PrimaryButton' ? node.props.label === label : node.type === 'Pressable' && (node.props.accessibilityLabel === label || text(node) === label))
  const field = label => nodes(harness.tree()).find(node => node.type === 'TextInput' && node.props.accessibilityLabel === label)
  const appState = status => { client.stubs['react-native'].AppState.currentState = status; appListeners.forEach(listener => listener(status)) }
  const cameraVisible = () => nodes(harness.tree()).some(node => node.type === 'CameraView')
  mount()
  assert.ok(field('绑定码')); assert.strictEqual(back(), false)
  permission = deferred()
  const pendingPermission = button('扫描二维码').props.onPress()
  await harness.settle(); assert.strictEqual(back(), true)
  permission.resolve({ granted: true }); await pendingPermission; await harness.settle()
  assert.ok(!nodes(harness.tree()).some(node => node.type === 'CameraView'), 'cancelled permission cannot reopen the camera')
  permission = deferred()
  const open = button('扫描二维码').props.onPress(); permission.resolve({ granted: true }); await open; await harness.settle()
  const oldCamera = nodes(harness.tree()).find(node => node.type === 'CameraView')
  assert.ok(oldCamera); assert.strictEqual(back(), true); await harness.settle()
  oldCamera.props.onBarcodeScanned({ data: 'valid' }); await harness.settle()
  assert.strictEqual(claimed, 0, 'a late camera frame after back cannot create a pairing')
  permission = deferred()
  const retryScanner = button('扫描二维码').props.onPress(); permission.resolve({ granted: true }); await retryScanner; await harness.settle()
  const camera = nodes(harness.tree()).find(node => node.type === 'CameraView')
  camera.props.onBarcodeScanned({ data: 'invalid' }); camera.props.onBarcodeScanned({ data: 'valid' }); await harness.settle()
  assert.strictEqual(claimed, 0, 'invalid input closes this camera generation; a queued frame cannot submit after it')
  permission = deferred(); const covered = button('扫描二维码').props.onPress()
  appState('background'); await harness.settle()
  permission.resolve({ granted: true }); await covered; await harness.settle()
  assert.ok(!nodes(harness.tree()).some(node => node.type === 'CameraView'), 'a permission result cannot open a camera in the background')
  appState('active'); await harness.settle()
  assert.strictEqual(cameraVisible(), true, 'the same granted permission request opens on foreground without a second scan tap')
  assert.strictEqual(back(), true); await harness.settle()
  appState('active'); await harness.settle(); assert.strictEqual(cameraVisible(), false, 'returning again cannot reopen a consumed request')

  permission = deferred(); const activeFirst = button('扫描二维码').props.onPress()
  appState('background'); await harness.settle(); appState('active'); await harness.settle()
  permission.resolve({ granted: true }); await activeFirst; await harness.settle()
  assert.strictEqual(cameraVisible(), true, 'foreground may precede completion of the system permission promise')
  appState('background'); await harness.settle(); appState('active'); await harness.settle()
  assert.strictEqual(cameraVisible(), false, 'an already-open scanner is closed by backgrounding and is not an outstanding permission request')

  permission = deferred(); const denied = button('扫描二维码').props.onPress()
  appState('background'); await harness.settle(); permission.resolve({ granted: false }); await denied
  appState('active'); await harness.settle(); assert.strictEqual(cameraVisible(), false)
  assert.ok(nodes(harness.tree()).some(node => node.props?.accessibilityRole === 'alert' && text(node).includes('相机权限')))

  permission = deferred(); const cancelGranted = button('扫描二维码').props.onPress()
  appState('background'); await harness.settle(); permission.resolve({ granted: true }); await cancelGranted; await harness.settle()
  button('取消绑定').props.onPress(); appState('active'); await harness.settle()
  assert.strictEqual(cameraVisible(), false, 'explicit cancellation expires a granted request waiting for foreground')

  permission = deferred(); const beforeCommit = button('扫描二维码').props.onPress()
  appState('background'); permission.resolve({ granted: true }); await beforeCommit
  assert.strictEqual(cameraVisible(), false, 'a permission promise cannot mount the camera before the background React commit')
  await harness.settle(); appState('active'); await harness.settle(); assert.strictEqual(cameraVisible(), true)
  assert.strictEqual(back(), true); await harness.settle()
  clipboard = deferred()
  const paste = button('粘贴并绑定').props.onPress(); await harness.settle()
  button('取消绑定').props.onPress(); clipboard.resolve('valid'); await paste; await harness.settle()
  assert.strictEqual(claimed, 0, 'a cancelled clipboard read cannot submit a pairing')
  clipboard = deferred()
  const failedPaste = button('粘贴并绑定').props.onPress(); clipboard.reject(new Error('clipboard unavailable'))
  await failedPaste; await harness.settle()
  assert.ok(nodes(harness.tree()).some(node => node.props?.accessibilityRole === 'alert' && text(node).includes('剪贴板')))
  field('绑定码').props.onChangeText('valid'); await harness.settle()
  pairing = deferred(); button('使用绑定码').props.onPress(); await harness.settle()
  assert.strictEqual(claimed, 1); assert.strictEqual(back(), true); assert.strictEqual(signal.aborted, true)
  pairing.resolve({ id: 'stale' }); await harness.settle(); assert.strictEqual(saved, 0); assert.strictEqual(navigated, 0)
  pairing = deferred(); button('使用绑定码').props.onPress(); await harness.settle()
  pairing.resolve({ id: 'current' }); await harness.settle(); assert.strictEqual(saved, 1); assert.strictEqual(navigated, 1)
  permission = deferred(); const unmounted = button('扫描二维码').props.onPress(); harness.unmount()
  permission.resolve({ granted: true }); await unmounted
  assert.strictEqual(back, null); assert.strictEqual(appListeners.size, 0); assert.strictEqual(harness.diagnostics().timers, 0)
}
async function progressGestures() {
  const client = phone(), harness = createHookHarness(client); views(client)
  const { PlaybackProgress } = client.load('mobile/src/components/player/PlaybackProgress.tsx')
  const seeks = [], held = []
  let duration = 100, currentTime = 20
  const render = () => PlaybackProgress({ duration, currentTime, onSeek: value => seeks.push(value), onScrubChange: value => held.push(value) })
  const slider = () => nodes(harness.tree()).find(node => node.props?.accessibilityRole === 'adjustable')
  harness.mount(render)
  slider().props.onLayout({ nativeEvent: { layout: { width: 200 } } }); await harness.settle()
  const gesture = slider().props
  gesture.onPanResponderGrant({ nativeEvent: { locationX: 40 } })
  gesture.onPanResponderMove({ nativeEvent: { locationX: 150 } })
  gesture.onPanResponderRelease() // Native events can finish before another React commit.
  assert.deepStrictEqual(seeks, [75]); assert.deepStrictEqual(held, [true, false])
  gesture.onPanResponderRelease(); assert.deepStrictEqual(seeks, [75], 'duplicate native release must not submit twice')
  gesture.onPanResponderGrant({ nativeEvent: { locationX: 80 } }); gesture.onPanResponderTerminate()
  assert.deepStrictEqual(seeks, [75], 'a parent taking the responder cancels the scrub without seeking')
  await harness.settle()
  slider().props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } }); assert.strictEqual(seeks.at(-1), 25)
  currentTime = 99; harness.mount(render)
  slider().props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } }); assert.strictEqual(seeks.at(-1), 100)
  duration = 0; harness.mount(render); const count = seeks.length
  slider().props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } }); assert.strictEqual(seeks.length, count)
  assert.strictEqual(slider().props.accessibilityState.disabled, true)
  assert.ok(styles(slider().props.style).height >= 48)
  harness.unmount()
}
async function accessibilityChanges() {
  const client = phone(), harness = createHookHarness(client), reader = deferred(), motion = deferred(), listeners = new Map()
  client.stubs['react-native'].AccessibilityInfo = { isScreenReaderEnabled: () => reader.promise, isReduceMotionEnabled: () => motion.promise,
    addEventListener(name, listener) { listeners.set(name, listener); return { remove() { listeners.delete(name) } } } }
  const { useAccessibilityPreferences } = client.load('mobile/src/hooks/useAccessibilityPreferences.ts')
  harness.mount(() => ({ props: useAccessibilityPreferences() }))
  listeners.get('screenReaderChanged')(true); listeners.get('reduceMotionChanged')(true)
  reader.resolve(false); motion.resolve(false); await harness.settle()
  assert.strictEqual(harness.tree().props.screenReaderEnabled, true, 'late initial query cannot override the live system preference')
  assert.strictEqual(harness.tree().props.reduceMotion, true)
  listeners.get('screenReaderChanged')(false); await harness.settle(); assert.strictEqual(harness.tree().props.screenReaderEnabled, false)
  const staleReader = listeners.get('screenReaderChanged'), staleMotion = listeners.get('reduceMotionChanged')
  harness.unmount(); assert.strictEqual(listeners.size, 0)
  staleReader(true); staleMotion(false); await harness.settle()
  assert.strictEqual(harness.tree().props.screenReaderEnabled, false); assert.strictEqual(harness.tree().props.reduceMotion, true)
}
(async () => {
  await deviceTargets(); await pairingInputOwnership(); await progressGestures(); await accessibilityChanges()
  const parent = path.resolve(__dirname, '../.tmp/refactor-tests'); fs.mkdirSync(parent, { recursive: true })
  fs.writeFileSync(path.join(parent, 'mobile-input-accessibility-evidence.json'), JSON.stringify({ date: new Date().toISOString(),
    passed: ['independent device open/remove', 'heading scroll ownership', 'cancelled permission/clipboard and late barcode',
      'clipboard rejection alert', 'aborted pairing not saved; valid result saved once', 'unmounted camera permission and back listener cleanup',
      'scrub release before React commit; duplicate release; responder termination', 'adjustable seek and disabled state',
      'live reader/motion changes supersede initial queries; stale event ignored after unmount'],
    conditions: 'Production screens/hooks/components; controlled native host, permission, clipboard and persistence. Not native Yoga, TalkBack/VoiceOver or physical camera evidence.' }, null, 2) + '\n')
  console.log('mobile input accessibility passed: independent device actions, scrollable heading, cancellable camera/clipboard/pairing, native scrub event ordering/cancellation and live accessibility preference ownership (native views controlled)')
})().catch(error => { console.error(error); process.exitCode = 1 })
