const assert = require('node:assert/strict')
const { phone } = require('./mobile-module-harness')
const { createHookHarness } = require('./verify-mobile-player-behavior')
const contracts = require('../packages/contracts')
function findClass(tree, name) {
  if (!tree || typeof tree !== 'object') return null
  if (Array.isArray(tree)) return tree.map(value => findClass(value, name)).find(Boolean)
  if (tree.props?.className?.split(' ').includes(name)) return tree
  return findClass(tree.props?.children, name)
}
function mediaElement() {
  const listeners = new Map()
  const element = { currentTime: 0, duration: 20, readyState: 0, paused: true, volume: 1, muted: true, playbackRate: 1, loop: false, src: '',
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn) },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn) },
    emit(name) { for (const fn of listeners.get(name) || []) fn() },
    async play() { element.paused = false; element.emit('play') }, pause() { element.paused = true; element.emit('pause') },
    removeAttribute(name) { if (name === 'src') element.src = '' }, load() { element.readyState = 0 },
    listenerCount: () => [...listeners.values()].reduce((n, set) => n + set.size, 0) }
  return element
}
async function scenario(initiallyHidden = false, engine = 'mpv') {
  const client = phone(), harness = createHookHarness(client), listeners = new Map(), events = new Map(), requests = []
  client.stubs.react.memo = value => value
  let native, current = '', sequence = 0, video = { fullPath: 'E:/visibility/a.mp4', name: 'A', playbackToken: 'a' }
  const on = (name, fn) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return () => listeners.get(name).delete(fn) }
  const emit = value => { for (const fn of listeners.get('state') || []) fn(value) }
  const api = {
    async playerAction(input) {
      const request = contracts.playerActionSchema.parse(input); requests.push(request)
      if (request.action === 'load') {
        current = request.sessionId
        native = { sessionId: current, engineSessionId: ++sequence, resourceTarget: request.target, filePath: request.target,
          timePos: 1, duration: 20, paused: false, ready: true, volume: 100, muted: true, speed: 1, eofReached: false, trackList: [] }
        emit(native)
      } else if (current !== request.sessionId) return { success: false, code: 'stale_session', error: 'Replaced' }
      else if (request.action === 'stop') { current = ''; return { success: true, sessionId: request.sessionId } }
      else if (request.action === 'command' && request.command.command === 'setPaused') { native = { ...native, paused: request.command.value }; emit(native) }
      else if (request.action === 'command' && request.command.command === 'cyclePause') { native = { ...native, paused: !native.paused }; emit(native) }
      return { success: true, sessionId: request.sessionId, state: native }
    },
    onMpvState: fn => on('state', fn), onMpvEnded: fn => on('ended', fn), onMpvError: fn => on('error', fn),
    getPlaybackState: async () => ({ position: 0 }), getFileUrl: async target => 'video://' + target,
    savePlaybackState: async () => ({ success: true }), setMediaPlaybackActive: async () => ({ success: true })
  }
  const surface = { innerWidth: 1200, innerHeight: 800, electronAPI: api,
    addEventListener(name, fn) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn) },
    removeEventListener(name, fn) { events.get(name)?.delete(fn) } }
  const document = { hidden: initiallyHidden, documentElement: { clientWidth: 1200, clientHeight: 800 }, addEventListener: surface.addEventListener, removeEventListener: surface.removeEventListener }
  client.control.globals = { ...client.control.globals, window: surface, document }
  const context = { settings: {}, plugins: [], pluginsLoaded: true, mpvStatus: { available: engine === 'mpv' }, queueItems: [], setPlayerError() {}, registerPlayerCommandTarget: () => () => {} }
  client.override('src/context/AppContext.js', { useAppFields: () => context, useAppSelection: selector => selector(context) })
  for (const name of ['VideoAnalysisPanel', 'PlayerAnalysisStatus', 'PlayerProgressPreview', 'PlayerToolbarMenu']) {
    client.override((name === 'VideoAnalysisPanel' ? 'src/components/' : 'src/components/player/') + name + '.jsx', { __esModule: true, default: name, formatSpeed: speed => speed + 'x' })
  }
  const VideoPlayer = client.load('src/components/VideoPlayer.jsx').default
  let element
  const elements = []
  const bind = async () => {
    const node = findClass(harness.tree(), 'player-video')
    if (node && element?.src !== 'video://' + video.fullPath) {
      element = mediaElement(); elements.push(element); node.props.ref(element); element.readyState = 1; element.emit('loadedmetadata'); await harness.settle()
    }
  }
  const mount = async () => { harness.mount(() => VideoPlayer({ video })); await harness.settle(); await bind() }
  await mount()
  return {
    state: () => element || native, requests, callbacks: () => [...(events.get('visibilitychange') || [])],
    async restoreAfterOldCallbacks(old) { document.hidden = false; old.forEach(fn => fn()); for (const fn of events.get('visibilitychange') || []) fn(); await harness.settle() },
    async fallback() { for (const fn of listeners.get('error') || []) fn({ sessionId: current, message: 'decoder failed' }); await harness.settle(); await bind() },
    async visibility(hidden) { document.hidden = hidden; for (const fn of [...(events.get('visibilitychange') || [])]) fn(); await harness.settle() },
    async toggle() { findClass(harness.tree(), 'player-play-toggle').props.onClick(); await harness.settle() },
    async switchVideo() { video = { fullPath: 'E:/visibility/b.mp4', name: 'B', playbackToken: 'b' }; await mount() },
    async dispose() {
      harness.unmount(); await harness.settle()
      assert.deepEqual(harness.diagnostics(), { intervals: 0, timers: 0, frames: 0, listeners: 0 })
      assert.equal([...listeners.values(), ...events.values()].reduce((n, set) => n + set.size, 0), 0)
      assert.equal(elements.reduce((n, el) => n + el.listenerCount(), 0), 0)
    }
  }
}
const cases = [
  ['background mount pauses before readiness', async test => { assert.equal(test.state().paused, true); await test.visibility(false); assert.equal(test.state().paused, false) }, true],
  ['visible playback auto-pauses and resumes', async test => { await test.visibility(true); assert.equal(test.state().paused, true); await test.visibility(false); assert.equal(test.state().paused, false) }],
  ['manual pause survives hiding and restoration', async test => { await test.toggle(); assert.equal(test.state().paused, true); await test.visibility(true); await test.visibility(false); assert.equal(test.state().paused, true) }],
  ['replacement while hidden is paused', async test => { await test.visibility(true); await test.switchVideo(); assert.equal(test.state().paused, true); await test.visibility(false); assert.equal(test.state().paused, false) }],
  ['explicit pause overrides an earlier automatic pause', async test => { await test.visibility(true); await test.toggle(); await test.toggle(); assert.equal(test.state().paused, true); await test.visibility(false); assert.equal(test.state().paused, true) }],
  ['retired visibility callbacks cannot consume the new auto-resume', async test => { const old = test.callbacks(); await test.visibility(true); await test.switchVideo(); await test.restoreAfterOldCallbacks(old); assert.equal(test.state().paused, false) }]
]
async function main() {
  const failures = []
  for (const engine of ['mpv', 'html5']) for (const [name, run, hidden] of cases) {
    const test = await scenario(hidden, engine)
    try { await run(test); console.log('visibility passed: ' + engine + ': ' + name) }
    catch (error) { failures.push({ engine, name, error: error.message }); console.error('visibility failed: ' + engine + ': ' + name + ': ' + error.message) }
    finally { await test.dispose() }
  }
  const fallback = await scenario()
  try { await fallback.visibility(true); await fallback.fallback(); assert.equal(fallback.state().paused, true); await fallback.visibility(false); assert.equal(fallback.state().paused, false); console.log('visibility passed: hidden native failure to HTML5 preserves automatic pause ownership') }
  finally { await fallback.dispose() }
  assert.deepEqual(failures, [], 'desktop visibility and manual pause intent')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
