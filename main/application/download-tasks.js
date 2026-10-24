const fsp = require('fs/promises'), path = require('path'), crypto = require('crypto')
const { mediaScheduler, taskError } = require('./resource-scheduler')
const GID = /^[0-9a-f]{16}$/
const HASH = /^[0-9a-f]{64}$/
const terminal = state => ['complete', 'error', 'removed', 'missing'].includes(state)
const validGid = value => { if (typeof value !== 'string' || !GID.test(value) || /^0+$/.test(value)) throw taskError('download_gid_invalid', '下载任务编号无效', 400); return value }
const digest = value => crypto.createHash('sha256').update(value).digest('hex')

class DownloadTasks {
  constructor({ filename, rpc, stopEngine, scheduler = mediaScheduler, taskMs = 24 * 60 * 60 * 1000, pollMs = 2000, limit = 128, historyLimit = 512 } = {}) {
    this.filename = filename; this.rpc = rpc; this.stopEngine = stopEngine; this.scheduler = scheduler
    this.taskMs = taskMs; this.pollMs = pollMs; this.limit = limit; this.historyLimit = historyLimit
    this.entries = new Map(); this.loading = null; this.writes = Promise.resolve(); this.queues = new Map(); this.pending = new Set()
    this.lifecycle = new AbortController(); this.live = false; this.timers = new Map(); this.pollTimer = null; this.polling = null
  }
  file() { return typeof this.filename === 'function' ? this.filename() : this.filename }
  check(context) { if (this.lifecycle.signal.aborted) throw this.lifecycle.signal.reason; context?.throwIfAborted?.() }
  async load() {
    if (!this.loading) this.loading = (async () => {
      try {
        const stat = await fsp.stat(this.file())
        if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('下载任务账本超过大小上限')
        const bytes = await fsp.readFile(this.file()); if (bytes.length > 1024 * 1024) throw new Error('下载任务账本超过大小上限')
        const saved = JSON.parse(bytes)
        if (saved.version !== 1 || !Array.isArray(saved.tasks) || saved.tasks.length > this.historyLimit) throw new Error('下载任务账本格式无效')
        const operations = new Set()
        for (const task of saved.tasks) {
          validGid(task.gid); validGid(task.rootGid)
          task.parentGid ??= task.rootGid === task.gid ? '' : task.rootGid
          if (task.parentGid) validGid(task.parentGid)
          if (this.entries.has(task.gid) || !['running', 'paused', 'removed'].includes(task.desired) ||
            !['submitting', 'active', 'waiting', 'paused', 'complete', 'error', 'removed', 'missing', 'unknown'].includes(task.state) ||
            !['url', 'magnet', 'restored'].includes(task.kind) || !Number.isSafeInteger(task.createdAt) || task.createdAt < 0 ||
            !Number.isSafeInteger(task.deadlineAt) || task.deadlineAt < 0 || typeof task.generation !== 'string' || task.generation.length > 64 ||
            typeof task.pending !== 'boolean' || typeof task.expired !== 'boolean' || typeof task.linksChecked !== 'boolean' ||
            typeof task.name !== 'string' || task.name.length > 256 || !task.generation.length ||
            typeof task.operation !== 'string' || typeof task.fingerprint !== 'string' || (!task.operation && task.fingerprint !== '') ||
            (task.desired === 'running' && !terminal(task.state) && !task.deadlineAt) ||
            (task.operation && (!HASH.test(task.operation) || operations.has(task.operation) || !HASH.test(task.fingerprint)))) throw new Error('下载任务账本格式无效')
          if (task.operation) operations.add(task.operation)
          this.entries.set(task.gid, task)
        }
        for (const task of this.entries.values()) {
          const seen = new Set(); let current = task
          while (current.parentGid) {
            if (seen.has(current.gid) || !this.entries.has(current.parentGid)) throw new Error('下载父任务账本无效')
            seen.add(current.gid); current = this.entries.get(current.parentGid)
            if (current.rootGid !== task.rootGid) throw new Error('下载父任务账本无效')
          }
          if (current.gid !== task.rootGid) throw new Error('下载父任务账本无效')
        }
      } catch (error) {
        if (error.code !== 'ENOENT') { this.entries.clear(); throw new Error('下载任务账本无法读取，请保留原文件后修复') }
      }
    })()
    return this.loading
  }
  update(change, checkCommit = () => {}) {
    const work = this.writes.catch(() => {}).then(async () => {
      await this.load()
      const next = new Map([...this.entries].map(([key, value]) => [key, { ...value }]))
      const result = change(next), serialized = JSON.stringify({ version: 1, tasks: [...next.values()] })
      if (serialized === JSON.stringify({ version: 1, tasks: [...this.entries.values()] })) return result
      if (Buffer.byteLength(serialized) > 1024 * 1024) throw taskError('download_ledger_full', '下载任务账本已满', 429)
      const target = this.file(), temporary = target + '.' + crypto.randomUUID() + '.tmp'
      await fsp.mkdir(path.dirname(target), { recursive: true })
      let file
      try {
        file = await fsp.open(temporary, 'wx'); await file.writeFile(serialized); await file.sync(); await file.close(); file = null
        checkCommit(); await fsp.rename(temporary, target); this.entries = next; this.arm()
      } finally { await file?.close().catch(() => {}); await fsp.unlink(temporary).catch(() => {}) }
      return result
    })
    this.writes = work; return work
  }
  makeRecord(gid, kind = 'restored', rootGid = gid, parentGid = rootGid === gid ? '' : rootGid) {
    return { gid, rootGid, parentGid, kind, name: '下载任务', operation: '', fingerprint: '', createdAt: Date.now(), deadlineAt: 0,
      generation: crypto.randomUUID(), desired: 'paused', state: 'unknown', pending: false, expired: false, linksChecked: false }
  }
  admit(next, record) {
    const groups = new Map()
    for (const task of next.values()) { const group = groups.get(task.rootGid) || []; group.push(task); groups.set(task.rootGid, group) }
    for (const group of groups.values()) if (group.every(task => terminal(task.state) && !task.pending && Date.now() - task.createdAt > 24 * 60 * 60 * 1000)) group.forEach(task => next.delete(task.gid))
    if (!next.has(record.gid) && next.size >= this.historyLimit) throw taskError('download_ledger_full', '下载记录已满，请稍后再添加', 429)
    if (record.desired === 'running' && [...next.values()].filter(task => task.gid !== record.gid && task.desired === 'running' && !terminal(task.state)).length >= this.limit) throw taskError('download_task_limit', '运行或等待中的下载过多，请先暂停其他任务', 429)
    next.set(record.gid, record)
  }
  queue(rootGid, action, { priority = 70, context } = {}) {
    this.check(context)
    if (this.pending.size >= 128) return Promise.reject(taskError('download_command_limit', '下载操作过多，请稍后再试', 429))
    const previous = this.queues.get(rootGid) || Promise.resolve(), deadlineAt = Date.now() + 60000
    const work = previous.catch(() => {}).then(() => {
      this.check(context)
      if (Date.now() >= deadlineAt) throw taskError('task_timeout', '下载操作等待超时', 504, true)
      const key = Symbol('download-command')
      return this.scheduler.enqueue({ key, type: 'download-command', resources: { control: 1 }, priority,
        timeoutMs: deadlineAt - Date.now(), signal: this.lifecycle.signal }, context => action(context, work))
        .finally(() => this.scheduler.waitForCancelledKey(key))
    })
    this.queues.set(rootGid, work); this.pending.add(work)
    return work.finally(() => { this.pending.delete(work); for (const [key, value] of this.queues) if (value === work) this.queues.delete(key) })
  }
  call(method, params = [], context) {
    this.check(context)
    if (!this.live) throw taskError('download_engine_stopped', '下载引擎尚未就绪', 503, true)
    return this.rpc(method, params, { signal: this.lifecycle.signal })
  }
  async engineStarted() {
    await this.load(); this.check()
    await this.update(next => { for (const task of next.values()) {
      if (task.desired === 'running' && !terminal(task.state)) {
        task.expired ||= task.deadlineAt > 0 && task.deadlineAt <= Date.now()
        task.desired = 'paused'; task.deadlineAt = 0; task.pending = true; task.generation = crypto.randomUUID()
      }
    } })
    this.live = true; this.arm()
  }
  engineStopped() { this.live = false; this.clearTimers() }
  clearTimers() { for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); clearTimeout(this.pollTimer); this.pollTimer = null }
  watch(task) {
    return task.pending || task.desired === 'running' && !terminal(task.state) ||
      task.kind === 'magnet' && task.state === 'complete' && !task.linksChecked && Date.now() - task.createdAt < 5 * 60 * 1000
  }
  arm() {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    if (!this.live || this.lifecycle.signal.aborted) { clearTimeout(this.pollTimer); this.pollTimer = null; return }
    for (const task of this.entries.values()) if (task.desired === 'running' && task.deadlineAt && !terminal(task.state)) {
      const timer = setTimeout(() => { this.timers.delete(task.gid); void this.expire(task.gid, task.generation).catch(() => this.failClosed()) }, Math.min(0x7fffffff, Math.max(1, task.deadlineAt - Date.now())))
      timer.unref?.(); this.timers.set(task.gid, timer)
    }
    const watching = [...this.entries.values()].some(task => this.watch(task))
    if (!watching) { clearTimeout(this.pollTimer); this.pollTimer = null }
    if (!this.polling && !this.pollTimer && watching) {
      this.pollTimer = setTimeout(() => { this.pollTimer = null; void this.poll().catch(() => {}) }, this.pollMs); this.pollTimer.unref?.()
    }
  }
  async failClosed() { if (this.live && !this.lifecycle.signal.aborted) { this.engineStopped(); await this.stopEngine() } }
  async expire(gid, generation) {
    const root = this.entries.get(gid)?.rootGid || gid
    return this.queue(root, async context => {
      const task = this.entries.get(gid)
      if (!task || task.generation !== generation || task.desired !== 'running' || !task.deadlineAt || task.deadlineAt > Date.now() || terminal(task.state)) return
      await this.update(next => {
        const current = next.get(gid); current.desired = 'paused'; current.expired = true; current.pending = true; current.deadlineAt = 0; current.generation = crypto.randomUUID()
        if (root !== gid) next.get(root).generation = crypto.randomUUID()
      })
      try { await this.enforce(gid, context) } catch { await this.failClosed() }
    }, { priority: 100 })
  }
  async rootFor(gid, seen = new Set()) {
    validGid(gid); await this.load(); this.check()
    if (this.entries.has(gid)) return this.entries.get(gid).rootGid
    if (seen.has(gid) || seen.size >= 8) throw new Error('下载父任务链无效')
    seen.add(gid)
    const status = await this.call('aria2.tellStatus', [gid, ['gid', 'status', 'following']])
    if (status?.gid !== gid) throw taskError('download_status_invalid', '下载状态编号不匹配', 502)
    let root = gid
    if (status.following) {
      validGid(status.following)
      try { root = await this.rootFor(status.following, seen) } catch (error) {
        if (!error.taskNotFound) throw error
        await this.adopt(status.following, status.following); root = status.following
      }
    }
    await this.adopt(gid, root, status.following || '')
    return root
  }
  async submit({ operationId = crypto.randomUUID(), fingerprint, kind, name }, send, context) {
    if (typeof operationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) throw taskError('download_operation_invalid', '下载操作编号无效', 400)
    if (!HASH.test(fingerprint)) throw taskError('download_operation_invalid', '下载来源签名无效', 400)
    const operation = digest(operationId)
    return this.queue('operation:' + operation, async (internal, ownership) => {
      this.check(context); internal.throwIfAborted(); await this.load()
      if (!this.live) throw taskError('download_engine_stopped', '下载引擎尚未就绪', 503, true)
      const existing = [...this.entries.values()].find(task => task.operation === operation)
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw taskError('download_operation_conflict', '同一下载操作不能更换资源或目录', 409)
        return this.acceptance(existing, true)
      }
      let gid; do { gid = crypto.randomBytes(8).toString('hex') } while (/^0+$/.test(gid) || this.entries.has(gid))
      this.queues.set(gid, ownership)
      const record = { ...this.makeRecord(gid, kind), operation, fingerprint, name: String(name || '下载任务').slice(0, 256),
        desired: 'running', state: 'submitting', pending: true, deadlineAt: Date.now() + this.taskMs }
      const checkAdmission = () => { this.check(context); if (context?.signal?.aborted) throw context.signal.reason; internal.throwIfAborted() }
      await this.update(next => { checkAdmission(); this.admit(next, record) }, checkAdmission)
      // The durable intent is the ownership boundary; window cancellation after it cannot abandon an accepted task.
      try {
        const result = await send(gid, internal)
        if (result !== gid) { await this.failClosed(); throw new Error('下载引擎未使用指定任务编号') }
        await this.update(next => { const current = next.get(gid); current.state = 'waiting'; current.pending = false })
      } catch (error) {
        if (error.code === 'aria2_rpc_error') await this.update(next => { const current = next.get(gid); current.state = 'error'; current.desired = 'paused'; current.deadlineAt = 0; current.pending = false })
        // A transport failure may have followed a successful addUri. Never send it again automatically.
      }
      return this.acceptance(this.entries.get(gid))
    }, { context })
  }
  acceptance(task, existing = false) {
    return { gid: task.gid, existing, accepted: !['error', 'missing'].includes(task.state), confirmationPending: task.pending,
      operationState: task.state, rootGid: task.rootGid }
  }
  async adopt(gid, root, parent) {
    if (this.entries.has(gid)) return
    await this.update(next => { if (!next.has(gid)) this.admit(next, this.makeRecord(gid, 'restored', root, parent)) })
  }
  branch(gid) {
    const ids = new Set([gid]); let changed
    do { changed = false; for (const task of this.entries.values()) if (ids.has(task.parentGid) && !ids.has(task.gid)) { ids.add(task.gid); changed = true } } while (changed)
    return ids
  }
  async control(gid, action, indexes, context) {
    if (context?.expectedGeneration !== undefined && (typeof context.expectedGeneration !== 'string' || !context.expectedGeneration.length || context.expectedGeneration.length > 64)) throw taskError('download_generation_invalid', '下载状态版本无效', 400)
    const root = await this.rootFor(gid)
    return this.queue(root, async internal => {
      this.check(context); internal.throwIfAborted(); await this.adopt(gid, root)
      if (context?.expectedGeneration && this.entries.get(gid).generation !== context.expectedGeneration) throw taskError('download_task_conflict', '下载状态已改变，请刷新后重试', 409, true)
      if (action === 'pause' || action === 'remove') {
        await this.discover(gid, internal)
        const branch = this.branch(gid)
        await this.update(next => { for (const task of next.values()) if (branch.has(task.gid)) {
          task.desired = action === 'pause' ? 'paused' : 'removed'; task.deadlineAt = 0; task.pending = true; task.generation = crypto.randomUUID()
        } if (root !== gid) next.get(root).generation = crypto.randomUUID() })
        for (const task of [...this.entries.values()].filter(task => branch.has(task.gid))) await this.enforce(task.gid, internal)
      } else {
        if (!['resume', 'select'].includes(action)) throw new Error('下载控制动作无效')
        const status = await this.discover(gid, internal)
        if (!status || terminal(status.status)) throw new Error('当前任务不能继续，请确认任务记录')
        for (let current = this.entries.get(gid); current; current = this.entries.get(current.parentGid)) if (current.desired === 'removed') throw new Error('任务或父任务已移除，不能继续旧子任务')
        if (action === 'select') {
          const valid = new Set((status.files || []).map(file => Number(file.index)))
          if (!Array.isArray(indexes) || !indexes.length || indexes.some(index => !Number.isInteger(index) || index < 1 || !valid.has(index))) throw new Error('请选择当前任务中的有效文件')
          await this.call('aria2.changeOption', [gid, { 'select-file': [...new Set(indexes)].sort((a, b) => a - b).join(',') }], internal)
        }
        await this.update(next => {
          const task = next.get(gid); this.admit(next, { ...task, desired: 'running', state: 'waiting', pending: true, expired: false,
            deadlineAt: Date.now() + this.taskMs, generation: crypto.randomUUID() })
          if (root !== gid) next.get(root).generation = crypto.randomUUID()
        })
        try {
          if (status.status === 'paused') await this.call('aria2.unpause', [gid], internal)
          await this.update(next => { next.get(gid).pending = false })
        }
        catch (error) {
          if (error.code === 'aria2_rpc_error') await this.update(next => { const task = next.get(gid); task.desired = 'paused'; task.state = 'error'; task.deadlineAt = 0; task.pending = false })
        }
      }
      await this.call('aria2.saveSession', [], internal).catch(() => {})
      return this.acceptance(this.entries.get(gid))
    }, { context })
  }
  async discover(gid, context) {
    let status
    try { status = await this.call('aria2.tellStatus', [gid], context) } catch (error) {
      if (error.code !== 'aria2_rpc_error' || !error.taskNotFound) throw error
      await this.update(next => { const task = next.get(gid); if (task) { task.state = task.desired === 'removed' ? 'removed' : 'missing'; task.pending = false; task.deadlineAt = 0 } })
      return null
    }
    if (!status || status.gid !== gid || !['active', 'waiting', 'paused', 'complete', 'error', 'removed'].includes(status.status)) throw taskError('download_status_invalid', '下载状态响应无效', 502)
    const links = status.followedBy || []
    if (!Array.isArray(links) || links.length > 128 || links.some(child => !GID.test(child) || child === gid)) throw taskError('download_status_invalid', '下载子任务响应无效', 502)
    const root = this.entries.get(gid)?.rootGid || gid
    const previous = this.entries.get(gid)
    if (previous && previous.state === status.status &&
      !(terminal(status.status) && (previous.deadlineAt || previous.desired === 'running')) &&
      !(previous.desired === 'running' && status.status === 'paused') &&
      !(previous.desired === 'running' && previous.pending && ['active', 'waiting'].includes(status.status)) &&
      (!links.length || previous.linksChecked) && links.every(child => this.entries.get(child)?.rootGid === root && this.entries.get(child)?.parentGid === gid)) return status
    try {
      await this.update(next => {
        const task = next.get(gid); if (!task) return
        task.state = status.status
        if (task.desired === 'running' && status.status === 'paused') { task.desired = 'paused'; task.deadlineAt = 0; task.pending = false }
        if (terminal(status.status)) { task.deadlineAt = 0; if (task.desired === 'running') task.desired = 'paused' }
        if (task.desired === 'running' && ['active', 'waiting'].includes(status.status)) task.pending = false
        if (links.length) task.linksChecked = true
        for (const child of links) {
          const previous = next.get(child)
          if (previous && (previous.rootGid !== root || previous.parentGid !== gid)) throw taskError('download_child_conflict', '下载子任务归属不匹配', 409)
          if (!previous) this.admit(next, { ...this.makeRecord(child, 'restored', root, gid), desired: task.desired === 'removed' ? 'removed' : 'paused', pending: true })
        }
      })
    } catch (error) { if (links.length) await this.failClosed(); throw error }
    return status
  }
  async enforce(gid, context) {
    const status = await this.discover(gid, context), task = this.entries.get(gid)
    if (!task || !task.pending || !status) return
    if (task.desired === 'running') return // An ambiguous add/unpause is observed, never repeated.
    try {
      if (task.desired === 'removed') {
        if (!terminal(status.status)) {
          await this.call('aria2.forceRemove', [gid], context)
          const current = await this.discover(gid, context)
          if (!current || !terminal(current.status)) return
        }
        await this.call('aria2.removeDownloadResult', [gid], context)
      } else if (['active', 'waiting'].includes(status.status)) await this.call('aria2.forcePause', [gid], context)
      await this.update(next => { const current = next.get(gid); current.pending = false; current.state = task.desired === 'removed' ? 'removed' : terminal(status.status) ? status.status : 'paused' })
    } catch (error) { if (task.expired) await this.failClosed(); throw error }
  }
  async poll() {
    if (this.polling || !this.live || this.lifecycle.signal.aborted) return this.polling
    clearTimeout(this.pollTimer); this.pollTimer = null
    const groups = [...new Set([...this.entries.values()].filter(task => this.watch(task)).map(task => task.rootGid))]
    let next = 0
    this.polling = Promise.allSettled(Array.from({ length: Math.min(4, groups.length) }, async () => {
      while (next < groups.length && this.live && !this.lifecycle.signal.aborted) {
        const root = groups[next++]
        await this.queue(root, async context => {
          for (const task of [...this.entries.values()].filter(task => task.rootGid === root && this.watch(task))) {
            await this.enforce(task.gid, context)
          }
        }, { priority: 30 }).catch(() => {})
      }
    })).finally(() => { this.polling = null; this.arm() })
    return this.polling
  }
  decorate(tasks = []) {
    const rows = new Map(tasks.map(task => [task.gid, task]))
    for (const task of this.entries.values()) {
      if (task.desired === 'removed' && !task.pending) { rows.delete(task.gid); continue }
      const original = rows.get(task.gid), missing = task.state === 'missing'
      const offline = !this.live && task.desired !== 'removed' && !terminal(task.state)
      const message = offline ? '下载引擎未运行，请明确点击继续；不会自动重复提交' : task.expired ? '运行时限已到，已请求暂停；点击继续会开始新的运行时限' : missing
        ? '当前引擎没有此任务；未重复提交，可移除记录后明确重新添加' : task.pending ? '操作已记录，正在核对引擎结果，请勿重复添加' : ''
      rows.set(task.gid, { ...(original || { gid: task.gid, name: task.name, files: [], dir: '', totalLength: 0, completedLength: 0 }),
        status: missing ? 'error' : terminal(task.state) ? task.state : task.expired || offline ? 'paused' : task.pending ? original?.status || 'waiting'
          : terminal(original?.status) ? original.status : task.state === 'waiting' && original?.status === 'active' ? 'active' : task.state,
        ownership: 'computer', rootGid: task.rootGid, taskGeneration: task.generation, deadlineAt: task.deadlineAt,
        confirmationPending: task.pending, expired: task.expired, message,
        ...(missing ? { errorMessage: message } : {}),
        controls: { pause: this.live && !task.pending && task.desired === 'running', resume: (offline || !task.pending && task.desired === 'paused') && !missing && !terminal(task.state),
          remove: true, selectFiles: !task.pending && !missing && task.desired !== 'removed' } })
    }
    return [...rows.values()]
  }
  async dispose() {
    this.lifecycle.abort(taskError('download_stopping', '下载任务服务正在关闭')); this.engineStopped()
    await Promise.allSettled([...this.pending]); await this.polling; await this.writes.catch(() => {})
  }
}
module.exports = { DownloadTasks, validGid, digest }
