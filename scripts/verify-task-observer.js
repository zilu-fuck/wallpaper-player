const assert = require('assert')
const { phone } = require('./mobile-module-harness')
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate) {
  const deadline = Date.now() + 3000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('task observer did not reach the expected state')
    await delay(5)
  }
}
async function main() {
  const client = phone(), { TaskObserver } = client.load('mobile/src/services/task-observer.ts')
  const observer = new TaskObserver(), first = deferred()
  let calls = 0, signal
  const run = async owned => { calls++; signal = owned; return first.promise }
  const a = observer.request(run), b = observer.request(run)
  await delay(0); assert.strictEqual(calls, 1)
  observer.stop(); assert.ok(signal.aborted)
  first.resolve('old'); assert.strictEqual(await a, undefined); assert.strictEqual(await b, undefined)
  let active = 0, maximum = 0, received = 0, failures = 0
  observer.poll(async () => {
    calls++; active++; maximum = Math.max(maximum, active)
    await delay(35); active--; return calls
  }, () => ++received < 3, () => failures++, 5)
  await until(() => received === 3)
  assert.strictEqual(received, 3); assert.strictEqual(maximum, 1); assert.strictEqual(failures, 0)
  const terminalCalls = calls; await delay(40); assert.strictEqual(calls, terminalCalls)
  const slow = deferred(); let oldReceived = 0
  observer.poll(async () => slow.promise, () => { oldReceived++; return true }, () => failures++, 5)
  await delay(0)
  observer.poll(async () => 'replacement', value => { assert.strictEqual(value, 'replacement'); return false }, () => failures++, 5)
  slow.resolve('superseded'); await delay(20); assert.strictEqual(oldReceived, 0)
  observer.poll(async () => { throw new Error('terminal') }, () => true, () => failures++, 5)
  await delay(30); assert.strictEqual(failures, 1)
  observer.dispose(); assert.strictEqual(await observer.request(async () => 'closed'), undefined)
  console.log('task observer passed: single request, abort, ignored stubborn late responses, completion-paced polling, replacement, terminal failure and disposal')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
