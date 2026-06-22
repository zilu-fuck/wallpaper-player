const crypto = require('crypto')
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const { spawn } = require('child_process')
const { getResourcePath, pathKey } = require('./paths')

let activeJob = null
let activeJobSeq = 0

function getVideoComprehensionRoot() {
  return getResourcePath('video comprehension', 'video comprehension')
}

function getOutputsDir() {
  return path.join(getVideoComprehensionRoot(), 'outputs')
}

function getActiveAnalysisJob() {
  if (!activeJob) return { running: false }
  return {
    running: true,
    jobId: activeJob.jobId,
    videoPath: activeJob.videoPath,
    startedAt: activeJob.startedAt,
    lastEvent: activeJob.lastEvent
  }
}

function emitAnalysisEvent(sender, payload) {
  if (!sender || sender.isDestroyed()) return
  sender.send('video-analysis-event', payload)
}

function parsePipelineLine(line) {
  const trimmed = line.trim()
  if (!trimmed) return null
  const match = trimmed.match(/^\[(.*?)\]\s+(\S+)\s+(\S+):\s*(.*)$/)
  if (!match) {
    return {
      type: 'output',
      message: trimmed
    }
  }

  let message = match[4]
  let extra = null
  const jsonStart = message.indexOf(' {')
  if (jsonStart >= 0) {
    const maybeJson = message.slice(jsonStart + 1)
    try {
      extra = JSON.parse(maybeJson)
      message = message.slice(0, jsonStart)
    } catch {}
  }

  return {
    type: 'stage',
    createdAt: match[1],
    stage: match[2],
    status: match[3],
    message: message.trim(),
    extra
  }
}

function handleProcessOutput(job, sender, text) {
  job.outputBuffer += text
  const lines = job.outputBuffer.split(/\r?\n/)
  job.outputBuffer = lines.pop() || ''

  for (const line of lines) {
    const event = parsePipelineLine(line)
    if (!event) continue
    job.lastEvent = event
    emitAnalysisEvent(sender, {
      jobId: job.jobId,
      videoPath: job.videoPath,
      status: 'running',
      event
    })
  }
}

async function startVideoAnalysis(videoPath, sender) {
  if (activeJob) {
    return {
      accepted: false,
      reason: 'already_running',
      job: getActiveAnalysisJob()
    }
  }

  const root = getVideoComprehensionRoot()
  try {
    await fsp.access(path.join(root, 'pyproject.toml'))
  } catch {
    return {
      accepted: false,
      reason: 'missing_project',
      error: `未找到视频理解项目：${root}`
    }
  }

  const job = {
    jobId: `analysis_${Date.now()}_${++activeJobSeq}`,
    videoPath: path.resolve(videoPath),
    startedAt: Date.now(),
    lastEvent: null,
    outputBuffer: '',
    process: null
  }

  const child = spawn('uv', ['run', 'video-comprehension', job.videoPath], {
    cwd: root,
    windowsHide: true,
    shell: false,
    env: {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8'
    }
  })
  job.process = child
  activeJob = job

  emitAnalysisEvent(sender, {
    jobId: job.jobId,
    videoPath: job.videoPath,
    status: 'started',
    message: '开始分析当前视频'
  })

  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', chunk => handleProcessOutput(job, sender, chunk))
  child.stderr?.on('data', chunk => handleProcessOutput(job, sender, chunk))

  child.on('error', (err) => {
    if (activeJob?.jobId === job.jobId) activeJob = null
    emitAnalysisEvent(sender, {
      jobId: job.jobId,
      videoPath: job.videoPath,
      status: 'error',
      error: err.message
    })
  })

  child.on('close', async (code, signal) => {
    if (job.outputBuffer.trim()) {
      const event = parsePipelineLine(job.outputBuffer)
      if (event) {
        job.lastEvent = event
        emitAnalysisEvent(sender, {
          jobId: job.jobId,
          videoPath: job.videoPath,
          status: 'running',
          event
        })
      }
      job.outputBuffer = ''
    }

    if (activeJob?.jobId === job.jobId) activeJob = null
    if (code === 0) {
      const analysis = await findVideoAnalysis(job.videoPath)
      emitAnalysisEvent(sender, {
        jobId: job.jobId,
        videoPath: job.videoPath,
        status: 'success',
        analysis
      })
      return
    }

    emitAnalysisEvent(sender, {
      jobId: job.jobId,
      videoPath: job.videoPath,
      status: signal ? 'cancelled' : 'error',
      code,
      signal,
      error: signal ? '分析已取消' : `视频理解管线退出：${code}`
    })
  })

  return {
    accepted: true,
    job: getActiveAnalysisJob()
  }
}

function cancelVideoAnalysis(jobId) {
  if (!activeJob) return { cancelled: false, reason: 'not_running' }
  if (jobId && activeJob.jobId !== jobId) return { cancelled: false, reason: 'job_mismatch' }

  const job = activeJob
  try {
    job.process?.kill()
  } catch {}
  return { cancelled: true, jobId: job.jobId }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf-8'))
  } catch {
    return null
  }
}

