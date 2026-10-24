const assert = require('assert'), fs = require('fs'), fsp = require('fs/promises'), path = require('path'), crypto = require('crypto')
const { MpvVersionCache } = require('../main/application/mpv-version-cache')
const { removeTempRootWithRetry } = require('./verify-helpers')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
fs.mkdirSync(parent, { recursive: true }); const fixture = fs.mkdtempSync(path.join(parent, 'mpv-version-cache-'))
const pause = ms => new Promise(done => setTimeout(done, ms))
async function main() {
  let sequence = 0
  async function setup(options = {}) {
    const directory = path.join(fixture, 'case-' + (++sequence)), versions = path.join(directory, 'versions'), ids = []
    await fsp.mkdir(versions, { recursive: true })
    const add = async (bytes = 20) => {
      const id = crypto.randomUUID(), target = path.join(versions, id); ids.push(id); await fsp.mkdir(target)
      await fsp.writeFile(path.join(target, 'mpv.exe'), Buffer.alloc(bytes / 2, 1)); await fsp.writeFile(path.join(target, 'runtime.dll'), Buffer.alloc(bytes / 2, 2))
      await fsp.utimes(target, new Date(1000000000000 + ids.length * 1000), new Date(1000000000000 + ids.length * 1000)); return id
    }
    const exe = id => path.join(versions, id, 'mpv.exe')
    const current = id => fsp.writeFile(path.join(directory, 'installed.json'), JSON.stringify({ version: 1, installation: id }))
    return { directory, versions, ids, add, exe, current, cache: new MpvVersionCache({ directory, ...options }) }
  }
  const a = await setup(), old = await a.add(), middle = await a.add(), active = await a.add(), latest = await a.add()
  await a.current(latest)
  const lease = await a.cache.retain(a.exe(old)), selected = await a.cache.retain(a.exe(middle))
  const other = new MpvVersionCache({ directory: a.directory })
  let result = await other.collect({}, { count: 1, bytes: 0 })
  assert.strictEqual(result.overBudget, true); assert.ok(fs.existsSync(a.exe(old)) && fs.existsSync(a.exe(middle)) && fs.existsSync(a.exe(latest)))
  assert.strictEqual(fs.existsSync(a.exe(active)), false, 'only unprotected versions are retired')
  lease.release(); result = await other.collect({}, { count: 1, bytes: 0 })
  assert.strictEqual(result.overBudget, false); assert.strictEqual(fs.existsSync(a.exe(old)), false); selected.release()

  const bytes = await setup({ maxBytes: 50 }), first = await bytes.add(30), current = await bytes.add(30)
  await bytes.current(current)
  result = await bytes.cache.collect(); assert.strictEqual(result.bytes, 30); assert.strictEqual(fs.existsSync(bytes.exe(first)), false)
  assert.strictEqual((await bytes.cache.collect({}, { count: 1, bytes: 30 })).overBudget, true, 'the current version survives byte-budget admission failure')
  assert.ok(fs.existsSync(bytes.exe(current)))

  let configured = ''
  const config = await setup({ maxVersions: 1, configuredPaths: () => [configured] }), pinned = await config.add(), pointer = await config.add()
  await config.current(pointer); configured = config.exe(pinned)
  assert.strictEqual((await config.cache.collect()).overBudget, true); assert.ok(fs.existsSync(configured))
  configured = ''; await config.cache.collect(); assert.strictEqual(fs.existsSync(config.exe(pinned)), false)

  const unknown = await setup({ maxVersions: 1 }); await unknown.add(); const u = await unknown.add(); await unknown.current(u)
  const opaque = await unknown.cache.retain('mpv')
  assert.strictEqual((await unknown.cache.collect()).protectedUnknown, true)
  opaque.release(); assert.strictEqual((await unknown.cache.collect()).versions, 1)

  const cancellation = await setup({ maxVersions: 1 }), candidate = await cancellation.add(), kept = await cancellation.add(); await cancellation.current(kept)
  const cancel = new AbortController(), rename = fsp.rename
  fsp.rename = async (source, target) => { await rename(source, target); if (path.basename(source) === candidate && path.basename(target).startsWith('.trash-')) cancel.abort(new Error('cancel-retirement')) }
  try { await assert.rejects(cancellation.cache.collect({ signal: cancel.signal }), /cancel-retirement/) } finally { fsp.rename = rename }
  assert.ok(fs.existsSync(cancellation.exe(candidate))); assert.strictEqual((await fsp.readdir(cancellation.versions)).some(name => name.startsWith('.trash-')), false)

  const partial = await setup({ maxVersions: 1 }), doomed = await partial.add(), survivor = await partial.add(); await partial.current(survivor)
  const remove = fsp.rm
  fsp.rm = async (target, options) => {
    if (path.basename(target).startsWith('.trash-' + doomed)) { await fsp.unlink(path.join(target, 'runtime.dll')); throw Object.assign(new Error('controlled delete failure'), { code: 'EACCES' }) }
    return remove(target, options)
  }
  try { result = await partial.cache.collect(); assert.strictEqual(result.overBudget, true) } finally { fsp.rm = remove }
  assert.strictEqual(fs.existsSync(partial.exe(doomed)), false, 'a partially deleted directory is never restored as a usable version')
  await assert.rejects(partial.cache.retain(partial.exe(doomed)))
  const retiredDirectory = (await fsp.readdir(partial.versions)).find(name => name.startsWith('.trash-'))
  await assert.rejects(partial.cache.retain(path.join(partial.versions, retiredDirectory, 'mpv.exe')), error => error.code === 'mpv_version_unavailable')
  result = await partial.cache.collect(); assert.strictEqual(result.versions, 1); assert.strictEqual(result.overBudget, false)

  const unpublished = path.join(partial.directory, '.install-unpublished'); await fsp.mkdir(unpublished)
  await fsp.writeFile(path.join(unpublished, 'mpv.exe'), 'unpublished')
  await assert.rejects(partial.cache.retain(path.join(unpublished, 'mpv.exe')), error => error.code === 'mpv_version_unavailable')

  const recovery = await setup({ maxVersions: 1 }), recoveryId = await recovery.add()
  await recovery.current(crypto.randomUUID())
  assert.strictEqual((await recovery.cache.collect({}, { count: 1, bytes: 0 })).overBudget, true)
  assert.ok(fs.existsSync(recovery.exe(recoveryId)), 'a missing pointer target preserves the latest complete recovery version')

  const lock = await setup(), lockedId = await lock.add(); await lock.current(lockedId)
  let release, entered = false
  const barrier = new Promise(done => { release = done })
  const holding = lock.cache.serialize({}, async () => { entered = true; await barrier })
  while (!entered) await pause(1)
  const stopped = new AbortController(), waiting = lock.cache.retain(lock.exe(lockedId), { signal: stopped.signal })
  const rejected = assert.rejects(waiting, /cancel-waiter/); stopped.abort(new Error('cancel-waiter')); await rejected
  release(); await holding

  const linked = await setup({ maxVersions: 1 }), good = await linked.add(); await linked.current(good)
  const outside = path.join(fixture, 'outside'); await fsp.mkdir(outside); await fsp.writeFile(path.join(outside, 'mpv.exe'), 'preserve')
  await fsp.symlink(outside, path.join(linked.versions, crypto.randomUUID()), 'junction')
  result = await linked.cache.collect(); assert.strictEqual(result.overBudget, true)
  assert.strictEqual(await fsp.readFile(path.join(outside, 'mpv.exe'), 'utf8'), 'preserve')
  console.log('mpv version cache passed: actual filesystem, cross-instance leases, current/configured/opaque-path protection, count/byte admission, quarantine rollback, partial-delete isolation/retry, cancelled lock waiters and junction boundary preservation')
}
const deadline = setTimeout(() => { console.error('mpv cache verification timed out'); process.exit(1) }, 20000)
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  clearTimeout(deadline); assert.strictEqual(path.dirname(path.resolve(fixture)), parent); await removeTempRootWithRetry(fixture)
})
