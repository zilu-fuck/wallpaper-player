const assert = require('assert')
const { phone } = require('./mobile-module-harness')
const { createHookHarness } = require('./verify-mobile-player-behavior')
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function main() {
  const client = phone(), observers = [], thumbnails = [], metadata = [], cancellations = [], imageURLs = [], updates = []
  const commitRefs = tree => {
    if (!tree || typeof tree !== 'object') return
    if (Array.isArray(tree)) return tree.forEach(commitRefs)
    if (tree.props?.ref && typeof tree.props.ref === 'object' && !tree.props.ref.current) {
      tree.props.ref.current = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) }
    }
    commitRefs(tree.props?.children)
  }
  const harness = createHookHarness(client, { commitRefs })
  client.stubs.react.memo = value => value; client.stubs.react.useLayoutEffect = client.stubs.react.useEffect
  client.stubs['react-dom'] = { createPortal: value => value }
  class Observer { constructor(callback) { this.callback = callback; observers.push(this) } observe() { this.callback([{ isIntersecting: true }]) } disconnect() { this.closed = true } }
  const api = { generateThumbnail(path, requestId) { const pending = deferred(); thumbnails.push({ path, requestId, ...pending }); return pending.promise },
    getVideoMetadata(path, { requestId }) { const pending = deferred(); metadata.push({ path, requestId, ...pending }); return pending.promise },
    async cancelMediaWork(requestId) { cancellations.push(requestId) },
    async getThumbnailUrl(path) { imageURLs.push(path); return 'image://' + path } }
  const context = { settings: {}, plugins: [], pluginsLoaded: true, thumbnails: {}, favoriteKeys: new Set(), selectedVideoKeys: [],
    setVideos: value => updates.push(value) }
  client.override('src/context/AppContext.js', { useAppActions: () => context, useAppSelection: select => select(context) })
  client.control.globals = { ...client.control.globals, IntersectionObserver: Observer,
    window: { electronAPI: api, setTimeout: client.control.globals.setTimeout, clearTimeout: client.control.globals.clearTimeout,
      addEventListener() {}, removeEventListener() {} }, document: { querySelector: () => null, body: {} } }
  const VideoCard = client.load('src/components/VideoCard.jsx').default
  const video = { fullPath: 'E:/library/shared.mp4', fileName: 'shared.mp4', extension: '.mp4', name: 'Shared', size: 1, modified: 1, tags: [] }
  harness.mount(() => [VideoCard({ video, index: 0, viewMode: 'grid' }), VideoCard({ video, index: 1, viewMode: 'grid' })])
  await harness.until(() => metadata.length === 2 && thumbnails.length === 2)
  assert.notStrictEqual(metadata[0].requestId, metadata[1].requestId, 'each visible card retains its own shared-task interest')
  observers[0].callback([{ isIntersecting: false }]); await harness.settle()
  assert.ok(cancellations.includes(metadata[0].requestId)); assert.ok(cancellations.includes(thumbnails[0].requestId))
  assert.ok(!cancellations.includes(metadata[1].requestId), 'leaving one card cannot release another card interest')
  metadata[0].resolve({ success: true, media: { available: true, width: 999 } }); thumbnails[0].resolve({ thumbPath: 'retired.jpg' })
  await harness.settle(); assert.strictEqual(updates.length, 0); assert.ok(!imageURLs.includes('retired.jpg'))
  metadata[1].resolve({ success: true, media: { available: true, width: 320 } }); thumbnails[1].resolve({ thumbPath: 'current.jpg' })
  await harness.until(() => updates.length === 1)
  assert.ok(imageURLs.includes('current.jpg'))
  assert.strictEqual(updates[0]([video])[0].media.width, 320)
  observers[0].callback([{ isIntersecting: true }]); await harness.until(() => thumbnails.length === 3)
  const final = thumbnails.at(-1)
  harness.unmount(); await harness.settle()
  assert.ok(cancellations.includes(final.requestId)); assert.ok(observers.every(observer => observer.closed))
  final.resolve({ thumbPath: 'after-unmount.jpg' }); await harness.settle()
  assert.ok(!imageURLs.includes('after-unmount.jpg'))
  assert.deepStrictEqual(harness.diagnostics(), { intervals: 0, timers: 0, frames: 0, listeners: 0 })
  console.log('card media lifecycle passed: production visible cards, independent interests, leave/re-enter/unmount cancellation, ignored late metadata/images, live-owner metadata publication and observer/timer cleanup')
}
const deadline = setTimeout(() => { console.error('card media verification timed out'); process.exit(1) }, 10000)
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => clearTimeout(deadline))
