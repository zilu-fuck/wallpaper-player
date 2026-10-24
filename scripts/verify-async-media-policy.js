const assert = require('assert'), fs = require('fs'), fsp = require('fs/promises'), path = require('path'), Module = require('module')
const { EventEmitter } = require('events')
const { removeTempRootWithRetry } = require('./verify-helpers')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
fs.mkdirSync(parent, { recursive: true })
const fixture = fs.mkdtempSync(path.join(parent, 'async-media-policy-'))
const delay = ms => new Promise(done => setTimeout(done, ms))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const until = async predicate => { const deadline = Date.now() + 5000
  while (!predicate()) { if (Date.now() > deadline) throw new Error('async media policy condition timed out'); await delay(4) } }
async function main() {
  process.chdir(fixture)
  const settings = require('../main/settings'), privateDir = path.join(fixture, 'private'), video = path.join(privateDir, 'source.mp4')
  fs.mkdirSync(privateDir); fs.writeFileSync(video, Buffer.alloc(512))
  await settings.saveSettingsAndFlush({ directories: [fixture, privateDir], privateDirectories: [] })
  const original = Module._load, rootGates = new Map(), entered = new Set()
  let fileGate = null, fileEntered = false, accessCalls = 0, activeRoots = 0, maxRoots = 0
  Module._load = function (name, owner, ...rest) {
    const filename = owner?.filename.replace(/\\/g, '/') || ''
    if (name === 'fs/promises' && filename.endsWith('/main/security/media-access.js')) return { ...fsp, realpath: async input => {
      entered.add(input); activeRoots++; maxRoots = Math.max(maxRoots, activeRoots)
      try { if (rootGates.has(input)) await rootGates.get(input).promise; return await fsp.realpath(input) } finally { activeRoots-- }
    } }
    if (name === 'fs/promises' && filename.endsWith('/main/scanner.js')) return { ...fsp,
      realpath: async input => { if (fileGate && input === video) { fileEntered = true; await fileGate.promise } return fsp.realpath(input) },
      access: async input => { accessCalls++; return fsp.access(input) } }
    return original.call(this, name, owner, ...rest)
  }
  let scanner, policy
  try { scanner = require('../main/scanner'); policy = require('../main/security/media-access') } finally { Module._load = original }
  require('../main/window')
  try {
    const gate = deferred(); rootGates.set(fixture, gate)
    const denied = scanner.assertAllowedVideoPath(video, { audience: 'remote' }).catch(error => error)
    await until(() => entered.has(fixture))
    await settings.saveSettingsAndFlush({ privateDirectories: [privateDir] })
    gate.resolve(); rootGates.clear()
    assert.strictEqual((await denied).status, 404, 'permissions changed while resolving roots cannot publish a stale public decision')

    entered.clear(); const lockGate = deferred(); rootGates.set(fixture, lockGate)
    const sender = new EventEmitter(); sender.id = 810; sender.isDestroyed = () => false
    policy.unlockDesktopPrivacy(sender)
    const locked = scanner.assertAllowedVideoPath(video, { audience: 'desktop', senderId: sender.id }).catch(error => error)
    await until(() => entered.has(fixture)); policy.lockDesktopPrivacy(sender); lockGate.resolve(); rootGates.clear()
    assert.strictEqual((await locked).status, 403, 'privacy is checked after asynchronous root resolution')

    fileGate = deferred(); const controller = new AbortController(), beforeAccess = accessCalls
    const abandoned = scanner.assertAllowedVideoPath(video, { signal: controller.signal }).catch(error => error)
    await until(() => fileEntered); controller.abort(new Error('cancelled-realpath')); fileGate.resolve(); fileGate = null
    assert.match((await abandoned).message, /cancelled-realpath/); assert.strictEqual(accessCalls, beforeAccess, 'cancellation after realpath prevents the next filesystem stage')

    const roots = Array.from({ length: 12 }, (_, index) => path.join(fixture, 'root-' + index))
    roots.forEach(dir => fs.mkdirSync(dir)); await settings.saveSettingsAndFlush({ directories: roots, privateDirectories: [] })
    entered.clear(); maxRoots = 0; roots.forEach(dir => rootGates.set(dir, deferred()))
    const cancellation = new AbortController(); let settled = false
    const work = policy.createMediaAccessPolicyAsync({ signal: cancellation.signal }).catch(error => error).finally(() => { settled = true })
    await until(() => activeRoots === 8); cancellation.abort(new Error('cancelled-roots'))
    rootGates.get(roots[0]).resolve(); await delay(15)
    assert.strictEqual(settled, false, 'a rejected root operation still waits for the other actual filesystem calls')
    for (const gate of rootGates.values()) gate.resolve()
    assert.match((await work).message, /cancelled-roots/)
    assert.strictEqual(maxRoots, 8); assert.strictEqual(entered.size, 8); assert.strictEqual(activeRoots, 0)
    rootGates.clear(); await settings.saveSettingsAndFlush({ directories: [fixture], privateDirectories: [] })
    let syncCalls = 0; const realpathSync = fs.realpathSync.native
    fs.realpathSync.native = (...args) => { syncCalls++; return realpathSync(...args) }
    try { assert.strictEqual(await scanner.assertAllowedVideoPath(video, { audience: 'remote', senderId: 0 }), await fsp.realpath(video)) }
    finally { fs.realpathSync.native = realpathSync }
    assert.strictEqual(syncCalls, 0, 'interactive video authorization uses asynchronous canonicalization throughout')
    await settings.saveSettingsAndFlush({ directories: [fixture, privateDir], privateDirectories: [privateDir] }); syncCalls = 0
    fs.realpathSync.native = (...args) => { syncCalls++; return realpathSync(...args) }
    try { await assert.rejects(scanner.assertAllowedVideoPath(video, { audience: 'desktop', senderId: 0 }), error => error.code === 'media_access_denied') }
    finally { fs.realpathSync.native = realpathSync }
    assert.strictEqual(syncCalls, 0, 'denied desktop authorization also avoids synchronous canonicalization')
    console.log('async media policy passed: production scanner/policy, zero synchronous realpath calls, changed privacy/settings during root IO, cancellation before the next stage, maximum eight root resolutions and actual cleanup before settlement')
  } finally { for (const gate of rootGates.values()) gate.resolve(); fileGate?.resolve(); scanner.unwatchAllDirectories(); await settings.flushSettingsWrites() }
}
const deadline = setTimeout(() => { console.error('async media policy verification timed out'); process.exit(1) }, 15000)
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  clearTimeout(deadline); process.chdir(root); assert.strictEqual(path.dirname(path.resolve(fixture)), parent); await removeTempRootWithRetry(fixture)
})
