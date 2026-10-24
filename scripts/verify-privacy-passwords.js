const assert = require('assert'), crypto = require('crypto'), fsp = require('fs/promises'), path = require('path'), http = require('http')
const { performance } = require('perf_hooks'), { EventEmitter } = require('events')
const { removeTempRootWithRetry, requestJson } = require('./verify-helpers')
const { createPrivacyPasswordService, createPrivacyAttemptQueue } = require('../main/security/privacy-password')
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const next = async () => { for (let index = 0; index < 50; index++) await Promise.resolve() }
const delay = ms => new Promise(done => setTimeout(done, ms))
const deadline = setTimeout(() => { console.error('privacy password verification timed out'); process.exit(1) }, 30000)

async function poolBehavior() {
  const calls = [], service = createPrivacyPasswordService({ concurrent: 1, limit: 2, derive: () => { const item = deferred(); calls.push(item); return item.promise } })
  const first = service.create('first-password'), second = service.create('second-password'); await next()
  await assert.rejects(service.create('overflow'), error => error.code === 'privacy_busy'); assert.strictEqual(calls.length, 1)
  calls[0].resolve(Buffer.alloc(32)); await first; await next(); assert.strictEqual(calls.length, 2)
  calls[1].reject(Error('derive failed')); await assert.rejects(second, /derive failed/); await next()
  let current = true
  const held = service.create('accepted'), cancelled = service.create('cancelled', () => { if (!current) throw Error('owner closed') }); await next()
  current = false; calls[2].resolve(Buffer.alloc(32)); await held; await assert.rejects(cancelled, /owner closed/)
  assert.strictEqual(calls.length, 3, 'cancelled queued passwords never start a native derivation')
  await assert.rejects(service.create('x'), /4 位/); await assert.rejects(service.create('x'.repeat(65537)), /64 KiB/)
  const run = createPrivacyAttemptQueue(3), gate = deferred(), order = []
  const a = run('same', async () => { order.push('a'); await gate.promise }), b = run('same', async () => order.push('b')), c = run('other', async () => order.push('other'))
  await assert.rejects(run('overflow', async () => {}), error => error.code === 'privacy_busy'); await next(); assert.deepStrictEqual(order, ['a', 'other'])
  gate.resolve(); await Promise.all([a, b, c]); assert.deepStrictEqual(order, ['a', 'other', 'b'])
}

async function withHeldDerivation(operation) {
  const original = crypto.pbkdf2, ready = deferred(); let release
  crypto.pbkdf2 = function (...args) {
    const callback = args.pop()
    return original(...args, (error, value) => { release = () => { release = null; callback(error, value) }; ready.resolve() })
  }
  try { await operation(ready.promise, () => release()) } finally { crypto.pbkdf2 = original; release?.(); await next() }
}

