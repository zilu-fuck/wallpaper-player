const assert = require('assert'), fs = require('fs'), fsp = require('fs/promises'), path = require('path'), http = require('http')
const { MpvInstaller } = require('../main/application/mpv-installer')
const { ResourceScheduler } = require('../main/application/resource-scheduler')
const { execFileTreeAsync } = require('../main/exec')
const { removeTempRootWithRetry } = require('./verify-helpers')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
fs.mkdirSync(parent, { recursive: true }); const fixture = fs.mkdtempSync(path.join(parent, 'mpv-installer-'))
const delay = ms => new Promise(done => setTimeout(done, ms))
const until = async predicate => { const deadline = Date.now() + 8000
  while (!predicate()) { if (Date.now() > deadline) throw new Error('mpv installer condition timed out'); await delay(5) } }
function zip(entries) {
  const locals = [], central = []; let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = Buffer.from(entry.data || '')
    let crc = 0xffffffff
    for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0) }
    crc = (crc ^ 0xffffffff) >>> 0
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26)
    const header = Buffer.alloc(46); header.writeUInt32LE(0x02014b50); header.writeUInt16LE(0x314, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(0x800, 8)
    header.writeUInt32LE(crc, 16); header.writeUInt32LE(data.length, 20); header.writeUInt32LE(data.length, 24); header.writeUInt16LE(name.length, 28)
    header.writeUInt32LE(entry.attributes || 0, 38); header.writeUInt32LE(offset, 42)
    locals.push(local, name, data); central.push(header, name); offset += local.length + name.length + data.length
  }
  const directory = Buffer.concat(central), tail = Buffer.alloc(22); tail.writeUInt32LE(0x06054b50)
  tail.writeUInt16LE(entries.length, 8); tail.writeUInt16LE(entries.length, 10); tail.writeUInt32LE(directory.length, 12); tail.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, tail])
}
async function main() {
  assert.strictEqual(process.platform, 'win32', 'the production mpv installer targets Windows')
  const good = zip([{ name: 'mpv-build/mpv.exe', data: 'controlled-cli' }, { name: 'mpv-build/libmpv.dll', data: 'paired-runtime' }])
  const unsafe = zip([{ name: '../escaped.txt', data: 'must-not-extract' }, { name: 'mpv.exe', data: 'controlled-cli' }])
  const scheduler = new ResourceScheduler({ subscribe: () => () => {} }), installations = [], requests = [], pending = new Set()
  let held, extractionCalls = 0, verificationCalls = 0, ticks = 0
  const timer = setInterval(() => ticks++, 5)
  const server = http.createServer((req, res) => {
    requests.push(req.url); pending.add(res); res.once('close', () => pending.delete(res))
    if (req.url === '/missing') { res.writeHead(404); res.end(); return }
    const payload = req.url === '/unsafe' ? unsafe : good
    res.writeHead(200, { 'Content-Length': payload.length })
    if (req.url === '/held' || req.url === '/slow') { res.write(payload.subarray(0, 8)); held = () => res.end(payload.subarray(8)); return }
    res.end(payload)
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const base = 'http://127.0.0.1:' + server.address().port, directory = path.join(fixture, "installed-中文 space &'quote")
  await fsp.mkdir(directory); await fsp.writeFile(path.join(directory, 'mpv.exe'), 'legacy-install')
  const execute = async (file, args, options) => {
    if (file.endsWith('powershell.exe')) { extractionCalls++; return execFileTreeAsync(file, args, options) }
    verificationCalls++
    assert.strictEqual((await fsp.readFile(file, 'utf8')), 'controlled-cli')
    return execFileTreeAsync(process.execPath, ['-e', 'console.log("mpv 0.41.0 fixture")'], options)
  }
  const create = options => { const value = new MpvInstaller({ directory, scheduler, execute, urls: [base + '/zip'], ...options }); installations.push(value); return value }
  const assertClean = async () => assert.deepStrictEqual((await fsp.readdir(directory)).filter(name => name.startsWith('.install-')), [])
  try {
    const installer = create({ urls: [base + '/missing', base + '/held'] }), controller = new AbortController(), progressA = [], progressB = []
    const first = installer.install(value => progressA.push(value), { signal: controller.signal }).catch(error => error)
    const second = installer.install(value => progressB.push(value))
    await until(() => held && requests.includes('/held'))
    assert.strictEqual(scheduler.diagnostics().used.installer, 1); assert.strictEqual(scheduler.diagnostics().used.transfer, 1)
    controller.abort(); assert.strictEqual((await first).code, 'task_cancelled')
    const abandonedUpdates = progressA.length; held()
    const installed = await second
    assert.strictEqual(await fsp.readFile(path.join(path.dirname(installed), 'libmpv.dll'), 'utf8'), 'paired-runtime')
    assert.strictEqual(await fsp.readFile(path.join(directory, 'mpv.exe'), 'utf8'), 'legacy-install')
    assert.strictEqual(extractionCalls, 1); assert.strictEqual(verificationCalls, 1); assert.ok(ticks > 2)
    assert.strictEqual(progressA.length, abandonedUpdates); assert.strictEqual(progressB.at(-1).percent, 100)
    assert.strictEqual(await create().resolveInstalled(), installed, 'fresh instances restore the committed installation')
    const pointer = await fsp.readFile(path.join(directory, 'installed.json'), 'utf8')
    await assertClean()

    await assert.rejects(create({ urls: [base + '/unsafe'] }).install(), /archive|Archive|process|工作进程/)
    assert.strictEqual(fs.existsSync(path.join(fixture, 'escaped.txt')), false)
    assert.strictEqual(await fsp.readFile(path.join(directory, 'installed.json'), 'utf8'), pointer); await assertClean()

    await assert.rejects(create({ execute: (file, args, options) => file.endsWith('powershell.exe')
      ? execute(file, args, options) : execFileTreeAsync(process.execPath, ['--version'], options) }).install(), /版本检查/)
    assert.strictEqual(await fsp.readFile(path.join(directory, 'installed.json'), 'utf8'), pointer); await assertClean()

    held = null
    const stopDownload = new AbortController(), slow = create({ urls: [base + '/slow', base + '/zip'] })
    const before = requests.length, cancelled = slow.install(null, { signal: stopDownload.signal }).catch(error => error)
    await until(() => held && requests.length > before); stopDownload.abort()
    assert.strictEqual((await cancelled).code, 'task_cancelled'); await until(() => pending.size === 0)
    assert.deepStrictEqual(requests.slice(before), ['/slow'], 'last-owner cancellation never starts a fallback download'); await assertClean()

    const pidPath = path.join(fixture, 'extract.pid')
    const extracting = create({ execute: (file, args, options) => file.endsWith('powershell.exe')
      ? execFileTreeAsync(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1], String(process.pid));setInterval(()=>{},1000)', pidPath], options)
      : execute(file, args, options) })
    const interrupted = extracting.install().catch(error => error)
    await until(() => fs.existsSync(pidPath)); const pid = Number(await fsp.readFile(pidPath, 'utf8'))
    await extracting.dispose(); assert.ok((await interrupted) instanceof Error)
    assert.throws(() => process.kill(pid, 0)); await assertClean()
    await assert.rejects(extracting.install(), error => error.code === 'task_stopping')

    const timed = create({ timeoutMs: 180, execute: (file, args, options) => file.endsWith('powershell.exe')
      ? execFileTreeAsync(process.execPath, ['-e', 'setInterval(()=>{},1000)'], options) : execute(file, args, options) })
    const started = Date.now()
    await assert.rejects(timed.install(), error => error.code === 'task_timeout')
    assert.ok(Date.now() - started < 3000, 'one deadline covers download, extraction and cleanup'); await assertClean()

    let entered = false, release
    const barrier = new Promise(done => { release = done }), cleanupAbort = new AbortController()
    const replacement = create({ execute: async (file, args, options) => {
      if (!entered && file.endsWith('powershell.exe')) { entered = true; await barrier; options.signal.throwIfAborted() }
      return execute(file, args, options)
    } })
    const retired = replacement.install(null, { signal: cleanupAbort.signal }).catch(error => error)
    await until(() => entered); cleanupAbort.abort()
    const countBeforeReplacement = requests.length, next = replacement.install()
    await delay(20); assert.strictEqual(requests.length, countBeforeReplacement, 'replacement waits for actual cancelled preparation cleanup')
    release(); assert.ok((await retired) instanceof Error); await next; await assertClean()
    const replacementPointer = await fsp.readFile(path.join(directory, 'installed.json'), 'utf8')
    const versionsBeforeRollback = (await fsp.readdir(path.join(directory, 'versions'))).length

    const rollbackAbort = new AbortController(), realRename = fsp.rename, selectingInstaller = create()
    let crossed = false, concurrentSelection
    fsp.rename = async (source, target) => {
      await realRename(source, target)
      if (!crossed && target === path.join(directory, 'installed.json') && path.basename(source) === 'installed.json') {
        crossed = true
        const failedInstallation = JSON.parse(await fsp.readFile(target, 'utf8')).installation
        concurrentSelection = selectingInstaller.retainExecutable(path.join(directory, 'versions', failedInstallation, 'mpv.exe'))
          .then(lease => { lease.release(); return 'unexpected selection' }, error => error)
        rollbackAbort.abort()
      }
    }
    try { assert.ok(await create().install(null, { signal: rollbackAbort.signal }).catch(error => error) instanceof Error) }
    finally { fsp.rename = realRename }
    assert.strictEqual(crossed, true); await scheduler.waitForIdle()
    assert.strictEqual(await fsp.readFile(path.join(directory, 'installed.json'), 'utf8'), replacementPointer)
    assert.strictEqual((await fsp.readdir(path.join(directory, 'versions'))).length, versionsBeforeRollback, 'cancelled publication rolls back the pointer and removes its new directory')
    assert.strictEqual((await concurrentSelection).code, 'ENOENT', 'a selector cannot acquire a version between failed publication and rollback')
    await assertClean()

    const retained = await create().retainExecutable(installed)
    try {
      await assert.rejects(create({ maxVersions: 2 }).install(), error => error.code === 'mpv_cache_busy')
      await assert.rejects(create({ maxBytes: 1 }).install(), error => error.code === 'mpv_cache_busy')
      assert.strictEqual(await fsp.readFile(path.join(directory, 'installed.json'), 'utf8'), replacementPointer)
      assert.ok(fs.existsSync(installed), 'capacity rejection preserves selected and current versions')
      await assertClean()
    } finally { retained.release() }
    let latest
    for (let i = 0; i < 3; i++) {
      latest = await create().install()
      assert.ok((await fsp.readdir(path.join(directory, 'versions'))).length <= 3)
      assert.ok(fs.existsSync(latest))
    }
    assert.strictEqual(fs.existsSync(installed), false, 'repeated successful installs reclaim an unreferenced old version')
    assert.strictEqual(await create().resolveInstalled(), latest); await assertClean()
    console.log('mpv installer passed: real HTTP/ZIP/PowerShell extraction, controlled native version CLI, shared ownership, fallback/cancel cleanup, asynchronous extraction, shutdown, durable publication/rollback, concurrent selection, count/byte admission and repeated-install reclamation; no external download or real mpv launch')
  } finally {
    clearInterval(timer); server.closeAllConnections(); await new Promise(done => server.close(done))
    await Promise.allSettled(installations.map(installer => installer.dispose())); await scheduler.dispose()
  }
}
const deadline = setTimeout(() => { console.error('mpv installer verification timed out'); process.exit(1) }, 45000)
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  clearTimeout(deadline); assert.strictEqual(path.dirname(path.resolve(fixture)), parent); await removeTempRootWithRetry(fixture)
})
