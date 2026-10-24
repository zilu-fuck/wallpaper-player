const crypto = require('crypto')
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const { spawn } = require('child_process')
const { app } = require('electron')
const { execFileAsync } = require('../exec')
const { getUserDataDir } = require('../user-data')
const { findFfmpeg } = require('../thumbnail')
const { getResourcePath } = require('../paths')
const { mediaScheduler } = require('../application/resource-scheduler')
const { stopProcessTree, workerSpawnSpec } = require('../process-lifecycle')
const transcodeCache = require('./transcode-cache')

const tasks = new Map()
const activeExecutions = new Set()
const taskStartPromises = new Map()
const MAX_RUNNING_TRANSCODES = 1
const MAX_TASK_HISTORY = 256
const TRANSCODE_CACHE_MAX_FILES = 60
const TRANSCODE_CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
const TRANSCODE_CACHE_MAX_BYTES = 8 * 1024 * 1024 * 1024
const TRANSCODE_DEADLINE_MS = 2 * 60 * 60 * 1000
let cacheCleanupQueue = Promise.resolve()
let shuttingDown = false
let runningTranscodeSlots = 0
let drainPromise = null, drainTimer = null, drainAgain = false
const QUALITY_PRESETS = {
  compatible: { label: 'compatible', landscapeWidth: 1920, landscapeHeight: 1080, portraitWidth: 1080, portraitHeight: 1920, crf: '23' },
  '1080p': { label: '1080p', landscapeWidth: 1920, landscapeHeight: 1080, portraitWidth: 1080, portraitHeight: 1920, crf: '23' },
  '720p': { label: '720p', landscapeWidth: 1280, landscapeHeight: 720, portraitWidth: 720, portraitHeight: 1280, crf: '24' },
  '480p': { label: '480p', landscapeWidth: 854, landscapeHeight: 480, portraitWidth: 480, portraitHeight: 854, crf: '26' }
}

function getTranscodeDir() {
  const dir = path.join(getUserDataDir(), 'remote-transcodes')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function getCacheKey(videoPath) {
  return crypto.createHash('sha256').update(path.resolve(videoPath)).digest('hex')
}

function normalizeQuality(quality) {
  const value = String(quality || '').trim().toLowerCase()
  return QUALITY_PRESETS[value] ? value : 'compatible'
}

function getTaskKey(videoId, quality) {
  return `${videoId}::${normalizeQuality(quality)}`
}

function getOutputPath(videoPath, quality) {
  const normalizedQuality = normalizeQuality(quality)
  return path.join(getTranscodeDir(), `${getCacheKey(videoPath)}.${normalizedQuality}.mobile.mp4`)
}

function buildScaleFilter(quality) {
  const preset = QUALITY_PRESETS[normalizeQuality(quality)]
  return [
    'scale=',
    `trunc(if(gte(iw\\,ih)\\,min(iw\\,${preset.landscapeWidth})\\,min(iw\\,${preset.portraitWidth}))/2)*2`,
    ':',
    `trunc(if(gte(iw\\,ih)\\,min(ih\\,${preset.landscapeHeight})\\,min(ih\\,${preset.portraitHeight}))/2)*2`,
    ':force_original_aspect_ratio=decrease'
  ].join('')
}

async function findFfprobe(options = {}) {
  if (process.env.WALLPAPER_PLAYER_FFPROBE_PATH) return process.env.WALLPAPER_PLAYER_FFPROBE_PATH
  const candidates = [
    getResourcePath('vendor', 'ffmpeg', 'bin', 'ffprobe.exe'),
    getResourcePath('vendor', 'ffmpeg', 'ffprobe.exe'),
    'ffprobe',
    'ffprobe.exe',
    app?.getAppPath ? path.join(app.getAppPath(), 'ffprobe.exe') : '',
    'C:\\ffmpeg\\bin\\ffprobe.exe',
    'C:\\Program Files\\ffmpeg\\bin\\ffprobe.exe'
  ]

  for (const candidate of candidates) {
    if (options.signal?.aborted) throw options.signal.reason
    try {
      await execFileAsync(candidate, ['-version'], { timeout: 5000, signal: options.signal })
      return candidate
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason || error
      continue
    }
  }
  return null
}

function parseDurationSeconds(output) {
  const duration = Number(output)
  return Number.isFinite(duration) && duration > 0 ? duration : 0
}

async function probeTranscodeMedia(videoPath, options) {
  const ffprobe = await findFfprobe(options)
  if (!ffprobe) return { duration: 0, streams: [] }
  await options.authorize?.()
  options.throwIfAborted?.()
  try {
    const { stdout } = await execFileAsync(ffprobe, ['-v', 'error', '-show_entries',
      'format=duration:stream=codec_type,codec_name,pix_fmt,width,height', '-of', 'json', videoPath], {
        timeout: Math.max(1, Math.min(10000, options.deadlineAt - Date.now())), signal: options.signal })
    const media = JSON.parse(String(stdout))
    return { duration: parseDurationSeconds(media?.format?.duration || media), streams: Array.isArray(media?.streams) ? media.streams : [] }
  } catch (error) { if (options.signal?.aborted) throw options.signal.reason || error; return { duration: 0, streams: [] } }
}

function selectTranscodeOperation(media, quality) {
  const video = media.streams.find(stream => stream.codec_type === 'video')
  const audio = media.streams.find(stream => stream.codec_type === 'audio')
  const preset = QUALITY_PRESETS.compatible
  const width = Number(video?.width), height = Number(video?.height)
  const fits = width >= height ? width <= preset.landscapeWidth && height <= preset.landscapeHeight
    : width <= preset.portraitWidth && height <= preset.portraitHeight
  return quality === 'compatible' && video?.codec_name === 'h264' && video.pix_fmt === 'yuv420p' &&
    width > 0 && height > 0 && fits && (!audio || audio.codec_name === 'aac') ? 'remux' : 'reencode'
}

function parseTimeSeconds(line) {
  const match = String(line).match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!match) return null
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

function pruneTaskHistory() {
  if (tasks.size <= MAX_TASK_HISTORY) return
  const idle = [...tasks.entries()].filter(([, task]) => !task.process && ['ready', 'error', 'cancelled'].includes(task.status))
    .sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0))
  for (const [key] of idle) { if (tasks.size <= MAX_TASK_HISTORY) break; tasks.delete(key) }
}