async function fileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function collectCandidates(outputsDir) {
  let entries = []
  try {
    entries = await fsp.readdir(outputsDir, { withFileTypes: true })
  } catch {
    return []
  }

  const candidates = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const taskDir = path.join(outputsDir, entry.name)
    const resultPath = path.join(taskDir, 'final', 'result.json')
    try {
      await fsp.access(resultPath)
    } catch {
      continue
    }

    const manifest = await readJson(path.join(taskDir, 'input', 'input_manifest.json'))
    candidates.push({
      taskDir,
      taskDirName: entry.name,
      resultPath,
      manifest: manifest && typeof manifest === 'object' ? manifest : null
    })
  }
  return candidates
}

function matchesManifestPath(candidate, videoPath) {
  const manifestPath = candidate.manifest?.video_path
  return typeof manifestPath === 'string' && pathKey(manifestPath) === pathKey(videoPath)
}

function matchesFilenameAndSize(candidate, result, fileName, fileSizeBytes) {
  const manifest = candidate.manifest || {}
  const source = result?.source_video || {}
  const manifestName = typeof manifest.video_path === 'string' ? path.basename(manifest.video_path) : ''
  const sourceName = typeof source.original_filename === 'string' ? source.original_filename : ''
  const manifestSize = Number(manifest.file_size_bytes)
  return (
    manifestSize === fileSizeBytes &&
    [manifestName, sourceName].some(name => name && name.toLowerCase() === fileName.toLowerCase())
  )
}

function compactTimeline(timeline) {
  return Array.isArray(timeline)
    ? timeline.map(item => ({
        start_time: Number(item?.start_time) || 0,
        end_time: Number(item?.end_time) || 0,
        title: typeof item?.title === 'string' ? item.title : '',
        description: typeof item?.description === 'string' ? item.description : '',
        confidence: Number(item?.confidence) || 0,
        vlm_status: typeof item?.vlm_status === 'string' ? item.vlm_status : '',
        evidence_count: Array.isArray(item?.evidence_refs) ? item.evidence_refs.length : 0
      }))
    : []
}

function compactCharacters(characters) {
  return Array.isArray(characters)
    ? characters.map(item => ({
        name: typeof item?.name === 'string' ? item.name : '',
        identity_status: typeof item?.identity_status === 'string' ? item.identity_status : '',
        description: typeof item?.description === 'string' ? item.description : '',
        confidence: Number(item?.confidence) || 0
      })).filter(item => item.name || item.description)
    : []
}

function compactResult(result, candidate, matchType) {
  return {
    available: true,
    taskId: result.task_id || candidate.taskDirName,
    taskDirName: candidate.taskDirName,
    taskDir: candidate.taskDir,
    matchType,
    sourceVideo: result.source_video || {},
    summary: typeof result.summary === 'string' ? result.summary : '',
    tags: Array.isArray(result.tags) ? result.tags.filter(item => typeof item === 'string') : [],
    keywords: Array.isArray(result.keywords) ? result.keywords.filter(item => typeof item === 'string') : [],
    timeline: compactTimeline(result.timeline),
    characters: compactCharacters(result.characters),
    quality: result.quality && typeof result.quality === 'object' ? result.quality : {},
    naming: result.naming && typeof result.naming === 'object' ? result.naming : {}
  }
}

async function loadCandidateResult(candidate, matchType) {
  const result = await readJson(candidate.resultPath)
  if (!result || typeof result !== 'object') return null
  return compactResult(result, candidate, matchType)
}

async function findVideoAnalysis(videoPath) {
  const resolvedPath = path.resolve(videoPath)
  const outputsDir = getOutputsDir()
  const candidates = await collectCandidates(outputsDir)
  if (!candidates.length) {
    return {
      available: false,
      reason: 'no_outputs',
      outputsDir
    }
  }

  const pathMatch = candidates.find(candidate => matchesManifestPath(candidate, resolvedPath))
  if (pathMatch) {
    const analysis = await loadCandidateResult(pathMatch, 'path')
    if (analysis) return analysis
  }

  let stats
  try {
    stats = await fsp.stat(resolvedPath)
  } catch {
    stats = null
  }

  const currentHash = stats?.isFile() ? await fileSha256(resolvedPath) : ''
  if (currentHash) {
    for (const candidate of candidates) {
      const manifestHash = candidate.manifest?.file_hash
      if (typeof manifestHash === 'string' && manifestHash === currentHash) {
        const analysis = await loadCandidateResult(candidate, 'hash')
        if (analysis) return analysis
      }
    }

    for (const candidate of candidates) {
      const result = await readJson(candidate.resultPath)
      if (result?.source_video?.file_hash === currentHash) {
        return compactResult(result, candidate, 'hash')
      }
    }
  }

  if (stats?.isFile()) {
    const fileName = path.basename(resolvedPath)
    for (const candidate of candidates) {
      const result = await readJson(candidate.resultPath)
      if (result && matchesFilenameAndSize(candidate, result, fileName, stats.size)) {
        return compactResult(result, candidate, 'filename_size')
      }
    }
  }

  return {
    available: false,
    reason: 'not_found',
    outputsDir
  }
}

module.exports = {
  findVideoAnalysis,
  startVideoAnalysis,
  cancelVideoAnalysis,
  getActiveAnalysisJob,
  getOutputsDir,
  getVideoComprehensionRoot
}
