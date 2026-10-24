const assert = require('assert')
const { phone } = require('./mobile-module-harness')
const { createHookHarness, find } = require('./verify-mobile-player-behavior')
const contracts = require('../packages/contracts')
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const plain = value => JSON.parse(JSON.stringify(value))
function findClass(tree, className) {
  if (!tree || typeof tree !== 'object') return null
  if (Array.isArray(tree)) return tree.map(value => findClass(value, className)).find(Boolean)
  if (tree.props?.className === className) return tree
  return findClass(tree.props?.children, className)
}
function mediaElement() {
  const listeners = new Map()
  const element = { currentTime: 0, duration: 100, readyState: 0, paused: true, volume: 1, muted: false, playbackRate: 1,
    loop: false, src: '', error: null, ended: false,
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn) },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn) },
    emit(name) { for (const fn of [...(listeners.get(name) || [])]) fn({ currentTarget: element }) },
    async play() { element.paused = false; element.emit('play') }, pause() { element.paused = true; element.emit('pause') },
    removeAttribute(name) { if (name === 'src') element.src = '' }, load() { element.readyState = 0 },
    listenerCount: () => [...listeners.values()].reduce((count, value) => count + value.size, 0) }
  return element
}
async function main() {
  const client = phone(), harness = createHookHarness(client)
  client.stubs.react.memo = value => value
  client.stubs.react.useLayoutEffect = client.stubs.react.useEffect
  const listeners = new Map(), requests = [], saves = [], removed = new Set(), holds = new Map(), previews = []
  let current = '', native = null, advances = 0, playerError = '', sequence = 0, stopFailure = false
  const on = (name, fn) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return () => { listeners.get(name).delete(fn); removed.add(fn) } }
  const emit = (name, value) => { for (const fn of [...(listeners.get(name) || [])]) fn(value) }
  const baseState = (id, target) => ({ sessionId: id, engineSessionId: ++sequence, resourceTarget: target, filePath: target,
    timePos: 30, duration: 100, paused: false, ready: true, volume: 0, muted: true, speed: 1.5, eofReached: false, trackList: [] })
  const api = {
    async playerAction(input) {
      const request = contracts.playerActionSchema.parse(input); requests.push(request)
      if (request.action === 'load') {
        current = request.sessionId
        if (stopFailure) return { success: false, error: 'old process still alive', code: 'player_stop_timeout' }
        if (holds.has(request.target)) await holds.get(request.target).promise
        if (request.sessionId !== current) return { success: false, error: 'replaced', code: 'stale_session' }
        native = baseState(request.sessionId, request.target); emit('state', native)
      } else if (request.sessionId !== current) return { success: false, error: 'replaced', code: 'stale_session' }
      else if (request.action === 'stop') { current = ''; return { success: true, sessionId: request.sessionId } }
      else if (request.action === 'command') {
        if (request.command.command === 'seekTo') native = { ...native, timePos: request.command.value }
        if (request.command.command === 'setPaused') native = { ...native, paused: request.command.value }
        emit('state', native)
      }
      return { success: true, sessionId: request.sessionId, state: native }
    },
    onMpvState: fn => on('state', fn), onMpvEnded: fn => on('ended', fn), onMpvError: fn => on('error', fn),
    getPlaybackState: async () => ({ position: 40, volume: 0, muted: true, speed: 1.5 }),
    savePlaybackState: async (target, patch) => { saves.push({ target, patch }); return { success: true } },
    getFileUrl: async target => 'video://' + target,
    generatePreviewFrame: (target, seconds) => { const pending = deferred(); previews.push({ target, seconds, ...pending }); return pending.promise },
    getThumbnailUrl: async file => 'image://' + file,
    setMediaPlaybackActive: async () => ({ success: true })
  }
  const surfaceEvents = new Map()
  const surface = { innerWidth: 1200, innerHeight: 800, electronAPI: api,
    addEventListener: (name, fn) => { if (!surfaceEvents.has(name)) surfaceEvents.set(name, new Set()); surfaceEvents.get(name).add(fn) },
    removeEventListener: (name, fn) => surfaceEvents.get(name)?.delete(fn) }
  const document = { hidden: false, documentElement: { clientWidth: 1200, clientHeight: 800 },
    addEventListener: surface.addEventListener, removeEventListener: surface.removeEventListener }
  client.control.globals = { ...client.control.globals, window: surface, document }
  const context = { settings: {}, plugins: [], pluginsLoaded: true, mpvStatus: { available: true }, queueItems: [],
    setPlayerError: error => { playerError = error }, handleAdvanceFromEnd: () => { advances++ }, registerPlayerCommandTarget: () => () => {} }
  client.override('src/context/AppContext.js', { useAppFields: () => context, useAppSelection: select => select(context) })
  for (const name of ['VideoAnalysisPanel', 'PlayerAnalysisStatus', 'PlayerProgressPreview', 'PlayerToolbarMenu']) {
    const folder = name === 'VideoAnalysisPanel' ? 'src/components/' : 'src/components/player/'
    client.override(folder + name + '.jsx', { __esModule: true, default: name, formatSpeed: speed => speed + 'x' })
  }
  const VideoPlayer = client.load('src/components/VideoPlayer.jsx').default
  let video = { fullPath: 'E:/library/a.mp4', name: 'A', fileName: 'a.mp4', playbackToken: 'a1' }
  harness.mount(() => VideoPlayer({ video })); await harness.settle()
  assert.strictEqual(requests.filter(request => request.action === 'load').length, 1)
  const a = current, oldEnded = [...listeners.get('ended')][0]
  const hover = seconds => findClass(harness.tree(), 'player-progress-wrap').props.onMouseMove({ clientX: seconds,
    currentTarget: { getBoundingClientRect: () => ({ left: 0, width: 100 }) } })
  hover(10); await harness.until(() => previews.length === 1)
  findClass(harness.tree(), 'player-progress-wrap').props.onMouseLeave(); hover(30)
  await new Promise(done => setTimeout(done, 160)); await harness.settle()
  assert.strictEqual(previews.length, 1, 'production hide/re-enter cannot overlap a pending frame request')
  previews[0].resolve({ framePath: 'a10' }); await harness.until(() => previews.length === 2)
  assert.strictEqual(previews[1].seconds, 30)
  video = { ...video, tags: ['edited'], name: 'Updated A' }; harness.mount(() => VideoPlayer({ video })); await harness.settle()
  assert.strictEqual(requests.filter(request => request.action === 'load').length, 1, 'metadata edits cannot restart the player')
  assert.strictEqual(find(harness.tree(), 'PlayerProgressPreview').props.progressPreview.time, 30, 'metadata edits preserve the preview owner')
  holds.set('E:/library/b.mp4', deferred())
  video = { fullPath: 'E:/library/b.mp4', name: 'B', fileName: 'b.mp4', playbackToken: 'b1' }
  harness.mount(() => VideoPlayer({ video })); await harness.settle()
  previews[1].resolve({ framePath: 'a30' }); await harness.settle()
  assert.strictEqual(find(harness.tree(), 'PlayerProgressPreview').props.progressPreview.visible, false, 'the retired preview request cannot paint the new resource')
  oldEnded({ sessionId: a, reason: 'eof' }); emit('state', { ...baseState(a, 'E:/library/a.mp4'), timePos: 99 })
  await harness.settle(); assert.strictEqual(advances, 0)
  holds.get(video.fullPath).resolve(); await harness.settle()
  emit('ended', { sessionId: current, reason: 'eof' }); emit('ended', { sessionId: current, reason: 'eof' })
  await harness.settle(); assert.strictEqual(advances, 1)
  emit('error', { sessionId: current, message: 'current decoder failure' }); await harness.settle()
  const htmlNode = find(harness.tree(), 'video'); assert.ok(htmlNode, 'current engine failure falls back to HTML5')
  const element = mediaElement(); htmlNode.props.ref(element)
  element.readyState = 1; element.emit('loadedmetadata'); await harness.settle()
  assert.strictEqual(element.currentTime, 40); assert.strictEqual(element.volume, 0)
  const oldHtmlNode = htmlNode
  element.currentTime = 45; element.emit('timeupdate'); await harness.settle()
  video = { ...video, tags: ['again'] }; harness.mount(() => VideoPlayer({ video })); await harness.settle()
  assert.strictEqual(element.currentTime, 45, 'HTML5 metadata edits cannot restore old progress')
  video = { fullPath: 'E:/library/c.mp4', name: 'C', fileName: 'c.mp4', playbackToken: 'c1' }
  harness.mount(() => VideoPlayer({ video })); await harness.settle()
  assert.ok(requests.some(request => request.action === 'load' && request.target === video.fullPath), 'new resource retries the preferred engine')
  oldHtmlNode.props.onTimeUpdate({ currentTarget: element }); oldHtmlNode.props.onEnded({ currentTarget: element })
  await harness.settle(); assert.strictEqual(advances, 1)
  assert.strictEqual(element.src, ''); assert.strictEqual(element.listenerCount(), 0)
  assert.ok(saves.some(save => save.target === 'E:/library/b.mp4' && save.patch.position === 45), 'old final progress is saved from its own adapter')
  stopFailure = true
  video = { fullPath: 'E:/library/d.mp4', name: 'D', fileName: 'd.mp4', playbackToken: 'd1' }
  harness.mount(() => VideoPlayer({ video })); await harness.settle()
  assert.ok(!find(harness.tree(), 'video'), 'a live old process blocks HTML5 fallback as well as a new native process')
  assert.strictEqual(playerError, 'old process still alive')
  harness.unmount(); await harness.settle()
  assert.deepStrictEqual(harness.diagnostics(), { intervals: 0, timers: 0, frames: 0, listeners: 0 })
  assert.strictEqual([...surfaceEvents.values()].reduce((count, value) => count + value.size, 0), 0)
  assert.strictEqual([...listeners.values()].reduce((count, value) => count + value.size, 0), 0)
  assert.ok(removed.size > 0)
  await verifyAdapters(client)
  console.log('desktop player passed: production component and adapters, metadata stability, late native/media events, one queue advance, HTML5 fallback and preferred retry, volume zero, own final checkpoint and complete resource/listener cleanup')
}
async function verifyAdapters(client) {
  const { Html5Adapter, WebpageAdapter } = client.load('src/api/player.ts')
  const adapter = new Html5Adapter(), element = mediaElement()
  await adapter.seek(0); await adapter.pause(); adapter.load('video://source', { position: 40, volume: 0 })
  adapter.attach(element); assert.strictEqual(adapter.getState().explicitPosition, 0)
  element.readyState = 1; element.emit('loadedmetadata')
  assert.strictEqual(element.currentTime, 0); assert.strictEqual(element.paused, true)
  element.emit('waiting'); assert.strictEqual(adapter.getState().phase, 'buffering')
  await adapter.stop(); assert.strictEqual(element.listenerCount(), 0)
  const frame = mediaElement(), webpage = new WebpageAdapter()
  webpage.load(frame, 'https://example.com/Video')
  frame.emit('did-finish-load'); assert.strictEqual(webpage.getState().phase, 'ready')
  await assert.rejects(webpage.seek(10), error => error.code === 'unsupported_operation')
  await webpage.stop(); assert.strictEqual(frame.src, 'about:blank'); assert.strictEqual(frame.listenerCount(), 0)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
