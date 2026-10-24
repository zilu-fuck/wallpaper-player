const crypto = require('crypto')
const backend = require('../remote/transcode')

function requestTaskOwner(req) {
  const authorization = req.remoteAuthorization
  if (!authorization?.authorized) throw Object.assign(new Error('设备未授权'), { status: 401, code: 'unauthorized' })
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
  return crypto.createHash('sha256').update(JSON.stringify([authorization.type, authorization.deviceId, token])).digest('hex')
}

function createTranscodeService(worker, { maxTasks = 64, maxInterests = 128, receiptLimit = 2048, receiptMs = 10 * 60 * 1000 } = {}) {
  const interests = new Map(), queues = new Map(), retired = new Map()
  const keyFor = (id, quality) => JSON.stringify([id, worker.normalizeQuality(quality)])
  const receiptFor = (key, actor, interestId) => JSON.stringify([key, actor, interestId])
  const terminal = task => !task || ['ready', 'error', 'cancelled'].includes(task.status)
  const retire = (key, actor, interestId) => {
    if (interestId === 'legacy') return
    retired.set(receiptFor(key, actor, interestId), Date.now() + receiptMs)
    while (retired.size > receiptLimit) retired.delete(retired.keys().next().value)
  }
  const prune = (executingKey) => {
    for (const [receipt, expires] of retired) if (expires <= Date.now()) retired.delete(receipt)
    for (const [key, record] of interests) {
      if ((queues.has(key) && key !== executingKey) || !terminal(worker.getMobileTranscodeStatus(record.id, record.quality))) continue
      interests.delete(key)
    }
  }
  const serialize = (key, operation) => {
    const result = (queues.get(key) || Promise.resolve()).catch(() => {}).then(operation)
    queues.set(key, result)
    const settled = () => { if (queues.get(key) === result) queues.delete(key) }
    result.then(settled, settled)
    return result
  }
  const decorate = (id, quality, actor, interestId) => {
    const task = worker.getMobileTranscodeStatus(id, quality)
    if (!task) return null
    const record = interests.get(keyFor(id, quality)), ids = record?.actors.get(actor)
    const selected = interestId || (ids?.size === 1 ? [...ids][0] : 'legacy')
    return { ...task, interestId: selected,
      canCancel: !terminal(task) && Boolean(ids?.has(selected)),
      interestedClients: terminal(task) ? 0 : record?.actors.size || 0 }
  }
  return {
    async start(id, filePath, quality, actor, interestId = 'legacy') {
      const key = keyFor(id, quality)
      return serialize(key, async () => {
        prune(key)
        if (retired.has(receiptFor(key, actor, interestId))) {
          throw Object.assign(new Error('这次任务订阅已结束，请重新发起'), { status: 409, code: 'task_interest_closed' })
        }
        let record = interests.get(key)
        if (!record) {
          if (interests.size >= maxTasks) throw Object.assign(new Error('转码任务过多，请稍后再试'), { status: 429, code: 'transcode_queue_full' })
          record = { id, quality, actors: new Map() }; interests.set(key, record)
        }
        const ids = record.actors.get(actor) || new Set()
        const count = [...record.actors.values()].reduce((total, item) => total + item.size, 0)
        if (!ids.has(interestId) && count >= maxInterests) throw Object.assign(new Error('任务订阅过多，请稍后再试'), { status: 429, code: 'task_interests_full' })
        ids.add(interestId); record.actors.set(actor, ids)
        try { await worker.startMobileTranscode(id, filePath, quality, { remote: true }) }
        catch (error) { ids.delete(interestId); if (!ids.size) record.actors.delete(actor); if (!record.actors.size) interests.delete(key); throw error }
        return decorate(id, quality, actor, interestId)
      })
    },
    get(id, quality, actor, interestId) {
      prune()
      if (interestId && retired.has(receiptFor(keyFor(id, quality), actor, interestId))) return {
        id, quality: worker.normalizeQuality(quality), status: 'cancelled', progress: 0,
        interestId, canCancel: false, interestedClients: 0, error: '这次任务订阅已取消'
      }
      return decorate(id, quality, actor, interestId)
    },
    async cancel(id, quality, actor, interestId = 'legacy') {
      const key = keyFor(id, quality)
      return serialize(key, async () => {
        prune(key)
        const record = interests.get(key), ids = record?.actors.get(actor)
        retire(key, actor, interestId)
        if (!ids?.has(interestId)) return { success: true, released: false, taskCancelled: false, shared: Boolean(record?.actors.size) }
        ids.delete(interestId)
        if (!ids.size) record.actors.delete(actor)
        if (record.actors.size) return { success: true, released: true, taskCancelled: false, shared: true }
        interests.delete(key)
        return { success: true, released: true,
          taskCancelled: terminal(worker.getMobileTranscodeStatus(id, quality)) ? false : worker.cancelMobileTranscode(id, quality), shared: false }
      })
    },
    list(actor) { prune(); return worker.listMobileTranscodeTasks().map(task => decorate(task.id, task.quality, actor)).filter(Boolean) },
    diagnostics() { prune(); return { tasks: interests.size, pending: queues.size, receipts: retired.size } }
  }
}

module.exports = { createTranscodeService, requestTaskOwner, transcodeService: createTranscodeService(backend) }
