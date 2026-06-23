const crypto = require('crypto')
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const { execFile, spawn } = require('child_process')
const { app } = require('electron')
const { findFfmpeg } = require('../thumbnail')
const { getResourcePath } = require('../paths')

const tasks = new Map()
const taskStartPromises = new Map()
const MAX_RUNNING_TRANSCODES = 1
const TRANSCODE_CACHE_MAX_FILES = 60
const TRANSCODE_CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
let runningTranscodeSlots = 0
const fallbackUserDataDir = path.join(process.cwd(), '.tmp-wallpaper-player')
const QUALITY_PRESETS = {
  compatible: { label: 'compatible', landscapeWidth: 1920, landscapeHeight: 1080, portraitWidth: 1080, portraitHeight: 1920, crf: '23' },
  '1080p': { label: '1080p', landscapeWidth: 1920, landscapeHeight: 1080, portraitWidth: 1080, portraitHeight: 1920, crf: '23' },
  '720p': { label: '720p', landscapeWidth: 1280, landscapeHeight: 720, portraitWidth: 720, portraitHeight: 1280, crf: '24' },
  '480p': { label: '480p', landscapeWidth: 854, landscapeHeight: 480, portraitWidth: 480, portraitHeight: 854, crf: '26' }
}

function getTranscodeDir() {
  const baseDir = app?.getPath
    ? app.getPath('userData')
    : fallbackUserDataDir
  const dir = path.join(baseDir, 'remote-transcodes')
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

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (err, stdout, stderr) => {
      if (err) reject(err)
      else resolve({ stdout, stderr })
    })
  })
}

async function findFfprobe() {
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
    try {
      await execFileAsync(candidate, ['-version'], { timeout: 5000 })
      return candidate
    } catch {
      continue
    }
  }
  return null
}

function parseDurationSeconds(output) {
  const duration = Number(output)
  return Number.isFinite(duration) && duration > 0 ? duration : 0
}

async function probeDuration(videoPath) {
  const ffprobe = await findFfprobe()
  if (!ffprobe) return 0

  try {
    const { stdout } = await execFileAsync(ffprobe, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=nokey=1:noprint_wrappers=1',
      videoPath
    ], { timeout: 10000 })
    return parseDurationSeconds(String(stdout).trim())
  } catch {
    return 0
  }
}

function parseTimeSeconds(line) {
  const match = String(line).match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!match) return null
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

function shouldSpawnWithShell(filePath) {
  return process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(String(filePath || ''))
}

async function getExistingTask(videoId, videoPath, quality) {
  const normalizedQuality = normalizeQuality(quality)
  const taskKey = getTaskKey(videoId, normalizedQuality)
  const outputPath = getOutputPath(videoPath, normalizedQuality)
  const existing = tasks.get(taskKey)
  if (existing) {
    if (existing.status === 'error') {
      tasks.delete(taskKey)
    } else if (existing.status !== 'ready') {
      return existing
    } else if (await isFreshTranscodeOutput(videoPath, existing.outputPath || outputPath)) {
      return existing
    } else {
      tasks.delete(taskKey)
      await fsp.rm(existing.outputPath || outputPath, { force: true }).catch(() => {})
    }
  }

  if (await isFreshTranscodeOutput(videoPath, outputPath)) {
    const readyTask = {
      id: videoId,
      quality: normalizedQuality,
      status: 'ready',
      progress: 1,
      outputPath,
      error: '',
      updatedAt: Date.now()
    }
    tasks.set(taskKey, readyTask)
    return readyTask
  }

  await fsp.rm(outputPath, { force: true }).catch(() => {})
  return null
}

async function isFreshTranscodeOutput(videoPath, outputPath) {
  try {
    const [sourceStat, outputStat] = await Promise.all([
      fsp.stat(videoPath),
      fsp.stat(outputPath)
    ])
    return outputStat.isFile() && outputStat.size > 0 && outputStat.mtimeMs >= sourceStat.mtimeMs
  } catch {
    return false
  }
}

async function startMobileTranscode(videoId, videoPath, quality = 'compatible') {
  const normalizedQuality = normalizeQuality(quality)
  const taskKey = getTaskKey(videoId, normalizedQuality)
  const pendingStart = taskStartPromises.get(taskKey)
  if (pendingStart) return pendingStart

  const startPromise = startMobileTranscodeTask(videoId, videoPath, normalizedQuality, taskKey)
    .finally(() => {
      taskStartPromises.delete(taskKey)
    })
  taskStartPromises.set(taskKey, startPromise)
  return startPromise
}

async function startMobileTranscodeTask(videoId, videoPath, normalizedQuality, taskKey) {
  const existing = await getExistingTask(videoId, videoPath, normalizedQuality)
  if (existing) return existing

  const ffmpeg = await findFfmpeg()
  if (!ffmpeg) {
    const failedTask = {
      id: videoId,
      quality: normalizedQuality,
      status: 'error',
      progress: 0,
      outputPath: '',
      error: '电脑端未检测到 FFmpeg，无法准备兼容格式',
      updatedAt: Date.now()
    }
    tasks.set(taskKey, failedTask)
    return failedTask
  }

  const outputPath = getOutputPath(videoPath, normalizedQuality)
  const tempPath = `${outputPath}.tmp`
  await fsp.mkdir(path.dirname(outputPath), { recursive: true })
  await fsp.rm(tempPath, { force: true }).catch(() => {})
  const duration = await probeDuration(videoPath)

  const shouldQueue = countRunningTasks() >= MAX_RUNNING_TRANSCODES
  if (!shouldQueue) runningTranscodeSlots += 1
  const task = {
    id: videoId,
    taskKey,
    videoPath,
    quality: normalizedQuality,
    status: shouldQueue ? 'queued' : 'running',
    progress: shouldQueue ? 0 : 0.02,
    outputPath,
    tempPath,
    ffmpeg,
    duration,
    error: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    process: null
  }
  tasks.set(taskKey, task)
  if (task.status === 'queued') {
    return task
  }

  try {
    await runQueuedTranscodeTask(task)
  } catch (err) {
    task.status = 'error'
    task.error = err?.message || '转码启动失败'
    task.updatedAt = Date.now()
    releaseRunningSlot(task)
    scheduleTranscodeDrain()
  }
  return task
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
  setTimeout(() => {
    drainTranscodeQueue().catch(() => {})
  }, 0)
}

