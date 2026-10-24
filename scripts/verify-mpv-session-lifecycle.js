const assert = require('assert'), path = require('path'), Module = require('module')
const { EventEmitter } = require('events'), { PassThrough } = require('stream')
const fs = require('fs'), fsp = require('fs/promises'), crypto = require('crypto')
const root = path.resolve(__dirname, '..'), fixtureParent = path.join(root, '.tmp/refactor-tests')
fs.mkdirSync(fixtureParent, { recursive: true }); const fixture = fs.mkdtempSync(path.join(fixtureParent, 'mpv-manager-cache-'))
const taskCwd = process.cwd(); process.chdir(fixture)
const props = { 'time-pos': 0, duration: 100, pause: false, volume: 100, mute: false, speed: 1 }
const children = [], sockets = [], events = [], control = { holdExit: false, ignoreReplies: false, maximum: 0 }
let active = 0
const original = Module._load
Module._load = function (request, parent, ...rest) {
  if (parent?.filename.replace(/\\/g, '/').endsWith('/main/mpv.js')) {
    if (request === 'electron') return { app: { isPackaged: false, get getPath() { return control.cache ? () => fixture : undefined } } }
    if (request === './settings') return { loadSettingsFields: () => ({ mpvPath: '' }) }
    if (request === './window') return { getMainWindow: () => null }
    if (request === './ytdlp-service') return { getSystemProxyAsync: async () => null }
    if (request === './mpv-host') return new Proxy({}, { get: (_value, key) => key === 'getMpvHostHandle' ? () => null : () => {} })
    if (request === 'child_process') return { spawn() {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 7000 + children.length
      child.finish = () => { if (child.closed) return; child.closed = true; active--; child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0) }
      child.kill = () => { child.killed = true; if (!control.holdExit) setImmediate(child.finish); return true }
      children.push(child); active++; control.maximum = Math.max(control.maximum, active); return child
    } }
    if (request === 'net') return { createConnection(_path, connected) {
      const child = children.at(-1), socket = new EventEmitter()
      socket.setEncoding = () => {}
      socket.destroy = () => { if (socket.closed) return; socket.closed = true; socket.emit('close') }
      socket.write = text => {
        const request = JSON.parse(text), command = request.command
        if (command[0] === 'quit') { if (!control.holdExit) setImmediate(child.finish); return }
        if (control.ignoreReplies) return
        if (command[0] === 'set_property') props[command[1]] = command[2]
        setImmediate(() => {
          socket.emit('data', JSON.stringify({ request_id: request.request_id, error: 'success', data: props[command[1]] ?? null }) + '\n')
          if (command[0] === 'set_property') socket.emit('data', JSON.stringify({ event: 'property-change', name: command[1], data: command[2] }) + '\n')
        })
      }
      sockets.push(socket); setImmediate(connected); return socket
    } }
  }
  return original.call(this, request, parent, ...rest)
}
let MpvManager
try { MpvManager = require('../main/mpv') } finally { Module._load = original }
async function main() {
  const manager = new MpvManager(); manager.mpvPath = 'fake.exe'
  manager.on('state', state => events.push({ type: 'state', state }))
  manager.on('error', state => events.push({ type: 'error', state }))
  await manager.play('E:/library/a.mp4', { sessionId: 'a', resume: { position: 40, volume: 0 } })
  assert.strictEqual(manager.getState().sessionId, 'a'); assert.strictEqual(manager.getState().volume, 0)
  const oldSocket = sockets[0], oldChild = children[0], lateData = oldSocket.listeners('data')[0]
  await manager.play('E:/library/b.mp4', { sessionId: 'b', resume: { position: 0 } })
  assert.ok(oldChild.closed); assert.strictEqual(control.maximum, 1)
  const before = events.length
  lateData(JSON.stringify({ event: 'property-change', name: 'time-pos', data: 99 }) + '\n')
  oldChild.emit('error', new Error('old process failure'))
  assert.strictEqual(events.length, before); assert.strictEqual(manager.getState().timePos, 0, 'old socket cannot overwrite new state')
  control.holdExit = true
  const replacement = manager.play('E:/library/c.mp4', { sessionId: 'c' })
  await assert.rejects(replacement, /stop timed out/)
  assert.strictEqual(children.length, 2, 'a process that has not closed prevents a second process from starting')
  assert.strictEqual(active, 1)
  children.at(-1).finish(); control.holdExit = false
  await manager.play('E:/library/d.mp4', { sessionId: 'd' })
  control.ignoreReplies = true
  const unanswered = manager.setVolume(30)
  // Session replacement must release pending commands immediately, rather than waiting for the timeout.
  const stopped = manager.stop(); await assert.rejects(unanswered, /closed/); await stopped
  assert.strictEqual(manager._pendingRequests.size, 0); assert.strictEqual(active, 0)
  await manager.destroy()
  control.ignoreReplies = false; control.cache = true
  assert.strictEqual(require('../main/user-data').getUserDataDir(), path.join(fixture, '.tmp-wallpaper-player'))
  const directory = path.join(fixture, 'mpv'), versions = path.join(directory, 'versions'), ids = []
  await fsp.mkdir(versions, { recursive: true })
  for (let i = 0; i < 3; i++) {
    const id = crypto.randomUUID(); ids.push(id); await fsp.mkdir(path.join(versions, id))
    await fsp.writeFile(path.join(versions, id, 'mpv.exe'), 'fake-version')
    await fsp.utimes(path.join(versions, id), new Date(1000000000000 + i * 1000), new Date(1000000000000 + i * 1000))
  }
  const executable = id => path.join(versions, id, 'mpv.exe')
  await fsp.writeFile(path.join(directory, 'installed.json'), JSON.stringify({ version: 1, installation: ids[2] }))
  const versioned = new MpvManager()
  try {
    await versioned.setMpvPath(executable(ids[0])); await versioned.play('E:/library/leased.mp4', { sessionId: 'leased' })
    const process = children.at(-1)
    await versioned.setMpvPath(executable(ids[1]))
    const extra = crypto.randomUUID(); await fsp.mkdir(path.join(versions, extra)); await fsp.writeFile(path.join(versions, extra, 'mpv.exe'), 'unselected-version')
    let capacity = await versioned.installer.versionCache.collect({}, { count: 1, bytes: 0 })
    assert.strictEqual(capacity.overBudget, true); assert.ok(fs.existsSync(executable(ids[0])), 'a selected-path change retains the actual old process version')
    control.holdExit = true
    const pendingStop = versioned.stop(); await new Promise(done => setImmediate(done))
    await versioned.installer.versionCache.collect({}, { count: 1, bytes: 0 })
    assert.ok(fs.existsSync(executable(ids[0])), 'pending native close still protects the version')
    process.finish(); control.holdExit = false; await pendingStop
    capacity = await versioned.installer.versionCache.collect({}, { count: 1, bytes: 0 })
    assert.strictEqual(capacity.overBudget, false); assert.strictEqual(fs.existsSync(executable(ids[0])), false)
    assert.ok(fs.existsSync(executable(ids[1])) && fs.existsSync(executable(ids[2])))
  } finally { control.holdExit = false; children.forEach(child => child.finish()); await versioned.destroy() }
  console.log('mpv lifecycle passed: production manager/process/socket protocol, session-tagged state, volume zero, late process/socket isolation, no overlapping processes on stop timeout, command cancellation and disposal')
}
main().catch(error => { console.error(error); process.exitCode = 1; children.forEach(child => child.finish()) }).finally(async () => {
  try {
    await require('../main/application/resource-scheduler').mediaScheduler.dispose()
    await require('../main/settings').disposeSettingsSerialization({ cancel: true })
  } finally {
    process.chdir(taskCwd)
    assert.strictEqual(path.dirname(path.resolve(fixture)), fixtureParent); await require('./verify-helpers').removeTempRootWithRetry(fixture)
  }
})