async function mainBehavior(fixture) {
  const settings = require('../main/settings'), access = require('../main/security/media-access'), handlers = new Map()
  require('../main/ipc/privacy').registerPrivacyIpc({ handle: (channel, handler) => handlers.set(channel, handler) })
  const sender = Object.assign(new EventEmitter(), { id: 311, send() {}, isDestroyed: () => false })
  require('../main/window').setMainWindow({ webContents: sender })
  const library = path.join(fixture, 'library'); await fsp.mkdir(library)
  await settings.saveSettingsAndFlush({ directories: [library], privateDirectories: [library], remoteAccess: { enabled: true, allowLegacyToken: true } })
  const invoke = (channel, password, options) => handlers.get(channel)({ sender }, password, options)
  access.lockDesktopPrivacy(sender)
  await withHeldDerivation(async (ready, release) => {
    const creating = invoke('privacy-set-password', 'abandoned-password'); await ready
    sender.emit('did-start-navigation', {}, 'file:///another.html', false, true); release()
    assert.strictEqual((await creating).success, false); assert.strictEqual(settings.loadSettings().privacy.passwordSet, false)
  })
  const rename = fsp.rename, settingsPath = path.join(require('../main/user-data').getUserDataDir(), 'settings.json')
  fsp.rename = async function (from, to) { if (to === settingsPath) throw Error('privacy disk failure'); return rename.call(this, from, to) }
  try {
    assert.ok((await invoke('privacy-set-password', 'failed-password')).error.includes('disk failure'))
    assert.strictEqual(settings.loadSettings().privacy.passwordSet, false); assert.strictEqual(access.createMediaAccessPolicy().privateUnlocked, false)
  } finally { fsp.rename = rename }
  const created = await Promise.all([invoke('privacy-set-password', 'fixture-password', { verifyOnly: true }), invoke('privacy-set-password', 'competing-password')])
  assert.deepStrictEqual(created.map(item => item.success), [true, false], 'concurrent first password creation cannot replace the first committed password')
  assert.strictEqual(access.createMediaAccessPolicy().privateUnlocked, false)
  const privacy = settings.loadSettings().privacy
  assert.strictEqual(await settings.verifyPrivacyPassword('fixture-password', privacy), true); assert.strictEqual(await settings.verifyPrivacyPassword('wrong', privacy), false)
  const legacySalt = '00112233445566778899aabbccddeeff'
  const legacy = { salt: legacySalt, passwordHash: crypto.pbkdf2Sync('legacy-fixture', legacySalt, 120000, 32, 'sha256').toString('hex') }
  assert.strictEqual(await settings.verifyPrivacyPassword('legacy-fixture', legacy), true, 'existing on-disk salt/hash format and PBKDF2 parameters remain compatible')
  for (const invalidate of [() => access.lockDesktopPrivacy(sender), () => sender.emit('did-start-navigation', {}, 'file:///another.html', false, true), () => sender.emit('render-process-gone')]) {
    await withHeldDerivation(async (ready, release) => {
      const unlocking = invoke('privacy-unlock', 'fixture-password'); await ready; invalidate(); release()
      assert.strictEqual((await unlocking).success, false); assert.strictEqual(access.createMediaAccessPolicy().privateUnlocked, false)
    })
  }
  assert.strictEqual((await invoke('privacy-unlock', 'fixture-password')).success, true)
  access.lockDesktopPrivacy(sender)
  await withHeldDerivation(async (ready, release) => {
    const unlocking = invoke('privacy-unlock', 'fixture-password'); await ready
    await settings.saveSettingsAndFlush({ privacy: legacy }); release()
    assert.ok((await unlocking).error.includes('已变化')); assert.strictEqual(access.createMediaAccessPolicy().privateUnlocked, false)
  })
  await settings.saveSettingsAndFlush({ privacy })
  let derivations = 0; const derive = crypto.pbkdf2
  crypto.pbkdf2 = function (...args) { derivations++; return derive(...args) }
  try {
    const failures = await Promise.all(Array.from({ length: 8 }, () => invoke('privacy-unlock', 'incorrect')))
    assert.strictEqual(derivations, 5, 'concurrent attempts cannot bypass the five-failure lockout')
    assert.ok(failures.every(item => !item.success)); assert.ok(failures.at(-1).error.includes('次数过多'))
  } finally { crypto.pbkdf2 = derive }

  const server = require('../main/remote/server').createRemoteServer({ port: 0 })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  try {
    const endpoint = 'http://127.0.0.1:' + server.address().port + '/v1/tags/restore-hidden'
    const headers = { Authorization: 'Bearer ' + require('../main/remote/identity').loadIdentity().accessToken, 'Content-Type': 'application/json' }
    await settings.saveSettingsAndFlush({ hiddenTags: ['keep-on-disconnect'] })
    await withHeldDerivation(async (ready, release) => {
      const request = http.request(endpoint, { method: 'POST', headers }); request.on('error', () => {}); request.end(JSON.stringify({ password: 'fixture-password' }))
      await ready; request.destroy(); await delay(30); release(); await delay(30)
      assert.deepStrictEqual(settings.loadSettings().hiddenTags, ['keep-on-disconnect'], 'a disconnected password request cannot later restore hidden tags')
    })
    const success = await requestJson(endpoint, { method: 'POST', headers, body: JSON.stringify({ password: 'fixture-password' }) })
    assert.strictEqual(success.status, 200); assert.deepStrictEqual(settings.loadSettings().hiddenTags, [])
    const failures = await Promise.all(Array.from({ length: 8 }, () => requestJson(endpoint, { method: 'POST', headers, body: JSON.stringify({ password: 'wrong' }) })))
    assert.strictEqual(failures.filter(item => item.status === 403).length, 4)
    assert.strictEqual(failures.filter(item => item.status === 429).length, 4)
    assert.ok(!JSON.stringify(settings.sanitizeSettingsForRenderer(settings.loadSettings())).includes(privacy.passwordHash))
  } finally { await new Promise(resolve => server.close(resolve)); await server.dispose?.() }
}

async function timing() {
  const service = createPrivacyPasswordService(), settings = require('../main/settings'), privacy = await settings.createPrivacyPassword('timing-fixture')
  async function sample(operation) {
    const started = performance.now(); const turn = new Promise(resolve => setImmediate(() => resolve(performance.now() - started)))
    await operation(); return { firstTurnMs: await turn, totalMs: performance.now() - started }
  }
  const before = await sample(() => { for (let i = 0; i < 8; i++) crypto.pbkdf2Sync('timing-fixture', privacy.salt, 120000, 32, 'sha256') })
  const after = await sample(() => Promise.all(Array.from({ length: 8 }, () => service.verify('timing-fixture', privacy))))
  return { environment: { platform: process.platform, node: process.version }, operations: 8, iterations: 120000, concurrent: 2, before, after }
}
async function main() {
  await poolBehavior()
  const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests'); await fsp.mkdir(parent, { recursive: true })
  const fixture = await fsp.mkdtemp(path.join(parent, 'privacy-password-')); process.chdir(fixture)
  try {
    await mainBehavior(fixture); const evidence = await timing()
    await fsp.writeFile(path.join(parent, 'privacy-password-timing.json'), JSON.stringify(evidence, null, 2) + '\n')
    console.log('privacy passwords passed: async compatible PBKDF2, bounded shared native work, queued cancellation, atomic first password, lock/navigation/process ownership, changed password, concurrent desktop/actual HTTP lockout and disconnected HTTP mutation')
    console.log('privacy password event-loop sample: ' + JSON.stringify(evidence))
  } finally {
    await require('../main/settings').flushSettingsWrites(); process.chdir(root)
    assert.strictEqual(path.dirname(path.resolve(fixture)), parent); await removeTempRootWithRetry(fixture)
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => clearTimeout(deadline))
