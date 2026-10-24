const crypto = require('node:crypto')

const sameVersion = (left, right) => Boolean(left && right && left.epoch === right.epoch && left.revision === right.revision)
function createSettingsBroadcast({ settings, getMainWindow = () => require('../window').getMainWindow(),
  captureSender = event => require('../security/ipc-sender').captureAppSender(event), maxQueuedMessages = 32 } = {}) {
  if (!Number.isSafeInteger(maxQueuedMessages) || maxQueuedMessages < 1) throw new TypeError('Invalid settings broadcast capacity')
  const states = new WeakMap(), pending = new Set()
  const repository = () => settings ||= require('../settings')
  let remove = null, closed = false, lifetime = 1, compactedMessages = 0
  const quitting = () => Object.assign(Error('应用正在关闭'), { code: 'app_quitting' })
  function retire(contents, state) {
    if (!state) return
    state.disposed = true; state.queue.length = 0; pending.delete(state)
    if (states.get(contents) === state) states.delete(contents)
  }
  function assertCurrent(contents, state, generation) {
    if (closed || generation !== lifetime) throw quitting()
    state.scope.assertCurrent()
    if (state.disposed || state.lifetime !== lifetime || states.get(contents) !== state) throw Object.assign(Error('设置同步会话已失效'), { code: 'settings_feed_retired' })
  }
  function stateFor(event) {
    let state = states.get(event.sender)
    if (state) { try { assertCurrent(event.sender, state, lifetime) } catch { retire(event.sender, state); state = null } }
    if (!state) {
      state = { scope: captureSender(event), feedId: null, version: null, legacy: false, legacySequence: -1,
        encoded: false, queue: [], draining: false, disposed: false, lifetime, needsSnapshot: false }
      states.set(event.sender, state)
    }
    return state
  }
  function patchFor(event, feedId) {
    const patch = event.readPatch(), set = repository().sanitizeSettingsForRenderer(patch.set, { partial: true })
    delete set._settingsVersion
    return { kind: 'settings-patch-v1', feedId, baseVersion: event.baseVersion,
      version: event.version, set, removed: patch.removed, maps: patch.maps }
  }
  async function drain(contents, state) {
    if (state.draining) return
    state.draining = true; const generation = lifetime
    try {
      while (state.queue.length) {
        assertCurrent(contents, state, generation)
        const item = state.queue.shift()
        const snapshot = item.snapshot ? await item.snapshot.read() : null
        assertCurrent(contents, state, generation)
        if (item.legacy && state.legacy && state.legacySequence === item.sequence) {
          contents.send('settings-changed', { kind: 'settings-legacy-json-v1', sequence: item.sequence, snapshot })
        }
        if (item.feedId) {
          contents.send('settings-patched', item.patch || { kind: 'settings-snapshot-v1', feedId: item.feedId,
            snapshot, version: item.version })
          if (!item.patch) state.needsSnapshot = false
        }
      }
    } catch {
      state.queue.length = 0
      try {
        assertCurrent(contents, state, generation)
        state.needsSnapshot = true
        if (state.feedId) contents.send('settings-patched', { kind: 'settings-resync-v1', feedId: state.feedId, version: state.version })
        if (state.legacy) contents.send('settings-changed', { kind: 'settings-legacy-resync-v1', sequence: state.legacySequence })
      } catch { retire(contents, state) }
    } finally {
      state.draining = false; pending.delete(state)
      // A synchronous send hook can enqueue a newer commit while recovery is
      // publishing. Keep that work owned by the same ordered drain.
      if (!state.disposed && !closed && generation === lifetime && state.queue.length) {
        pending.add(state); void drain(contents, state)
      }
    }
  }
  function publishEncoded(contents, state, event) {
    const full = event.requiresSnapshot || state.needsSnapshot || !sameVersion(state.version, event.baseVersion)
    const item = { feedId: state.feedId, version: event.version, legacy: state.legacy, sequence: state.legacySequence,
      patch: state.feedId && !full ? patchFor(event, state.feedId) : null,
      snapshot: full || state.legacy ? event.captureRendererSnapshot() : null }
    if (!item.feedId && !item.legacy) return
    if (!state.draining && !state.queue.length && item.patch && !item.legacy) {
      state.version = { ...event.version }; contents.send('settings-patched', item.patch); return
    }
    if (state.queue.length >= maxQueuedMessages) {
      compactedMessages += state.queue.length; state.queue.length = 0
      item.patch = null; item.snapshot ||= event.captureRendererSnapshot()
    }
    state.queue.push(item); state.version = { ...event.version }; pending.add(state)
    void drain(contents, state)
  }
  function publish(event) {
    if (closed) return
    const win = getMainWindow()
    if (!win || win.isDestroyed()) return
    const contents = win.webContents
    try {
      const state = states.get(contents)
      if (state) assertCurrent(contents, state, lifetime)
      const scope = state?.scope || captureSender({ sender: contents, senderFrame: contents.mainFrame })
      scope.assertCurrent()
      if (state?.feedId && state.version?.epoch === event.version.epoch && state.version.revision >= event.version.revision) return
      if (state?.encoded && state.lifetime === lifetime && !state.disposed) { publishEncoded(contents, state, event); return }
      let full
      const snapshot = () => full ||= repository().sanitizeSettingsForRenderer(event.readSnapshot())
      if (!state?.feedId || state.legacy) contents.send('settings-changed', snapshot())
      if (!state?.feedId) return
      let message
      if (event.requiresSnapshot || !sameVersion(state.version, event.baseVersion)) {
        message = { kind: 'settings-snapshot-v1', feedId: state.feedId, snapshot: snapshot() }
      } else {
        message = patchFor(event, state.feedId)
      }
      scope.assertCurrent(); contents.send('settings-patched', message)
      state.version = { ...event.version }
    } catch { retire(contents, states.get(contents)) }
  }
  function start() {
    if (closed) { closed = false; lifetime++ }
    const generation = lifetime
    if (!remove) remove = repository().onSettingsCommitted(event => { if (!closed && generation === lifetime) publish(event) })
    return () => {
      if (closed || generation !== lifetime) return
      closed = true; lifetime++; remove?.(); remove = null
      for (const state of pending) { state.disposed = true; state.queue.length = 0 }
      pending.clear()
    }
  }
  function openFeed(event, options) {
    if (closed) throw quitting()
    if (!remove) start()
    const state = stateFor(event)
    if (options?.encoding === 'json-v1') {
      const captured = repository().captureRendererSettings()
      state.encoded = true
      state.feedId ||= crypto.randomUUID(); state.version = { ...captured.version }
      const feedId = state.feedId, generation = lifetime
      return captured.read().then(snapshot => {
        assertCurrent(event.sender, state, generation)
        if (sameVersion(state.version, captured.version)) state.needsSnapshot = false
        // Commits may already have advanced state.version while this snapshot was
        // being decoded. The late baseline must not rewind the publisher.
        return { kind: 'settings-feed-v1', feedId, snapshot }
      })
    }
    const snapshot = repository().sanitizeSettingsForRenderer(repository().loadSettings())
    state.feedId ||= crypto.randomUUID(); state.version = { ...snapshot._settingsVersion }
    return { kind: 'settings-feed-v1', feedId: state.feedId, snapshot }
  }
  function setLegacy(event, { enabled, sequence, encoding }) {
    if (closed) return
    const state = stateFor(event)
    if (sequence > state.legacySequence) {
      state.legacySequence = sequence; state.legacy = enabled
      if (encoding === 'json-v1') state.encoded = true
    }
  }
  return { start, openFeed, setLegacy, diagnostics: () => ({ pendingFrames: pending.size,
    queuedMessages: [...pending].reduce((sum, state) => sum + state.queue.length, 0),
    inFlight: [...pending].filter(state => state.draining).length, compactedMessages }) }
}

const settingsBroadcast = createSettingsBroadcast()
module.exports = { createSettingsBroadcast, settingsBroadcast }
