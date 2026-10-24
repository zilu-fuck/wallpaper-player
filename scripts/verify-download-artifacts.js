const assert = require('assert'), fs = require('fs'), fsp = require('fs/promises'), path = require('path'), http = require('http')
const { downloadArtifact, publishArtifact } = require('../main/application/download-service')
const { mediaScheduler } = require('../main/application/resource-scheduler')
const { setDesktopPlaybackActive } = require('../main/media-pressure')
const { removeTempRootWithRetry } = require('./verify-helpers')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
fs.mkdirSync(parent, { recursive: true })
const fixture = fs.mkdtempSync(path.join(parent, 'download-artifacts-'))
const delay = ms => new Promise(done => setTimeout(done, ms))
const until = async predicate => { const end = Date.now() + 5000
  while (!predicate()) { if (Date.now() > end) throw new Error('download artifact condition timed out'); await delay(4) } }
async function main() {
  const authorizations = [], requests = [], timers = new Set()
  let active = 0
  const second = http.createServer((req, res) => { authorizations.push(req.headers.authorization); res.end(Buffer.alloc(128, 9)) })
  await new Promise(done => second.listen(0, '127.0.0.1', done))
  const origin = http.createServer((req, res) => {
    active++; requests.push(req.url); res.once('close', () => { active-- })
    if (req.url === '/redirect') { res.writeHead(302, { Location: 'http://127.0.0.1:' + second.address().port }); res.end(); return }
    if (req.url === '/loop') { res.writeHead(302, { Location: '/loop' }); res.end(); return }
    if (req.url === '/headers') {
      const id = setTimeout(() => res.end('late'), 500); timers.add(id); res.once('close', () => { clearTimeout(id); timers.delete(id) }); return
    }
    if (req.url === '/slow') {
      res.writeHead(200, { 'Content-Length': 100000 }); res.write('begin')
      const id = setInterval(() => res.write('x'), 10); timers.add(id); res.once('close', () => { clearInterval(id); timers.delete(id) }); return
    }
    if (req.url === '/broken') { res.writeHead(200, { 'Content-Length': 100000 }); res.write('part'); setImmediate(() => res.destroy()); return }
    if (req.url === '/huge') { res.writeHead(200, { 'Content-Length': 1000 }); res.end(Buffer.alloc(1000)); return }
    if (req.url === '/chunked') { res.writeHead(200); res.write(Buffer.alloc(1000)); res.end(); return }
    if (req.url === '/rate') { res.end(Buffer.alloc(64 * 1024)); return }
    authorizations.push(req.headers.authorization); res.end(Buffer.alloc(128, 7))
  })
  await new Promise(done => origin.listen(0, '127.0.0.1', done))
  const base = 'http://127.0.0.1:' + origin.address().port
  let sequence = 0
  const next = () => path.join(fixture, 'artifact-' + (++sequence))
  const run = (route, target, options) => downloadArtifact(base + route, target, options)
  const idle = () => mediaScheduler.waitForIdle(['download-file'])
  try {
    const first = next(); assert.strictEqual((await run('/plain', first, { token: 'test-token' })).bytes, 128)
    assert.strictEqual(authorizations[0], 'Bearer test-token')
    const redirected = next(); await run('/redirect', redirected, { token: 'test-token' })
    assert.strictEqual(authorizations.at(-1), undefined, 'a redirected origin cannot receive the original bearer token')
    await assert.rejects(run('/loop', next()), /重定向/)
    await assert.rejects(run('/headers', next(), { headersTimeoutMs: 80 }), /等待超时/)
    const slow = next()
    await assert.rejects(run('/slow', slow, { timeoutMs: 140 }), error => error.code === 'task_timeout')
    await idle(); assert.ok(!fs.existsSync(slow))
    const broken = next(); await assert.rejects(run('/broken', broken)); await idle(); assert.ok(!fs.existsSync(broken))
    for (const route of ['/huge', '/chunked']) {
      const target = next(); await assert.rejects(run(route, target, { maxBytes: 100 }), /大小上限/)
      await idle(); assert.ok(!fs.existsSync(target))
    }
    const original = next(); fs.writeFileSync(original, 'keep')
    await assert.rejects(run('/plain', original), error => error.code === 'EEXIST')
    assert.strictEqual(fs.readFileSync(original, 'utf8'), 'keep', 'failure cannot delete an existing caller-owned file')
    const abort = new AbortController(), cancelled = next(), pending = run('/slow', cancelled, { signal: abort.signal })
    const rejected = assert.rejects(pending, error => error.code === 'task_cancelled')
    await until(() => fs.existsSync(cancelled)); abort.abort(); await rejected; await idle()
    assert.ok(!fs.existsSync(cancelled)); await until(() => active === 0)
    setDesktopPlaybackActive(true)
    const started = Date.now(); await run('/rate', next(), { playbackBytesPerSecond: 32 * 1024 })
    assert.ok(Date.now() - started >= 1700, 'active playback enforces the transfer rate even when a chunk exceeds one second of budget')
    setDesktopPlaybackActive(false)
    const temporary = next(), target = next(); fs.writeFileSync(temporary, 'new'); fs.writeFileSync(target, 'old')
    const rename = fsp.rename, controller = new AbortController(); let commitSeen = false
    fsp.rename = async (from, to) => { await rename(from, to); if (to === target && !commitSeen) { commitSeen = true; controller.abort(new Error('cancel commit')) } }
    try { await assert.rejects(publishArtifact(temporary, target, () => { if (controller.signal.aborted) throw controller.signal.reason })) }
    finally { fsp.rename = rename }
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'old')
    assert.ok(!(await fsp.readdir(fixture)).some(file => file.endsWith('.backup')))
    await idle(); assert.strictEqual(mediaScheduler.diagnostics().used.transfer, 0)
    console.log('download artifacts passed: actual HTTP, original-origin authorization, redirect/header/body deadlines, disconnect/size/cancel cleanup, existing-file preservation, playback rate budget and atomic publication rollback')
  } finally {
    setDesktopPlaybackActive(false)
    for (const server of [origin, second]) { server.closeAllConnections(); await new Promise(done => server.close(done)) }
    timers.forEach(id => { clearTimeout(id); clearInterval(id) }); await mediaScheduler.dispose()
  }
}
const deadline = setTimeout(() => { console.error('download artifact verification timed out'); process.exit(1) }, 15000)
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  clearTimeout(deadline); assert.strictEqual(path.dirname(path.resolve(fixture)), parent); await removeTempRootWithRetry(fixture)
})
