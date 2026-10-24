const assert = require('assert')

// Executes the production screen and its hooks; native views and the decoder are test doubles.
// Hardware, rendering and memory acceptance remain in the real-device QA matrix.
function createHookHarness(phone, options = {}) {
  const slots = [], effects = [], intervals = new Map(), timers = new Set(), frames = new Set()
  const accessibilityListeners = new Map()
  const timerDelays = new Map()
  let cursor = 0, dirty = false, renderFunction, tree, intervalId = 0
  const changed = (a, b) => !a || !b || a.length !== b.length || a.some((value, i) => !Object.is(value, b[i]))
  const react = {
    useRef(initial) { const id = cursor++; return slots[id] ||= { current: initial } },
    useState(initial) {
      const id = cursor++
      if (!slots[id]) slots[id] = { value: typeof initial === 'function' ? initial() : initial }
      return [slots[id].value, next => {
        const value = typeof next === 'function' ? next(slots[id].value) : next
        if (!Object.is(value, slots[id].value)) { slots[id].value = value; dirty = true }
      }]
    },
    useMemo(factory, dependencies) {
      const id = cursor++
      if (!slots[id] || changed(slots[id].dependencies, dependencies)) slots[id] = { value: factory(), dependencies }
      return slots[id].value
    },
    useCallback(fn, dependencies) { return react.useMemo(() => fn, dependencies) },
    useEffect(fn, dependencies) {
      const id = cursor++
      if (!slots[id]) slots[id] = {}
      if (changed(slots[id].dependencies, dependencies)) effects.push({ id, fn, dependencies })
    }
  }
  react.useLayoutEffect = react.useEffect
  phone.stubs.react = react
  const jsx = (type, props) => ({ type, props })
  phone.stubs['react/jsx-runtime'] = { jsx, jsxs: jsx, Fragment: 'Fragment' }
  phone.stubs['react-native'] = {
    AccessibilityInfo: { isScreenReaderEnabled: async () => false, isReduceMotionEnabled: async () => false,
      addEventListener(name, listener) { accessibilityListeners.set(name, listener); return { remove() { accessibilityListeners.delete(name) } } } },
    Platform: { OS: 'android' }, StyleSheet: { create: value => value },
    useWindowDimensions: () => ({ width: 400, height: 800 }),
    View: 'View', FlatList: 'FlatList', PanResponder: { create: options => ({ panHandlers: options }) },
    BackHandler: { addEventListener: () => ({ remove() {} }) },
    AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) }
  }
  phone.stubs['react-native-safe-area-context'] = { useSafeAreaInsets: () => ({ top: 20, right: 0, bottom: 0, left: 0 }) }
  phone.stubs['expo-clipboard'] = { setStringAsync: async () => {} }
  phone.stubs['expo-screen-orientation'] = { lockAsync: async () => {}, unlockAsync: async () => {},
    OrientationLock: { PORTRAIT_UP: 1, LANDSCAPE: 2 } }
  phone.stubs.expo = { useEventListener(player, event, listener) {
    react.useEffect(() => {
      player.listeners[event] = listener
      return () => { if (player.listeners[event] === listener) delete player.listeners[event] }
    }, [player, event, listener])
  } }
  const players = []
  phone.stubs['expo-video'] = { useVideoPlayer(source, setup) {
    const current = react.useMemo(() => {
      const player = { status: 'loading', currentTime: 0, duration: 100, bufferedPosition: 100, playing: false, playbackRate: 1,
        source, replacements: [], listeners: {}, seeks: [],
        play() { assert.ok(!this.released, 'cannot play a released native object'); this.playing = true },
        pause() { assert.ok(!this.released, 'cannot pause a released native object'); this.playing = false },
        async replaceAsync(nextSource) {
          assert.ok(!this.released, 'cannot replace a released native object')
          const oldSource = this.source
          this.source = nextSource; this.replacements.push(nextSource); currentTime = 0; this.playing = false
          this.status = nextSource ? 'loading' : 'idle'
          this.listeners.sourceChange?.({ source: nextSource, oldSource })
        } }
      let currentTime = 0
      Object.defineProperty(player, 'currentTime', { get: () => currentTime, set: position => { currentTime = position; player.seeks.push(position) } })
      setup(player)
      players.push(player)
      return player
    }, [JSON.stringify(source)])
    react.useEffect(() => () => { current.released = true; current.playing = false }, [current])
    return current
  } }
  for (const name of ['PlayerMoreSheet', 'TagEditorSheet', 'VideoAnalysisSheet', 'VideoFeedItem', 'VideoOverlay']) {
    if (!options.realComponents?.includes(name)) phone.override(`mobile/src/components/player/${name}.tsx`, { [name]: name })
  }
  phone.control.globals = { ...(phone.control.globals || {}), setInterval(fn, ms) { const id = ++intervalId; intervals.set(id, { fn, ms }); return id },
    clearInterval(id) { intervals.delete(id) },
    setTimeout(fn, ms) { const id = setTimeout(() => { timers.delete(id); timerDelays.delete(id); fn() }, ms); timers.add(id); timerDelays.set(id, ms); return id },
    clearTimeout(id) { timers.delete(id); timerDelays.delete(id); clearTimeout(id) },
    requestAnimationFrame(fn) { const id = setTimeout(() => { frames.delete(id); fn() }, 0); frames.add(id); return id },
    cancelAnimationFrame(id) { frames.delete(id); clearTimeout(id) }
  }
  function render() {
    cursor = 0
    dirty = false
    tree = renderFunction()
    options.commitRefs?.(tree)
    const pending = effects.splice(0)
    for (const effect of pending) slots[effect.id].cleanup?.()
    for (const effect of pending) {
      slots[effect.id].dependencies = effect.dependencies
      slots[effect.id].cleanup = effect.fn()
    }
  }
  return {
    mount(fn) { renderFunction = fn; render() },
    async settle() {
      for (let i = 0; i < 8; i++) { await new Promise(resolve => setImmediate(resolve)); if (dirty) render() }
    },
    async until(predicate) {
      const deadline = Date.now() + 4000
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error('player behavior wait timed out')
        await this.settle()
        await new Promise(resolve => setTimeout(resolve, 4))
      }
      await this.settle()
    },
    tree: () => tree,
    players,
    setAccessibility(name, value) { accessibilityListeners.get(name)?.(value) },
    accessibilitySubscriptionCount: () => accessibilityListeners.size,
    pendingTimerDelays: () => [...timerDelays.values()],
    checkpoint() { for (const interval of intervals.values()) if (interval.ms === 5000) interval.fn() },
    diagnostics: () => ({ intervals: intervals.size, timers: timers.size, frames: frames.size,
      listeners: players.reduce((count, player) => count + Object.keys(player.listeners).length, 0) }),
    unmount() { for (const slot of slots) slot?.cleanup?.() }
  }
}
function find(tree, type) {
  if (!tree || typeof tree !== 'object') return null
  if (Array.isArray(tree)) return tree.map(item => find(item, type)).find(Boolean)
  if (tree.type === type) return tree
  return find(tree.props?.children, type)
}
function activePage(harness, video) {
  return find(harness.tree(), 'FlatList').props.renderItem({ item: video, index: 0 })
}

