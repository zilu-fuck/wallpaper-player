const assert = require('assert')
const { createPlayerService } = require('../main/application/player-service')
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const sender = { id: 7, mainFrame: {}, isDestroyed: () => false }, event = { sender, senderFrame: sender.mainFrame }
const initial = () => ({ filePath: null, timePos: 0, duration: 0, paused: false, ready: false,
  volume: 100, muted: false, speed: 1, eofReached: false, trackList: [], sessionId: '', engineSessionId: 0 })
async function main() {
  const plays = [], pressure = [], gates = new Map(), state = { value: initial() }
  let stops = 0, commands = 0
  const manager = { getState: () => state.value, async stop() { stops++; state.value = initial() },
    async play(target, options) { plays.push({ target, options }); state.value = { ...initial(), filePath: target,
      resourceTarget: options.resourceTarget, sessionId: options.sessionId, engineSessionId: plays.length, ready: true,
      volume: options.resume.volume ?? 100, timePos: options.resume.position ?? 0 } },
    setHostBounds() {}, async seekTo(position) { commands++; state.value.timePos = position }, async setVolume(volume) { commands++; state.value.volume = volume }
  }
  const service = createPlayerService({ manager, getMainWindow: () => ({ webContents: sender }),
    async resolveLocal(target) { if (gates.has(target)) await gates.get(target).promise; return target },
    resolveNetwork: async request => ({ url: request.target, playbackUrl: 'https://host/Resolved.MP4' }),
    resolveMpvPath: async () => 'mpv', readPlaybackState: () => ({ position: 40, volume: 0, speed: 1.5 }),
    setMediaPlaybackActive: value => pressure.push(value) })
  gates.set('a', deferred())
  const a = service.action(event, { action: 'load', sessionId: 'a', source: 'local', target: 'a' })
  const replaced = assert.rejects(a, error => error.code === 'stale_session')
  const b = await service.action(event, { action: 'load', sessionId: 'b', source: 'local', target: 'b', resume: false })
  gates.get('a').resolve(); await replaced
  assert.strictEqual(b.state.sessionId, 'b'); assert.strictEqual(plays.length, 1)
  assert.strictEqual(plays[0].options.resume.position, 0); assert.strictEqual(plays[0].options.resume.volume, 0)
  const stopCount = stops
  await assert.rejects(service.action(event, { action: 'stop', sessionId: 'a' }), error => error.code === 'stale_session')
  await assert.rejects(service.action(event, { action: 'command', sessionId: 'a', command: { command: 'seekTo', value: 99 } }), error => error.code === 'stale_session')
  assert.strictEqual(stops, stopCount); assert.strictEqual(commands, 0)
  await service.action(event, { action: 'command', sessionId: 'b', command: { command: 'seekTo', value: 0 } })
  assert.strictEqual(commands, 1)
  await assert.rejects(service.action({ sender, senderFrame: {} }, { action: 'stop', sessionId: 'b' }), error => error.code === 'ipc_sender_denied')
  await assert.rejects(service.action(event, { action: 'command', sessionId: 'b', command: { command: 'setVolume', value: 'invalid' } }), error => error.name === 'ContractError')
  gates.set('c', deferred())
  const c = service.action(event, { action: 'load', sessionId: 'c', source: 'local', target: 'c' })
  const cancelled = assert.rejects(c, error => error.code === 'stale_session')
  await service.action(event, { action: 'stop', sessionId: 'c' }); gates.get('c').resolve(); await cancelled
  assert.strictEqual(plays.length, 1, 'stop also invalidates pending preparation')
  await service.action(event, { action: 'load', sessionId: 'network', source: 'network', target: 'https://host/Video.MP4' })
  assert.strictEqual(plays.at(-1).options.resourceTarget, 'https://host/Video.MP4')
  assert.strictEqual(plays.at(-1).target, 'https://host/Resolved.MP4')
  assert.ok(pressure.at(-1))
  await service.legacyStop(event); assert.strictEqual(pressure.at(-1), false)
  let destroyed = false
  sender.isDestroyed = () => destroyed
  gates.set('destroyed', deferred())
  const closing = service.action(event, { action: 'load', sessionId: 'destroyed', source: 'local', target: 'destroyed' })
  const invalidated = assert.rejects(closing, error => error.code === 'stale_session')
  await Promise.resolve(); destroyed = true; gates.get('destroyed').resolve(); await invalidated
  assert.strictEqual(plays.length, 2, 'a destroyed renderer cannot finish preparation and create a process')
  console.log('player service passed: production contracts, newest load wins, cancelled preparation, stale stop/control isolation, frame ownership, zero/resume state and logical network target')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
