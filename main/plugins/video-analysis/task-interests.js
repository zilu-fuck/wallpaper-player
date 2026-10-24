const path = require('path'), crypto = require('crypto')
const pathKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
const failure = (code, message, status = 409) => Object.assign(new Error(message), { code, status })

function createAnalysisTaskService(worker, { maxInterests = 128, maxWindows = 32, receiptLimit = 2048, receiptMs = 10 * 60 * 1000 } = {}) {
  let record = null, queue = Promise.resolve(), pending = 0, closing = false
  const retired = new Map(), windows = new WeakMap(), windowRecords = new Set()
  const receiptKey = (actor, interest) => JSON.stringify([actor, interest])
  const interestFor = value => {
    if (value === undefined) return 'legacy'
    if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) throw failure('invalid_request', '分析订阅标识无效', 400)
    return value
  }
  const prune = () => {
    for (const [key, deadline] of retired) if (deadline <= Date.now()) retired.delete(key)
    const current = worker.getActiveAnalysisJob()
    if (record && (!current?.running || (record.jobId && record.jobId !== current.jobId))) record = null
    return current
  }
  const retire = (actor, interest) => {
    if (interest === 'legacy') return
    retired.set(receiptKey(actor, interest), Date.now() + receiptMs)
    while (retired.size > receiptLimit) retired.delete(retired.keys().next().value)
  }
  const serialize = operation => {
    pending++
    const result = queue.catch(() => {}).then(operation)
    queue = result
    return result.finally(() => { pending-- })
  }
  const decorate = (actor, requested) => {
    const job = prune()
    if (!job?.running) return { running: false }
    const ids = record?.actors.get(actor)?.ids
    const interest = requested || (ids?.size === 1 ? [...ids][0] : 'legacy')
    const cancelled = retired.has(receiptKey(actor, interest))
    return { ...job, interestId: interest, canCancel: Boolean(!cancelled && !record?.closing && ids?.has(interest)),
      interestedClients: record?.actors.size || 0,
      interestCancelled: cancelled }
  }
  const releaseActorNow = actor => {
    const current = prune(), owned = record?.actors.get(actor)
    if (!owned) return false
    for (const interest of owned.ids) retire(actor, interest)
    record.actors.delete(actor)
    if (!record.actors.size && !record.unmanaged && current?.running) {
      record.closing = true; worker.cancelVideoAnalysis(current.jobId)
    }
    return true
  }
  const service = {
    async start(videoPath, actor, interestId, { sender, authorize, isCurrent = () => true, ...options } = {}) {
      const interest = interestFor(interestId)
      if (pending >= 256) throw failure('analysis_queue_full', '分析请求过多，请稍后再试', 429)
      return serialize(async () => {
        if (closing || !isCurrent()) throw failure('analysis_stopping', '分析调用方已关闭')
        const current = prune()
        if (retired.has(receiptKey(actor, interest))) throw failure('task_interest_closed', '这次分析订阅已结束，请重新发起')
        if (typeof authorize !== 'function') throw failure('invalid_request', '分析调用方缺少读取授权', 400)
        if (current?.running && (pathKey(current.videoPath) !== pathKey(videoPath) || record?.closing)) {
          return { accepted: false, reason: record?.closing ? 'stopping' : 'already_running',
            error: record?.closing ? '上次分析正在收尾，请稍后重试' : '电脑端正在分析其他视频', job: decorate(actor, interest) }
        }
        if (!record) record = { path: pathKey(videoPath), jobId: current?.jobId || '', actors: new Map(), unmanaged: Boolean(current?.running) }
        const target = record, owned = target.actors.get(actor) || { ids: new Set(), authorize, isCurrent }
        const count = [...target.actors.values()].reduce((total, item) => total + item.ids.size, 0)
        if (!owned.ids.has(interest) && count >= maxInterests) throw failure('task_interests_full', '分析订阅过多，请稍后再试', 429)
        owned.ids.add(interest); owned.authorize = authorize; owned.isCurrent = isCurrent; target.actors.set(actor, owned)
        if (current?.running) return { accepted: true, shared: true, job: decorate(actor, interest) }
        try {
          const result = await worker.startVideoAnalysis(videoPath, sender, { ...options, authorize: async () => {
            for (const [key, owner] of target.actors) {
              if (!owner.isCurrent()) continue
              try { if (await owner.authorize() !== false && owner.isCurrent() && target.actors.get(key) === owner) return } catch {}
            }
            throw failure('analysis_owner_unavailable', '分析调用方已关闭或无权读取此视频', 403)
          } })
          if (!result.accepted) { owned.ids.delete(interest); if (!owned.ids.size) target.actors.delete(actor); return result }
          target.jobId = result.job.jobId
          if (!isCurrent() || retired.has(receiptKey(actor, interest))) { releaseActorNow(actor); throw failure('task_interest_closed', '这次分析订阅已结束') }
          return { ...result, shared: false, job: decorate(actor, interest) }
        } catch (error) {
          owned.ids.delete(interest); if (!owned.ids.size) target.actors.delete(actor)
          if (!target.actors.size && !worker.getActiveAnalysisJob()?.running && record === target) record = null
          throw error
        }
      })
    },
    get(actor, interestId) { return decorate(actor, interestId === undefined ? undefined : interestFor(interestId)) },
    cancel(actor, jobId, interestId) {
      const interest = interestFor(interestId)
      return serialize(() => {
        const current = prune()
        const owned = record?.actors.get(actor)
        if (current?.running && jobId && current.jobId !== jobId && owned?.ids.has(interest)) return {
          success: true, cancelled: false, released: false, taskCancelled: false, shared: true, reason: 'job_mismatch' }
        retire(actor, interest)
        if (!current?.running || (jobId && current.jobId !== jobId) || !owned?.ids.has(interest)) return {
          success: true, cancelled: false, released: false, taskCancelled: false, shared: Boolean(record?.actors.size),
          reason: !current?.running ? 'not_running' : jobId && current.jobId !== jobId ? 'job_mismatch' : 'not_owned' }
        owned.ids.delete(interest); if (!owned.ids.size) record.actors.delete(actor)
        const shared = Boolean(record.actors.size || record.unmanaged)
        if (!shared) record.closing = true
        const cancelled = shared ? false : worker.cancelVideoAnalysis(current.jobId).cancelled
        return { success: true, cancelled, released: true, taskCancelled: cancelled, shared, jobId: current.jobId }
      })
    },
    releaseActor(actor) { return serialize(() => releaseActorNow(actor)) },
    revalidate() { return serialize(async () => {
      prune()
      for (const [actor, owner] of [...record?.actors || []]) {
        try { if (owner.isCurrent() && await owner.authorize?.() !== false) continue } catch {}
        releaseActorNow(actor)
      }
    }) },
    windowOwner(sender) {
      if (closing) throw failure('analysis_stopping', '分析服务正在关闭')
      if (!sender || sender.isDestroyed?.()) throw failure('analysis_stopping', '分析窗口已关闭')
      if (windows.has(sender)) return windows.get(sender)
      if (windowRecords.size >= maxWindows) throw failure('analysis_owners_full', '分析窗口过多，请关闭未使用的窗口', 429)
      const owner = { actor: 'desktop:' + sender.id + ':' + crypto.randomUUID(), valid: true,
        isCurrent: () => owner.valid && !sender.isDestroyed?.() }
      const release = () => { if (!owner.valid) return; owner.valid = false; windows.delete(sender); windowRecords.delete(owner)
        sender.off?.('destroyed', release); sender.off?.('did-start-navigation', navigate); void service.releaseActor(owner.actor).catch(() => {}) }
      const navigate = (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) release() }
      owner.release = release
      windows.set(sender, owner); windowRecords.add(owner)
      sender.once?.('destroyed', release); sender.on?.('did-start-navigation', navigate)
      return owner
    },
    async dispose() {
      closing = true; for (const owner of [...windowRecords]) owner.release(); await queue.catch(() => {})
      const current = prune()
      if (current?.running && record && !record.unmanaged && !record.closing) worker.cancelVideoAnalysis(current.jobId)
      record = null; retired.clear()
    },
    resume() { closing = false },
    diagnostics() { prune(); return { interests: [...record?.actors.values() || []].reduce((total, owner) => total + owner.ids.size, 0), actors: record?.actors.size || 0, receipts: retired.size, windows: windowRecords.size, pending, closing } }
  }
  return service
}

function remoteAnalysisOwner(req) {
  if (!req.remoteAuthorization?.authorized) throw failure('unauthorized', '设备未授权', 401)
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
  return { actor: crypto.createHash('sha256').update(JSON.stringify([req.remoteAuthorization.type, req.remoteAuthorization.deviceId, tokenHash])).digest('hex'), tokenHash }
}
module.exports = { createAnalysisTaskService, remoteAnalysisOwner }
