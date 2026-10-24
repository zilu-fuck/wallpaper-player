const assert = require('assert')
const { phone } = require('./mobile-module-harness')
const { createHookHarness, find } = require('./verify-mobile-player-behavior')
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
async function verifyOrientation() {
  const client = phone(), calls = [], first = deferred()
  let active = 0, maximum = 0
  client.stubs['expo-screen-orientation'] = { OrientationLock: { LANDSCAPE: 2, PORTRAIT_UP: 1 }, async lockAsync(mode) {
    calls.push(mode); active++; maximum = Math.max(maximum, active)
    try { if (calls.length === 1) await first.promise } finally { active-- }
  } }
  const { lockOrientation } = client.load('mobile/src/services/orientation.ts')
  const old = lockOrientation('landscape'); await new Promise(done => setImmediate(done))
  const portrait = lockOrientation('portrait'), latest = lockOrientation('landscape')
  first.reject(new Error('superseded native failure'))
  assert.strictEqual(await old, false); assert.strictEqual(await portrait, false); assert.strictEqual(await latest, true)
  assert.strictEqual(maximum, 1); assert.deepStrictEqual(calls, [2, 2])
  assert.strictEqual(await lockOrientation('portrait'), true); assert.deepStrictEqual(calls, [2, 2, 1])
}
async function main() {
  await verifyOrientation()
  for (let iteration = 0; iteration < 30; iteration++) {
    const client = phone(), harness = createHookHarness(client), appListeners = new Set(), backListeners = new Set()
    let dimensions = { width: 400, height: 800 }, syncs = 0, focused = true
    const native = client.stubs['react-native']
    native.useWindowDimensions = () => dimensions
    native.AppState = { currentState: iteration === 0 ? 'background' : 'active', addEventListener(_event, callback) {
      appListeners.add(callback); return { remove: () => appListeners.delete(callback) }
    } }
    native.BackHandler = { addEventListener(_event, callback) { backListeners.add(callback); return { remove: () => backListeners.delete(callback) } } }
    client.override('mobile/src/persistence/playback.ts', {
      openPlaybackSession: async (device, videoId) => ({ device, videoId, position: 0 }), closePlaybackSession() {}, recordPlayback: async () => {},
      syncPendingPlayback: async () => { syncs++; return { message: '' } }
    })
    const device = { id: 'pc_cycles', bindingId: 'bound', name: 'Cycles', endpoint: 'http://localhost:1', token: 'test' }
    const videos = ['a', 'b'].map(id => ({ id, name: id, size: 1, extension: '.mp4', customTags: [], systemTags: [],
      streamUrl: '/v1/videos/' + id + '/stream', thumbnailUrl: '/v1/videos/' + id + '/thumbnail' }))
    const { PlayerScreen } = client.load('mobile/src/screens/PlayerScreen.tsx')
    const render = () => PlayerScreen({ device, video: videos[0], videos, focused, navigation: { canGoBack: true, back() {}, navigate() {} } })
    harness.mount(render)
    await harness.settle()
    const page = index => find(harness.tree(), 'FlatList').props.renderItem({ item: videos[index], index })
    const overlay = index => find(page(index), 'VideoOverlay').props
    const ready = player => { player.status = 'readyToPlay'; player.listeners.sourceLoad({ videoSource: player.source, duration: 100, availableVideoTracks: [] }); player.listeners.statusChange({ status: 'readyToPlay' }) }
    ready(harness.players[0]); await harness.settle()
    if (iteration === 0) {
      assert.strictEqual(harness.players[0].playing, false, 'mounting in the background cannot autoplay')
      assert.strictEqual(harness.diagnostics().intervals, 0)
      native.AppState.currentState = 'active'; appListeners.forEach(listener => listener('active')); await harness.settle()
    }
    await overlay(0).onFullscreen(); await harness.settle()
    dimensions = { width: 800, height: 400 }; harness.mount(render); await harness.settle()
    assert.strictEqual(overlay(0).landscapeMode, true)
    await overlay(0).onBack(); await harness.settle(); assert.strictEqual(overlay(0).landscapeMode, false)
    dimensions = { width: 400, height: 800 }
    harness.mount(render); await harness.settle()
    const oldPage = page(0), oldEvents = { ...harness.players[0].listeners }
    oldPage.props.onLongPress({ nativeEvent: { locationX: 1 } }); await harness.settle()
    assert.strictEqual(harness.diagnostics().intervals, 2)
    find(harness.tree(), 'FlatList').props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { y: 800 } } })
    await harness.settle(); assert.strictEqual(harness.diagnostics().intervals, 1, 'switching resource stops rewind')
    assert.strictEqual(harness.players.length, 1)
    ready(harness.players[0]); await harness.settle()
    const before = overlay(1).currentTime
    oldPage.props.onPressOut(); oldPage.props.onPress(); oldEvents.timeUpdate({ currentTime: 99, bufferedPosition: 100 })
    await harness.settle(); assert.strictEqual(overlay(1).currentTime, before)
    assert.strictEqual(harness.players[0].playbackRate, 1)
    focused = false; harness.mount(render); await harness.settle()
    assert.strictEqual(harness.players[0].playing, false); assert.strictEqual(harness.diagnostics().intervals, 0)
    focused = true; harness.mount(render); await harness.settle()
    assert.strictEqual(harness.players[0].playing, true)
    appListeners.forEach(listener => listener('background')); await harness.settle()
    const pausedSyncs = syncs; harness.checkpoint(); await harness.settle()
    assert.strictEqual(syncs, pausedSyncs); assert.strictEqual(harness.diagnostics().intervals, 0)
    appListeners.forEach(listener => listener('active')); await harness.settle()
    find(harness.tree(), 'FlatList').props.onScrollToIndexFailed({ averageItemLength: 800, index: 1 })
    harness.unmount(); await harness.settle()
    assert.deepStrictEqual(harness.diagnostics(), { intervals: 0, timers: 0, frames: 0, listeners: 0 })
    assert.strictEqual(appListeners.size, 0); assert.strictEqual(backListeners.size, 0)
    assert.strictEqual(harness.players.filter(player => !player.released).length, 0)
  }
  console.log('player resources passed: 30 production screen cycles, background mount/progress suspension, landscape/back, rewind across resource switch, old gestures/events, timers/frames/subscriptions and instance disposal; native locks serialize and superseded failures are ignored')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
