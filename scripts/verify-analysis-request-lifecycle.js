const assert = require('assert'), fs = require('fs'), path = require('path'), http = require('http'), Module = require('module')
const { requestJson, removeTempRootWithRetry } = require('./verify-helpers')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp', 'refactor-tests')
fs.mkdirSync(parent, { recursive: true })
const fixture = fs.mkdtempSync(path.join(parent, 'analysis-lifecycle-'))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const until = async predicate => {
  const deadline = Date.now() + 4000
  while (!predicate()) { if (Date.now() > deadline) throw new Error('analysis request wait timed out'); await new Promise(done => setTimeout(done, 5)) }
}
async function main() {
  process.chdir(fixture)
  const settings = require('../main/settings'), scanner = require('../main/scanner')
  const { sendError } = require('../main/remote/http-utils')
  const mediaPath = path.join(fixture, 'video.mp4'), alternate = path.join(fixture, 'alternate.mp4')
  fs.writeFileSync(mediaPath, Buffer.alloc(24)); fs.writeFileSync(alternate, Buffer.alloc(24))
  settings.saveSettings({ directories: [fixture], privateDirectories: [], videoAnalysis: { enabled: true } })
  require('../main/plugins/video-analysis/core').setCoreResolver(name => require(path.join(root, 'main', name)))
  const control = { reads: 0, starts: 0, gate: null, resolvedPath: mediaPath, authorized: true, resolves: 0, resolveGate: null }
  const original = Module._load
  Module._load = function (request, parentModule, ...rest) {
    if (request === './service' && parentModule?.filename.endsWith('remote-handlers.js')) return {
      findVideoAnalysis: async () => { control.reads++; if (control.gate) await control.gate.promise; return { available: true, summary: 'private analysis result' } },
      getRecentAnalysisEvent: () => null,
      analysisTaskService: { get: () => null, start: async () => { control.starts++; return { accepted: true } } }
    }
    return original.call(this, request, parentModule, ...rest)
  }
  let createAnalysisHandlers
  try { ({ createAnalysisHandlers } = require('../main/plugins/video-analysis/remote-handlers')) }
  finally { Module._load = original }
  const handlers = createAnalysisHandlers({
    resolveVideoPath: async () => {
      control.resolves++
      if (control.resolves === 2 && control.resolveGate) await control.resolveGate.promise
      return scanner.assertAllowedVideoPath(control.resolvedPath, { audience: 'remote' })
    },
    authorizeRequest: (req, res) => {
      if (control.authorized && req.headers.authorization === 'Bearer bound-test-token') return true
      sendError(req, res, 401, 'unauthorized', '设备未授权'); return false
    }
  })
  const server = http.createServer(async (req, res) => {
    req.remoteAuthorization = { authorized: true, type: 'paired', deviceId: 'fixture' }
    try { await handlers[req.method === 'POST' ? 'handleStartVideoAnalysis' : 'handleGetVideoAnalysis'](req, res, 'fixture') }
    catch (error) { sendError(req, res, error.status || 500, error.code || 'internal_error', error.status ? error.message : '服务错误') }
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${server.address().port}/v1/videos/fixture/analysis`
  const request = (method = 'GET') => requestJson(url, { method, headers: { Authorization: 'Bearer bound-test-token' } })
  try {
    control.gate = deferred()
    let response = request(); await until(() => control.reads === 1)
    settings.saveSettings({ privateDirectories: [fixture] }); control.gate.resolve()
    assert.strictEqual((await response).status, 404, 'permissions changing during saved-result IO must prevent disclosure')
    settings.saveSettings({ privateDirectories: [] }); control.gate = deferred()
    response = request(); await until(() => control.reads === 2)
    control.authorized = false; control.gate.resolve()
    assert.strictEqual((await response).status, 401, 'revoked authorization must be rechecked before JSON is sent')
    control.authorized = true; control.gate = deferred()
    response = request(); await until(() => control.reads === 3)
    control.resolvedPath = alternate; control.gate.resolve()
    assert.strictEqual((await response).status, 404, 'an ID resolving to another resource cannot receive old analysis')
    control.resolvedPath = mediaPath; control.gate = null; control.resolves = 0; control.resolveGate = deferred()
    response = request('POST'); await until(() => control.resolves === 2)
    settings.saveSettings({ privateDirectories: [fixture] }); control.resolveGate.resolve()
    assert.strictEqual((await response).status, 404); assert.strictEqual(control.starts, 0)
    settings.saveSettings({ privateDirectories: [] }); control.resolveGate = null
    const valid = await request(); assert.strictEqual(valid.status, 200); assert.strictEqual(valid.data.analysis.summary, 'private analysis result')
    console.log('analysis request lifecycle passed: actual HTTP and media policy, post-read privacy/auth checks, resource identity and pre-start revalidation')
  } finally {
    control.gate?.resolve(); control.resolveGate?.resolve(); server.closeAllConnections()
    await new Promise(done => server.close(done))
  }
}
main().finally(async () => { process.chdir(root); assert.strictEqual(path.dirname(path.resolve(fixture)), parent); await removeTempRootWithRetry(fixture) })
  .catch(error => { console.error(error); process.exitCode = 1 })