function transcodeConfiguration(quality, operation) {
  return { pipelineVersion: 1, quality: normalizeQuality(quality), operation, container: 'mp4',
    preset: QUALITY_PRESETS[normalizeQuality(quality)], scale: buildScaleFilter(quality),
    video: 'libx264/yuv420p/veryfast', audio: 'aac/160k', faststart: true, threads: 2, filterThreads: 1,
    streams: ['0:v:0', '0:a:0?'] }
}

async function startMobileTranscode(videoId, videoPath, quality = 'compatible', options = {}) {
  if (shuttingDown) throw Object.assign(new Error('转码服务正在关闭'), { status: 503, code: 'transcode_stopping' })
  const normalizedQuality = normalizeQuality(quality), taskKey = getTaskKey(videoId, normalizedQuality)
  const existing = tasks.get(taskKey)
  if (existing && ['queued', 'running'].includes(existing.status)) return existing
  if ([...tasks.values()].filter(task => ['queued', 'running'].includes(task.status)).length >= 64) {
    throw Object.assign(new Error('转码任务过多，请稍后再试'), { status: 429, code: 'transcode_queue_full' })
  }
  const taskId = crypto.randomUUID(), outputPath = getOutputPath(videoPath, normalizedQuality)
  const task = { id: videoId, taskId, taskKey, videoPath, remote: Boolean(options.remote), quality: normalizedQuality,
    status: 'queued', progress: 0, outputPath, tempPath: outputPath + '.' + taskId + '.tmp',
    error: '', createdAt: Date.now(), updatedAt: Date.now(), process: null, abort: new AbortController(),
    prepared: false, slotHeld: false }
  tasks.set(taskKey, task)
  const preparation = prepareTranscodeTask(task).finally(() => { taskStartPromises.delete(taskId); pruneTaskHistory() })
  taskStartPromises.set(taskId, preparation)
  pruneTaskHistory()
  return task
}

