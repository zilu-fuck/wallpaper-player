const crypto = require('crypto')
const { playerActionSchema, playerActionResultSchema } = require('../../packages/contracts')
const { mediaScheduler } = require('./resource-scheduler')

function createPlayerService({ manager, getMainWindow, resolveLocal, resolveNetwork, resolveMpvPath, readPlaybackState,
  setMediaPlaybackActive, scheduler = mediaScheduler, preparationMs = 45000 }) {
  let current = null
  const trackedSenders = new WeakSet()
  const fail = (code, message) => Object.assign(new Error(message), { code, status: 409 })
  function checkSender(event) {
    const sender = event?.sender, main = getMainWindow()?.webContents
    if (!sender || sender !== main || sender.isDestroyed?.()) throw fail('ipc_sender_denied', '播放器调用来源无效')
    if (sender.mainFrame && event.senderFrame !== sender.mainFrame) throw fail('ipc_sender_denied', '播放器调用来源无效')
  }
  const owns = (record) => current === record && !record.cancelled && !record.sender.isDestroyed?.() &&
    getMainWindow()?.webContents === record.sender
  const live = record => owns(record) && manager.getState().sessionId === record.sessionId
  const ensure = record => { if (!owns(record)) throw fail('stale_session', '播放会话已替换') }
  async function load(event, request) {
    checkSender(event)
    if (!trackedSenders.has(event.sender)) {
      trackedSenders.add(event.sender)
      const invalidate = () => {
        if (current?.sender !== event.sender) return
        current.cancelled = true; current.abort.abort(fail('stale_session', '播放窗口已关闭')); setMediaPlaybackActive(false)
        void manager.stop().catch(() => {})
      }
      event.sender.once?.('destroyed', invalidate)
      event.sender.on?.('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) invalidate() })
    }
    if (current) { current.cancelled = true; current.abort.abort(fail('stale_session', '播放会话已替换')) }
    const record = { sessionId: request.sessionId, sender: event.sender, cancelled: false, abort: new AbortController() }
    current = record
    try {
      return await scheduler.enqueue({ key: 'player-prepare:' + crypto.randomUUID(), type: 'player-prepare', resources: { prepare: 1 },
        signal: record.abort.signal, priority: 100, timeoutMs: preparationMs }, async context => {
      const check = () => { context.throwIfAborted(); ensure(record) }
      setMediaPlaybackActive(true)
      await manager.stop()
      check()
      const resource = request.source === 'network' ? await resolveNetwork(request, context) : null
      check()
      const target = resource ? resource.url : await resolveLocal(request.target, event.sender.id, context)
      check()
      if (resource && !resource.playbackUrl && resource.page?.openMode === 'webview') {
        setMediaPlaybackActive(false)
        return { success: true, sessionId: request.sessionId, webpageUrl: resource.url }
      }
      const playlist = []
      if (!resource && Array.isArray(request.playlist)) for (const item of request.playlist) {
        try { playlist.push(await resolveLocal(item, event.sender.id, context)) } catch {}
        check()
      }
      const executable = await resolveMpvPath(context)
      check()
      if (!executable) throw fail('mpv_unavailable', 'mpv 未安装')
      // Recheck local authority after tool discovery; unlocked state may have changed while awaiting it.
      if (!resource) await resolveLocal(target, event.sender.id, context)
      check()
      const saved = readPlaybackState(target)
      const resume = { ...(saved || {}), ...(request.resume === false ? { position: 0 } : {}) }
      check()
      setMediaPlaybackActive(true)
      await manager.play(resource?.playbackUrl || target, {
        sessionId: request.sessionId, resourceTarget: target, hostBounds: request.hostBounds,
        isCurrent: () => { context.throwIfAborted(); return owns(record) }, signal: context.signal,
        playlist: resource ? [resource.playbackUrl || target] : playlist.length ? playlist : [target],
        playlistIndex: resource ? 0 : request.playlistIndex, resume, httpHeaders: resource?.httpHeaders
      })
      check()
      return { success: true, sessionId: request.sessionId, state: manager.getState() }
      })
    } catch (error) {
      if (current === record && error.code !== 'player_stop_timeout') {
        record.cancelled = true; record.abort.abort(error); setMediaPlaybackActive(false)
        if (manager.getState().sessionId === record.sessionId) void manager.stop().catch(() => {})
      }
      if (record.abort.signal.aborted) throw record.abort.signal.reason
      throw error
    }
  }
  async function action(event, input) {
    checkSender(event)
    const request = playerActionSchema.parse(input, 'request')
    if (request.action === 'load') return playerActionResultSchema.parse(await load(event, request), 'response')
    const record = current
    if (!record || record.sender !== event.sender || record.sessionId !== request.sessionId || !owns(record)) throw fail('stale_session', '播放会话已替换')
    if (request.action === 'stop') {
      record.cancelled = true
      record.abort.abort(fail('stale_session', '播放会话已停止'))
      // Invalidate preparation as well as the process, before any asynchronous cleanup.
      setMediaPlaybackActive(false)
      await manager.stop()
      return { success: true, sessionId: request.sessionId }
    }
    if (!live(record)) throw fail('stale_session', '播放会话尚未就绪或已替换')
    if (request.action === 'bounds') manager.setHostBounds(request.bounds)
    else if (request.action === 'command') {
      const command = request.command
      const args = command.command === 'setABLoop' ? [command.start, command.end] : ('value' in command ? [command.value] : [])
      const result = await manager[command.command](...args)
      ensure(record)
      if (command.command === 'screenshot') return { success: true, sessionId: request.sessionId, screenshotPath: result }
    }
    return playerActionResultSchema.parse({ success: true, sessionId: request.sessionId, state: manager.getState() }, 'response')
  }
  return { action, async legacyStop(event) {
    checkSender(event)
    if (current) { current.cancelled = true; current.abort.abort(fail('stale_session', '播放会话已停止')) }
    setMediaPlaybackActive(false)
    await manager.stop()
    return { success: true }
  }, async legacyLoad(event, target, options, source) {
    return load(event, { action: 'load', sessionId: 'legacy_' + crypto.randomUUID(), target, source,
      resume: options?.resume !== false, hostBounds: options?.hostBounds, title: options?.title,
      temporary: options?.temporary === true, kind: options?.kind,
      playlist: options?.playlist, playlistIndex: options?.playlistIndex })
  } }
}

module.exports = { createPlayerService }
