const assert = require('assert')
const { phone } = require('./mobile-module-harness')
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(done => setImmediate(done)) }

async function main() {
  const client = phone(), timers = new Map(), replacements = [], seeks = [], failures = []
  let timerId = 0, preparing = 0, maximumPreparing = 0, position = 0, released = false, holdClears = false
  client.control.globals = {
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id },
    clearTimeout(id) { timers.delete(id) }
  }
  const native = { status: 'idle', playing: false, duration: 100, playbackRate: 1,
    play() { if (released) throw new Error('released'); this.playing = true },
    pause() { if (released) throw new Error('released'); this.playing = false },
    replaceAsync(source) {
      if (released) return Promise.reject(new Error('released'))
      const pending = deferred(); replacements.push({ source, ...pending })
      if (!source) { if (!holdClears) pending.resolve(); return pending.promise }
      preparing++; maximumPreparing = Math.max(maximumPreparing, preparing)
      return pending.promise.finally(() => { preparing-- })
    }
  }
  Object.defineProperty(native, 'currentTime', { get() { if (released) throw new Error('released'); return position },
    set(value) { if (released) throw new Error('released'); position = value; seeks.push(value) } })
  const { ExpoPlaybackAdapter } = client.load('mobile/src/services/playback-adapter.ts')
  const adapter = new ExpoPlaybackAdapter(native)
  const owner = (id, token = 'token') => ({ player: native, videoId: id, source: 'http://desktop/' + id, deviceId: 'pc', bindingId: 'binding', token })
  const source = value => ({ uri: value.source, headers: { Authorization: 'Bearer ' + value.token } })
  const load = value => adapter.load(value, () => true, error => failures.push(error.message))
  const sources = () => replacements.filter(item => item.source)
  const a = owner('a'), b = owner('b'), c = owner('c')
  load(a); await settle(); load(b); load(c); await settle()
  assert.deepStrictEqual(sources().map(item => item.source.uri), [a.source], 'a pending native replacement must serialize later sources')
  assert.ok(replacements.filter(item => !item.source).length >= 2, 'null replacement cancels superseded native preparation')
  sources()[0].resolve(); await settle()
  assert.deepStrictEqual(sources().map(item => item.source.uri), [a.source, c.source], 'only the latest queued source reaches native preparation')
  assert.strictEqual(maximumPreparing, 1)
  native.status = 'readyToPlay'
  assert.strictEqual(adapter.ready(c), false, 'replaceAsync resolution is not a committed native media item')
  assert.strictEqual(adapter.sourceLoaded(c, source(a), () => true), false)
  assert.strictEqual(adapter.sourceLoaded(c, source(owner('c', 'old-token')), () => true), false, 'matching URI cannot cross credential generations')
  assert.strictEqual(adapter.sourceLoaded(c, c.source, () => true), false, 'a string source cannot prove the authenticated source')
  native.status = 'loading'
  adapter.seek(0); adapter.pause(); adapter.sourceChanged(c, source(c))
  assert.strictEqual(adapter.sourceLoaded(c, source(c), () => true), true)
  sources()[1].resolve(); await settle()
  assert.strictEqual(adapter.ready(c), false, 'metadata and source commit are insufficient before decoder readiness')
  assert.strictEqual(native.playing, false)
  native.status = 'readyToPlay'; adapter.statusChanged(c, native.status); adapter.activate(c, () => true)
  assert.deepStrictEqual(seeks, [0], 'an early explicit zero overrides restore exactly once')
  assert.strictEqual(native.playing, false, 'an early pause survives decoder readiness')
  adapter.sourceLoaded(c, source(c), () => true)
  assert.deepStrictEqual(seeks, [0], 'duplicate metadata does not repeat the seek')
  assert.strictEqual(timers.size, 0)
  adapter.play(); assert.strictEqual(adapter.getState().phase, 'playing')
  position = 12.5; native.status = 'loading'; adapter.statusChanged(c, native.status)
  assert.strictEqual(adapter.getState().phase, 'buffering')
  assert.strictEqual(adapter.getState().position, 12.5, 'buffering must retain the checkpoint rather than write a default zero')
  native.status = 'readyToPlay'; adapter.statusChanged(c, native.status); adapter.activate(c, () => true)
  assert.strictEqual(adapter.ended(c), false, 'an unscoped late end event cannot end a current item far from its end')
  position = 99.8; assert.strictEqual(adapter.ended(c), true)
  assert.strictEqual(adapter.getState().phase, 'ended'); assert.strictEqual(native.playing, false)
  adapter.seek(0); adapter.play(); assert.strictEqual(adapter.getState().phase, 'playing')
  adapter.stop(a); assert.strictEqual(adapter.owns(c), true, 'old cleanup cannot stop the current owner')

  const broken = owner('broken')
  load(broken); await settle(); sources().at(-1).reject(new Error('decoder failed')); await settle()
  assert.strictEqual(adapter.getState().phase, 'error'); assert.strictEqual(failures.at(-1), 'decoder failed')
  native.status = 'readyToPlay'
  assert.strictEqual(adapter.sourceLoaded(broken, source(broken), () => true), false, 'a failed replacement cannot be resurrected by late metadata')
  assert.strictEqual(native.playing, false); assert.strictEqual(timers.size, 0)

  const timed = owner('timed')
  load(timed); await settle()
  const [id, expire] = [...timers][0]; timers.delete(id); expire()
  assert.strictEqual(adapter.getState().phase, 'error'); assert.match(failures.at(-1), /超时/)
  sources().at(-1).resolve(); await settle()
  assert.strictEqual(adapter.sourceLoaded(timed, source(timed), () => true), false)
  assert.strictEqual(native.playing, false)
  const recovery = owner('recovery')
  load(recovery); await settle(); sources().at(-1).resolve(); await settle()
  native.status = 'readyToPlay'; adapter.sourceLoaded(recovery, source(recovery), () => false)
  assert.strictEqual(native.playing, false, 'background readiness cannot autoplay')
  holdClears = true
  native.status = 'error'; assert.strictEqual(adapter.statusChanged(recovery, native.status, 'native failed'), true)
  assert.strictEqual(adapter.getState().phase, 'error'); assert.strictEqual(timers.size, 0)
  native.status = 'readyToPlay'; assert.strictEqual(adapter.sourceLoaded(recovery, source(recovery), () => true), false)

  const final = owner('final')
  const beforeFinal = sources().length
  load(final); await settle()
  assert.strictEqual(sources().length, beforeFinal, 'a previous async clear must settle before a new source starts')
  replacements.filter(item => !item.source).forEach(item => item.resolve()); holdClears = false
  await settle(); sources().at(-1).resolve(); await settle()
  native.status = 'readyToPlay'; adapter.sourceLoaded(final, source(final), () => true)
  position = 45; assert.strictEqual(adapter.getState().position, 45)
  released = true
  assert.doesNotThrow(() => adapter.stop(final), 'SDK release ordering must not throw during cleanup')
  assert.strictEqual(adapter.getState().position, 45)
  assert.strictEqual(adapter.getState().phase, 'stopped'); assert.strictEqual(timers.size, 0)
  await settle()
  console.log('mobile playback adapter passed: one serialized native preparation, latest source and credentials, commit/readiness separation, zero/pause intent, buffering checkpoint, guarded end, failure/timeout recovery, background and release ordering')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
