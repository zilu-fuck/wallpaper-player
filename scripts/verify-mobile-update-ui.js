const assert = require('node:assert/strict')
const { phone } = require('./mobile-module-harness')
const { createHookHarness, find } = require('./verify-mobile-player-behavior')
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function walk(tree, predicate) {
  if (!tree || typeof tree !== 'object') return null
  if (Array.isArray(tree)) return tree.map(item => walk(item, predicate)).find(Boolean) || null
  return predicate(tree) ? tree : walk(tree.props?.children, predicate)
}
const text = tree => !tree ? '' : typeof tree !== 'object' ? String(tree) : Array.isArray(tree) ? tree.map(text).join('') : text(tree.props?.children)
const colors = new Proxy({}, { get: () => '#222222' })
async function card() {
  const client = phone(), harness = createHookHarness(client), calls = [], opened = [], appListeners = new Set()
  const native = client.stubs['react-native']
  Object.assign(native, { ActivityIndicator: 'ActivityIndicator', Text: 'Text', Pressable: 'Pressable', Linking: { openURL: async url => { opened.push(url) } },
    AppState: { currentState: 'active', addEventListener(_name, callback) { appListeners.add(callback); return { remove: () => appListeners.delete(callback) } } } })
  client.override('mobile/src/theme-context.tsx', { useTheme: () => ({ colors }) })
  client.override('mobile/src/services/updates.ts', { checkMobileUpdate(version, options) {
    assert.equal(version, require('../mobile/package.json').version)
    const pending = deferred(); calls.push({ ...pending, signal: options.signal }); return pending.promise
  } })
  const devices = client.load('mobile/src/persistence/devices.ts')
  let heldRead = null
  client.override('mobile/src/persistence/devices.ts', { ...devices, loadDevice: (...args) => heldRead ? heldRead.promise : devices.loadDevice(...args) })
  const context = client.load('mobile/src/services/active-device-context.ts'), owner = Symbol('UI navigation')
  const device = await devices.saveDevice({ id: 'ui-pc', endpoint: 'http://127.0.0.1:1', name: 'UI PC', token: 'synthetic' })
  context.publishDeviceFocus(owner, { deviceId: device.id, bindingId: device.bindingId })
  const { MobileUpdateCard } = client.load('mobile/src/components/MobileUpdateCard.tsx')
  let focused = true, unmounted = false, lateWrites = 0
  const originalState = client.stubs.react.useState
  client.stubs.react.useState = value => { const [state, write] = originalState(value); return [state, next => { if (unmounted) lateWrites++; write(next) }] }
  const render = () => MobileUpdateCard({ focused })
  harness.mount(render); await harness.settle()
  const button = label => walk(harness.tree(), node => node.type === 'Pressable' && text(node).includes(label))
  const check = () => button('检查更新').props.onPress()
  const candidate = version => ({ available: true, latestVersion: version, currentVersion: '0.1.4', downloadUrl: 'https://github.com/qa/' + version, releaseName: 'QA ' + version })
  try {
    let pending = check(); await harness.settle()
    assert.equal(button('检查中').props.accessibilityState.busy, true)
    assert.equal(button('检查中').props.accessibilityLabel, '检查更新', 'busy state must retain a stable native button name')
    calls.at(-1).resolve(candidate('0.2.0')); await pending; await harness.settle()
    const oldOpen = button('下载更新').props.onPress
    await oldOpen(); assert.equal(opened.length, 1)
    pending = check()
    await oldOpen(); assert.equal(opened.length, 1, 'an already captured download handler cannot open a superseded result before React commits')
    await harness.settle(); assert.equal(button('下载更新'), null)
    calls.at(-1).reject(Error('catalog unavailable')); await pending; await harness.settle()
    assert.ok(text(harness.tree()).includes('catalog unavailable')); assert.equal(button('下载更新'), null)
    results.push('retry and failure remove old results and captured download handlers')

    const first = check(), firstCall = calls.at(-1), second = check(), secondCall = calls.at(-1)
    assert.equal(firstCall.signal.aborted, true)
    firstCall.resolve(candidate('stale')); await first; await harness.settle()
    assert.equal(button('下载更新'), null)
    secondCall.resolve(candidate('0.3.0')); await second; await harness.settle()
    assert.ok(text(harness.tree()).includes('0.3.0')); assert.ok(!text(harness.tree()).includes('stale'))
    results.push('superseded requests abort and late completion cannot replace the current result')

    const prior = button('下载更新').props.onPress
    context.publishDeviceFocus(owner, null)
    await prior(); await harness.settle(); assert.equal(opened.length, 1); assert.equal(button('下载更新'), null)
    pending = check(); const changed = calls.at(-1)
    context.publishDeviceFocus(owner, { deviceId: device.id, bindingId: device.bindingId })
    assert.equal(changed.signal.aborted, true)
    changed.reject(Error('late navigation error')); await pending; await harness.settle()
    assert.ok(!text(harness.tree()).includes('late navigation error'))
    results.push('route changes clear completed results and cancel pending requests')

    pending = check(); const same = calls.at(-1)
    context.publishDeviceFocus(owner, { deviceId: device.id, bindingId: device.bindingId })
    assert.equal(same.signal.aborted, false)
    same.resolve(candidate('0.4.0')); await pending; await harness.settle()
    const beforeRead = button('下载更新').props.onPress
    heldRead = deferred(); const opening = beforeRead()
    context.publishDeviceFocus(owner, null); heldRead.resolve(device); await opening
    heldRead = null; assert.equal(opened.length, 1)
    results.push('same computer transitions preserve a check while a changed scope during binding lookup blocks opening')

    context.publishDeviceFocus(owner, { deviceId: device.id, bindingId: device.bindingId })
    pending = check(); const rebound = calls.at(-1)
    await devices.saveDevice({ ...device, token: 'new-synthetic' })
    assert.equal(rebound.signal.aborted, true)
    rebound.resolve(candidate('rebound')); await pending; await harness.settle(); assert.equal(button('下载更新'), null)
    results.push('re-pairing invalidates the old binding even before navigation refreshes')

    pending = check(); const blurred = calls.at(-1); focused = false; harness.mount(render); await harness.settle()
    assert.equal(blurred.signal.aborted, true); blurred.resolve(candidate('blurred')); await pending; await harness.settle()
    assert.equal(button('下载更新'), null); assert.equal(button('检查更新').props.disabled, true)
    focused = true; harness.mount(render); await harness.settle()
    pending = check(); const background = calls.at(-1); appListeners.forEach(fn => fn('background')); await harness.settle()
    assert.equal(background.signal.aborted, true); background.reject(Error('background')); await pending; await harness.settle()
    assert.equal(button('下载更新'), null)
    appListeners.forEach(fn => fn('active')); await harness.settle()
    results.push('hidden screens and app background cancel work and require a fresh result on return')

    pending = check(); const removed = calls.at(-1)
    unmounted = true; harness.unmount()
    assert.equal(removed.signal.aborted, true); removed.resolve(candidate('unmounted')); await pending
    assert.equal(lateWrites, 0); assert.equal(appListeners.size, 0)
    assert.equal(context.activeDeviceContextDiagnostics().listeners, 0)
    results.push('unmount aborts requests, releases observers and prevents late state writes')
  } finally { if (!unmounted) harness.unmount(); context.releaseDeviceFocus(owner) }
}
async function gate() {
  const client = phone(), harness = createHookHarness(client)
  client.stubs.react.startTransition = fn => fn()
  client.stubs['lucide-react-native'] = new Proxy({}, { get: (_, key) => key })
  Object.assign(client.stubs['react-native'], { ActivityIndicator: 'ActivityIndicator', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', Pressable: 'Pressable', KeyboardAvoidingView: 'KeyboardAvoidingView' })
  client.override('mobile/src/theme-context.tsx', { useTheme: () => ({ colors, themeMode: 'dark', setThemeMode: async () => {} }) })
  for (const name of ['ConnectionStatus', 'MobileUpdateCard', 'PrimaryButton', 'VideoCard']) client.override(`mobile/src/components/${name}.tsx`, { [name]: name })
  const devices = client.load('mobile/src/persistence/devices.ts')
  const device = await devices.saveDevice({ id: 'gate-pc', name: 'New PC', endpoint: 'http://127.0.0.1:1', token: 'synthetic' })
  const api = client.load('mobile/src/services/api.ts'); let attempts = 0, returns = 0
  client.override('mobile/src/services/connection-manager.ts', { testConnection: async () => { attempts++; throw new api.ApiError('请更新手机客户端', 426, 'client_update_required', false) } })
  const { LibraryScreen } = client.load('mobile/src/screens/LibraryScreen.tsx')
  harness.mount(() => LibraryScreen({ device, navigation: { refreshDevices() { returns++ } } }))
  try {
    await harness.until(() => Boolean(find(harness.tree(), 'MobileUpdateCard')))
    assert.ok(text(harness.tree()).includes('请更新手机客户端'))
    assert.equal(find(harness.tree(), 'MobileUpdateCard').props.focused, true)
    assert.equal(find(harness.tree(), 'ScrollView').props.contentContainerStyle.flexGrow, 1)
    const primary = label => walk(harness.tree(), node => node.type === 'PrimaryButton' && node.props.label === label)
    primary('重新连接').props.onPress(); await harness.until(() => attempts === 2 && Boolean(find(harness.tree(), 'MobileUpdateCard')))
    primary('返回设备').props.onPress(); assert.equal(returns, 1)
    results.push('the actual first-connection failure screen exposes a scrollable update card, retry and return controls')
  } finally { harness.unmount() }
}
const results = []
;(async () => { await card(); await gate(); console.log(JSON.stringify({ passed: true, cases: results, scope: 'Production React components/hooks in VM; native views, update transport and linking are doubles' }, null, 2)) })().catch(error => { console.error(error); process.exitCode = 1 })
