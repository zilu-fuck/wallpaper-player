const path = require('path'), fsp = require('fs/promises'), crypto = require('crypto')
const { mediaScheduler, taskError } = require('./resource-scheduler')
const { downloadArtifact, publishArtifact } = require('./download-service')
const { execFileTreeAsync } = require('../exec')
const { MpvVersionCache } = require('./mpv-version-cache')

const DOWNLOAD_URLS = [
  'https://github.com/mpv-player/mpv/releases/download/v0.41.0/mpv-v0.41.0-x86_64-pc-windows-msvc.zip',
  'https://github.com/mpv-player/mpv/releases/download/v0.40.0/mpv-v0.40.0-x86_64-pc-windows-msvc.zip'
]
const VERSION_DIRECTORY = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const isWithin = (root, target) => { const relative = path.relative(root, target); return relative && !relative.startsWith('..') && !path.isAbsolute(relative) }
async function removeOwned(root, target) {
  if (!isWithin(path.resolve(root), path.resolve(target))) throw new Error('安装清理路径无效')
  let resolved
  try { resolved = await fsp.realpath(target) } catch (error) { if (error.code === 'ENOENT') return; throw error }
  const canonicalRoot = await fsp.realpath(root)
  if (path.relative(root, canonicalRoot) !== '' || path.relative(target, resolved) !== '' || !isWithin(canonicalRoot, resolved)) throw new Error('安装清理真实路径已改变')
  await fsp.rm(resolved, { recursive: true, force: true })
}

