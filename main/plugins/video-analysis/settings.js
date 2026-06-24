const path = require('path')
const { app } = require('electron')

const sessionAllowedAnalysisResultDirectories = new Set()
const sessionAllowedAnalysisModelDirectories = new Set()
const fallbackUserDataDir = path.join(process.cwd(), '.tmp-wallpaper-player')

function getUserDataDir() {
  return app?.getPath
    ? app.getPath('userData')
    : fallbackUserDataDir
}

function getDefaultAnalysisResultDirectory() {
  return path.join(getUserDataDir(), 'analysis-results')
}

function getDefaultAnalysisModelDirectory() {
  return path.join(getUserDataDir(), 'analysis-models')
}

function getDefaultAnalysisRuntimeDirectory() {
  return path.join(getUserDataDir(), 'video-analysis-runtime')
}

function normalizeAnalysisLlmProfile(profile) {
  const value = profile && typeof profile === 'object' && !Array.isArray(profile)
    ? profile
    : {}
  return {
    llmBaseUrl: typeof value.llmBaseUrl === 'string' ? value.llmBaseUrl : '',
    llmName: typeof value.llmName === 'string' ? value.llmName : '',
    llmApiKey: typeof value.llmApiKey === 'string' ? value.llmApiKey : ''
  }
}

function normalizeAnalysisLlmProfiles(profiles) {
  const value = profiles && typeof profiles === 'object' && !Array.isArray(profiles)
    ? profiles
    : {}
  return {
    local: normalizeAnalysisLlmProfile(value.local),
    api: normalizeAnalysisLlmProfile(value.api)
  }
}

function mergeAnalysisLlmProfile(currentProfile, nextProfile) {
  const current = normalizeAnalysisLlmProfile(currentProfile)
  const next = nextProfile && typeof nextProfile === 'object' && !Array.isArray(nextProfile)
    ? nextProfile
    : {}
  return normalizeAnalysisLlmProfile({
    ...current,
    ...next
  })
}

function mergeAnalysisLlmProfiles(currentProfiles, nextProfiles) {
  const current = normalizeAnalysisLlmProfiles(currentProfiles)
  const next = nextProfiles && typeof nextProfiles === 'object' && !Array.isArray(nextProfiles)
    ? nextProfiles
    : {}
  return {
    local: Object.hasOwn(next, 'local')
      ? mergeAnalysisLlmProfile(current.local, next.local)
      : current.local,
    api: Object.hasOwn(next, 'api')
      ? mergeAnalysisLlmProfile(current.api, next.api)
      : current.api
  }
}

function normalizeVideoAnalysis(videoAnalysis) {
  const analysis = videoAnalysis && typeof videoAnalysis === 'object' && !Array.isArray(videoAnalysis)
    ? videoAnalysis
    : {}
  const outputDir = typeof analysis.outputDir === 'string' && analysis.outputDir.trim()
    ? path.resolve(analysis.outputDir)
    : getDefaultAnalysisResultDirectory()
  const modelDir = typeof analysis.modelDir === 'string' && analysis.modelDir.trim()
    ? path.resolve(analysis.modelDir)
    : getDefaultAnalysisModelDirectory()
  return {
    enabled: Boolean(analysis.enabled),
    outputDir,
    modelDir,
    llmProfiles: normalizeAnalysisLlmProfiles(analysis.llmProfiles)
  }
}

function mergeVideoAnalysis(currentVideoAnalysis, nextVideoAnalysis) {
  const current = normalizeVideoAnalysis(currentVideoAnalysis)
  const next = nextVideoAnalysis && typeof nextVideoAnalysis === 'object' && !Array.isArray(nextVideoAnalysis)
    ? nextVideoAnalysis
    : {}
  return normalizeVideoAnalysis({
    ...current,
    ...(Object.hasOwn(next, 'enabled') ? { enabled: next.enabled } : {}),
    ...(Object.hasOwn(next, 'outputDir') ? { outputDir: next.outputDir } : {}),
    ...(Object.hasOwn(next, 'modelDir') ? { modelDir: next.modelDir } : {}),
    llmProfiles: Object.hasOwn(next, 'llmProfiles')
      ? mergeAnalysisLlmProfiles(current.llmProfiles, next.llmProfiles)
      : current.llmProfiles
  })
}

function sanitizeVideoAnalysisForSave(nextAnalysis, currentAnalysis, { pathKey }) {
  const current = normalizeVideoAnalysis(currentAnalysis)
  const next = normalizeVideoAnalysis(nextAnalysis)
  const currentDir = path.resolve(current.outputDir)
  const currentModelDir = path.resolve(current.modelDir)
  const nextDir = path.resolve(next.outputDir)
  const nextModelDir = path.resolve(next.modelDir)
  const canSaveOutputDir = (
    pathKey(nextDir) === pathKey(currentDir) ||
    pathKey(nextDir) === pathKey(getDefaultAnalysisResultDirectory()) ||
    sessionAllowedAnalysisResultDirectories.has(pathKey(nextDir))
  )
  const canSaveModelDir = (
    pathKey(nextModelDir) === pathKey(currentModelDir) ||
    pathKey(nextModelDir) === pathKey(getDefaultAnalysisModelDirectory()) ||
    sessionAllowedAnalysisModelDirectories.has(pathKey(nextModelDir))
  )

  return {
    ...next,
    outputDir: canSaveOutputDir ? nextDir : currentDir,
    modelDir: canSaveModelDir ? nextModelDir : currentModelDir
  }
}

const videoAnalysisSettingsSection = {
  normalize: normalizeVideoAnalysis,
  merge: mergeVideoAnalysis,
  sanitizeForSave: sanitizeVideoAnalysisForSave
}

module.exports = {
  sessionAllowedAnalysisResultDirectories,
  sessionAllowedAnalysisModelDirectories,
  getDefaultAnalysisResultDirectory,
  getDefaultAnalysisModelDirectory,
  getDefaultAnalysisRuntimeDirectory,
  normalizeVideoAnalysis,
  mergeVideoAnalysis,
  normalizeAnalysisLlmProfiles,
  videoAnalysisSettingsSection
}