function ownsTask(task) { return !shuttingDown && !task.cancelled && !task.abort.signal.aborted && tasks.get(task.taskKey) === task }

async function prepareTranscodeTask(task) {
  try {
    const prepared = await mediaScheduler.enqueue({ key: 'transcode-prepare:' + task.taskId,
      type: 'transcode-prepare', priority: 70, groupLimit: 1, timeoutMs: 45000, signal: task.abort.signal }, async context => {
      const check = () => { context.throwIfAborted(); if (!ownsTask(task)) throw new Error('转码准备已取消') }
      check()
      if (task.remote) await require('../scanner').assertAllowedVideoPath(task.videoPath, { audience: 'remote' })
      check()
      const sourceSignature = await transcodeCache.fileSignature(task.videoPath)
      const fresh = await transcodeCache.readFreshCache(task.videoPath, task.outputPath, operation => transcodeConfiguration(task.quality, operation))
      check()
      if (fresh) return { cached: true, sourceSignature, operation: fresh.operation }
      const ffmpeg = await findFfmpeg({ signal: context.signal })
      check()
      if (!ffmpeg) throw new Error('电脑端未检测到 FFmpeg，无法准备兼容格式')
      const authorize = task.remote ? () => require('../scanner').assertAllowedVideoPath(task.videoPath, { audience: 'remote' }) : undefined
      const media = await probeTranscodeMedia(task.videoPath, { ...context, authorize })
      check()
      if (task.remote) await require('../scanner').assertAllowedVideoPath(task.videoPath, { audience: 'remote' })
      check()
      if (!transcodeCache.same(sourceSignature, await transcodeCache.fileSignature(task.videoPath))) throw new Error('媒体文件已改变，请重新准备')
      check()
      return { ffmpeg, media, sourceSignature }
    })
    if (!ownsTask(task)) return
    task.sourceSignature = prepared.sourceSignature
    if (prepared.cached) {
      task.operation = prepared.operation
      task.status = 'ready'; task.progress = 1; task.updatedAt = Date.now()
      return
    }
    task.ffmpeg = prepared.ffmpeg; task.duration = prepared.media.duration
    task.operation = selectTranscodeOperation(prepared.media, task.quality)
    task.prepared = true; task.updatedAt = Date.now()
    scheduleTranscodeDrain()
  } catch (error) {
    if (!ownsTask(task)) return
    task.status = 'error'; task.error = error?.message || '转码准备失败'; task.updatedAt = Date.now()
  }
}

function countRunningTasks() {
  return runningTranscodeSlots
}

function getQueuedTasks() {
  return [...tasks.values()]
    .filter(task => task?.status === 'queued')
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
}

function getQueuePosition(task) {
  if (!task || task.status !== 'queued') return 0
  const queued = getQueuedTasks()
  const index = queued.findIndex(item => item === task)
  return index >= 0 ? index + 1 : queued.length
}

function serializeTask(task) {
  if (!task) return null
  const quality = task.quality || 'compatible'
  return {
    id: task.id,
    taskId: task.taskId,
    operation: task.operation,
    quality,
    status: task.status,
    progress: task.progress,
    error: task.error || '',
    queuePosition: getQueuePosition(task),
    createdAt: task.createdAt || 0,
    updatedAt: task.updatedAt || 0,
    streamUrl: task.status === 'ready'
      ? `/v1/videos/${encodeURIComponent(task.id)}/transcoded-stream?quality=${encodeURIComponent(quality)}`
      : ''
  }
}

function scheduleTranscodeDrain() {
  if (shuttingDown || drainTimer !== null) return
  if (drainPromise) { drainAgain = true; return }
  drainTimer = setTimeout(() => {
    drainTimer = null
    drainPromise = drainTranscodeQueue().catch(() => {}).finally(() => {
      drainPromise = null
      if (drainAgain) { drainAgain = false; scheduleTranscodeDrain() }
    })
  }, 0)
}

function releaseRunningSlot(task) {
  if (task) {
    if (task.slotReleased || !task.slotHeld) return
    task.slotReleased = true
  }
  runningTranscodeSlots = Math.max(0, runningTranscodeSlots - 1)
}

