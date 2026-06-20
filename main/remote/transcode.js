const crypto = require('crypto')
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const { execFile, spawn } = require('child_process')
const { app } = require('electron')
const { findFfmpeg } = require('../thumbnail')
const { getResourcePath } = require('../paths')

const tasks = new Map()
const MAX_RUNNING_TRANSCODES = 1
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

async function getExistingTask(videoId, videoPath, quality) {
  const normalizedQuality = normalizeQuality(quality)
  const taskKey = getTaskKey(videoId, normalizedQuality)
  const existing = tasks.get(taskKey)
  if (existing) {
    if (existing.status !== 'error') return existing
    tasks.delete(taskKey)
  }

  const outputPath = getOutputPath(videoPath, normalizedQuality)
  try {
    const [sourceStat, outputStat] = await Promise.all([
      fsp.stat(videoPath),
      fsp.stat(outputPath)
    ])
    if (outputStat.isFile() && outputStat.size > 0 && outputStat.mtimeMs >= sourceStat.mtimeMs) {
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
  } catch {
    // No cached output yet.
  }
  return null
}

async function startMobileTranscode(videoId, videoPath, quality = 'compatible') {
  const normalizedQuality = normalizeQuality(quality)
  const taskKey = getTaskKey(videoId, normalizedQuality)
  const existing = await getExistingTask(videoId, videoPath, normalizedQuality)
  if (existing) return existing
  const runningCount = [...tasks.values()].filter(task => task?.status === 'running' && task.process).length
  if (runningCount >= MAX_RUNNING_TRANSCODES) {
    return {
      id: videoId,
      quality: normalizedQuality,
      status: 'error',
      progress: 0,
      outputPath: '',
      error: '电脑正在准备另一个视频，请稍后再试',
      updatedAt: Date.now()
    }
  }

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

  const task = {
    id: videoId,
    quality: normalizedQuality,
    status: 'running',
    progress: 0.02,
    outputPath,
    error: '',
    updatedAt: Date.now(),
    process: null
  }
  tasks.set(taskKey, task)
  const preset = QUALITY_PRESETS[normalizedQuality]

  const args = [
    '-hide_banner',
    '-y',
    '-i', videoPath,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', preset.crf,
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-vf', buildScaleFilter(normalizedQuality),
    '-f', 'mp4',
    tempPath
  ]

  const child = spawn(ffmpeg, args, {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe']
  })
  task.process = child

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    const time = parseTimeSeconds(chunk)
    if (!time || !duration) return
    task.progress = Math.max(task.progress, Math.min(0.96, time / duration))
    task.updatedAt = Date.now()
  })

  child.on('error', (err) => {
    task.status = 'error'
    task.error = err.message || '转码启动失败'
    task.updatedAt = Date.now()
  })

  child.on('close', async (code) => {
    task.process = null
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
  })

  return task
}

function getMobileTranscodeStatus(videoId, quality = 'compatible') {
  const normalizedQuality = normalizeQuality(quality)
  const task = tasks.get(getTaskKey(videoId, normalizedQuality))
  if (!task) return null
  return {
    id: task.id,
    quality: task.quality || normalizedQuality,
    status: task.status,
    progress: task.progress,
    error: task.error || '',
    streamUrl: task.status === 'ready'
      ? `/v1/videos/${encodeURIComponent(videoId)}/transcoded-stream?quality=${encodeURIComponent(task.quality || normalizedQuality)}`
      : ''
  }
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
  }
  const tempPath = task.outputPath ? `${task.outputPath}.tmp` : ''
  if (tempPath) {
    fsp.rm(tempPath, { force: true }).catch(() => {})
  }
  tasks.delete(taskKey)
  return true
}

module.exports = {
  startMobileTranscode,
  getMobileTranscodeStatus,
  getTranscodedPath,
  cancelMobileTranscode,
  normalizeQuality,
  buildScaleFilter
}
