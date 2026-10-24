const assert = require('assert')
const { phone } = require('./mobile-module-harness')
const { createHookHarness } = require('./verify-mobile-player-behavior')
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const next = async () => { for (let index = 0; index < 50; index++) await Promise.resolve() }
const deadline = setTimeout(() => { console.error('app initialization verification timed out'); process.exit(1) }, 30000)

async function behavior() {
  const { AppInitialization } = phone().load('src/services/app-initialization.js')
  const reads = [], scans = [], ffmpeg = [], mpv = [], views = [], loading = []; let plugins = 0, cancelled = 0
  const owner = new AppInitialization({ settings: () => { const item = deferred(); reads.push(item); return item.promise },
    scan: async value => scans.push(value), setLoading: value => loading.push(value), cancelScan: () => cancelled++,
    plugins: async () => { if (++plugins === 1) throw Error('plugin read failure') },
    ffmpeg: () => { const item = deferred(); ffmpeg.push(item); return item.promise },
    mpv: () => { const item = deferred(); mpv.push(item); return item.promise } }, value => views.push(value))
  const first = owner.run(); assert.strictEqual(first, owner.run()); await next(); reads[0].reject(Error('settings read failure')); await first
  assert.strictEqual(owner.view.initializationErrors.settings, 'settings read failure'); assert.strictEqual(loading.at(-1), false)
  const retry = owner.run(); await next(); reads[1].resolve({ directories: ['public'] }); await retry; await next()
  assert.strictEqual(scans.length, 1); assert.strictEqual(owner.view.initializationErrors.settings, '')
  assert.strictEqual(owner.view.initializationErrors.plugins, 'plugin read failure')
  ffmpeg[0].reject(Error('ffmpeg check failed')); mpv[0].resolve({}); await next()
  await owner.run('plugins'); assert.strictEqual(owner.view.initializationErrors.plugins, '')
  const ffRetry = owner.run('ffmpeg'); assert.strictEqual(ffRetry, owner.run('ffmpeg')); await next(); ffmpeg[1].resolve({}); await ffRetry
  assert.strictEqual(owner.view.initializationErrors.ffmpeg, ''); assert.strictEqual(reads.length, 2, 'optional retries do not reload settings or reset the library')
  assert.strictEqual(scans.length, 1)
  const superseded = owner.run('ffmpeg'); await next(); owner.accept('ffmpeg'); ffmpeg[2].reject(Error('obsolete probe failure')); await superseded
  assert.strictEqual(owner.view.initializationErrors.ffmpeg, '', 'a newer authoritative probe result supersedes an old failure')
  const retired = owner.run(); await next(); owner.dispose(); const before = views.length
  reads[2].resolve({ directories: ['late'] }); await retired
  assert.strictEqual(views.length, before); assert.strictEqual(scans.length, 1); assert.strictEqual(cancelled, 1)
}

async function hook() {
  const client = phone(), harness = createHookHarness(client), events = [], read = deferred(), probe = deferred(), mpv = deferred(), revisions = { ffmpeg: 0, mpv: 0 }
  const app = { readSettings: () => read.promise, setLoading: value => events.push(['loading', value]),
    refreshPlugins: async () => [], setCurrentDir: value => events.push(['directory', value]),
    getStatusRevision: key => revisions[key],
    setFfmpegStatus: value => { revisions.ffmpeg++; events.push(['ffmpeg', value]) }, setMpvStatus: value => { revisions.mpv++; events.push(['mpv', value]) } }
  client.control.globals = { ...client.control.globals, window: { electronAPI: { checkFfmpeg: () => probe.promise, checkMpv: () => mpv.promise } } }
  const { useAppInitialization } = client.load('src/hooks/useAppInitialization.js')
  harness.mount(() => useAppInitialization(app, { cancelScan: () => events.push(['cancel']), scanAndLoad: async dir => events.push(['scan', dir]) }))
  read.resolve({ directories: ['/public', '/private'], privateDirectories: ['/private'], defaultDirectory: '/private' }); await harness.settle()
  assert.strictEqual(events.find(([name]) => name === 'directory')[1], '/public', 'initialization cannot select a private default from a stale snapshot')
  app.setMpvStatus({ available: true, path: 'manual-path' }); mpv.resolve({ available: false }); await harness.settle()
  assert.strictEqual(events.filter(([name]) => name === 'mpv').length, 1, 'a late startup probe cannot replace a later manual path or installation result')
  harness.unmount(); const count = events.length; probe.resolve({ available: true }); await harness.settle()
  assert.strictEqual(events.length, count, 'retired probes cannot publish status after hook cleanup')
}
async function main() { await behavior(); await hook(); console.log('app initialization passed: production owner/hook, visible failure state, per-job coalesced retries, independent optional work, private default exclusion and cleanup') }
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => clearTimeout(deadline))
