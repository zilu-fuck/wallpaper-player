const assert = require('assert')
const { phone } = require('./mobile-module-harness')
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(done => setImmediate(done)) }
async function main() {
  const client = phone(), timers = new Map(), frames = new Map(), requests = [], published = [], urls = []
  let id = 0
  client.control.globals = {
    setTimeout(fn) { const key = ++id; timers.set(key, fn); return key }, clearTimeout(key) { timers.delete(key) },
    requestAnimationFrame(fn) { const key = ++id; frames.set(key, fn); return key }, cancelAnimationFrame(key) { frames.delete(key) }
  }
  const tickTimers = () => { const pending = [...timers]; timers.clear(); pending.forEach(([, fn]) => fn()) }
  const tickFrames = () => { const pending = [...frames]; frames.clear(); pending.forEach(([, fn]) => fn()) }
  const { ProgressPreviewController, MpvHostController } = client.load('src/services/player-resources.js')
  const api = { generatePreviewFrame(target, seconds) { const pending = deferred(); requests.push({ target, seconds, ...pending }); return pending.promise },
    async getThumbnailUrl(file) { urls.push(file); return 'image://' + file } }
  const preview = new ProgressPreviewController(api, 'a.mp4', value => published.push(value), { cacheLimit: 2, cacheBytes: 100 })
  preview.show(10.1, '100px'); tickTimers(); await settle()
  preview.show(20, '110px'); tickTimers(); await settle()
  preview.hide(); preview.show(30, '120px'); tickTimers(); await settle()
  assert.strictEqual(requests.length, 1, 'hide/re-enter cannot release a frame request which is still running')
  requests[0].resolve({ framePath: 'a10' }); await settle()
  assert.strictEqual(requests.length, 2); assert.strictEqual(requests[1].seconds, 30, 'only the latest hovered position follows the active request')
  assert.strictEqual(published.at(-1).imageUrl, '', 'an older position cannot paint the current hover')
  requests[1].resolve({ framePath: 'a30' }); await settle()
  assert.strictEqual(published.at(-1).imageUrl, 'image://a30')
  preview.show(40, '130px'); tickTimers(); await settle(); requests[2].resolve({ framePath: 'a40' }); await settle()
  assert.strictEqual(preview.cache.size, 2); assert.ok(!preview.cache.has(10))
  const requestCount = requests.length
  preview.show(30, '120px'); assert.strictEqual(timers.size, 0); assert.strictEqual(requests.length, requestCount)
  preview.show(50, '150px'); tickTimers(); await settle()
  const lastPublication = published.length, lastURL = urls.length
  preview.dispose(); requests[3].resolve({ framePath: 'a50' }); await settle()
  assert.strictEqual(published.length, lastPublication); assert.strictEqual(urls.length, lastURL, 'disposed owners do not request a late image URL')
  assert.strictEqual(preview.cache.size, 0); assert.strictEqual(timers.size, 0)
  const bounded = new ProgressPreviewController({ generatePreviewFrame: async () => ({ framePath: 'huge' }),
    getThumbnailUrl: async () => 'x'.repeat(100) }, 'bounded', () => {}, { cacheBytes: 20 })
  bounded.show(1, 0); tickTimers(); await settle(); assert.strictEqual(bounded.cache.size, 0)
  bounded.dispose()
  const failed = new ProgressPreviewController({ generatePreviewFrame: async () => { throw new Error('offline') }, getThumbnailUrl() {} }, 'failed', () => {})
  failed.show(1, 0); tickTimers(); await settle(); assert.strictEqual(failed.state.loading, false); failed.dispose()

  const listeners = new Map(), boundsCalls = [], observed = new Set()
  const surface = { innerWidth: 1200, innerHeight: 800,
    addEventListener(name, listener) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener) },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener) } }
  const page = { documentElement: { clientWidth: 1200, clientHeight: 800 } }
  let rect = { left: 100, top: 20, width: 640, height: 360, right: 740, bottom: 380 }, adapter = null, resize
  const element = { getBoundingClientRect: () => rect }
  class Observer { constructor(listener) { resize = listener } observe(value) { observed.add(value) } disconnect() { observed.clear() } }
  const host = new MpvHostController(() => element, () => adapter, surface, page)
  host.start(Observer); tickFrames(); await settle()
  assert.strictEqual(boundsCalls.length, 0, 'layout before adapter installation cannot consume the initial bounds')
  adapter = { bounds: async value => boundsCalls.push(value) }
  tickFrames(); await settle(); assert.strictEqual(boundsCalls.length, 1)
  tickFrames(); tickTimers(); await settle(); assert.strictEqual(boundsCalls.length, 1, 'unchanged bounds are deduplicated')
  rect = { ...rect, width: 700, right: 800 }; resize(); tickFrames(); await settle()
  assert.strictEqual(boundsCalls.at(-1).width, 700)
  rect = { left: 31.25, top: 90.125, width: 701.75, height: 359.5, right: 733, bottom: 449.625 }
  resize(); tickFrames(); await settle()
  assert.deepStrictEqual(JSON.parse(JSON.stringify(boundsCalls.at(-1))), { x: 31.25, y: 90.125, width: 701.75, height: 359.5 }, 'retain CSS fractions until the native zoom conversion')
  const oldFailure = deferred()
  adapter = { bounds: () => oldFailure.promise }; host.sync(); await settle()
  adapter = { bounds: async value => boundsCalls.push(value) }; host.sync(); await settle()
  const afterReplacement = boundsCalls.length
  oldFailure.reject(new Error('old session')); await settle(); host.sync(); await settle()
  assert.strictEqual(boundsCalls.length, afterReplacement, 'old bounds failure cannot invalidate the current adapter cache')
  rect = { ...rect, left: 1300, right: 2000 }; assert.strictEqual(host.readBounds(), null)
  const oldResize = resize
  host.dispose(); oldResize(); tickFrames(); tickTimers(); await settle()
  assert.strictEqual(frames.size, 0); assert.strictEqual(timers.size, 0); assert.strictEqual(observed.size, 0)
  assert.strictEqual([...listeners.values()].reduce((count, value) => count + value.size, 0), 0)
  assert.strictEqual(boundsCalls.length, afterReplacement)
  console.log('desktop player resources passed: latest hover and one request across hide/re-enter, bounded cache, no late publication after dispose, first bounds after adapter installation, resize deduplication, old failure isolation and complete observer/frame/timer cleanup')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
