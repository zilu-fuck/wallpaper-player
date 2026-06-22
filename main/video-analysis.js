const crypto = require('crypto')
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const { getResourcePath, pathKey } = require('./paths')

function getVideoComprehensionRoot() {
  return getResourcePath('video comprehension', 'video comprehension')
}

function getOutputsDir() {
  return path.join(getVideoComprehensionRoot(), 'outputs')
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
  getOutputsDir,
  getVideoComprehensionRoot
}