function releaseRunningSlot(task) {
  if (task) {
    if (task.slotReleased) return
    task.slotReleased = true
  }
  runningTranscodeSlots = Math.max(0, runningTranscodeSlots - 1)
}

async function drainTranscodeQueue() {
  while (countRunningTasks() < MAX_RUNNING_TRANSCODES) {
    const task = getQueuedTasks()[0]
    if (!task) return
    runningTranscodeSlots += 1
    try {
      await runQueuedTranscodeTask(task)
    } catch (err) {
      task.status = 'error'
      task.error = err?.message || '转码启动失败'
      task.updatedAt = Date.now()
      releaseRunningSlot(task)
    }
  }
}

async function cleanupTranscodeCache(options = {}) {
  const force = Boolean(options.force)
  const maxFiles = Math.max(1, Number(options.maxFiles) || TRANSCODE_CACHE_MAX_FILES)
  const maxAgeMs = Math.max(60 * 1000, Number(options.maxAgeMs) || TRANSCODE_CACHE_MAX_AGE_MS)
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
  const removable = files.filter((file, index) => force || index >= maxFiles || file.mtimeMs < expiredBefore)
  const protectedOutputPaths = new Set(
    [...tasks.values()]
      .filter(task => task?.status === 'running' || task?.status === 'queued')
      .map(task => task?.outputPath ? path.resolve(task.outputPath).toLowerCase() : '')
      .filter(Boolean)
  )
  const removedPaths = new Set()
  let removed = 0
  let bytesRemoved = 0
  for (const file of removable) {
    const normalizedFilePath = path.resolve(file.filePath).toLowerCase()
    if (!force && protectedOutputPaths.has(normalizedFilePath)) continue
    try {
      await fsp.rm(file.filePath, { force: true })
      removedPaths.add(normalizedFilePath)
      removed += 1
      bytesRemoved += file.size
    } catch {}
  }

  if (force || removedPaths.size > 0) {
    for (const [taskKey, task] of tasks.entries()) {
      const normalizedOutputPath = task?.outputPath ? path.resolve(task.outputPath).toLowerCase() : ''
      if (task?.status === 'ready' && (force || removedPaths.has(normalizedOutputPath))) {
        tasks.delete(taskKey)
      }
    }
  }

  return {
    success: true,
    removed,
    bytesRemoved,
    totalFiles: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0)
  }
}

async function runQueuedTranscodeTask(task) {
  if (!task || task.status === 'ready' || task.process) return task
  task.status = 'running'
  task.progress = Math.max(task.progress || 0, 0.02)
  task.error = ''
  task.updatedAt = Date.now()

  const outputPath = task.outputPath
  const tempPath = task.tempPath || `${outputPath}.tmp`
  await fsp.rm(tempPath, { force: true }).catch(() => {})
  const preset = QUALITY_PRESETS[normalizeQuality(task.quality)]

  const args = [
    '-hide_banner',
    '-y',
    '-i', task.videoPath,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', preset.crf,
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-vf', buildScaleFilter(task.quality),
    '-f', 'mp4',
    tempPath
  ]

  const child = spawn(task.ffmpeg, args, {
    shell: shouldSpawnWithShell(task.ffmpeg),
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe']
  })
  task.process = child

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    const time = parseTimeSeconds(chunk)
    if (!time || !task.duration) return
    task.progress = Math.max(task.progress, Math.min(0.96, time / task.duration))
    task.updatedAt = Date.now()
  })

  child.on('error', (err) => {
    task.status = 'error'
    task.error = err.message || '转码启动失败'
    task.updatedAt = Date.now()
    releaseRunningSlot(task)
    scheduleTranscodeDrain()
  })

  child.on('close', async (code) => {
    task.process = null
    releaseRunningSlot(task)
    if (code === 0) {
      try {
        await fsp.rename(tempPath, outputPath)
        task.status = 'ready'
        task.progress = 1
        task.error = ''
      } catch (err) {
        task.status = 'error'
        task.error = err instanceof Error ? err.message : '转码结果保存失败'
      }
    } else if (task.status !== 'error') {
      task.status = 'error'
      task.error = `转码失败，退出码 ${code}`
    }
    task.updatedAt = Date.now()
    await fsp.rm(tempPath, { force: true }).catch(() => {})
    cleanupTranscodeCache().catch(() => {})
    scheduleTranscodeDrain()
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

function cancelMobileTranscode(videoId, quality = 'compatible') {
  const taskKey = getTaskKey(videoId, quality)
  const task = tasks.get(taskKey)
  if (!task) return false
  if (task.process) {
    task.process.kill()
  } else if (task.status === 'running') {
    releaseRunningSlot(task)
  }
  const tempPath = task.outputPath ? `${task.outputPath}.tmp` : ''
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

module.exports = {
  startMobileTranscode,
  getMobileTranscodeStatus,
  getTranscodedPath,
  cancelMobileTranscode,
  listMobileTranscodeTasks,
  cleanupTranscodeCache,
  normalizeQuality,
  buildScaleFilter
}