async function drainTranscodeQueue() {
  if (shuttingDown) return
  while (countRunningTasks() < MAX_RUNNING_TRANSCODES) {
    const task = getQueuedTasks().find(item => item.prepared && !item.slotHeld)
    if (!task) return
    runningTranscodeSlots += 1
    task.slotHeld = true
    try {
      await runQueuedTranscodeTask(task)
    } catch (err) {
      if (!task.cancelled) { task.status = 'error'; task.error = err?.message || '转码启动失败' }
      task.updatedAt = Date.now()
      releaseRunningSlot(task)
    }
  }
}

async function cleanupTranscodeCacheNow(options = {}) {
  const force = Boolean(options.force)
  const maxFiles = Math.max(1, Number(options.maxFiles) || TRANSCODE_CACHE_MAX_FILES)
  const maxAgeMs = Math.max(60 * 1000, Number(options.maxAgeMs) || TRANSCODE_CACHE_MAX_AGE_MS)
  const maxBytes = Math.max(1, Number(options.maxBytes) || TRANSCODE_CACHE_MAX_BYTES)
  const now = Date.now()
  const dir = getTranscodeDir()
  let entries = []
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return { success: true, removed: 0, bytesRemoved: 0, totalFiles: 0, totalBytes: 0 }
  }

  const files = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.mobile.mp4')) continue
    const filePath = path.join(dir, entry.name)
    try {
      const stat = await fsp.stat(filePath)
      files.push({ filePath, size: stat.size, mtimeMs: stat.mtimeMs })
    } catch {}
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const expiredBefore = now - maxAgeMs
  const protectedOutputPaths = new Set(
    [...tasks.values()]
      .filter(task => task?.status === 'running' || task?.status === 'queued')
      .map(task => task?.outputPath ? path.resolve(task.outputPath).toLowerCase() : '')
      .filter(Boolean)
  )
  for (const filePath of require('./streaming').getActiveFilePaths()) protectedOutputPaths.add(path.resolve(filePath).toLowerCase())
  const removedPaths = new Set()
  let removed = 0
  let bytesRemoved = 0
  let remainingFiles = files.length, remainingBytes = files.reduce((sum, file) => sum + file.size, 0)
  for (const file of [...files].reverse()) {
    const normalizedFilePath = path.resolve(file.filePath).toLowerCase()
    if (protectedOutputPaths.has(normalizedFilePath)) continue
    if (!force && remainingFiles <= maxFiles && remainingBytes <= maxBytes && file.mtimeMs >= expiredBefore) continue
    try {
      await fsp.rm(file.filePath, { force: true })
      await fsp.unlink(transcodeCache.manifestPath(file.filePath)).catch(() => {})
      removedPaths.add(normalizedFilePath)
      removed += 1
      bytesRemoved += file.size
      remainingFiles--; remainingBytes -= file.size
    } catch {}
  }

  if (force || removedPaths.size > 0) {
    for (const [taskKey, task] of tasks.entries()) {
      const normalizedOutputPath = task?.outputPath ? path.resolve(task.outputPath).toLowerCase() : ''
      if (task?.status === 'ready' && removedPaths.has(normalizedOutputPath)) {
        tasks.delete(taskKey)
      }
    }
  }

  return {
    success: true,
    removed,
    bytesRemoved,
    totalFiles: remainingFiles,
    totalBytes: remainingBytes,
    maxBytes,
    overBudget: remainingBytes > maxBytes
  }
}

function cleanupTranscodeCache(options = {}) {
  const result = cacheCleanupQueue.catch(() => {}).then(() => cleanupTranscodeCacheNow(options))
  cacheCleanupQueue = result
  return result
}

