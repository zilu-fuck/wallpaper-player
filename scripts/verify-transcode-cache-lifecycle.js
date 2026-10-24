const assert = require('assert'), fs = require('fs'), fsp = require('fs/promises'), path = require('path'), http = require('http'), Module = require('module')
const { EventEmitter } = require('events'), { PassThrough } = require('stream')
const { removeTempRootWithRetry } = require('./verify-helpers')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
fs.mkdirSync(parent, { recursive: true })
const fixture = fs.mkdtempSync(path.join(parent, 'transcode-cache-'))
const delay = ms => new Promise(done => setTimeout(done, ms))
const until = async predicate => { const deadline = Date.now() + 5000
  while (!predicate()) { if (Date.now() > deadline) throw new Error('transcode cache condition timed out'); await delay(4) } }
async function main() {
  process.chdir(fixture)
  const original = Module._load, children = []
  Module._load = function (name, owner, ...rest) {
    if (owner?.filename.replace(/\\/g, '/').endsWith('/main/remote/transcode.js')) {
      if (name === '../thumbnail') return { findFfmpeg: async () => 'fixture-ffmpeg' }
      if (name === '../exec') return { execFileAsync: async () => ({ stdout: JSON.stringify({ format: { duration: 1 },
        streams: [{ codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 320, height: 240 }] }) }) }
      if (name === 'child_process') return { spawn(_file, args) {
        const child = new EventEmitter(); child.stderr = new PassThrough(); child.args = args
        child.finish = code => child.emit('close', code)
        child.kill = () => { setImmediate(() => child.finish(1)); return true }
        children.push(child); return child
      } }
    }
    return original.call(this, name, owner, ...rest)
  }
  let worker
  try { worker = require('../main/remote/transcode') } finally { Module._load = original }
  const cache = require('../main/remote/transcode-cache'), scheduler = require('../main/application/resource-scheduler').mediaScheduler
  const source = path.join(fixture, 'source.mp4'); fs.writeFileSync(source, Buffer.alloc(1024, 1))
  const handlers = require('../main/remote/handlers/transcode').createTranscodeHandlers({ resolveVideoPath: async () => source })
  const server = http.createServer((req, res) => handlers.handleTranscodedStream(req, res, 'current').catch(error => { res.statusCode = 500; res.end(error.message) }))
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const request = () => new Promise((resolve, reject) => http.get('http://127.0.0.1:' + server.address().port + '/?quality=compatible',
    { headers: { Range: 'bytes=0-3' } }, res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) })) }).on('error', reject))
  const finish = async (task, byte) => {
    await until(() => task.process)
    fs.writeFileSync(task.tempPath, Buffer.alloc(512, byte)); task.process.finish(0)
    await task.completion
  }
  try {
    let task = await worker.startMobileTranscode('current', source)
    await finish(task, 2); assert.strictEqual(task.status, 'ready')
    const output = task.outputPath, manifest = cache.manifestPath(output)
    assert.strictEqual(await worker.getFreshTranscodedPath('current'), output)
    assert.strictEqual((await request()).status, 206)
    const alias = await worker.startMobileTranscode('alias', source)
    await until(() => alias.status === 'ready')
    assert.strictEqual(children.length, 1, 'matching source and configuration reuse the cache without a process')
    assert.strictEqual(alias.operation, 'remux')

    const priorOutput = fs.readFileSync(output), priorManifest = fs.readFileSync(manifest)
    const sourceTime = fs.statSync(source).mtime
    fs.writeFileSync(source, Buffer.alloc(1024, 3)); fs.utimesSync(source, sourceTime, sourceTime)
    assert.strictEqual(await worker.getFreshTranscodedPath('current'), '', 'same size/mtime does not hide a changed source identity')
    assert.strictEqual((await request()).status, 409, 'a formerly ready task cannot stream a stale cache')
    task = await worker.startMobileTranscode('current', source)
    await until(() => task.process)
    fs.writeFileSync(source, Buffer.alloc(1024, 4)); fs.utimesSync(source, sourceTime, sourceTime)
    await finish(task, 5)
    assert.strictEqual(task.status, 'error', 'source changes during execution prevent publication')
    assert.deepStrictEqual(fs.readFileSync(output), priorOutput)
    assert.deepStrictEqual(fs.readFileSync(manifest), priorManifest)
    task = await worker.startMobileTranscode('current', source); await finish(task, 6)
    assert.strictEqual(task.status, 'ready')

    const record = JSON.parse(fs.readFileSync(manifest, 'utf8')); record.configuration = 'old-config'
    fs.writeFileSync(manifest, JSON.stringify(record))
    assert.strictEqual(await worker.getFreshTranscodedPath('current'), '', 'configuration changes invalidate cached output')
    task = await worker.startMobileTranscode('current', source); await finish(task, 7)
    assert.strictEqual(task.status, 'ready')
    const outputTime = fs.statSync(output).mtime
    fs.writeFileSync(output, Buffer.alloc(512, 8)); fs.utimesSync(output, outputTime, outputTime)
    assert.strictEqual(await worker.getFreshTranscodedPath('current'), '', 'same size/mtime does not hide replacement of the cached output')
    assert.strictEqual((await request()).status, 409)
    fs.unlinkSync(manifest)
    assert.strictEqual(await cache.readFreshCache(source, output, operation => worker.transcodeConfiguration('compatible', operation)), null, 'legacy mtime-only cache is conservatively regenerated')
    task = await worker.startMobileTranscode('current', source); await finish(task, 9)
    assert.strictEqual(task.status, 'ready')

    const oldHandle = await fsp.open(output, 'r'), replacement = output + '.replacement.tmp'
    fs.writeFileSync(replacement, Buffer.alloc(512, 11))
    try {
      await cache.publishTranscode({ outputPath: output, tempPath: replacement, taskId: 'replacement',
        sourceSignature: await cache.fileSignature(source), operation: 'remux' }, worker.transcodeConfiguration('compatible', 'remux'), async () => {})
      assert.strictEqual(await worker.getFreshTranscodedPath('current', 'compatible', oldHandle), '', 'an old open descriptor cannot stream a newly replaced cache path')
    } finally { await oldHandle.close() }
    task = await worker.startMobileTranscode('current', source); await until(() => task.status === 'ready')
    assert.strictEqual((await request()).body[0], 11)

    const beforeOutput = fs.readFileSync(output), beforeManifest = fs.readFileSync(manifest)
    const temporary = output + '.rollback.tmp'; fs.writeFileSync(temporary, Buffer.alloc(512, 10))
    let checks = 0
    await assert.rejects(cache.publishTranscode({ outputPath: output, tempPath: temporary, taskId: 'rollback',
      sourceSignature: await cache.fileSignature(source), operation: 'remux' }, worker.transcodeConfiguration('compatible', 'remux'), async () => {
      if (++checks === 5) throw new Error('cancelled-after-manifest-rename')
    }), /cancelled-after-manifest-rename/)
    assert.deepStrictEqual(fs.readFileSync(output), beforeOutput); assert.deepStrictEqual(fs.readFileSync(manifest), beforeManifest)
    assert.ok(!(await fsp.readdir(path.dirname(output))).some(file => file.endsWith('.tmp') || file.endsWith('.backup')))

    fs.unlinkSync(manifest)
    task = await worker.startMobileTranscode('current', source); await until(() => task.process)
    const nativeRename = fsp.rename
    let releaseCommit, blocked = false
    const commitGate = new Promise(done => { releaseCommit = done })
    fsp.rename = async (from, to) => {
      const result = await nativeRename(from, to)
      if (from === task.tempPath && to === output) { blocked = true; await commitGate }
      return result
    }
    try {
      fs.writeFileSync(task.tempPath, Buffer.alloc(512, 12)); task.process.finish(0)
      await until(() => blocked)
      worker.cancelMobileTranscode('current')
      const childCount = children.length, next = await worker.startMobileTranscode('current', source)
      await delay(25)
      assert.strictEqual(worker.getTranscodeDiagnostics().running, 1, 'cancelled publication retains the transcode slot until rollback finishes')
      assert.strictEqual(scheduler.diagnostics().used.media, 1)
      assert.strictEqual(children.length, childCount, 'the next execution waits for publication cleanup')
      releaseCommit(); await task.completion
      fsp.rename = nativeRename
      await finish(next, 13); assert.strictEqual(next.status, 'ready')
      assert.strictEqual((await request()).body[0], 13, 'an old cancelled commit cannot overwrite the new task')
    } finally { fsp.rename = nativeRename; releaseCommit() }
    await worker.disposeTranscodes(); assert.strictEqual(scheduler.diagnostics().used.media, 0)
    await worker.cleanupTranscodeCache({ force: true })
    assert.ok(!fs.existsSync(output)); assert.ok(!fs.existsSync(manifest), 'output eviction also removes its manifest')
    console.log('transcode cache lifecycle passed: production worker/HTTP range route, complete stat identity, exact configuration, cache reuse/legacy rejection, execution source changes, cached-file replacement, paired atomic rollback, manifest eviction and held cleanup resources')
  } finally { await worker.disposeTranscodes(); server.closeAllConnections(); await new Promise(done => server.close(done)); await scheduler.dispose() }
}
const deadline = setTimeout(() => { console.error('transcode cache verification timed out'); process.exit(1) }, 15000)
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  clearTimeout(deadline); process.chdir(root); assert.strictEqual(path.dirname(path.resolve(fixture)), parent); await removeTempRootWithRetry(fixture)
})
