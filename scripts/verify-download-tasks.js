const assert = require('assert'), fs = require('fs'), fsp = require('fs/promises'), path = require('path')
const { DownloadTasks, digest } = require('../main/application/download-tasks')
const { ResourceScheduler } = require('../main/application/resource-scheduler')
const { removeTempRootWithRetry } = require('./verify-helpers')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
fs.mkdirSync(parent, { recursive: true }); const fixture = fs.mkdtempSync(path.join(parent, 'download-tasks-'))
const delay = ms => new Promise(done => setTimeout(done, ms))
const until = async predicate => { const deadline = Date.now() + 6000
  while (!predicate()) { if (Date.now() > deadline) throw new Error('download task condition timed out'); await delay(4) } }
async function main() {
  const scheduler = new ResourceScheduler({ subscribe: () => () => {} }), services = [], tasks = new Map(), calls = []
  let stops = 0, blockPause = false, unpauseGate = null
  const rpc = async (method, params) => {
    calls.push({ method, gid: params[0] }); const task = tasks.get(params[0])
    if (method === 'aria2.saveSession') return 'OK'
    if (!task) throw Object.assign(new Error('missing task'), { code: 'aria2_rpc_error', taskNotFound: true })
    if (method === 'aria2.tellStatus') return { ...task, followedBy: [...(task.followedBy || [])] }
    if (method === 'aria2.forcePause') { if (blockPause) throw new Error('transport failure'); task.status = 'paused'; return task.gid }
    if (method === 'aria2.unpause') { if (unpauseGate) await unpauseGate; task.status = 'active'; return task.gid }
    if (method === 'aria2.forceRemove') { task.status = 'removed'; return task.gid }
    if (method === 'aria2.removeDownloadResult') { tasks.delete(task.gid); return 'OK' }
    if (method === 'aria2.changeOption') { task.selection = params[1]['select-file']; return 'OK' }
    throw new Error('unexpected RPC ' + method)
  }
  const create = (name, options = {}) => { const service = new DownloadTasks({ filename: path.join(fixture, name + '.json'), scheduler, rpc, pollMs: 3600000,
    stopEngine: async () => { stops++; for (const task of tasks.values()) if (task.status === 'active') task.status = 'paused' }, ...options }); services.push(service); return service }
  const descriptor = operationId => ({ operationId, fingerprint: digest('same-resource'), kind: 'url', name: 'source.mp4' })
  let sent = 0
  try {
    const ledger = create('main'); await ledger.engineStarted()
    const send = async gid => {
      assert.ok(JSON.parse(await fsp.readFile(ledger.file(), 'utf8')).tasks.some(task => task.gid === gid), 'durable intent precedes the effect')
      sent++; tasks.set(gid, { gid, status: 'active', files: [{ index: '1', path: 'source.mp4' }] })
      throw new Error('lost ACK')
    }
    const [a, b] = await Promise.all([ledger.submit(descriptor('lost-ack'), send), ledger.submit(descriptor('lost-ack'), send)])
    assert.strictEqual(a.gid, b.gid); assert.strictEqual(sent, 1); assert.strictEqual(a.confirmationPending, true)
    await ledger.poll(); assert.strictEqual(ledger.entries.get(a.gid).pending, false)
    await assert.rejects(ledger.submit({ ...descriptor('lost-ack'), fingerprint: digest('changed') }, send), error => error.code === 'download_operation_conflict')
    assert.strictEqual(sent, 1); assert.ok(!fs.readFileSync(ledger.file(), 'utf8').includes('lost-ack'), 'raw operation and source values are not saved')
    const oldGeneration = ledger.entries.get(a.gid).generation
    await ledger.control(a.gid, 'pause'); assert.strictEqual(tasks.get(a.gid).status, 'paused')
    await ledger.control(a.gid, 'resume'); assert.notStrictEqual(ledger.entries.get(a.gid).generation, oldGeneration)
    const beforeStaleControl = calls.length
    await assert.rejects(ledger.control(a.gid, 'pause', undefined, { expectedGeneration: oldGeneration }), error => error.code === 'download_task_conflict')
    assert.strictEqual(calls.length, beforeStaleControl, 'stale controls never reach the engine')
    const beforeOldExpiry = calls.length; await ledger.expire(a.gid, oldGeneration); assert.strictEqual(calls.length, beforeOldExpiry)
    await assert.rejects(ledger.control(a.gid.slice(0, 6), 'pause'), /编号无效/)

    await ledger.control(a.gid, 'pause')
    let release; unpauseGate = new Promise(done => { release = done })
    const resumed = ledger.control(a.gid, 'resume'); await until(() => calls.at(-1)?.method === 'aria2.unpause')
    const removed = ledger.control(a.gid, 'remove'); await delay(15)
    assert.ok(tasks.has(a.gid), 'removal waits for the earlier actual unpause')
    release(); await resumed; await removed; unpauseGate = null
    assert.strictEqual(tasks.has(a.gid), false); assert.strictEqual(ledger.decorate().length, 0)
    await ledger.submit(descriptor('lost-ack'), send); assert.strictEqual(sent, 1, 'removed operation receipts cannot be restarted by a late retry')

    const magnet = await ledger.submit({ ...descriptor('magnet'), kind: 'magnet' }, async gid => {
      tasks.set(gid, { gid, status: 'complete', followedBy: ['1111111111111111', '3333333333333333'] })
      tasks.set('1111111111111111', { gid: '1111111111111111', status: 'paused', following: gid, followedBy: ['2222222222222222'], files: [{ index: '1', path: 'movie.mp4' }] })
      tasks.set('2222222222222222', { gid: '2222222222222222', status: 'paused', following: '1111111111111111' })
      tasks.set('3333333333333333', { gid: '3333333333333333', status: 'paused', following: gid })
      return gid
    })
    await ledger.poll(); await ledger.poll(); await ledger.poll()
    assert.strictEqual(ledger.entries.get('1111111111111111').rootGid, magnet.gid)
    await assert.rejects(ledger.control('1111111111111111', 'select', [2]), /有效文件/)
    const parentGeneration = ledger.entries.get(magnet.gid).generation
    await ledger.control('1111111111111111', 'select', [1]); assert.strictEqual(tasks.get('1111111111111111').selection, '1')
    await assert.rejects(ledger.control(magnet.gid, 'remove', undefined, { expectedGeneration: parentGeneration }), error => error.code === 'download_task_conflict')
    await ledger.control('3333333333333333', 'resume')
    await ledger.control('1111111111111111', 'remove'); assert.strictEqual(tasks.has('2222222222222222'), false)
    assert.strictEqual(tasks.get('3333333333333333').status, 'active', 'branch removal preserves another child')
    await ledger.control(magnet.gid, 'remove'); assert.strictEqual(tasks.has('1111111111111111'), false)
    assert.strictEqual(tasks.has('3333333333333333'), false)
    await assert.rejects(ledger.control('1111111111111111', 'resume'))

    tasks.set('8888888888888888', { gid: '8888888888888888', status: 'complete', followedBy: ['9999999999999999'] })
    tasks.set('9999999999999999', { gid: '9999999999999999', status: 'paused', following: '8888888888888888' })
    await ledger.control('9999999999999999', 'resume')
    assert.strictEqual(ledger.entries.get('9999999999999999').rootGid, '8888888888888888', 'legacy child-first control adopts the actual parent chain')
    await ledger.control('8888888888888888', 'remove'); assert.strictEqual(tasks.has('9999999999999999'), false)

    const expiring = create('expiry', { taskMs: 100 })
    await expiring.engineStarted()
    const timed = await expiring.submit(descriptor('timed'), async gid => { tasks.set(gid, { gid, status: 'active' }); return gid })
    await until(() => expiring.entries.get(timed.gid).expired && !expiring.entries.get(timed.gid).pending)
    assert.strictEqual(tasks.get(timed.gid).status, 'paused'); assert.strictEqual(expiring.decorate()[0].controls.resume, true)
    blockPause = true; await expiring.control(timed.gid, 'resume')
    await until(() => stops === 1); assert.strictEqual(expiring.live, false)
    blockPause = false; await expiring.dispose()
    const completed = create('complete-at-expiry', { taskMs: 80 }); await completed.engineStarted()
    const finished = await completed.submit(descriptor('complete-race'), async gid => { tasks.set(gid, { gid, status: 'complete' }); return gid })
    await until(() => completed.entries.get(finished.gid).state === 'complete' && !completed.entries.get(finished.gid).pending)
    assert.strictEqual(completed.decorate()[0].status, 'complete', 'confirmed completion wins over a simultaneous expiry request')
    await completed.dispose()

    const survivor = await ledger.submit(descriptor('restart'), async gid => { sent++; tasks.set(gid, { gid, status: 'active' }); return gid })
    await ledger.dispose(); for (const task of tasks.values()) task.status = 'paused'
    const restored = create('main'); await restored.engineStarted(); await restored.poll()
    const repeated = await restored.submit(descriptor('restart'), send)
    assert.strictEqual(repeated.gid, survivor.gid); assert.strictEqual(tasks.get(survivor.gid).status, 'paused', 'restart never resumes a task implicitly')
    await restored.control(survivor.gid, 'resume'); assert.strictEqual(tasks.get(survivor.gid).status, 'active')
    await restored.dispose(); tasks.delete(survivor.gid)
    const missing = create('main'); await missing.engineStarted(); await missing.poll()
    assert.strictEqual(missing.entries.get(survivor.gid).state, 'missing')
    const beforeMissing = sent; await missing.submit(descriptor('restart'), send); assert.strictEqual(sent, beforeMissing)

    const denied = create('write-failure'); await denied.engineStarted()
    const rename = fsp.rename
    fsp.rename = async (source, target) => { if (target === denied.file()) throw Object.assign(new Error('disk denied'), { code: 'EACCES' }); return rename(source, target) }
    try { await assert.rejects(denied.submit(descriptor('not-accepted'), send), /disk denied/) } finally { fsp.rename = rename }
    assert.strictEqual(sent, beforeMissing, 'failed durable admission performs no network side effect')
    const cancelled = create('cancelled-admission'); await cancelled.engineStarted()
    const open = fsp.open, cancellation = new AbortController(); let entered = false, releaseWrite
    const writeBarrier = new Promise(done => { releaseWrite = done })
    fsp.open = async (file, ...options) => {
      const handle = await open(file, ...options)
      if (!String(file).startsWith(cancelled.file() + '.')) return handle
      return { writeFile: handle.writeFile.bind(handle), close: handle.close.bind(handle), sync: async () => { entered = true; await writeBarrier; await handle.sync() } }
    }
    try {
      const admission = cancelled.submit(descriptor('cancel-during-sync'), send, { signal: cancellation.signal }).catch(error => error)
      await until(() => entered); cancellation.abort(new Error('cancel-before-publication')); releaseWrite()
      assert.match((await admission).message, /cancel-before-publication/)
    } finally { releaseWrite(); fsp.open = open }
    assert.strictEqual(sent, beforeMissing); assert.strictEqual(fs.existsSync(cancelled.file()), false)
    const capped = create('cap', { limit: 1, historyLimit: 2 }); await capped.engineStarted()
    await capped.submit(descriptor('one'), async gid => { tasks.set(gid, { gid, status: 'active' }); return gid })
    await assert.rejects(capped.submit(descriptor('two'), send), error => error.code === 'download_task_limit')
    const busy = create('busy-monitor', { pollMs: 30 }); await busy.engineStarted()
    const pending = await busy.submit(descriptor('pending-monitor'), async gid => { tasks.set(gid, { gid, status: 'active' }); throw new Error('lost ACK') })
    const changing = await busy.submit(descriptor('changing-monitor'), async gid => { tasks.set(gid, { gid, status: 'active' }); return gid })
    for (let i = 0; i < 20; i++) { await busy.control(changing.gid, 'resume'); await delay(5) }
    assert.strictEqual(busy.entries.get(pending.gid).pending, false, 'unrelated commands never postpone another task confirmation indefinitely')
    await fsp.writeFile(path.join(fixture, 'corrupt.json'), '{broken')
    await assert.rejects(create('corrupt').engineStarted(), /账本无法读取/)
    assert.strictEqual(fs.readFileSync(path.join(fixture, 'corrupt.json'), 'utf8'), '{broken')
    console.log('download tasks passed: durable fixed-GID admission, concurrent/lost-ACK deduplication, source conflict, serialized controls, stale deadline isolation, exact child ownership/selection/removal, per-task expiry/fail-closed stop, restart without implicit resume, missing/corrupt/disk-failure preservation and quotas')
  } finally { await Promise.allSettled(services.map(service => service.dispose())); await scheduler.dispose() }
}
const deadline = setTimeout(() => { console.error('download task verification timed out'); process.exit(1) }, 20000)
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  clearTimeout(deadline); assert.strictEqual(path.dirname(path.resolve(fixture)), parent); await removeTempRootWithRetry(fixture)
})