async function runQueuedTranscodeTask(task) {
  if (!task || task.status === 'ready' || task.process) return task
  task.status = 'queued'
  task.progress = Math.max(task.progress || 0, 0.02)
  task.error = ''
  task.updatedAt = Date.now()

  const outputPath = task.outputPath
  const tempPath = task.tempPath || `${outputPath}.tmp`
  const lease = await mediaScheduler.acquire({ key: 'transcode-execution:' + task.taskId, type: 'transcode-execution',
    priority: 70, timeoutMs: TRANSCODE_DEADLINE_MS, signal: task.abort?.signal })
  task.lease = lease
  await fsp.rm(tempPath, { force: true }).catch(() => {})
  try {
    if (task.remote) await require('../scanner').assertAllowedVideoPath(task.videoPath, { audience: 'remote' })
    if (!transcodeCache.same(task.sourceSignature, await transcodeCache.fileSignature(task.videoPath))) throw new Error('媒体文件已改变，请重新准备')
  } catch (error) {
    lease.release(); task.lease = null; throw error
  }
  if (lease.signal.aborted || shuttingDown || task.cancelled || tasks.get(task.taskKey) !== task) {
    lease.release(); task.lease = null
    releaseRunningSlot(task)
    if (shuttingDown) { task.cancelled = true; task.status = 'cancelled'; tasks.delete(task.taskKey) }
    return task
  }
  task.status = 'running'
  const preset = QUALITY_PRESETS[normalizeQuality(task.quality)]

  const args = task.operation === 'remux' ? [
    '-hide_banner', '-y', '-i', task.videoPath, '-map', '0:v:0', '-map', '0:a:0?',
    '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', tempPath
  ] : [
    '-hide_banner',
    '-y',
    '-threads', '2',
    '-i', task.videoPath,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', preset.crf,
    '-pix_fmt', 'yuv420p',
    '-threads', '2',
    '-filter_threads', '1',
    '-movflags', '+faststart',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-vf', buildScaleFilter(task.quality),
    '-f', 'mp4',
    tempPath
  ]

  let child
  try {
    const spec = workerSpawnSpec(task.ffmpeg, args, { windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe'] })
    child = spawn(spec.file, spec.args, spec.options)
  } catch (error) { lease.release(); task.lease = null; throw error }
  task.process = child
  const leaseAborted = () => {
    if (!task.cancelled) { task.error = '转码超过最长执行时间或服务正在关闭'; task.status = 'error' }
    void stopProcessTree(child, { processGroup: process.platform !== 'win32' }).catch(() => {})
  }
  lease.signal.addEventListener('abort', leaseAborted, { once: true })
  let settle
  task.completion = new Promise(resolve => { settle = resolve })
  activeExecutions.add(task)
  task.deadlineTimer = setTimeout(() => {
    task.error = '转码超过最长执行时间'; task.status = 'error'
    void stopProcessTree(child, { processGroup: process.platform !== 'win32' }).catch(() => {})
  }, TRANSCODE_DEADLINE_MS)
  task.deadlineTimer.unref?.()

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    const time = parseTimeSeconds(chunk)
    if (!time || !task.duration) return
    task.progress = Math.max(task.progress, Math.min(0.96, time / task.duration))
    task.updatedAt = Date.now()
  })

  child.on('error', (err) => {
    if (task.cancelled) return
    task.status = 'error'
    task.error = '无法启动转码进程'
    task.updatedAt = Date.now()
    if (!child.pid) releaseRunningSlot(task)
    scheduleTranscodeDrain()
  })

  child.on('close', async (code) => {
    clearTimeout(task.deadlineTimer)
    lease.signal.removeEventListener('abort', leaseAborted)
    task.process = null
    if (code === 0 && !task.cancelled && task.status !== 'error' && tasks.get(task.taskKey) === task) {
      try {
        await transcodeCache.publishTranscode(task, transcodeConfiguration(task.quality, task.operation), async () => {
          if (!ownsTask(task) || lease.signal.aborted || task.status === 'error') throw new Error('转码结果保存已取消')
          if (task.remote) await require('../scanner').assertAllowedVideoPath(task.videoPath, { audience: 'remote' })
          if (!transcodeCache.same(task.sourceSignature, await transcodeCache.fileSignature(task.videoPath))) throw new Error('媒体文件已改变，请重新准备')
          if (!ownsTask(task) || lease.signal.aborted || task.status === 'error') throw new Error('转码结果保存已取消')
        })
        task.status = 'ready'
        task.progress = 1
        task.error = ''
      } catch (err) {
        if (!task.cancelled) { task.status = 'error'; task.error = err?.message || '转码结果保存失败' }
      }
    } else if (task.status !== 'error' && !task.cancelled) {
      task.status = 'error'
      task.error = `转码失败，退出码 ${code}`
    }
    task.updatedAt = Date.now()
    pruneTaskHistory()
    await fsp.rm(tempPath, { force: true }).catch(() => {})
    lease.release(); task.lease = null; releaseRunningSlot(task)
    cleanupTranscodeCache().catch(() => {})
    scheduleTranscodeDrain()
    activeExecutions.delete(task)
    settle()
  })

  return task
}

