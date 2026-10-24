const assert = require('assert')
const { phone } = require('./mobile-module-harness')
const { createHookHarness, find } = require('./verify-mobile-player-behavior')
function walk(tree, predicate) {
  if (!tree || typeof tree !== 'object') return null
  if (Array.isArray(tree)) return tree.map(item => walk(item, predicate)).find(Boolean)
  if (predicate(tree)) return tree
  return walk(tree.props?.children, predicate)
}
async function verifyLibraryScreen({ endpoint, token }) {
  const client = phone(), harness = createHookHarness(client)
  const appStateListeners = new Set()
  client.stubs['react-native'].AppState = { currentState: 'active', addEventListener(_event, callback) {
    appStateListeners.add(callback); return { remove: () => appStateListeners.delete(callback) }
  } }
  let focused = true
  let idleId = 0
  const idleJobs = new Map(), cancelledIdle = []
  client.control.globals = { ...client.control.globals,
    requestIdleCallback(callback, options) {
      assert.strictEqual(options.timeout, 250, 'sort dispatch must remain bounded on a busy JS thread')
      const id = ++idleId; idleJobs.set(id, callback); return id
    },
    cancelIdleCallback(id) { cancelledIdle.push(id); idleJobs.delete(id) } }
  const flushIdle = () => { const jobs = [...idleJobs.values()]; idleJobs.clear(); jobs.forEach(callback => callback({ didTimeout: false, timeRemaining: () => 20 })) }
  client.stubs.react.startTransition = fn => fn()
  client.stubs['lucide-react-native'] = new Proxy({}, { get: (_, key) => key })
  Object.assign(client.stubs['react-native'], { ActivityIndicator: 'ActivityIndicator', ScrollView: 'ScrollView',
    Text: 'Text', TextInput: 'TextInput', Pressable: 'Pressable', KeyboardAvoidingView: 'KeyboardAvoidingView' })
  for (const name of ['ConnectionStatus', 'MobileUpdateCard', 'PrimaryButton', 'VideoCard']) {
    client.override(`mobile/src/components/${name}.tsx`, { [name]: name })
  }
  client.override('mobile/src/theme-context.tsx', { useTheme: () => ({ colors: new Proxy({}, { get: () => '#222222' }),
    themeMode: 'dark', setThemeMode: async () => {} }) })
  const devices = client.load('mobile/src/persistence/devices.ts')
  const device = await devices.saveDevice({ id: 'screen-phone', name: 'Desktop', endpoint, token,
    capabilities: { libraryQuery: true, libraryRevision: true, cursorPagination: true } })
  let connectionCalls = 0
  client.override('mobile/src/services/connection-manager.ts', { testConnection: async () => { connectionCalls++; return device } })
  const api = client.load('mobile/src/services/api.ts')
  const completedSorts = []
  client.override('mobile/src/services/api.ts', { ...api, queryLibrary: async (...args) => {
    const response = await api.queryLibrary(...args); completedSorts.push(args[1].sort)
    return { ...response, scanState: 'refreshing', refreshing: true, indexed: true }
  } })
  let fullCalls = 0, networkCalls = 0
  const queriedSorts = []
  client.control.hold = async (url, options) => {
    networkCalls++; if (String(url).endsWith('/v1/library')) fullCalls++
    if (String(url).endsWith('/v1/library/query') && options?.body) queriedSorts.push(JSON.parse(options.body).sort)
  }
  const { LibraryScreen } = client.load('mobile/src/screens/LibraryScreen.tsx')
  const navigation = { navigate() {}, refreshDevices() {} }
  const render = () => LibraryScreen({ device, navigation, focused })
  harness.mount(render)
  await harness.until(() => find(harness.tree(), 'FlatList')?.props.data.length === 200)
  await new Promise(resolve => setTimeout(resolve, 1300)); await harness.settle()
  assert.strictEqual(connectionCalls, 1, 'modern scan refresh must not start the legacy reconnect/speed-test timer')
  const toolbar = () => walk(harness.tree(), node => typeof node.props?.onSortSelect === 'function')
  const beforeSorts = queriedSorts.length
  toolbar().props.onSortSelect('date'); toolbar().props.onSortSelect('size'); await harness.settle()
  assert.strictEqual(idleJobs.size, 1, 'rapid sort changes retain only the latest idle task')
  assert.strictEqual(cancelledIdle.length, 1)
  assert.strictEqual(queriedSorts.length, beforeSorts, 'pending sort does not issue a premature query')
  flushIdle()
  await harness.until(() => completedSorts.at(-1) === 'size' && find(harness.tree(), 'FlatList')?.props.data.length === 200)
  assert.ok(!queriedSorts.slice(beforeSorts).includes('date'), 'superseded sort never reaches the server')
  toolbar().props.onSortSelect('name'); flushIdle()
  await harness.until(() => completedSorts.at(-1) === 'name' && find(harness.tree(), 'FlatList')?.props.data.length === 200)
  let list = find(harness.tree(), 'FlatList')
  list.props.onEndReached()
  await harness.until(() => find(harness.tree(), 'FlatList')?.props.data.length === 245)
  const button = icon => walk(harness.tree(), node => node.type === 'Pressable' && find(node.props.children, icon))
  button('Search').props.onPress(); await harness.settle()
  find(harness.tree(), 'TextInput').props.onChangeText('Unique-240')
  await harness.until(() => find(harness.tree(), 'FlatList')?.props.data.length === 1)
  assert.strictEqual(find(harness.tree(), 'FlatList').props.data[0].name, 'Clip-240')
  button('ArrowLeft').props.onPress(); await harness.settle()
  await harness.until(() => find(harness.tree(), 'FlatList')?.props.data.length >= 200)
  button('Menu').props.onPress(); await harness.settle()
  const drawer = label => walk(harness.tree(), node => node.type?.name === 'DrawerItem' && node.props.label === label)
  const favorites = drawer('我喜欢')
  assert.strictEqual(favorites.props.count, 2, 'drawer aggregate is global even before all pages load')
  favorites.props.onPress(); await harness.settle()
  await harness.until(() => find(harness.tree(), 'FlatList')?.props.data.length === 2)
  assert.ok(find(harness.tree(), 'FlatList').props.data.every(item => item.favorite))
  button('Menu').props.onPress(); await harness.settle()
  drawer('Include').props.onPress(); await harness.settle()
  await harness.until(() => find(harness.tree(), 'FlatList')?.props.data.length === 2)
  button('Menu').props.onPress(); await harness.settle()
  drawer('Exclude').props.onPress(); await harness.settle()
  await harness.until(() => find(harness.tree(), 'FlatList')?.props.data.length === 1)
  assert.strictEqual(find(harness.tree(), 'FlatList').props.data[0].name, 'Clip-239')
  focused = false; harness.mount(render); await harness.settle()
  const backgroundCalls = networkCalls
  client.load('mobile/src/services/library-events.ts').emitVideoLibraryUpdate({ deviceId: device.id,
    videoId: find(harness.tree(), 'FlatList').props.data[0].id, patch: { favorite: true } })
  await new Promise(resolve => setTimeout(resolve, 1300)); await harness.settle()
  assert.strictEqual(networkCalls, backgroundCalls, 'covered library must not query, reconnect or poll')
  appStateListeners.forEach(callback => callback('background')); await harness.settle()
  focused = true; harness.mount(render); await harness.settle()
  assert.strictEqual(networkCalls, backgroundCalls, 'focused page must remain quiet while the app is backgrounded')
  appStateListeners.forEach(callback => callback('active'))
  await harness.until(() => networkCalls > backgroundCalls)
  assert.strictEqual(connectionCalls, 1, 'foreground revision checks must not repeat endpoint speed selection')
  assert.strictEqual(find(harness.tree(), 'FlatList').props.data[0].name, 'Clip-239', 'foreground resume retains the query and loaded rows')
  assert.strictEqual(fullCalls, 0)
  button('Menu').props.onPress(); await harness.settle()
  const modal = () => walk(harness.tree(), node => node.type?.name === 'AccessibleModal')
  assert.ok(modal(), 'navigation uses the native modal owner')
  focused = false; harness.mount(render); await harness.settle()
  assert.ok(!modal(), 'a covered library cannot leave its native modal over the active page')
  focused = true; harness.mount(render); await harness.settle()
  assert.ok(modal(), 'the covered navigation draft is retained')
  modal().props.onClose(); await harness.settle(); assert.ok(!modal())
  toolbar().props.onSortSelect('type'); assert.strictEqual(idleJobs.size, 1)
  harness.unmount()
  assert.strictEqual(idleJobs.size, 0, 'unmount cancels the outstanding sort before it can set state')
  assert.strictEqual(appStateListeners.size, 0)
  console.log('library screen behavior passed: production hooks/pages/search, typed scope, global counts, covered/background suspension, focused revision resume and subscription cleanup')
}
module.exports = { verifyLibraryScreen }
