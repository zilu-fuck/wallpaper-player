const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), { EventEmitter } = require('events')
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const deadline = setTimeout(() => { console.error('updater startup verification timed out'); process.exit(1) }, 30000)
async function main() {
  let imports = 0, portable = false, calls = 0, downloads = 0, installed = 0, timerId = 0
  const timers = new Map(), intervals = new Map(), check = deferred(), download = deferred(), app = { isPackaged: false, getVersion: () => '1.5.1' }
  const updater = Object.assign(new EventEmitter(), { checkForUpdates() { calls++; return check.promise }, downloadUpdate() { downloads++; return download.promise }, quitAndInstall(...args) { assert.deepStrictEqual(args, [false, true]); installed++ } })
  const log = { info() {}, error() {}, transports: { file: {} } }
  const module = { exports: {} }, stubs = { electron: { app }, 'electron-updater': { autoUpdater: updater }, 'electron-log': log,
    './ipc-channels': { EVENT: { UPDATER_STATUS: 'updater-status' } }, './paths': { isPortableApp: () => portable }, './window': { getMainWindow: () => null } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main/updater.js'), 'utf8'), { module, exports: module.exports, Promise,
    require(name) { if (name === 'electron-updater') imports++; if (!Object.hasOwn(stubs, name)) throw Error('Unexpected import: ' + name); return stubs[name] },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id }, clearTimeout(id) { timers.delete(id) },
    setInterval(fn, ms) { const id = ++timerId; intervals.set(id, { fn, ms }); return id }, clearInterval(id) { intervals.delete(id) } }, { filename: 'main/updater.js' })
  const api = module.exports
  assert.strictEqual(imports, 0); api.setupAutoUpdater(); assert.strictEqual(api.getUpdateState().status, 'disabled'); assert.strictEqual(imports, 0)
  app.isPackaged = true; portable = true; api.setupAutoUpdater(); assert.strictEqual(imports, 0); assert.strictEqual(timers.size + intervals.size, 0)
  portable = false; api.setupAutoUpdater(); api.setupAutoUpdater()
  assert.strictEqual(imports, 1); assert.strictEqual(timers.size, 1); assert.strictEqual(intervals.size, 1); assert.strictEqual(updater.listenerCount('error'), 1)
  assert.strictEqual(updater.autoDownload, false); assert.strictEqual(updater.autoInstallOnAppQuit, true)
  const first = api.checkForUpdates(); assert.strictEqual(first, api.checkForUpdates()); await Promise.resolve(); assert.strictEqual(calls, 1)
  updater.emit('update-available', { version: '1.5.2', releaseNotes: 'fixture notes' }); check.resolve({}); await first
  const fetching = api.downloadUpdate(); assert.strictEqual(fetching, api.downloadUpdate()); await Promise.resolve(); assert.strictEqual(downloads, 1)
  updater.emit('download-progress', { percent: 50, bytesPerSecond: 100, transferred: 500, total: 1000 }); assert.strictEqual(api.getUpdateState().progress.percent, 50)
  updater.emit('update-downloaded', { version: '1.5.2' }); download.resolve([]); await fetching
  assert.strictEqual(api.installUpdate().success, true); assert.strictEqual(installed, 1)
  api.disposeUpdater(); assert.strictEqual(timers.size + intervals.size, 0, 'quit clears both the initial check and periodic checks')
  api.setupAutoUpdater(); assert.strictEqual(imports, 1); assert.strictEqual(updater.listenerCount('error'), 1); assert.strictEqual(timers.size + intervals.size, 2)
  api.disposeUpdater()
  console.log('updater startup passed: no updater-library import in development/portable startup, supported one-time setup, deduplicated check/download, native event state/install behavior and both timer cleanups')
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => clearTimeout(deadline))