function getMobileTranscodeStatus(videoId, quality = 'compatible') {
  const normalizedQuality = normalizeQuality(quality)
  const task = tasks.get(getTaskKey(videoId, normalizedQuality))
  return serializeTask(task)
}

function getTranscodedPath(videoId, quality = 'compatible') {
  const task = tasks.get(getTaskKey(videoId, quality))
  return task?.status === 'ready' ? task.outputPath : ''
}

async function getFreshTranscodedPath(videoId, quality = 'compatible', openedFile) {
  const task = tasks.get(getTaskKey(videoId, quality))
  if (task?.status !== 'ready') return ''
  const fresh = await transcodeCache.readFreshCache(task.videoPath, task.outputPath, operation => transcodeConfiguration(task.quality, operation))
  const openedMatches = !openedFile || (fresh && transcodeCache.same(fresh.output,
    transcodeCache.signatureFromStat(fresh.output.path, await openedFile.stat({ bigint: true }))))
  if (task.status !== 'ready' || tasks.get(task.taskKey) !== task) return ''
  if (!fresh || !openedMatches) { task.status = 'error'; task.error = '媒体文件或转码缓存已改变，请重新准备'; task.updatedAt = Date.now(); return '' }
  return task.outputPath
}

function cancelMobileTranscode(videoId, quality = 'compatible') {
  const taskKey = getTaskKey(videoId, quality)
  const task = tasks.get(taskKey)
  if (!task) return false
  task.cancelled = true
  task.status = 'cancelled'
  task.abort?.abort()
  clearTimeout(task.deadlineTimer)
  if (task.process) {
    void stopProcessTree(task.process, { processGroup: process.platform !== 'win32' }).catch(() => {})
  } else if (task.slotHeld && !activeExecutions.has(task)) {
    releaseRunningSlot(task)
  }
  const tempPath = task.tempPath || ''
  if (tempPath) {
    fsp.rm(tempPath, { force: true }).catch(() => {})
  }
  tasks.delete(taskKey)
  scheduleTranscodeDrain()
  return true
}

function listMobileTranscodeTasks() {
  return [...tasks.values()]
    .map(serializeTask)
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
}

async function disposeTranscodes() {
  shuttingDown = true
  if (drainTimer !== null) clearTimeout(drainTimer)
  drainTimer = null; drainAgain = false
  const current = [...new Set([...tasks.values(), ...activeExecutions])]
  for (const task of current) {
    if (tasks.get(getTaskKey(task.id, task.quality)) === task && (task.process || task.status === 'queued' || task.status === 'running')) {
      cancelMobileTranscode(task.id, task.quality)
    } else if (task.process) {
      task.cancelled = true; task.abort?.abort(); clearTimeout(task.deadlineTimer)
      void stopProcessTree(task.process, { processGroup: process.platform !== 'win32' }).catch(() => {})
    }
  }
  await Promise.allSettled([...taskStartPromises.values()])
  await mediaScheduler.waitForIdle(['transcode-prepare'])
  await drainPromise
  await Promise.allSettled(current.map(task => task.completion).filter(Boolean))
  await cacheCleanupQueue.catch(() => {})
}

module.exports = {
  startMobileTranscode,
  getMobileTranscodeStatus,
  getTranscodedPath,
  getFreshTranscodedPath,
  cancelMobileTranscode,
  listMobileTranscodeTasks,
  cleanupTranscodeCache,
  normalizeQuality,
  buildScaleFilter,
  transcodeConfiguration,
  selectTranscodeOperation,
  disposeTranscodes,
  getTranscodeDiagnostics: () => ({ tasks: tasks.size, preparing: taskStartPromises.size, running: runningTranscodeSlots,
    processes: activeExecutions.size, closing: shuttingDown })
}