class MpvInstaller {
  constructor({ directory, scheduler = mediaScheduler, download = downloadArtifact, execute = execFileTreeAsync,
    urls = DOWNLOAD_URLS, timeoutMs = 15 * 60 * 1000, extractTimeoutMs = 120000, configuredPaths,
    maxVersions = 3, maxBytes = 2 * 1024 * 1024 * 1024 } = {}) {
    this.directory = directory; this.scheduler = scheduler; this.download = download; this.execute = execute
    this.urls = urls; this.timeoutMs = timeoutMs; this.extractTimeoutMs = extractTimeoutMs
    this.key = Symbol('mpv-install'); this.controller = new AbortController(); this.listeners = new Set()
    this.cleanupKey = Symbol('mpv-cache'); this.maintenance = null
    this.versionCache = new MpvVersionCache({ directory, configuredPaths, maxVersions, maxBytes })
  }
  root() { return path.resolve(typeof this.directory === 'function' ? this.directory() : this.directory) }
  async resolveInstalled(options = {}) {
    return this.versionCache.serialize(options, store => this.readInstalled(options, store.root))
  }
  async readInstalled(options = {}, directory = this.root()) {
    const check = () => { options.throwIfAborted?.(); if (options.signal?.aborted) throw options.signal.reason }
    check()
    try {
      const root = directory, pointer = path.join(root, 'installed.json')
      const stat = await fsp.stat(pointer); check()
      if (!stat.isFile() || stat.size > 16384) return null
      const manifest = JSON.parse(await fsp.readFile(pointer, 'utf8')); check()
      if (manifest.version !== 1 || !VERSION_DIRECTORY.test(manifest.installation)) return null
      const versionRoot = path.join(root, 'versions', manifest.installation), executable = path.join(versionRoot, 'mpv.exe')
      const [canonicalVersions, canonicalRoot, canonicalExe, info] = await Promise.all([
        fsp.realpath(path.join(root, 'versions')), fsp.realpath(versionRoot), fsp.realpath(executable), fsp.stat(executable)])
      check()
      if (!isWithin(canonicalVersions, canonicalRoot) || !isWithin(canonicalRoot, canonicalExe) || !info.isFile()) return null
      return executable
    } catch (error) { check(); return null }
  }
  retainExecutable(executable, context) { return this.versionCache.retain(executable, context) }
  async cleanup(options = {}) {
    const signal = options.signal ? AbortSignal.any([options.signal, this.controller.signal]) : this.controller.signal
    try {
      return await this.scheduler.enqueue({ key: this.cleanupKey, type: 'mpv-cache', resources: { prepare: 1 }, background: true,
        priority: 0, timeoutMs: 30000, signal }, context => this.versionCache.collect(context))
    } finally { await this.scheduler.waitForCancelledKey(this.cleanupKey) }
  }
  scheduleCleanup() {
    if (this.controller.signal.aborted || !(typeof this.directory === 'function' ? this.directory() : this.directory)) return
    if (!this.maintenance) this.maintenance = this.cleanup().catch(() => null).finally(() => { this.maintenance = null })
  }
  async install(onProgress, options = {}) {
    if (this.controller.signal.aborted) throw taskError('task_stopping', '播放器安装服务正在关闭')
    if (this.listeners.size >= 128) throw taskError('task_interest_limit', '安装请求过多', 429, true)
    const signal = options.signal ? AbortSignal.any([options.signal, this.controller.signal]) : this.controller.signal
    const listener = progress => { if (!signal.aborted) { try { onProgress?.(progress) } catch {} } }
    this.listeners.add(listener)
    try {
      const deadlineAt = Date.now() + this.timeoutMs
      while (true) {
        if (signal.aborted) throw signal.reason
        if (Date.now() >= deadlineAt) throw taskError('task_timeout', '播放器安装超过最长等待时间', 504, true)
        try {
          return await this.scheduler.enqueue({ key: this.key, type: 'mpv-install', resources: { installer: 1 },
            priority: 20, timeoutMs: deadlineAt - Date.now(), signal }, context => this.run(context))
        } catch (error) {
          if (error.code !== 'task_cancelling') throw error
          await this.scheduler.waitForKey(this.key, { signal, deadlineAt })
        }
      }
    } finally { this.listeners.delete(listener); await this.scheduler.waitForCancelledKey(this.key) }
  }
  progress(value) { for (const listener of this.listeners) listener(value) }
  async run(context) {
    const check = context.throwIfAborted, root = (await this.versionCache.store()).root, installation = crypto.randomUUID()
    const temporary = path.join(root, '.install-' + installation), extraction = path.join(temporary, 'unpacked')
    const archive = path.join(temporary, 'mpv.zip'), versionRoot = path.join(root, 'versions', installation)
    const executable = path.join(versionRoot, 'mpv.exe'), pointer = path.join(root, 'installed.json')
    let moved = false, committed = false
    const remaining = maximum => { check(); return Math.max(1, Math.min(maximum, context.deadlineAt - Date.now())) }
    const progress = value => { check(); this.progress(value) }
    try {
      check(); await fsp.mkdir(extraction, { recursive: true }); check()
      let downloaded = false, downloadError
      for (const url of this.urls) {
        check()
        const downloadKey = Symbol('mpv-archive')
        try {
          await this.download(url, archive, { scheduler: this.scheduler, key: downloadKey, type: 'mpv-archive', signal: context.signal, timeoutMs: remaining(this.timeoutMs), maxBytes: 256 * 1024 * 1024,
            onProgress: ({ transferred, total }) => progress({ stage: 'download', downloaded: transferred, total,
              percent: total ? Math.min(99, Math.round(transferred / total * 100)) : 0 }) })
          check(); downloaded = true; break
        } catch (error) { check(); downloadError = error }
        finally { await this.scheduler.waitForCancelledKey(downloadKey) }
      }
      if (!downloaded) throw downloadError || new Error('mpv 下载失败')
      progress({ stage: 'extract', percent: 99 })
      const script = await fsp.readFile(path.join(__dirname, 'extract-mpv.ps1')); check()
      const scriptPath = path.join(temporary, 'extract-mpv.ps1')
      await fsp.writeFile(scriptPath, script, { flag: 'wx' }); check()
      const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      await this.execute(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
        signal: context.signal, timeout: remaining(this.extractTimeoutMs), maxBuffer: 128 * 1024,
        env: { ...process.env, WALLPAPER_MPV_ARCHIVE: archive, WALLPAPER_MPV_EXTRACT: extraction }
      })
      check()
      const found = await this.findExecutable(extraction, check)
      if (!found) throw new Error('解压后未找到唯一的 mpv.exe，请在设置中手动指定路径')
      const { stdout } = await this.execute(found, ['--version'], { signal: context.signal, timeout: remaining(5000), maxBuffer: 128 * 1024 })
      check()
      if (!/^mpv\s+\d+\./m.test(stdout)) throw new Error('下载文件未通过 mpv 版本检查')
      const incomingBytes = await this.versionCache.measure(path.dirname(found), context)
      await this.versionCache.serialize(context, async store => {
        const capacity = await this.versionCache.collect(context, { count: 1, bytes: incomingBytes }, store)
        if (capacity.overBudget) throw taskError('mpv_cache_busy', '播放器版本仍被使用或缓存无法回收，请停止旧播放器或检查安装目录后重试', 409, true)
        try {
          await fsp.mkdir(path.dirname(versionRoot), { recursive: true }); check()
          await fsp.rename(path.dirname(found), versionRoot); moved = true; check()
          const manifest = path.join(temporary, 'installed.json')
          await fsp.writeFile(manifest, JSON.stringify({ version: 1, installation }), { flag: 'wx' }); check()
          await publishArtifact(manifest, pointer, check, () => { committed = true })
        } catch (error) {
          if (moved && !committed) {
            const retired = path.join(path.dirname(versionRoot), '.trash-' + installation + '-' + crypto.randomUUID())
            await fsp.rename(versionRoot, retired); moved = false
            await removeOwned(path.dirname(versionRoot), retired)
          }
          throw error
        }
      })
      this.progress({ stage: 'ready', percent: 100 })
      return executable
    } finally {
      await removeOwned(root, temporary)
    }
  }
  async findExecutable(root, check) {
    const queue = [{ directory: root, depth: 0 }], matches = []
    let count = 0
    while (queue.length) {
      check(); const { directory, depth } = queue.shift()
      for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
        check(); if (++count > 8192) throw new Error('安装文件数量超过上限')
        if (entry.isSymbolicLink()) throw new Error('安装文件包含符号链接')
        const target = path.join(directory, entry.name)
        if (entry.isFile() && entry.name.toLowerCase() === 'mpv.exe') matches.push(target)
        else if (entry.isDirectory() && depth < 3) queue.push({ directory: target, depth: depth + 1 })
      }
    }
    return matches.length === 1 ? matches[0] : null
  }
  async dispose() {
    this.controller.abort(taskError('task_stopping', '播放器安装服务正在关闭'))
    await Promise.all([this.scheduler.waitForCancelledKey(this.key), this.scheduler.waitForCancelledKey(this.cleanupKey), this.maintenance])
  }
}
module.exports = { MpvInstaller }
