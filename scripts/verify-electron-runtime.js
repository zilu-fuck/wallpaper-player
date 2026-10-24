const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
assert.ok(fs.existsSync(path.join(root, 'dist/index.html')), 'Build the desktop frontend before the native runtime verification')
const { IPC } = require('../main/ipc-channels')
const handlers = new Map(), calls = [], state = { endpoint: 'http://127.0.0.1:38127', settings: { allowLegacyToken: true } }
let write
const identity = { refreshIdentity: async () => {}, getIdentityReadError: () => null, loadIdentity: () => ({ accessToken: 'fixture-only-token' }) }
const moduleFixture = { exports: {} }
vm.runInNewContext(fs.readFileSync(path.join(root, 'main/ipc/remote.js'), 'utf8'), {
  module: moduleFixture, exports: moduleFixture.exports,
  require(name) {
    if (name === 'electron') return { clipboard: { writeText: text => { calls.push(text); return write() } } }
    if (name === '../security/ipc') return { ipcMain: null }
    if (name === '../ipc-channels') return { IPC }
    if (name === '../remote') return { getRemoteState: () => state }
    if (name === '../remote/identity') return identity
    if (name === 'qrcode') return {}
    throw Error('Unexpected dependency: ' + name)
  }
}, { filename: 'main/ipc/remote.js' })
moduleFixture.exports.registerRemoteIpc({ handle: (name, handler) => handlers.set(name, handler) })

;(async () => {
  const tested = []
  for (const [channel, args, text] of [
    [IPC.REMOTE_COPY_ENDPOINT, [], state.endpoint],
    [IPC.REMOTE_COPY_TOKEN, [], 'fixture-only-token'],
    [IPC.REMOTE_COPY_PAIRING_CODE, ['  fixture-pairing-code  '], 'fixture-pairing-code']
  ]) {
    let release, finished = false
    write = () => new Promise(resolve => { release = resolve })
    const pending = handlers.get(channel)(null, ...args).then(value => { finished = true; return value })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls.at(-1), text)
    assert.equal(finished, false, channel + ' must wait for native clipboard completion')
    release(); assert.equal((await pending).success, true)
    const error = Error('fixture clipboard unavailable')
    write = async () => { throw error }
    await assert.rejects(handlers.get(channel)(null, ...args), reason => reason === error)
    tested.push(channel + ': pending completion and rejection')
  }
  const count = calls.length
  state.settings.allowLegacyToken = false
  await assert.rejects(handlers.get(IPC.REMOTE_COPY_TOKEN)(), /兼容旧版/)
  assert.equal((await handlers.get(IPC.REMOTE_COPY_PAIRING_CODE)(null, ' ')).success, false)
  assert.equal(calls.length, count, 'disabled legacy token / invalid pairing must not touch clipboard')
  const parent = path.join(root, '.tmp/refactor-tests'); fs.mkdirSync(parent, { recursive: true })
  const fixture = fs.mkdtempSync(path.join(parent, 'runtime-native-中文 空格-'))
  const env = { ...process.env, WALLPAPER_RUNTIME_FIXTURE: fixture }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawnSync(require('electron'), [...process.argv.slice(2), path.join(__dirname, 'verify-electron-runtime-electron.js')], {
    cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 45000, maxBuffer: 2 * 1024 * 1024
  })
  assert.ifError(child.error)
  const file = path.join(fixture, 'runtime-result.json')
  if (child.status !== 0 || !fs.existsSync(file)) throw Error('Native startup failed: ' + child.stderr + '\n' + child.stdout)
  const native = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(native.success, true, JSON.stringify(native))
  const result = { date: new Date().toISOString(), clipboard: tested, native,
    conditions: 'Clipboard writes are controlled promises; no native clipboard contents are read or modified. Native check uses real main/index, window, preload, frontend, IPC and settings worker with its own profile.' }
  fs.writeFileSync(path.join(parent, 'electron-runtime-evidence.json'), JSON.stringify(result, null, 2))
  console.log('Electron runtime passed: delayed/rejected clipboard IPC, actual complete startup, preload/IPC/settings worker, console details, capture and graceful shutdown; ' + native.electron)
})().catch(error => { console.error(error); process.exitCode = 1 })
