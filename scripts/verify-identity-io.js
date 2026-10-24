const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const http = require('node:http')
const Module = require('node:module')
const { performance } = require('node:perf_hooks')
const root = path.resolve(__dirname, '..')
const parent = path.join(root, '.tmp/refactor-tests')
fs.mkdirSync(parent, { recursive: true })
const fixture = fs.mkdtempSync(path.join(parent, 'identity-io-'))
const baseline = process.argv.includes('--baseline')
const userData = path.join(fixture, '.tmp-wallpaper-player')
fs.mkdirSync(userData)
const identityFile = path.join(userData, 'remote-identity.json')
const accessToken = crypto.randomBytes(32).toString('base64url')
fs.writeFileSync(identityFile, JSON.stringify({ deviceId: 'pc_fixture', deviceName: 'IO fixture', machineSecret: 'fixture-machine-secret',
  accessToken: 'fixture-legacy-secret', createdAt: Date.now(), pairedDevices: Array.from({ length: 100 }, (_, index) => ({
    id: 'phone_' + index, name: 'Fixture', platform: 'verify',
    tokenHash: crypto.createHash('sha256').update(index === 0 ? accessToken : 'other-' + index).digest('hex'),
    createdAt: Date.now(), lastSeenAt: Date.now(), lastAddress: '127.0.0.1', revokedAt: 0
  })) }))
process.chdir(fixture)
const sourceFiles = ['main/remote/identity.js', 'main/remote/server.js', 'main/remote/json-responses.js']
const capturedBaseline = path.join(parent, 'identity-io-baseline.json')
const replay = baseline && fs.existsSync(capturedBaseline) ? JSON.parse(fs.readFileSync(capturedBaseline, 'utf8')) : null
const sources = new Map()
const sourceDigests = Object.fromEntries(sourceFiles.map(file => {
  const source = fs.readFileSync(replay ? path.join(root, replay.fixture, path.basename(file) + '.at-start.cjs') : path.join(root, file))
  const digest = crypto.createHash('sha256').update(source).digest('hex')
  if (replay) assert.equal(digest, replay.sourceDigests[file], file)
  sources.set(path.join(root, file), source)
  fs.writeFileSync(path.join(fixture, path.basename(file) + '.at-start.cjs'), source)
  return [file, digest]
}))
const originalLoader = Module._extensions['.js']
if (replay) Module._extensions['.js'] = (mod, filename) => sources.has(filename)
  ? mod._compile(sources.get(filename).toString('utf8'), filename) : originalLoader(mod, filename)
let identity, server
try {
  identity = require('../main/remote/identity')
  server = require('../main/remote/server').createRemoteServer({ port: 0 })
} finally { Module._extensions['.js'] = originalLoader }
const originals = {}, counts = {}, results = []
let counting = false
const relevant = file => typeof file === 'string' && (file === identityFile || file.startsWith(identityFile + '.'))
for (const name of ['readFileSync', 'existsSync', 'writeFileSync', 'renameSync', 'statSync']) {
  originals[name] = fs[name]
  fs[name] = function (file, ...args) { if (counting && relevant(file)) counts[name]++; return originals[name].call(this, file, ...args) }
}
const request = () => new Promise((resolve, reject) => {
  const req = http.get({ hostname: '127.0.0.1', port: server.address().port, path: '/v1/auth',
    headers: { Authorization: 'Bearer ' + accessToken }, agent: false }, response => {
    response.resume(); response.on('end', () => response.statusCode === 200 ? resolve() : reject(Error('HTTP ' + response.statusCode)))
  })
  req.on('error', reject)
})
async function measure(name, operation) {
  for (const key of Object.keys(originals)) counts[key] = 0
  const started = performance.now(); let last = started, gap = 0
  const timer = setInterval(() => { const now = performance.now(); gap = Math.max(gap, now - last); last = now }, 1)
  counting = true
  try {
    await operation(); await identity.flushIdentityWrites?.(); await new Promise(resolve => setImmediate(resolve))
    gap = Math.max(gap, performance.now() - last)
    results.push({ name, milliseconds: performance.now() - started, maxHeartbeatGapMs: gap, synchronousIdentityIO: { ...counts } })
    if (!baseline) assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 0, name + ' must not perform synchronous identity IO')
  } finally { counting = false; clearInterval(timer) }
}
;(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  await request()
  await measure('twenty sequential authenticated HTTP requests', async () => { for (let i = 0; i < 20; i++) await request() })
  await measure('sixteen concurrent authenticated HTTP requests', () => Promise.all(Array.from({ length: 16 }, request)))
  const token = identity.createBoundScopedToken('thumbnail', 'fixture-video', accessToken, 60000)
  await measure('one thousand bound token checks', () => {
    for (let i = 0; i < 1000; i++) assert.equal(identity.verifyBoundScopedToken('thumbnail', 'fixture-video', token), true)
  })
  const evidence = { date: new Date().toISOString(), fixture: path.relative(root, fixture), baseline, sourceDigests, pairedDevices: 100, results,
    ...(replay ? { baselineMode: 'SHA-verified captured identity/server/JSON transport modules; current dependencies; production sources not replaced.' } : {}),
    conditions: 'Actual production HTTP server and identity repository, 100 generated paired identities, warmed local profile, loopback requests. Counts include identity/temp-file sync IO only. Single process observations, not P95 or phone/native acceptance.' }
  fs.writeFileSync(path.join(fixture, 'result.json'), JSON.stringify(evidence, null, 2))
  fs.writeFileSync(path.join(parent, 'identity-io-' + (baseline ? replay ? 'baseline-replay' : 'baseline' : 'after') + '.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence))
})().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  counting = false
  for (const [name, original] of Object.entries(originals)) fs[name] = original
  await identity.flushIdentityWrites?.()
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  process.chdir(root)
})
