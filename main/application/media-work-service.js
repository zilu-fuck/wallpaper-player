const crypto = require('crypto')
const { mediaRequestIdSchema } = require('../../packages/contracts')
const { taskError } = require('./resource-scheduler')

class MediaWorkService {
  constructor() { this.owners = new Map(); this.closing = false }
  getOwner(sender) {
    if (!sender || !Number.isInteger(sender.id) || sender.isDestroyed?.()) return null
    let owner = this.owners.get(sender.id)
    if (owner) return owner
    for (const current of [...this.owners.values()]) {
      this.prune(current)
      if (!current.requests.size && !current.cancelled.size) this.removeOwner(current)
    }
    if (this.owners.size >= 32) throw taskError('task_owner_limit', '媒体任务调用方过多', 429, true)
    owner = { sender, requests: new Map(), cancelled: new Map() }
    owner.close = () => {
      for (const record of owner.requests.values()) record.controller.abort(taskError('task_cancelled', '播放页面已关闭', 499))
      owner.cancelled.clear(); this.removeOwner(owner)
    }
    owner.navigate = (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) owner.close() }
    sender.once?.('destroyed', owner.close); sender.on?.('did-start-navigation', owner.navigate)
    this.owners.set(sender.id, owner)
    return owner
  }
  removeOwner(owner) {
    owner.sender.off?.('destroyed', owner.close); owner.sender.off?.('did-start-navigation', owner.navigate)
    if (this.owners.get(owner.sender.id) === owner) this.owners.delete(owner.sender.id)
  }
  prune(owner) {
    const now = Date.now()
    for (const [key, expires] of owner.cancelled) if (expires <= now) owner.cancelled.delete(key)
  }
  async run(event, requestId, operation) {
    if (this.closing) throw taskError('task_stopping', '媒体任务服务正在关闭')
    if (requestId !== undefined) requestId = mediaRequestIdSchema.parse(requestId)
    if (event?.sender?.isDestroyed?.()) throw taskError('task_cancelled', '调用页面已关闭', 499)
    const owner = this.getOwner(event?.sender), controller = new AbortController()
    if (!owner) return operation(controller.signal)
    this.prune(owner)
    const key = requestId || crypto.randomUUID()
    if (owner.cancelled.has(key)) throw taskError('task_cancelled', '媒体请求已取消', 499)
    if (owner.requests.has(key)) throw taskError('task_request_duplicate', '媒体请求编号正在使用', 409)
    if (owner.requests.size >= 128) throw taskError('task_interest_limit', '媒体请求过多', 429, true)
    const record = { controller }; owner.requests.set(key, record)
    try {
      const result = await operation(controller.signal)
      if (controller.signal.aborted) throw controller.signal.reason
      return result
    } finally {
      if (owner.requests.get(key) === record) owner.requests.delete(key)
      if (!owner.requests.size && !owner.cancelled.size) this.removeOwner(owner)
    }
  }
  cancel(event, requestId) {
    const key = mediaRequestIdSchema.parse(requestId)
    if (this.closing) return { success: true, cancelled: false }
    const owner = this.getOwner(event?.sender)
    if (!owner) return { success: true, cancelled: false }
    this.prune(owner)
    owner.cancelled.delete(key); owner.cancelled.set(key, Date.now() + 5 * 60 * 1000)
    while (owner.cancelled.size > 256) owner.cancelled.delete(owner.cancelled.keys().next().value)
    const record = owner.requests.get(key)
    record?.controller.abort(taskError('task_cancelled', '媒体请求已取消', 499))
    return { success: true, cancelled: Boolean(record) }
  }
  dispose() { this.closing = true; for (const owner of [...this.owners.values()]) owner.close() }
}
const mediaWorkService = new MediaWorkService()
module.exports = { MediaWorkService, mediaWorkService }
