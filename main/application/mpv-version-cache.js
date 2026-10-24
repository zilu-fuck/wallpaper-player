const path = require('path'), fsp = require('fs/promises'), crypto = require('crypto')
const { taskError } = require('./resource-scheduler')
const VERSION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const TRASH = /^\.trash-([0-9a-f-]{36})-[0-9a-f-]{36}$/
const stores = new Map()
const check = context => { context?.throwIfAborted?.(); if (context?.signal?.aborted) throw context.signal.reason }
const inside = (root, target) => { const relative = path.relative(root, target); return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
async function canonicalDirectory(directory) {
  const suffix = []; let current = path.resolve(directory)
  while (true) {
    try { return path.join(await fsp.realpath(current), ...suffix.reverse()) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const parent = path.dirname(current); if (parent === current) throw error
      suffix.push(path.basename(current)); current = parent
    }
  }
}
function locked(store, context, action) {
  return new Promise((resolve, reject) => {
    let started = false
    const abort = () => { if (!started) { context.signal.removeEventListener('abort', abort); reject(context.signal.reason) } }
    const work = store.tail.catch(() => {}).then(async () => {
      context?.signal?.removeEventListener('abort', abort); check(context); started = true
      return action()
    })
    store.tail = work.catch(() => {})
    context?.signal?.addEventListener('abort', abort, { once: true }); if (context?.signal?.aborted) abort()
    work.then(resolve, reject)
  })
}
class MpvVersionCache {
  constructor({ directory, configuredPaths = () => [], maxVersions = 3, maxBytes = 2 * 1024 * 1024 * 1024, entryLimit = 32768 } = {}) {
    this.directory = directory; this.configuredPaths = configuredPaths; this.maxVersions = maxVersions; this.maxBytes = maxBytes; this.entryLimit = entryLimit
    this.lastResult = null
  }
  async store() {
    const value = typeof this.directory === 'function' ? this.directory() : this.directory
    if (!value) return null
    const root = await canonicalDirectory(value), key = process.platform === 'win32' ? root.toLowerCase() : root
    if (!stores.has(key)) stores.set(key, { root, tail: Promise.resolve(), pins: new Map(), allPins: 0 })
    return stores.get(key)
  }
  versionFor(store, executable) {
    if (!path.isAbsolute(executable)) return '*'
    const relative = path.relative(path.join(store.root, 'versions'), executable), parts = relative.split(path.sep)
    return parts.length >= 2 && VERSION.test(parts[0]) && inside(path.join(store.root, 'versions'), executable) ? parts[0] : null
  }
  lease(store, executable, version, released = false) {
    const retain = () => {
      if (version === '*') store.allPins++
      else if (version) store.pins.set(version, (store.pins.get(version) || 0) + 1)
    }
    if (store) retain()
    return { executable, version,
      fork: () => { if (released) throw new Error('播放器版本引用已释放'); return this.lease(store, executable, version) },
      release: () => {
        if (released) return; released = true
        if (store && version === '*') store.allPins--
        else if (store && version) { const count = (store.pins.get(version) || 1) - 1; if (count) store.pins.set(version, count); else store.pins.delete(version) }
      }
    }
  }
  async retain(executable, context = {}) {
    check(context)
    const store = await this.store(); check(context)
    if (!store) return this.lease(null, executable, null)
    return locked(store, context, async () => {
      check(context)
      if (!path.isAbsolute(executable)) return this.lease(store, executable, '*')
      const canonical = await fsp.realpath(executable); check(context)
      const relative = path.relative(store.root, canonical).split(path.sep)
      if (inside(store.root, canonical) && (relative[0].startsWith('.install-') || relative[0] === 'versions' && relative[1]?.startsWith('.trash-'))) {
        throw taskError('mpv_version_unavailable', '该播放器版本尚未发布或已回收，请重新选择', 409, true)
      }
      const stat = await fsp.stat(canonical); check(context)
      if (!stat.isFile()) throw new Error('播放器路径不是文件')
      return this.lease(store, canonical, this.versionFor(store, canonical))
    })
  }
  async serialize(context, action) {
    const store = await this.store(); check(context)
    if (!store) throw new Error('播放器安装目录不可用')
    return locked(store, context, () => action(store))
  }
  async measure(directory, context, budget = { count: 0 }) {
    const queue = [directory]; let bytes = 0
    while (queue.length) {
      check(context); const current = queue.shift()
      const stat = await fsp.lstat(current); check(context)
      if (stat.isSymbolicLink()) throw new Error('版本目录包含链接，保留该目录')
      if (++budget.count > this.entryLimit) throw new Error('版本目录条目过多')
      if (stat.isDirectory()) {
        const entries = await fsp.readdir(current); check(context)
        if (queue.length + entries.length + budget.count > this.entryLimit) throw new Error('版本目录条目过多')
        for (const entry of entries) queue.push(path.join(current, entry))
      } else if (stat.isFile()) bytes += stat.size
      else throw new Error('版本目录包含非普通文件')
    }
    return bytes
  }
  async configured(store, context) {
    const raw = await this.configuredPaths(), result = new Set()
    if (!Array.isArray(raw) || raw.length > 32) throw new Error('播放器路径配置无法确认')
    for (const value of raw.filter(Boolean)) {
      check(context)
      const canonical = path.isAbsolute(value) ? await fsp.realpath(value).catch(() => path.resolve(value)) : value
      const id = this.versionFor(store, canonical); if (id) result.add(id)
    }
    check(context); return result
  }
  async collect(context = {}, reserve = { count: 0, bytes: 0 }, suppliedStore) {
    if (!suppliedStore) return this.serialize(context, store => this.collect(context, reserve, store))
    const store = suppliedStore, versions = path.join(store.root, 'versions'), budget = { count: 0 }
    let entries
    try { entries = await fsp.readdir(versions, { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') entries = []; else throw error }
    const files = [], blocked = [], removed = []
    if (entries.length > 512) throw taskError('mpv_cache_limit', '播放器缓存目录过多，请先检查安装目录', 409)
    for (const entry of entries) {
      check(context)
      const trash = entry.name.match(TRASH)
      if (!VERSION.test(entry.name) && !trash) continue
      const target = path.join(versions, entry.name)
      try {
        const stat = await fsp.lstat(target), canonical = await fsp.realpath(target)
        if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(store.root, canonical) || path.relative(target, canonical) !== '') throw new Error('版本目录不是独立目录')
        const bytes = await this.measure(target, context, budget)
        files.push({ id: trash ? trash[1] : entry.name, name: entry.name, target, trash: Boolean(trash), bytes, mtime: stat.mtimeMs, dev: stat.dev, ino: stat.ino })
      } catch (error) { check(context); blocked.push(entry.name) }
    }
    let current
    try {
      const pointer = path.join(store.root, 'installed.json'), stat = await fsp.stat(pointer)
      if (stat.size > 16384) throw new Error('安装索引过大')
      const manifest = JSON.parse(await fsp.readFile(pointer, 'utf8'))
      if (manifest.version === 1 && VERSION.test(manifest.installation)) current = manifest.installation
    } catch (error) { check(context) }
    if (!files.some(file => !file.trash && file.id === current)) {
      current = files.filter(file => !file.trash).sort((a, b) => b.mtime - a.mtime)[0]?.id
    }
    let count = files.length, bytes = files.reduce((sum, file) => sum + file.bytes, 0)
    const over = () => count + blocked.length + reserve.count > this.maxVersions || bytes + reserve.bytes > this.maxBytes || blocked.length > 0
    files.sort((a, b) => Number(b.trash) - Number(a.trash) || a.mtime - b.mtime || a.id.localeCompare(b.id))
    for (const file of files) {
      check(context)
      if (!file.trash && !over()) break
      const configured = await this.configured(store, context)
      if (store.allPins || store.pins.has(file.id) || configured.has('*') || configured.has(file.id) || file.id === current) continue
      let target = file.target, quarantined = file.trash, deleting = false
      try {
        const stat = await fsp.lstat(target), canonical = await fsp.realpath(target); check(context)
        if (stat.isSymbolicLink() || stat.dev !== file.dev || stat.ino !== file.ino || path.relative(target, canonical) !== '' || !inside(versions, canonical)) throw new Error('版本目录已改变')
        if (!quarantined) {
          target = path.join(versions, '.trash-' + file.id + '-' + crypto.randomUUID())
          await fsp.rename(file.target, target); quarantined = true
        }
        check(context)
        const confirmed = await fsp.realpath(target); check(context)
        if (path.relative(target, confirmed) !== '' || !inside(versions, confirmed)) throw new Error('版本清理路径已改变')
        // The complete directory is retired before deletion; partial deletion is never restored as an executable version.
        deleting = true
        await fsp.rm(target, { recursive: true, force: true })
        count--; bytes -= file.bytes; removed.push(file.id)
      } catch (error) {
        if (quarantined && !deleting && !file.trash) await fsp.rename(target, file.target)
        check(context); blocked.push(file.name)
      }
    }
    const result = { versions: count + blocked.filter(name => !files.some(file => file.name === name)).length, bytes,
      removed, blocked, protectedVersions: [...store.pins.keys()], protectedUnknown: store.allPins > 0,
      overBudget: over(), maxVersions: this.maxVersions, maxBytes: this.maxBytes }
    this.lastResult = result
    return result
  }
}
module.exports = { MpvVersionCache }
