const assert = require('assert'), fs = require('fs'), path = require('path'), Module = require('module')
const { execFileAsync, execFileTreeAsync } = require('../main/exec')
const { removeTempRootWithRetry } = require('./verify-helpers')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
fs.mkdirSync(parent, { recursive: true })
const fixture = fs.mkdtempSync(path.join(parent, 'parser-process-'))
const delay = ms => new Promise(done => setTimeout(done, ms))
const until = async predicate => { const deadline = Date.now() + 6000
  while (!predicate()) { if (Date.now() > deadline) throw new Error('parser process condition timed out'); await delay(4) } }
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
async function main() {
  const names = ['ALL_PROXY', 'all_proxy', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'WALLPAPER_PLAYER_YTDLP',
    'WALLPAPER_VERIFY_YTDLP_ARGS', 'WALLPAPER_VERIFY_YTDLP_MODE', 'WALLPAPER_VERIFY_YTDLP_PIDS']
  const previous = new Map(names.map(name => [name, process.env[name]]))
  names.forEach(name => delete process.env[name])
  const executable = path.join(fixture, 'yt-fixture.exe'), script = path.join(fixture, 'yt-worker.js'), argsFile = path.join(fixture, 'args.json'), pidsFile = path.join(fixture, 'pids.json')
  fs.writeFileSync(executable, 'fixture entry')
  fs.writeFileSync(script, `const fs=require('fs');fs.writeFileSync(process.env.WALLPAPER_VERIFY_YTDLP_ARGS,JSON.stringify(process.argv.slice(2)));if(process.env.WALLPAPER_VERIFY_YTDLP_MODE==='hold'){const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});fs.writeFileSync(process.env.WALLPAPER_VERIFY_YTDLP_PIDS,JSON.stringify({parent:process.pid,child:child.pid}));setInterval(()=>{},1000)}else console.log(JSON.stringify({title:'fixture',url:'https://media.example.test/Resolved.MP4',ext:'mp4',protocol:'https'}))`)
  process.env.WALLPAPER_PLAYER_YTDLP = executable; process.env.WALLPAPER_VERIFY_YTDLP_ARGS = argsFile; process.env.WALLPAPER_VERIFY_YTDLP_PIDS = pidsFile
  const original = Module._load
  let registryCalls = 0, toolCalls = 0, registryGate, registryEntered = false, lastOptions
  Module._load = function (name, owner, ...rest) {
    if (name === './exec' && owner?.filename.replace(/\\/g, '/').endsWith('/main/ytdlp-service.js')) return {
      execFileAsync,
      execFileTreeAsync: async (file, args, options) => {
        if (path.basename(file).toLowerCase() === 'reg.exe') {
          registryCalls++; registryEntered = true; if (registryGate) await registryGate
          return { stdout: 'ProxyEnable    REG_DWORD    0x1\nProxyServer    REG_SZ    http=127.0.0.1:18888;https=127.0.0.1:18888\nProxyOverride    REG_SZ    *.internal.test;<local>\n' }
        }
        assert.strictEqual(file, executable, 'only the owned fixture can be executed')
        toolCalls++; lastOptions = options
        return execFileTreeAsync(process.execPath, [script, ...args], options)
      }
    }
    return original.call(this, name, owner, ...rest)
  }
  let ytdlp
  try { ytdlp = require('../main/ytdlp-service') } finally { Module._load = original }
  try {
    if (process.platform === 'win32') {
      const enabled = await ytdlp.getSystemProxyAsync('https://public.example.test')
      assert.strictEqual(enabled.enabled, true); assert.strictEqual(enabled.proxy, 'http://127.0.0.1:18888')
      const before = registryCalls
      assert.strictEqual((await ytdlp.getSystemProxyAsync('http://192.168.1.1/file')).enabled, false)
      assert.strictEqual((await ytdlp.getSystemProxyAsync('https://one.internal.test/file')).enabled, false)
      assert.strictEqual(registryCalls, before)
      process.env.ALL_PROXY = 'http://environment.example.test:19898'
      assert.strictEqual((await ytdlp.getSystemProxyAsync('https://public.example.test')).proxy, process.env.ALL_PROXY)
      assert.strictEqual(registryCalls, before); delete process.env.ALL_PROXY
      let releaseRegistry
      registryGate = new Promise(done => { releaseRegistry = done }); registryEntered = false
      const controller = new AbortController(), pending = ytdlp.getSystemProxyAsync('https://public.example.test', { signal: controller.signal, refresh: true }).catch(error => error)
      await until(() => registryEntered); controller.abort(new Error('cancel-proxy')); releaseRegistry(); registryGate = null
      assert.match((await pending).message, /cancel-proxy/)
    }
    assert.strictEqual(await ytdlp.detectYtDlp(), executable)
    const result = await ytdlp.parseWithYtDlp('https://public.example.test/page', { timeoutMs: 5000 })
    assert.strictEqual(result.playbackUrl, 'https://media.example.test/Resolved.MP4')
    assert.strictEqual(lastOptions.maxBuffer, 24 * 1024 * 1024)
    if (process.platform === 'win32') {
      const args = JSON.parse(fs.readFileSync(argsFile, 'utf8'))
      assert.strictEqual(args[args.indexOf('--proxy') + 1], 'http://127.0.0.1:18888')
    }
    process.env.WALLPAPER_VERIFY_YTDLP_MODE = 'hold'
    const controller = new AbortController(), pending = ytdlp.parseWithYtDlp('https://public.example.test/page', { timeoutMs: 5000, signal: controller.signal }).catch(error => error)
    await until(() => fs.existsSync(pidsFile)); const pids = JSON.parse(fs.readFileSync(pidsFile, 'utf8'))
    controller.abort(new Error('cancel-parser-process'))
    assert.match((await pending).message, /cancel-parser-process/)
    await until(() => !alive(pids.parent) && !alive(pids.child))
    const before = toolCalls, stopped = new AbortController(); stopped.abort(new Error('already-cancelled'))
    await assert.rejects(ytdlp.parseWithYtDlp('https://public.example.test/page', { signal: stopped.signal }), /already-cancelled/)
    assert.strictEqual(toolCalls, before)
    console.log('parser process lifecycle passed: production parser command/proxy handling, asynchronous Windows proxy snapshots and bypass/refresh cancellation, actual owned CLI/process tree, bounded output options and no spawn after cancellation')
  } finally { for (const name of names) { const value = previous.get(name); if (value === undefined) delete process.env[name]; else process.env[name] = value } }
}
const deadline = setTimeout(() => { console.error('parser process verification timed out'); process.exit(1) }, 20000)
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  clearTimeout(deadline); assert.strictEqual(path.dirname(path.resolve(fixture)), parent); await removeTempRootWithRetry(fixture)
})
