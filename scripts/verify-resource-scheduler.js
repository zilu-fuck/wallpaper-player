const assert = require('assert')
const { EventEmitter } = require('events')
const { ResourceScheduler } = require('../main/application/resource-scheduler')
const { MediaWorkService } = require('../main/application/media-work-service')
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(done => setImmediate(done)) }

async function main() {
  let pressure = false
  const scheduler = new ResourceScheduler({ getPressure: () => ({ active: pressure }), subscribe: () => () => {} })
  const first = new AbortController(), second = new AbortController(), a = deferred(), b = deferred(), events = []
  let activeSignal
  const one = scheduler.enqueue({ key: 'shared', type: 'metadata', signal: first.signal }, async context => {
    activeSignal = context.signal; events.push('shared'); await a.promise; return 'shared-result'
  })
  const two = scheduler.enqueue({ key: 'shared', type: 'metadata', signal: second.signal }, () => { throw new Error('duplicate worker') })
  const other = scheduler.enqueue({ key: 'other', type: 'metadata' }, async () => { events.push('other'); await b.promise; return 'other-result' })
  await tick(); assert.strictEqual(scheduler.diagnostics().running, 2)
  const oneCancelled = assert.rejects(one, error => error.code === 'task_cancelled')
  first.abort(); await oneCancelled
  assert.strictEqual(activeSignal.aborted, false, 'one consumer cannot cancel a shared worker')
  const twoCancelled = assert.rejects(two, error => error.code === 'task_cancelled')
  second.abort(); await twoCancelled; assert.strictEqual(activeSignal.aborted, true)
  const background = scheduler.enqueue({ key: 'warm', background: true, priority: 0 }, async () => { events.push('warm'); return 'warm' })
  const visible = scheduler.enqueue({ key: 'visible', priority: 40 }, async () => { events.push('visible'); return 'visible' })
  const preview = scheduler.enqueue({ key: 'preview', priority: 80 }, async () => { events.push('preview'); return 'preview' })
  await tick(); assert.strictEqual(scheduler.diagnostics().running, 2)
  assert.deepStrictEqual(events, ['shared', 'other'], 'cancel does not release native resources before the worker closes')
  pressure = true; a.resolve(); await tick()
  assert.deepStrictEqual(events.slice(2), ['preview', 'visible']); assert.strictEqual(scheduler.diagnostics().queued, 1)
  assert.strictEqual(await preview, 'preview'); assert.strictEqual(await visible, 'visible')
  pressure = false; scheduler.drain(); assert.strictEqual(await background, 'warm')
  b.resolve(); assert.strictEqual(await other, 'other-result'); await tick()
  assert.strictEqual(scheduler.diagnostics().running, 0)

  pressure = true
  let promotedRuns = 0
  const warmed = scheduler.enqueue({ key: 'promoted', type: 'metadata', background: true }, () => { promotedRuns++; return 'promoted' })
  const promoted = scheduler.enqueue({ key: 'promoted', type: 'metadata', priority: 60 }, () => { throw new Error('duplicate promotion') })
  assert.deepStrictEqual(await Promise.all([warmed, promoted]), ['promoted', 'promoted']); assert.strictEqual(promotedRuns, 1)

  const stubborn = deferred()
  const timed = scheduler.enqueue({ key: 'timed', timeoutMs: 20 }, () => stubborn.promise)
  await assert.rejects(timed, error => error.code === 'task_timeout')
  assert.strictEqual(scheduler.diagnostics().running, 1, 'a timeout retains the slot until actual cleanup completes')
  stubborn.resolve(); await tick()
  const lease = await scheduler.acquire({ key: 'lease', type: 'transcode', timeoutMs: 1000 })
  assert.strictEqual(scheduler.diagnostics().running, 1); lease.release(); await tick()
  assert.strictEqual(scheduler.diagnostics().running, 0)
  await scheduler.dispose()
  await assert.rejects(scheduler.enqueue({}, () => 1), error => error.code === 'task_stopping')

  const limited = new ResourceScheduler({ backgroundLimit: 2, getPressure: () => ({ active: true }), subscribe: () => () => {} })
  const queued = [1, 2].map(key => limited.enqueue({ key, background: true }, () => key))
  await assert.rejects(limited.enqueue({ key: 3, background: true }, () => 3), error => error.code === 'task_queue_full')
  const queuedRejected = queued.map(value => assert.rejects(value, error => error.code === 'task_stopping'))
  await limited.dispose(); await Promise.all(queuedRejected)

  const service = new MediaWorkService(), senderA = new EventEmitter(), senderB = new EventEmitter()
  senderA.id = 1; senderB.id = 2
  const held = deferred(); let ownerSignal
  const owned = service.run({ sender: senderA }, 'owned', async signal => { ownerSignal = signal; await held.promise })
  assert.strictEqual(service.cancel({ sender: senderB }, 'owned').cancelled, false)
  assert.strictEqual(ownerSignal.aborted, false, 'another renderer cannot release an owner with the same request ID')
  senderA.emit('did-start-navigation', {}, 'about:blank', false, false); assert.strictEqual(ownerSignal.aborted, false)
  senderA.emit('did-start-navigation', {}, 'about:blank', false, true); assert.strictEqual(ownerSignal.aborted, true)
  held.resolve(); await assert.rejects(owned, error => error.code === 'task_cancelled')
  service.cancel({ sender: senderA }, 'late')
  await assert.rejects(service.run({ sender: senderA }, 'late', () => 1), error => error.code === 'task_cancelled')
  await assert.rejects(service.run({ sender: senderA }, '../invalid', () => 1))
  for (let index = 0; index < 300; index++) service.cancel({ sender: senderB }, 'nonce_' + index)
  assert.strictEqual(service.owners.get(senderB.id).cancelled.size, 256)
  service.dispose()
  await assert.rejects(service.run({ sender: senderA }, 'after-close', () => 1), error => error.code === 'task_stopping')
  assert.strictEqual(senderA.listenerCount('destroyed'), 0); assert.strictEqual(senderA.listenerCount('did-start-navigation'), 0)
  assert.strictEqual(senderB.listenerCount('destroyed'), 0); assert.strictEqual(service.owners.size, 0)
  console.log('resource scheduler passed: shared interests, newest foreground priority, promotion under playback pressure, queue/deadline bounds, no premature resource release, external execution leases, renderer ownership/retired requests and shutdown cleanup')
}
const deadline = setTimeout(() => { console.error('resource scheduler verification timed out'); process.exit(1) }, 10000)
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => clearTimeout(deadline))
