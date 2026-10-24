const assert = require('assert')
const { phone } = require('./mobile-module-harness')
const { createHookHarness, find } = require('./verify-mobile-player-behavior')
const plain = value => JSON.parse(JSON.stringify(value))

async function main() {
  const client = phone(), { NavigationStore } = client.load('mobile/src/services/navigation-store.ts')
  const device = { id: 'pc_nav', bindingId: 'binding_1', name: 'Navigation', endpoint: 'http://localhost:39000', token: 'private-credential' }
  const videos = Array.from({ length: 10000 }, (_, index) => ({ id: `video_${index}`, name: `Video ${index}`, size: 1, extension: '.mp4' }))
  const store = new NavigationStore()
  store.setDevices([device]); store.reset({ name: 'devices' })
  store.navigate({ name: 'library', device })
  const library = store.getSnapshot()[1]
  store.navigate({ name: 'search', device, videos })
  const search = store.getSnapshot()[2]
  store.navigate({ name: 'player', device, video: videos[5000], videos })
  let player = store.getSnapshot()[3]
  const serialized = JSON.stringify(store.getSnapshot())
  assert.ok(serialized.length < 1000 && !serialized.includes(device.token) && !serialized.includes(device.endpoint))
  assert.ok(!serialized.includes('Video ') && !serialized.includes('videos'))
  assert.strictEqual(store.getPlaylist(player)[5000], videos[5000])
  assert.strictEqual(store.getPlaylist(player), store.getPlaylist(player), 'playlist resolution is stable across renders')
  assert.strictEqual(store.diagnostics().media, 10000, 'shared search/player objects are indexed once')
  store.updateVideo(device.id, device.bindingId, videos[5000].id, { favorite: true })
  assert.strictEqual(store.getPlaylist(search)[5000].favorite, true)
  store.updateVideo(device.id, 'retired-binding', videos[5000].id, { favorite: false })
  assert.strictEqual(store.getPlaylist(search)[5000].favorite, true, 'old bindings cannot patch a new queue')
  assert.ok(store.back()); assert.strictEqual(store.getSnapshot()[2], search)
  assert.ok(store.back()); assert.strictEqual(store.getSnapshot()[1], library)
  assert.deepStrictEqual(plain(store.diagnostics()), { routes: 2, queues: 0, media: 0, listeners: 0 })
  // Immediate pushes and pops must read the current stack, before React has rerendered.
  for (let index = 0; index < 30; index++) {
    store.navigate({ name: 'player', device, video: videos[index], videos })
    player = store.getSnapshot()[2]
    assert.strictEqual(player.videoId, videos[index].id)
    assert.ok(store.back()); assert.strictEqual(store.getSnapshot()[1], library)
    assert.strictEqual(store.diagnostics().queues, 0); assert.strictEqual(store.diagnostics().media, 0)
  }
  store.navigate({ name: 'search', device, videos })
  store.navigate({ name: 'player', device, video: videos[4], videos: [videos[1], videos[1], videos[3]] })
  assert.deepStrictEqual(plain(store.getPlaylist(store.getSnapshot()[3]).map(video => video.id)), ['video_4', 'video_1', 'video_3'])
  store.navigate({ name: 'library', device }); assert.strictEqual(store.getSnapshot()[1], library)
  store.navigate({ name: 'player', device, video: videos[4], videos })
  store.invalidateDevice(device.id, device.bindingId)
  assert.strictEqual(store.getSnapshot().length, 1)
  assert.strictEqual(store.diagnostics().media, 0)
  const rebound = { ...device, bindingId: 'binding_2', token: 'replacement' }
  store.setDevices([rebound]); store.navigate({ name: 'library', device: rebound })
  const reboundStack = store.getSnapshot()
  store.navigate({ name: 'player', device, video: videos[4], videos })
  assert.strictEqual(store.getSnapshot(), reboundStack, 'old callbacks cannot resurrect a retired binding')
  assert.strictEqual(store.getDevice(reboundStack[1]), rebound)

  const shellClient = phone(), harness = createHookHarness(shellClient)
  shellClient.stubs['expo-status-bar'] = { StatusBar: 'ExpoStatusBar' }
  shellClient.stubs['react-native'].StatusBar = 'StatusBar'
  shellClient.stubs['react-native-safe-area-context'].SafeAreaView = 'SafeAreaView'
  shellClient.override('mobile/src/theme-context.tsx', { useTheme: () => ({ colors: {}, themeMode: 'dark' }) })
  shellClient.override('mobile/src/AppNavigator.tsx', { AppNavigator: 'AppNavigator' })
  const repository = shellClient.load('mobile/src/persistence/devices.ts')
  const saved = await repository.saveDevice(device)
  const { AppShell } = shellClient.load('mobile/App.tsx')
  harness.mount(() => AppShell())
  await harness.until(() => Boolean(find(harness.tree(), 'AppNavigator')))
  let context = find(harness.tree(), 'AppNavigator').props.context
  context.navigate({ name: 'library', device: saved })
  context.navigate({ name: 'search', device: saved, videos })
  context.navigate({ name: 'player', device: saved, video: videos[0], videos })
  assert.ok(context.back()); assert.ok(context.back())
  await harness.settle()
  context = find(harness.tree(), 'AppNavigator').props.context
  assert.strictEqual(context.route.name, 'library'); assert.strictEqual(context.stack.length, 2)
  await repository.removeDevice(saved.id, saved.bindingId); await harness.settle()
  context = find(harness.tree(), 'AppNavigator').props.context
  assert.strictEqual(context.route.name, 'devices'); assert.strictEqual(context.stack.length, 1)
  harness.unmount(); assert.strictEqual(context.resources.diagnostics().listeners, 0)
  console.log('mobile navigation passed: production stack and AppShell, ID-only routes, stable library/search identities, synchronous back, 10k shared media, 30 entries with cleanup, binding invalidation and stale callbacks')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
