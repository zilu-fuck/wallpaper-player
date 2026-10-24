const assert = require('assert'), fs = require('fs'), fsp = require('fs/promises'), path = require('path'), http = require('http')
const { Readable } = require('stream')
const { removeTempRootWithRetry } = require('./verify-helpers')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
fs.mkdirSync(parent, { recursive: true })
const fixture = fs.mkdtempSync(path.join(parent, 'stream-lifecycle-'))
const file = path.join(fixture, '视频.mp4'), empty = path.join(fixture, 'empty.mp4')
fs.writeFileSync(file, 'stream-fixture'); fs.truncateSync(file, 64 * 1024 * 1024); fs.writeFileSync(empty, '')
const streaming = require('../main/remote/streaming'), pressure = require('../main/media-pressure')
const { sendError } = require('../main/remote/http-utils')
const { enqueueThumbnailJob, setMediaPlaybackActive } = require('../main/thumbnail')
const nativeOpen = fsp.open, handles = []
let mode = '', releaseOpen, signalOpen, server
const until = async predicate => {
  const deadline = Date.now() + 5000
  while (!predicate()) { if (Date.now() > deadline) throw new Error('stream lifecycle wait timed out'); await new Promise(resolve => setTimeout(resolve, 5)) }
}
fsp.open = async (...args) => {
  if (mode === 'hold-open') { signalOpen(); await new Promise(resolve => { releaseOpen = resolve }) }
  const handle = await nativeOpen(...args), record = { handle, closed: 0 }
  handles.push(record)
  const close = handle.close.bind(handle)
  handle.close = async () => { record.closed++; return close() }
  if (mode === 'read-failure') handle.createReadStream = () => new Readable({ read() { this.destroy(new Error('injected read failure')) } })
  return handle
}
function request(endpoint, pathname = '/', options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(endpoint + pathname, options, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk)); res.on('error', reject)
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject); req.end()
  })
}
function stalled(endpoint, pathname = '/') {
  return new Promise((resolve, reject) => {
    const req = http.get(endpoint + pathname, res => { res.pause(); res.on('error', () => {}); resolve({ req, res }) })
    req.on('error', reject)
  })
}
async function main() {
  server = http.createServer((req, res) => {
    streaming.streamFileWithRange(req, res, req.url === '/missing' ? file + '.missing' : req.url === '/empty' ? empty : file,
      'video/mp4', sendError, 'media missing', req.url === '/denied' ? { beforeHeaders: () => { throw Object.assign(new Error('deny'), { status: 404, code: 'video_not_found' }) } } : {})
      .catch(error => { console.error(error); res.destroy() })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const endpoint = 'http://127.0.0.1:' + server.address().port
  const range = await request(endpoint, '/', { headers: { Range: 'bytes=0-13' } })
  assert.strictEqual(range.status, 206); assert.strictEqual(range.body.toString(), 'stream-fixture')
  assert.strictEqual(range.headers['content-range'], 'bytes 0-13/67108864')
  assert.strictEqual((await request(endpoint, '/', { method: 'HEAD' })).body.length, 0)
  assert.strictEqual((await request(endpoint, '/empty')).status, 200)
  assert.strictEqual((await request(endpoint, '/missing')).status, 404)
  assert.strictEqual((await request(endpoint, '/denied')).status, 404)
  for (const value of ['bytes=-', 'bytes=-0', 'bytes=80000000-', 'bytes=10-3', 'other=0-1']) {
    assert.strictEqual((await request(endpoint, '/', { headers: { Range: value } })).status, 416)
  }
  await streaming.waitForFileStreams()
  assert.ok(handles.every(record => record.closed === 1 && record.handle.fd === -1), 'HEAD/error/range must each release exactly one owned descriptor')

  const first = await stalled(endpoint), second = await stalled(endpoint)
  await until(() => pressure.getMediaPressure().remoteStreams === 2)
  let warmed = false
  const queued = enqueueThumbnailJob(async () => { warmed = true; return 'thumbnail' })
  setMediaPlaybackActive(false)
  await new Promise(resolve => setTimeout(resolve, 20)); assert.strictEqual(warmed, false)
  first.req.destroy(); first.res.destroy()
  await until(() => pressure.getMediaPressure().remoteStreams === 1)
  assert.strictEqual(warmed, false, 'one remote departure must retain the other stream pressure')
  setMediaPlaybackActive(true)
  second.req.destroy(); second.res.destroy()
  await streaming.waitForFileStreams()
  assert.strictEqual(pressure.getMediaPressure().remoteStreams, 0)
  assert.strictEqual(pressure.getMediaPressure().active, true, 'remote completion must retain desktop ownership')
  setMediaPlaybackActive(false); assert.strictEqual(await queued, 'thumbnail')

  mode = 'hold-open'
  let entered
  const opened = new Promise(resolve => { signalOpen = resolve })
  const pending = stalled(endpoint).catch(() => null)
  await opened
  streaming.closeActiveFileStreams()
  releaseOpen(); mode = ''
  await pending; await streaming.waitForFileStreams()
  assert.strictEqual(streaming.getStreamDiagnostics().active, 0)

  mode = 'read-failure'
  await assert.rejects(request(endpoint))
  mode = ''; await streaming.waitForFileStreams()
  assert.strictEqual(pressure.getMediaPressure().active, false)
  assert.ok(handles.every(record => record.closed === 1 && record.handle.fd === -1), 'disconnect, delayed-open cancellation and read failure release all handles')
  console.log('file stream lifecycle passed: actual HTTP ranges/HEAD/empty/errors, opened descriptor ownership, two-client pressure, cancellation during open, read failure and bounded shutdown cleanup')
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  fsp.open = nativeOpen; releaseOpen?.(); streaming.closeActiveFileStreams(); setMediaPlaybackActive(false)
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  await streaming.waitForFileStreams()
  assert.strictEqual(path.dirname(path.resolve(fixture)), parent); assert.ok(path.basename(fixture).startsWith('stream-lifecycle-'))
  await removeTempRootWithRetry(fixture)
})
