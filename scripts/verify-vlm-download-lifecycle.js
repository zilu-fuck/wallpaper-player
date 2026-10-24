const assert = require('assert'), fs = require('fs'), fsp = require('fs/promises'), path = require('path'), http = require('http'), net = require('net'), Module = require('module')
const { spawn } = require('child_process')
const { removeTempRootWithRetry } = require('./verify-helpers')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
fs.mkdirSync(parent, { recursive: true })
const fixture = fs.mkdtempSync(path.join(parent, 'vlm-downloads-'))
const delay = ms => new Promise(done => setTimeout(done, ms))
const until = async predicate => { const end = Date.now() + 8000
  while (!predicate()) { if (Date.now() > end) throw new Error('VLM lifecycle condition timed out'); await delay(4) } }
const freePort = () => new Promise(done => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => done(port)) }) })
async function main() {
  process.chdir(fixture)
  const core = require('../main/plugins/video-analysis/core')
  core.setCoreResolver(name => require('../main/plugins/core-api').requireCoreModule(name))
  const original = Module._load, children = [], events = []
  Module._load = function (name, owner, ...rest) {
    if (/\/main\/plugins\/video-analysis\/(vlm-service|service)\.js$/.test(owner?.filename.replace(/\\/g, '/') || '')) {
      if (name === 'electron') return { BrowserWindow: { getAllWindows: () => [{ webContents: { id: 1, send: (_channel, event) => events.push(event) } }] } }
      if (name === 'child_process') return { spawn(file, args, options) { const child = spawn(file, args, options); children.push(child); return child } }
    }
    return original.call(this, name, owner, ...rest)
  }
  let vlm, service
  try { service = require('../main/plugins/video-analysis/service'); vlm = require('../main/plugins/video-analysis/vlm-service') }
  finally { Module._load = original }
  const header = Buffer.alloc(64); header.write('GGUF'); header.writeUInt32LE(3, 4); header.writeBigUInt64LE(1n, 8)
  const target = path.join(fixture, 'models/model.gguf'), timers = new Set()
  let requests = 0
  const origin = http.createServer((req, res) => {
    if (req.url !== '/v1/models') requests++
    if (req.url === '/bad') { res.end('<html>not a model</html>'); return }
    if (req.url === '/slow') {
      res.writeHead(200, { 'Content-Length': 1024 * 1024 }); res.write(header)
      const timer = setInterval(() => res.write(Buffer.alloc(64)), 15); timers.add(timer)
      res.once('close', () => { clearInterval(timer); timers.delete(timer) }); return
    }
    if (req.url === '/v1/models') { res.end('{"data":[]}'); return }
    res.end(header)
  })
  await new Promise(done => origin.listen(0, '127.0.0.1', done))
  const base = 'http://127.0.0.1:' + origin.address().port
  const configure = url => service.saveVideoAnalysisRuntimeConfig({ vlmProvider: 'local', vlmModelPath: target, vlmModelDownloadUrl: url, vlmBaseUrl: base, vlmHfToken: 'fixture-token' })
  const scheduler = require('../main/application/resource-scheduler').mediaScheduler
  try {
    await configure(base + '/good')
    const result = await vlm.downloadVlmModel()
    assert.strictEqual(result.success, true); assert.strictEqual(result.state.downloading, false)
    assert.deepStrictEqual(fs.readFileSync(target), header)
    const previous = fs.readFileSync(target)
    await configure(base + '/bad'); assert.strictEqual((await vlm.downloadVlmModel()).success, false)
    assert.deepStrictEqual(fs.readFileSync(target), previous, 'an invalid container cannot replace a previous model')
    await configure(base + '/slow')
    const progressStart = events.length
    const pending = vlm.downloadVlmModel(); await until(() => events.slice(progressStart).some(event => event.type === 'download-progress' && event.progress.transferred > 0))
    const duplicate = await vlm.downloadVlmModel(); assert.strictEqual(duplicate.state.downloading, true)
    assert.strictEqual(vlm.cancelVlmModelDownload().cancelled, true)
    assert.strictEqual((await pending).success, false)
    assert.deepStrictEqual(fs.readFileSync(target), previous)
    assert.ok(!(await fsp.readdir(path.dirname(target))).some(file => file.endsWith('.part')))
    const before = requests, abandoned = vlm.downloadVlmModel(); vlm.cancelVlmModelDownload(); await abandoned
    assert.strictEqual(requests, before, 'cancellation during configuration cannot start a later HTTP request')

    const running = vlm.downloadVlmModel()
    await until(() => requests > before)
    await vlm.disposeVlmService(); assert.strictEqual((await running).success, false)
    assert.strictEqual((await vlm.downloadVlmModel()).success, false)
    vlm.resumeVlmService()
    assert.strictEqual(scheduler.diagnostics().used.transfer, 0)

    const serverDirectory = path.join(fixture, 'model server'); fs.mkdirSync(serverDirectory)
    const serverScript = path.join(serverDirectory, 'model-server.js'), port = await freePort()
    fs.writeFileSync(serverScript, 'require("http").createServer((req,res)=>res.end(JSON.stringify({data:[]}))).listen(Number(process.argv[2]),"127.0.0.1")')
    await service.saveVideoAnalysisRuntimeConfig({ vlmProvider: 'local', vlmModelPath: target, vlmBaseUrl: 'http://127.0.0.1:' + port,
      vlmServerExecutable: process.execPath, vlmServerArgs: '"' + serverScript + '" {port}' })
    assert.strictEqual((await service.getVideoAnalysisRuntimeConfig()).vlmServerArgs, '"' + serverScript + '" {port}')
    const first = vlm.startVlmService(), second = vlm.startVlmService()
    assert.strictEqual(first, second)
    const started = await first
    assert.strictEqual(started.success, true, JSON.stringify({ started, events: events.slice(-6) })); assert.strictEqual(children.length, 1)
    await vlm.stopVlmService(); assert.ok(children[0].exitCode !== null || children[0].signalCode !== null)
    const interrupted = vlm.startVlmService(); await vlm.stopVlmService()
    assert.strictEqual((await interrupted).success, false); assert.strictEqual(children.length, 1)
    fs.writeFileSync(serverScript, 'process.exit(2)')
    const crashStart = Date.now(), crashed = await vlm.startVlmService()
    assert.strictEqual(crashed.success, false); assert.ok(Date.now() - crashStart < 4000)
    assert.strictEqual(children.length, 2); assert.strictEqual(children[1].exitCode, 2)
    await vlm.disposeVlmService()
    assert.strictEqual((await vlm.startVlmService()).success, false)
    console.log('VLM lifecycle passed: production plugin, actual HTTP/container validation, single model download, cancellation/configuration/disposal guards, previous-model preservation, transfer cleanup and one actual owned model-server process/start cancellation')
  } finally {
    await vlm.disposeVlmService(); origin.closeAllConnections(); await new Promise(done => origin.close(done))
    timers.forEach(timer => clearInterval(timer)); await scheduler.dispose()
  }
}
const deadline = setTimeout(() => { console.error('VLM download verification timed out'); process.exit(1) }, 20000)
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  clearTimeout(deadline); process.chdir(root); assert.strictEqual(path.dirname(path.resolve(fixture)), parent); await removeTempRootWithRetry(fixture)
})
