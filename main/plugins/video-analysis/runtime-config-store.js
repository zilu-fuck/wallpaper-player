const fsp = require('fs/promises')
const path = require('path')
const crypto = require('crypto')

const failure = (code, message, status = 409) => Object.assign(new Error(message), { code, status })

class RuntimeConfigStore {
  constructor({ filename, legacyFilename, maxBytes = 1024 * 1024, maxPending = 64 }) {
    this.filename = filename; this.legacyFilename = legacyFilename; this.maxBytes = maxBytes; this.maxPending = maxPending
    this.tail = Promise.resolve(); this.pending = 0; this.closing = false; this.recovery = null
  }
  enqueue(action) {
    if (this.closing) return Promise.reject(failure('runtime_config_stopping', '配置服务正在关闭'))
    if (this.pending >= this.maxPending) return Promise.reject(failure('runtime_config_busy', '配置请求过多，请稍后重试', 429))
    this.pending++
    const work = this.tail.then(async () => {
      if (this.recovery) throw failure('runtime_config_recovery_required', '配置回滚未完成，已保留恢复文件，请先检查配置目录')
      return action()
    }).finally(() => this.pending--)
    this.tail = work.catch(() => {})
    return work
  }
  async readText(filename) {
    let handle
    try {
      handle = await fsp.open(filename, 'r')
      const stat = await handle.stat()
      if (!stat.isFile()) throw failure('runtime_config_invalid', '分析配置不是普通文件')
      if (stat.size > this.maxBytes) throw failure('runtime_config_too_large', '分析配置超过大小限制')
      const chunks = []; let size = 0
      while (size <= this.maxBytes) {
        const buffer = Buffer.alloc(Math.min(16384, this.maxBytes + 1 - size))
        const result = await handle.read(buffer, 0, buffer.length, null)
        if (!result.bytesRead) break
        chunks.push(buffer.subarray(0, result.bytesRead))
        size += result.bytesRead
      }
      if (size > this.maxBytes) throw failure('runtime_config_too_large', '分析配置超过大小限制')
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))
    } catch (error) { if (error.code === 'ENOENT') return null; throw error }
    finally { await handle?.close() }
  }
  async stage(text, kind = 'write') {
    if (Buffer.byteLength(text, 'utf8') > this.maxBytes) throw failure('runtime_config_too_large', '分析配置超过大小限制')
    const directory = path.dirname(this.filename())
    await fsp.mkdir(directory, { recursive: true })
    const filename = path.join(directory, '.runtime-env-' + kind + '-' + crypto.randomUUID() + '.tmp')
    let handle
    try {
      handle = await fsp.open(filename, 'wx', 0o600)
      await handle.writeFile(text, 'utf8'); await handle.sync(); await handle.close(); handle = null
      return filename
    } catch (error) {
      await handle?.close().catch(() => {})
      await fsp.unlink(filename).catch(() => {})
      throw error
    }
  }
  async publish(candidate, previous) {
    for (let attempt = 0; ; attempt++) {
      if (await this.readText(this.filename()) !== previous) throw failure('runtime_config_conflict', '配置文件已被其他程序修改，请重新读取后保存')
      try { await fsp.rename(candidate, this.filename()); return }
      catch (error) {
        // Windows readers/scanners can briefly deny rename. Keep the old file intact.
        if (!['EPERM', 'EBUSY'].includes(error.code) || attempt >= 6) throw error
        await new Promise(resolve => setTimeout(resolve, Math.min(10 * 2 ** attempt, 160)))
      }
    }
  }
  async readCurrent() {
    const current = await this.readText(this.filename())
    if (current !== null) return current
    const legacy = this.legacyFilename?.()
    if (!legacy || path.resolve(legacy) === path.resolve(this.filename())) return null
    const text = await this.readText(legacy)
    if (text === null) return null
    // Migration keeps the legacy copy and publishes a complete new file once.
    const temporary = await this.stage(text, 'migration')
    try { await this.publish(temporary, null) }
    finally { await fsp.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
    return text
  }
  read(decode) { return this.enqueue(async () => decode(await this.readCurrent())) }
  materialize(defaultText) {
    return this.enqueue(async () => {
      if (await this.readCurrent() === null) {
        const candidate = await this.stage(defaultText())
        try { await this.publish(candidate, null) }
        finally { await fsp.unlink(candidate).catch(error => { if (error.code !== 'ENOENT') throw error }) }
      }
      return this.filename()
    })
  }
  update(prepare, commitMetadata) {
    return this.enqueue(async () => {
      const previous = await this.readCurrent(), mutation = prepare(previous)
      if (!mutation || typeof mutation.then === 'function' || typeof mutation.text !== 'string') throw new TypeError('Runtime configuration mutation must be synchronous')
      const changed = mutation.text !== previous
      let candidate, backup, published = false, committed = false
      try {
        if (changed) {
          candidate = await this.stage(mutation.text)
          if (previous !== null) backup = await this.stage(previous, 'rollback')
          await this.publish(candidate, previous); candidate = null; published = true
        }
        await commitMetadata?.(mutation)
        committed = true
        return mutation.value
      } catch (error) {
        if (published && !committed) {
          try {
            if (await this.readText(this.filename()) !== mutation.text) throw failure('runtime_config_conflict', '配置文件已被其他程序修改，未覆盖该文件')
            if (backup) { await this.publish(backup, mutation.text); backup = null }
            else await fsp.unlink(this.filename())
          } catch (rollbackError) {
            this.recovery = { backup, error: rollbackError }
            const combined = new AggregateError([error, rollbackError], '保存失败且配置回滚未完成，恢复文件已保留')
            combined.code = 'runtime_config_rollback_failed'; combined.recoveryPath = backup || null
            throw combined
          }
        }
        throw error
      } finally {
        if (candidate) await fsp.unlink(candidate).catch(error => { if (error.code !== 'ENOENT') throw error })
        if (backup && !this.recovery) await fsp.unlink(backup).catch(error => { if (error.code !== 'ENOENT') throw error })
      }
    })
  }
  async close() { this.closing = true; await this.tail }
  resume() { this.closing = false }
}

module.exports = { RuntimeConfigStore }