async function verifyPlayerBehavior({ phone, device, videoId, setRemotePosition, getRemotePosition }) {
  await setRemotePosition(30)
  phone.async.values.set(`wallpaper-player.playback.${device.id}.${videoId}`, JSON.stringify({ position: 180, updatedAt: 1 }))
  const realProgress = phone.load('mobile/src/persistence/playback.ts')
  let openCount = 0
  phone.override('mobile/src/persistence/playback.ts', { ...realProgress,
    async openPlaybackSession(...args) { openCount++; return realProgress.openPlaybackSession(...args) } })
  const harness = createHookHarness(phone)
  const { PlayerScreen } = phone.load('mobile/src/screens/PlayerScreen.tsx')
  const video = { id: videoId, name: 'Screen fixture', extension: '.mp4', size: 1, customTags: [], systemTags: [],
    streamUrl: '/v1/videos/' + videoId + '/stream', thumbnailUrl: '/v1/videos/' + videoId + '/thumbnail' }
  const props = { device, video, videos: [video], navigation: { canGoBack: false, navigate() {}, back() {} } }
  harness.mount(() => PlayerScreen(props))
  await harness.until(() => phone.secure.values.has('wallpaper-player.playback-session.v1'))
  await harness.settle()
  const player = harness.players[0]
  assert.deepStrictEqual(player.seeks, [], 'restore must wait for source readiness')
  player.status = 'readyToPlay'
  player.listeners.sourceLoad({ videoSource: player.source, duration: 100, availableVideoTracks: [] })
  await harness.until(() => player.seeks.length > 0)
  assert.strictEqual(player.currentTime, 30, 'the screen must seek to the latest rewind rather than max position')
  player.currentTime = 35
  player.listeners.timeUpdate({ currentTime: 99, bufferedPosition: 100 })
  await harness.settle()
  assert.strictEqual(find(activePage(harness, video), 'VideoOverlay').props.currentTime, 35,
    'untagged queued time events must read the current native item instead of a stale payload')
  player.status = 'loading'
  player.listeners.statusChange({ status: 'loading' })
  await harness.settle()
  harness.checkpoint()
  await harness.settle()
  await realProgress.syncPendingPlayback(device, videoId)
  assert.strictEqual(getRemotePosition(), 35, 'buffering must not overwrite the durable checkpoint with zero')
  player.status = 'readyToPlay'
  player.listeners.statusChange({ status: 'readyToPlay' })
  await harness.settle()
  const originalSeekCount = player.seeks.length
  await find(activePage(harness, video), 'VideoOverlay').props.onTags()
  await harness.settle()
  await find(harness.tree(), 'TagEditorSheet').props.onSave(['UI-tag'])
  await harness.settle()
  assert.strictEqual(openCount, 1, 'metadata object changes must not reopen the progress session')
  assert.strictEqual(player.seeks.length, originalSeekCount, 'editing tags must not restore an older checkpoint')
  assert.strictEqual(player.currentTime, 35)
  await find(activePage(harness, video), 'VideoOverlay').props.onFavorite()
  await harness.settle()
  assert.strictEqual(openCount, 1)
  find(activePage(harness, video), 'VideoOverlay').props.onSeek(0)
  await harness.settle()
  await realProgress.syncPendingPlayback(device, videoId)
  assert.strictEqual(getRemotePosition(), 0, 'screen seeking must persist an explicit zero')
  const oldNativeListeners = { ...player.listeners }
  find(activePage(harness, video), 'VideoOverlay').props.onRetry()
  await harness.until(() => openCount === 2)
  await harness.settle()
  const retried = harness.players[0]
  assert.strictEqual(harness.players.length, 1, 'source retry reuses the same SDK native instance')
  assert.strictEqual(harness.players.filter(player => !player.released).length, 1)
  retried.status = 'readyToPlay'
  retried.listeners.sourceLoad({ videoSource: retried.source, duration: 100, availableVideoTracks: [] })
  retried.listeners.statusChange({ status: 'readyToPlay' })
  await harness.until(() => retried.seeks.length > 0)
  assert.strictEqual(retried.currentTime, 0, 'source retry must restore zero on the new player')
  const stateBeforeOldEvents = find(activePage(harness, video), 'VideoOverlay').props
  oldNativeListeners.statusChange({ status: 'error', error: { message: 'old decoder failure' } })
  oldNativeListeners.playingChange({ isPlaying: false })
  oldNativeListeners.timeUpdate({ currentTime: 99, bufferedPosition: 100 })
  oldNativeListeners.sourceLoad({ duration: 999, availableVideoTracks: [{ size: { width: 999, height: 999 } }] })
  await harness.settle()
  const stateAfterOldEvents = find(activePage(harness, video), 'VideoOverlay').props
  for (const key of ['error', 'currentTime', 'duration', 'isPlaying']) assert.strictEqual(stateAfterOldEvents[key], stateBeforeOldEvents[key], 'old native event must not update ' + key)
  harness.setAccessibility('screenReaderChanged', true)
  harness.setAccessibility('reduceMotionChanged', true)
  await harness.settle()
  const accessibleOverlay = () => find(activePage(harness, video), 'VideoOverlay').props
  assert.strictEqual(accessibleOverlay().controlsVisible, true, 'playback controls stay reachable while the screen reader is enabled')
  await accessibleOverlay().onFavorite(); await harness.settle()
  assert.strictEqual(accessibleOverlay().heartBurst, false, 'reduced motion suppresses the decorative favorite burst')
  const hideDelay = phone.load('mobile/src/screens/player/playerLayout.ts').CONTROLS_HIDE_DELAY_MS
  assert.ok(!harness.pendingTimerDelays().includes(hideDelay), 'screen reader interaction must not arm a control-hide timer')
  harness.setAccessibility('screenReaderChanged', false); await harness.settle()
  accessibleOverlay().onControlsInteract(true); await harness.settle()
  assert.strictEqual(accessibleOverlay().controlsVisible, true)
  assert.ok(!harness.pendingTimerDelays().includes(hideDelay), 'holding the seek responder prevents the controls from disappearing')
  accessibleOverlay().onControlsInteract(false); await harness.settle()
  assert.strictEqual(harness.pendingTimerDelays().filter(ms => ms === hideDelay).length, 1, 'release restores the ordinary auto-hide behavior')
  harness.unmount()
  assert.strictEqual(harness.accessibilitySubscriptionCount(), 0)
  assert.strictEqual(harness.players.filter(player => !player.released).length, 0)
  await harness.settle()
  await realProgress.syncPendingPlayback(device, videoId)
}
module.exports = { verifyPlayerBehavior, createHookHarness, find, activePage }
