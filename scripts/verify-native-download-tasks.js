const assert = require('assert'), fs = require('fs'), fsp = require('fs/promises'), path = require('path'), http = require('http'), net = require('net'), Module = require('module')
const { spawn } = require('child_process')
const { DownloadTasks } = require('../main/application/download-tasks')
const { removeTempRootWithRetry } = require('./verify-helpers')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
fs.mkdirSync(parent, { recursive: true }); const fixture = fs.mkdtempSync(path.join(parent, 'native-download-tasks-'))
const delay = ms => new Promise(done => setTimeout(done, ms))
let phase = 'setup'
const until = async predicate => { const deadline = Date.now() + 12000
  while (!(await predicate())) { if (Date.now() > deadline) throw new Error('native download condition timed out'); await delay(25) } }
async function main() {
  process.chdir(fixture)
  const binary = path.join(root, 'vendor/aria2/aria2c.exe'); assert.ok(fs.existsSync(binary))
  const environment = { aria: process.env.WALLPAPER_PLAYER_ARIA2C, ports: process.env.WALLPAPER_PLAYER_BT_PORT_RANGE }
  process.env.WALLPAPER_PLAYER_ARIA2C = binary
  const reserve = net.createServer(); await new Promise(done => reserve.listen(0, '127.0.0.1', done))
  process.env.WALLPAPER_PLAYER_BT_PORT_RANGE = String(reserve.address().port); await new Promise(done => reserve.close(done))
  const children = [], managers = [], responses = new Set(), directory = path.join(fixture, 'files')
  await fsp.mkdir(directory)
  let requests = 0, dropNextPause = false, lastNativeArgs
  const server = http.createServer((req, res) => {
    requests++; responses.add(res); const total = 1024 * 1024, match = req.headers.range?.match(/^bytes=(\d+)-/), start = match ? Number(match[1]) : 0
    let position = start
    res.writeHead(match ? 206 : 200, { 'Content-Length': total - start, 'Accept-Ranges': 'bytes', ...(match ? { 'Content-Range': 'bytes ' + start + '-' + (total - 1) + '/' + total } : {}) })
    const timer = setInterval(() => { if (position >= total) { clearInterval(timer); res.end(); return } const size = Math.min(1024, total - position); position += size; res.write(Buffer.alloc(size, 55)) }, 10)
    res.once('close', () => { clearInterval(timer); responses.delete(res) })
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const base = 'http://127.0.0.1:' + server.address().port, original = Module._load
  function createManager() {
    delete require.cache[require.resolve('../main/download-manager')]
    Module._load = function (name, owner, ...rest) {
      if (owner?.filename.replace(/\\/g, '/').endsWith('/main/download-manager.js')) {
        if (name === 'http') return { ...http, request(options, callback) {
          let method
          const request = http.request(options, response => {
            callback(response)
            if (method === 'aria2.forcePause' && dropNextPause) { dropNextPause = false; response.destroy(new Error('controlled lost pause ACK')) }
          })
          const end = request.end
          request.end = function (body, ...args) { method = JSON.parse(body).method; return end.call(this, body, ...args) }
          return request
        } }
        if (name === './application/download-tasks') return { ...require('../main/application/download-tasks'), DownloadTasks: class extends DownloadTasks {
          constructor(options) { super({ ...options, taskMs: 1700, pollMs: 100 }) }
        } }
        if (name === './ytdlp-service') return { detectYtDlp: async () => null, getYtDlpStatus: () => ({ available: false }), getSystemProxyAsync: async () => ({ enabled: false }) }
        if (name === './download-xunlei') return { createXunleiManager: () => ({ detect: async () => null, getStatus: () => ({}), loadTasks: async () => [], normalizeTask: value => value }) }
        if (name === 'child_process') return { spawn(file, args, options) {
          assert.strictEqual(file, binary)
          const local = args.filter(arg => !arg.startsWith('--bt-tracker=')).map(arg => /^--(enable-dht6?|bt-enable-lpd)=/.test(arg) ? arg.replace(/=.+$/, '=false') : arg)
          assert.ok(local.includes('--stop-with-process=' + process.pid)); lastNativeArgs = local
          const child = spawn(file, local, options); children.push(child); return child
        } }
      }
      return original.call(this, name, owner, ...rest)
    }
    try { const manager = require('../main/download-manager'); managers.push(manager); return manager } finally { Module._load = original }
  }
  try {
    const manager = createManager(), payload = { url: base + '/source.mp4?key=test-credential', dir: directory, operationId: 'native-one' }
    phase = 'add'; const [a, b] = await Promise.all([manager.addUrl(payload), manager.addUrl(payload)])
    assert.strictEqual(a.gid, b.gid); assert.strictEqual(a.success, true); assert.strictEqual(children.length, 1)
    assert.match(a.gid, /^[0-9a-f]{16}$/)
    const ledger = path.join(fixture, '.tmp-wallpaper-player/downloads/tasks.json')
    assert.ok(!fs.readFileSync(ledger, 'utf8').includes('test-credential'))
    phase = 'expiry'; await until(async () => {
      const state = await manager.getSnapshot({ start: false }), task = state.tasks.find(task => task.gid === a.gid)
      return task?.expired && !task.confirmationPending && task.status === 'paused'
    })
    await until(() => responses.size === 0)
    assert.strictEqual(children[0].exitCode, null, 'per-task expiry pauses the actual GID and keeps the engine alive')
    phase = 'resume'; const before = requests; await manager.resume(a.gid); await until(() => requests > before)
    phase = 'pause'; await manager.pause(a.gid); phase = 'remove'; await manager.remove(a.gid)
    const beforeRetry = requests, retired = await manager.addUrl(payload)
    assert.strictEqual(retired.gid, a.gid); assert.strictEqual(retired.operationState, 'removed'); assert.strictEqual(requests, beforeRetry)
    phase = 'refreshed playback URL'
    const sourceIdentity = 'https://catalog.example.invalid/page', op = 'network-signed-url'
    const originalUrl = await manager.addUrl({ url: base + '/renewed.mp4?signature=one', sourceIdentity, dir: directory, operationId: op })
    const refreshedUrl = await manager.addUrl({ url: base + '/renewed.mp4?signature=two', sourceIdentity, dir: directory, operationId: op })
    assert.strictEqual(refreshedUrl.gid, originalUrl.gid); assert.strictEqual(refreshedUrl.existing, true)
    await manager.remove(originalUrl.gid)

    phase = 'persist'; const retained = await manager.addUrl({ url: base + '/second.mp4', dir: directory, operationId: 'native-restart' })
    assert.strictEqual(retained.success, true)
    await manager.disposeDownloadManager(); await until(() => responses.size === 0)
    phase = 'restart'; const restartRequests = requests, restarted = createManager()
    let restored
    await until(async () => { const state = await restarted.getSnapshot(); restored = state.tasks.find(task => task.gid === retained.gid); return restored?.status === 'paused' && !restored.confirmationPending })
    assert.strictEqual(requests, restartRequests, 'actual saved sessions restore paused without network activity')
    const duplicate = await restarted.addUrl({ url: base + '/second.mp4', dir: directory, operationId: 'native-restart' })
    assert.strictEqual(duplicate.gid, retained.gid); assert.strictEqual(requests, restartRequests)
    await restarted.resume(retained.gid); await until(() => requests > restartRequests)
    phase = 'missing'; await assert.rejects(restarted.resume('eeeeeeeeeeeeeeee'), error => error.taskNotFound === true)
    phase = 'unconfirmed expiry stop'; dropNextPause = true
    await until(() => !restarted.getDownloadDiagnostics().running)
    assert.strictEqual(restarted.getDownloadDiagnostics().expired, true)
    const stoppedTask = (await restarted.getSnapshot({ start: false })).tasks.find(task => task.gid === retained.gid)
    assert.strictEqual(stoppedTask.controls.resume, true)
    const beforeRecovery = requests
    await restarted.resume(retained.gid, { expectedGeneration: stoppedTask.taskGeneration }); await until(() => requests > beforeRecovery)
    await restarted.pause(retained.gid)
    await restarted.disposeDownloadManager(); assert.strictEqual(children.length, 3)
    assert.ok(children.every(child => child.exitCode != null || child.signalCode != null))
    phase = 'abrupt parent exit'
    const ownerDir = path.join(fixture, 'owner-exit'); await fsp.mkdir(ownerDir)
    const helper = path.join(ownerDir, 'owner.js'), specFile = path.join(ownerDir, 'spec.json'), pidFile = path.join(ownerDir, 'aria.pid')
    const args = lastNativeArgs.filter(arg => !arg.startsWith('--input-file=')).map(arg => arg.startsWith('--save-session=') ? '--save-session=' + path.join(ownerDir, 'session') : arg)
    await fsp.writeFile(specFile, JSON.stringify({ binary, args, pidFile }))
    await fsp.writeFile(helper, `const fs=require('fs'),{spawn}=require('child_process'),spec=JSON.parse(fs.readFileSync(process.argv[2]));
const child=spawn(spec.binary,spec.args.map(arg=>arg.startsWith('--stop-with-process=')?'--stop-with-process='+process.pid:arg),{windowsHide:true,stdio:'ignore'});
child.on('error',()=>process.exit(2));child.once('spawn',()=>fs.writeFileSync(spec.pidFile,String(child.pid)));child.unref();setInterval(()=>{},1000);`)
    const owner = spawn(process.execPath, [helper, specFile], { windowsHide: true, stdio: 'ignore' })
    const port = Number(args.find(arg => arg.startsWith('--rpc-listen-port=')).split('=')[1])
    const secret = args.find(arg => arg.startsWith('--rpc-secret=')).slice('--rpc-secret='.length)
    const rpc = method => new Promise((resolve, reject) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 'owner-check', method, params: ['token:' + secret] })
      const request = http.request({ hostname: '127.0.0.1', port, method: 'POST', path: '/jsonrpc', headers: { 'Content-Length': Buffer.byteLength(body) } }, response => {
        response.resume(); response.once('end', () => response.statusCode === 200 ? resolve() : reject(new Error('test owner RPC failed')))
      }); request.setTimeout(500, () => request.destroy(new Error('test owner timeout'))); request.on('error', reject); request.end(body)
    })
    try {
      await until(() => fs.existsSync(pidFile)); const pid = Number(await fsp.readFile(pidFile, 'utf8'))
      await until(() => rpc('aria2.getVersion').then(() => true, () => false))
      const closed = new Promise(done => owner.once('close', done)); owner.kill(); await closed
      await until(() => { try { process.kill(pid, 0); return false } catch { return true } })
    } finally {
      if (owner.exitCode == null && owner.signalCode == null) owner.kill()
      await rpc('aria2.shutdown').catch(() => {})
    }
    console.log('native download tasks passed: actual bundled aria2 and local HTTP/RPC, fixed-GID deduplication, timed pause/resume/remove, saved-session restart, lost pause ACK stops the owned engine, versioned recovery and abrupt parent exit stops its aria2 child; no BT swarm or external endpoint used')
  } finally {
    await Promise.allSettled(managers.map(manager => manager.disposeDownloadManager()))
    server.closeAllConnections(); await new Promise(done => server.close(done))
    await require('../main/application/resource-scheduler').mediaScheduler.dispose()
    if (environment.aria === undefined) delete process.env.WALLPAPER_PLAYER_ARIA2C; else process.env.WALLPAPER_PLAYER_ARIA2C = environment.aria
    if (environment.ports === undefined) delete process.env.WALLPAPER_PLAYER_BT_PORT_RANGE; else process.env.WALLPAPER_PLAYER_BT_PORT_RANGE = environment.ports
  }
}
const deadline = setTimeout(() => { console.error('native download verification timed out'); process.exit(1) }, 45000)
main().catch(error => { console.error('native phase: ' + phase, error); process.exitCode = 1 }).finally(async () => {
  clearTimeout(deadline); process.chdir(root); assert.strictEqual(path.dirname(path.resolve(fixture)), parent); await removeTempRootWithRetry(fixture)
})
