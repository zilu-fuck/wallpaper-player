const assert = require('assert'), fs = require('fs'), fsp = require('fs/promises'), path = require('path'), Module = require('module')
const { spawn } = require('child_process')
const { removeTempRootWithRetry } = require('./verify-helpers')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
fs.mkdirSync(parent, { recursive: true })
const fixture = fs.mkdtempSync(path.join(parent, 'download-manager-'))
const delay = ms => new Promise(done => setTimeout(done, ms))
const until = async condition => { const end = Date.now() + 8000
  while (!condition()) { if (Date.now() > end) throw new Error('download manager condition timed out'); await delay(4) } }
const originalTimeout = global.setTimeout
const timeoutCase = process.argv.includes('--startup-timeout')
let expiredPreparation = false
if (timeoutCase) global.setTimeout = (callback, ms, ...args) => originalTimeout(ms === 45000 ? () => { expiredPreparation = true; callback(...args) } : callback, ms === 45000 ? 80 : ms, ...args)
async function main() {
  process.chdir(fixture)
  const daemon = path.join(fixture, 'daemon.js'), mode = path.join(fixture, 'mode'), log = path.join(fixture, 'calls.jsonl')
  fs.writeFileSync(mode, 'normal')
  fs.writeFileSync(daemon, `const fs = require('fs'), http = require('http');
const values = Object.fromEntries(process.argv.slice(2).map(value => { const index = value.indexOf('='); return [value.slice(0,index), value.slice(index+1)] }));
const server = http.createServer((req,res) => { const chunks=[]; req.on('data',value=>chunks.push(value)); req.on('end',()=>{
 const body=JSON.parse(Buffer.concat(chunks)), method=body.method, mode=fs.readFileSync(process.env.TEST_DOWNLOAD_MODE,'utf8');
 fs.appendFileSync(process.env.TEST_DOWNLOAD_LOG,JSON.stringify({method, options:method==='aria2.changeGlobalOption'?body.params[1]:null})+'\\n');
 if(body.params[0]!=='token:'+values['--rpc-secret']) {res.writeHead(403);res.end();return}
 if(method.startsWith('aria2.tell') && mode==='slow') {res.writeHead(200);res.write('{"result":[');const timer=setInterval(()=>res.write(' '),20);res.once('close',()=>clearInterval(timer));return}
 if(method==='aria2.tellActive' && mode==='huge') {res.end(JSON.stringify({result:'x'.repeat(9*1024*1024)}));return}
 let result=method==='aria2.getVersion'?{version:'test'}:method==='aria2.getGlobalStat'?{}:method.startsWith('aria2.tell')?[]:'OK';
 if(method==='aria2.saveSession') fs.writeFileSync(values['--save-session'],'saved');
 res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result}));
 if(method==='aria2.shutdown') setImmediate(()=>{server.closeAllConnections();server.close(()=>process.exit(0))});
 }) }); server.listen(Number(values['--rpc-listen-port']),'127.0.0.1');`)
  process.env.WALLPAPER_PLAYER_ARIA2C = process.execPath
  const original = Module._load, children = []
  let releasePreparation, held = false
  const preparation = new Promise(done => { releasePreparation = done })
  Module._load = function (name, owner, ...rest) {
    if (owner?.filename.replace(/\\/g, '/').endsWith('/main/download-manager.js')) {
      if (name === './ytdlp-service') return { detectYtDlp: async () => null, getYtDlpStatus: () => ({ available: false }), getSystemProxyAsync: async () => ({ enabled: false }) }
      if (name === './download-xunlei') return { createXunleiManager: () => ({ detect: async () => null, getStatus: () => ({}), loadTasks: async () => [], normalizeTask: value => value }) }
      if (name === 'electron-log') return { warn() {} }
      if (name === 'child_process') return { spawn(_file, args, options) {
        const child = spawn(process.execPath, [daemon, ...args], { ...options, env: { ...process.env, TEST_DOWNLOAD_MODE: mode, TEST_DOWNLOAD_LOG: log } }); children.push(child); return child } }
      if (name === 'fs/promises' && (process.argv.includes('--startup') || timeoutCase)) return { ...fsp, mkdir: async (...args) => { held = true; await preparation; return fsp.mkdir(...args) } }
    }
    return original.call(this, name, owner, ...rest)
  }
  let manager
  try { manager = require('../main/download-manager') } finally { Module._load = original }
  const scheduler = require('../main/application/resource-scheduler').mediaScheduler
  const pressure = require('../main/media-pressure')
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(value => JSON.parse(value)) : []
  try {
    if (timeoutCase) {
      const beginning = manager.getSnapshot()
      await until(() => held && expiredPreparation)
      assert.strictEqual(children.length, 0)
      assert.strictEqual(scheduler.diagnostics().used.transfer, 3, 'an expired preparation holds its resources until the real operation returns')
      releasePreparation()
      const failed = await beginning
      assert.match(failed.engine.error, /准备超过最长等待时间/)
      await scheduler.waitForIdle(['download-daemon'])
      assert.strictEqual(scheduler.diagnostics().used.transfer, 0)
      global.setTimeout = originalTimeout
      assert.strictEqual((await manager.getSnapshot()).engine.running, true)
      assert.strictEqual(children.length, 1, 'a new explicit attempt can recover after completed timeout cleanup')
      await manager.disposeDownloadManager()
    } else if (process.argv.includes('--startup')) {
      const beginning = manager.getSnapshot().catch(error => error)
      await until(() => held)
      let stopped = false
      const closing = manager.disposeDownloadManager().then(() => { stopped = true })
      await delay(20); assert.strictEqual(stopped, false)
      releasePreparation(); await beginning; await closing
      assert.strictEqual(children.length, 0, 'a shutdown during directory preparation cannot start a late daemon')
    } else {
      const snapshots = await Promise.all(Array.from({ length: 6 }, () => manager.getSnapshot()))
      assert.strictEqual(children.length, 1); assert.ok(snapshots.every(value => value.engine.running))
      assert.strictEqual(calls().filter(value => value.method.startsWith('aria2.tell')).length, 3, 'six observers share one snapshot')
      const child = children[0]
      const releaseA = pressure.acquireRemoteStream(), releaseB = pressure.acquireRemoteStream()
      await until(() => calls().some(value => value.options?.['max-overall-download-limit'] === '2M'))
      const count = calls().filter(value => value.options).length
      releaseA(); await delay(30); assert.strictEqual(calls().filter(value => value.options).length, count)
      releaseB(); await until(() => calls().at(-1)?.options?.['max-overall-download-limit'] === '0')
      fs.writeFileSync(mode, 'huge')
      const huge = await manager.getSnapshot(); assert.match(huge.engine.error, /响应过大/)
      fs.writeFileSync(mode, 'slow')
      const a = new AbortController(), b = new AbortController()
      const abandoned = manager.getSnapshot({ start: false, signal: a.signal }).catch(error => error)
      const kept = manager.getSnapshot({ start: false, signal: b.signal }).catch(error => error)
      await until(() => manager.getDownloadDiagnostics().rpc === 3)
      a.abort(); assert.strictEqual((await abandoned).code, 'task_cancelled')
      assert.strictEqual(manager.getDownloadDiagnostics().rpc, 3, 'one observer leaving retains the other observer')
      b.abort(); assert.strictEqual((await kept).code, 'task_cancelled')
      assert.strictEqual(manager.getDownloadDiagnostics().rpc, 0, 'the last observer waits for all actual RPC connections to close')
      assert.strictEqual(child.exitCode, null, 'leaving observation never stops the computer-owned download daemon')
      const start = Date.now(), slow = await manager.getSnapshot()
      assert.match(slow.engine.error, /响应超时/); assert.ok(Date.now() - start < 6500, 'response progress cannot extend the RPC deadline')
      await until(() => manager.getDownloadDiagnostics().rpc === 0)
      const pending = Promise.all(Array.from({ length: 11 }, () => manager.getSnapshot().catch(error => error)))
      await until(() => manager.getDownloadDiagnostics().rpc === 3)
      await delay(20); assert.strictEqual(manager.getDownloadDiagnostics().rpc, 3, 'eleven simultaneous observers share the same three state RPC requests')
      scheduler.beginShutdown({ preserveTypes: ['download-daemon'] })
      const disposal = manager.disposeDownloadManager()
      assert.strictEqual(manager.disposeDownloadManager(), disposal)
      await pending; await disposal
      const methods = calls().map(value => value.method)
      assert.ok(methods.lastIndexOf('aria2.saveSession') < methods.lastIndexOf('aria2.shutdown'))
      assert.strictEqual(fs.readFileSync(path.join(fixture, '.tmp-wallpaper-player/downloads/aria2.session'), 'utf8'), 'saved')
      assert.strictEqual(child.exitCode, 0)
      assert.strictEqual(manager.getDownloadDiagnostics().rpc, 0)
      await assert.rejects(manager.getSnapshot(), error => error.code === 'download_stopping')
    }
    assert.strictEqual(scheduler.diagnostics().used.transfer, 0)
    console.log('download manager passed: production manager and real daemon/RPC, single startup, playback budget, absolute/size limits, session-before-stop, native close, no late startup and idempotent disposal')
  } finally { global.setTimeout = originalTimeout; releasePreparation(); await manager.disposeDownloadManager(); await scheduler.dispose() }
}
const deadline = setTimeout(() => { console.error('download manager verification timed out'); process.exit(1) }, 20000)
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  clearTimeout(deadline); process.chdir(root); assert.strictEqual(path.dirname(path.resolve(fixture)), parent); await removeTempRootWithRetry(fixture)
})
