const assert = require('assert'), fs = require('fs'), fsp = require('fs/promises'), path = require('path'), Module = require('module')
const { EventEmitter } = require('events'), { PassThrough } = require('stream')
const { removeTempRootWithRetry } = require('./verify-helpers')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
fs.mkdirSync(parent, { recursive: true })
const fixture = fs.mkdtempSync(path.join(parent, 'analysis-jobs-'))
const delay = ms => new Promise(done => setTimeout(done, ms))
const until = async condition => { const end = Date.now() + 5000
  while (!condition()) { if (Date.now() > end) throw new Error('analysis job condition timed out'); await delay(4) } }
async function main() {
  process.chdir(fixture)
  const project = path.join(fixture, 'runtime'), video = path.join(fixture, 'source.mp4')
  fs.mkdirSync(path.join(project, 'video_comprehension'), { recursive: true })
  for (const [file, text] of [['pyproject.toml', 'project'], ['video_comprehension/cli.py', 'VIDEO_COMPREHENSION_ENV'],
    ['video_comprehension/config.py', 'VIDEO_COMPREHENSION_OUTPUT_DIR'], ['video_comprehension/pipeline.py', 'pipeline']]) fs.writeFileSync(path.join(project, file), text)
  fs.writeFileSync(video, Buffer.alloc(512))
  const settings = require('../main/settings'), actualPaths = require('../main/paths'), scheduler = require('../main/application/resource-scheduler').mediaScheduler
  await settings.saveSettingsAndFlush({ directories: [fixture], privateDirectories: [] })
  require('../main/plugins/video-analysis/core').setCoreResolver(name => {
    if (name === 'paths') return { ...actualPaths, getResourcePath: (...segments) => segments[0] === 'video comprehension' ? project : actualPaths.getResourcePath(...segments) }
    return require('../main/plugins/core-api').requireCoreModule(name)
  })
  const original = Module._load, children = [], events = [], foreignEvents = []
  Module._load = function (name, owner, ...rest) {
    if (owner?.filename.replace(/\\/g, '/').endsWith('/main/plugins/video-analysis/service.js')) {
      if (name === 'electron') return { BrowserWindow: { getAllWindows: () => [{ webContents: { id: 501, send: (_channel, event) => foreignEvents.push(event) } }] } }
      if (name === 'child_process') return { spawn(_file, args) {
        const child = new EventEmitter(); child.args = args; child.stdout = new PassThrough(); child.stderr = new PassThrough()
        child.kill = () => { child.kills = (child.kills || 0) + 1; return true }
        child.finish = code => { if (!child.closed) { child.closed = true; child.emit('close', code) } }
        children.push(child); return child
      } }
    }
    return original.call(this, name, owner, ...rest)
  }
  let service
  try { service = require('../main/plugins/video-analysis/service') } finally { Module._load = original }
  await service.saveVideoAnalysisRuntimeConfig({ llmProvider: 'api', vlmProvider: 'api', llmBaseUrl: 'http://127.0.0.1:1/v1', vlmBaseUrl: 'http://127.0.0.1:1/v1' })
  const sender = { id: 500, send: (_channel, event) => events.push(event) }
  try {
    const pair = await Promise.all([service.startVideoAnalysis(video, sender), service.startVideoAnalysis(video, sender)])
    assert.strictEqual(pair[0].accepted, true); assert.strictEqual(pair[1].reason, 'already_running')
    await until(() => children.length === 1)
    const first = children[0]
    first.stdout.write('stage progress\n'); assert.ok(events.some(event => event.status === 'running'))
    assert.strictEqual(service.cancelVideoAnalysis('old-job').cancelled, false)
    assert.strictEqual(service.cancelVideoAnalysis(pair[0].job.jobId).cancelled, true)
    await until(() => first.kills === 1)
    assert.strictEqual(service.getActiveAnalysisJob().running, true, 'ownership remains held until the actual process closes')
    assert.strictEqual((await service.startVideoAnalysis(video, sender)).reason, 'already_running')
    first.finish(0); await until(() => !service.getActiveAnalysisJob().running)
    assert.strictEqual(service.getRecentAnalysisEvent(video).status, 'cancelled', 'a cancelled successful exit cannot publish success')
    assert.ok(!fs.existsSync(service.getSavedAnalysisResultPath(video)))
    assert.strictEqual(first.stdout.listenerCount('data'), 0); assert.strictEqual(first.stderr.listenerCount('data'), 0)

    const timed = await service.startVideoAnalysis(video, sender, { timeoutMs: 500 })
    await until(() => children.length === 2 && children[1].kills === 1)
    assert.strictEqual(scheduler.diagnostics().running, 1)
    children[1].finish(0); await until(() => !service.getActiveAnalysisJob().running)
    assert.strictEqual(service.getRecentAnalysisEvent(video).status, 'error'); assert.match(service.getRecentAnalysisEvent(video).error, /最长等待/)
    assert.ok(!events.some(event => event.jobId === timed.job.jobId && event.status === 'success'))

    await service.startVideoAnalysis(video, sender); await until(() => children.length === 3)
    children[2].stderr.write('中'.repeat(100000)); await until(() => children[2].kills === 1)
    children[2].finish(0); await until(() => !service.getActiveAnalysisJob().running)
    assert.match(service.getRecentAnalysisEvent(video).error, /输出过大/)

    const oldAnalysis = { available: true, summary: 'old' }, result = await service.saveAnalysisResult(video, oldAnalysis)
    const previous = fs.readFileSync(result, 'utf8'), abort = new AbortController(), rename = fsp.rename
    let cancelledCommit = false
    fsp.rename = async (from, to) => {
      await rename(from, to)
      if (to === result && !cancelledCommit) { cancelledCommit = true; abort.abort(new Error('cancel during commit')) }
    }
    try { await assert.rejects(service.saveAnalysisResult(video, { available: true, summary: 'new' }, { signal: abort.signal })) }
    finally { fsp.rename = rename }
    assert.strictEqual(fs.readFileSync(result, 'utf8'), previous, 'a cancelled atomic result commit restores the previous result')
    assert.ok(!(await fsp.readdir(path.dirname(result))).some(file => file.endsWith('.tmp')))

    await settings.saveSettingsAndFlush({ privateDirectories: [fixture] })
    require('../main/security/media-access').unlockDesktopPrivacy(sender)
    const foreignCount = foreignEvents.length
    await service.startVideoAnalysis(video, sender); await until(() => children.length === 4)
    let disposed = false
    const disposal = service.disposeVideoAnalysis().then(() => { disposed = true })
    await until(() => children[3].kills === 1); await delay(20); assert.strictEqual(disposed, false)
    children[3].finish(0); await disposal
    assert.strictEqual(foreignEvents.length, foreignCount, 'a window without the private unlock cannot receive analysis events')
    assert.strictEqual(scheduler.diagnostics().running, 0)
    assert.strictEqual((await service.startVideoAnalysis(video, sender)).reason, 'stopping')
    service.resumeVideoAnalysis(); const resumed = await service.startVideoAnalysis(video, sender)
    assert.strictEqual(resumed.accepted, true); await until(() => children.length === 5)
    service.cancelVideoAnalysis(resumed.job.jobId); children[4].finish(0)
    await service.disposeVideoAnalysis()
    console.log('analysis job lifecycle passed: production service, atomic admission, one owned process, stale cancel, held cleanup budget, cancelled zero-exit, total deadline, output bound, atomic result rollback, disposal waiting and enable/disable resume')
  } finally { children.forEach(child => child.finish(1)); await service.disposeVideoAnalysis(); await scheduler.dispose() }
}
const deadline = setTimeout(() => { console.error('analysis job verification timed out'); process.exit(1) }, 15000)
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  clearTimeout(deadline); process.chdir(root); assert.strictEqual(path.dirname(path.resolve(fixture)), parent); await removeTempRootWithRetry(fixture)
})
