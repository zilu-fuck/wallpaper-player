const crypto = require('crypto')
const fs = require('fs')
const fsp = require('fs/promises')
const net = require('net')
const path = require('path')
const { spawn } = require('child_process')
const { BrowserWindow } = require('electron')
const { core } = require('./core')
const { getResourcePath, isPathInside, pathKey } = core('paths')
const { loadSettings, updateSettingsAndFlush } = core('settings')
const { RuntimeConfigStore } = require('./runtime-config-store')
const {
  getDefaultAnalysisModelDirectory,
  getDefaultAnalysisResultDirectory,
  getDefaultAnalysisRuntimeDirectory
} = require('./settings')

let activeJob = null
let activeJobSeq = 0
let analysisClosing = false
const ANALYSIS_WAIT_MS = 2 * 60 * 60 * 1000
const ANALYSIS_OUTPUT_LIMIT = 256 * 1024
const recentAnalysisEvents = new Map()
const RECENT_ANALYSIS_EVENT_LIMIT = 100
const REQUIRED_VIDEO_COMPREHENSION_FILES = [
  'pyproject.toml',
  path.join('video_comprehension', 'cli.py'),
  path.join('video_comprehension', 'config.py'),
  path.join('video_comprehension', 'pipeline.py')
]

const ANALYSIS_ENV_KEYS = [
  'MAX_DURATION_SECONDS',
  'MODEL_STORAGE_DIR',
  'LLM_PROVIDER',
  'LLM_BASE_URL',
  'LLM_NAME',
  'LLM_API_KEY',
  'VLM_PROVIDER',
  'VLM_BASE_URL',
  'VLM_NAME',
  'VLM_API_KEY',
  'VLM_MODEL_PATH',
  'VLM_MODEL_DOWNLOAD_URL',
  'VLM_HF_REPO',
  'VLM_HF_REVISION',
  'VLM_HF_TOKEN',
  'VLM_SERVER_EXECUTABLE',
  'VLM_SERVER_ARGS',
  'VLM_CONCURRENCY',
  'MODE'
]

const LOCAL_DEFAULT_ANALYSIS_ENV = {
  MAX_DURATION_SECONDS: '1800',
  MODEL_STORAGE_DIR: getDefaultAnalysisModelDirectory(),
  LLM_PROVIDER: 'local',
  LLM_BASE_URL: 'http://127.0.0.1:11434/v1',
  LLM_NAME: 'qwen2.5:14b',
  LLM_API_KEY: 'local-placeholder',
  VLM_PROVIDER: 'local',
  VLM_BASE_URL: 'http://127.0.0.1:5803',
  VLM_NAME: 'Huihui-Qwen3.5-9B-Claude-4.6-Opus-abliterated.Q4_K_M.gguf',
  VLM_API_KEY: 'local-placeholder',
  VLM_MODEL_PATH: path.join(getDefaultAnalysisModelDirectory(), 'vlm', 'Huihui-Qwen3.5-9B-Claude-4.6-Opus-abliterated.Q4_K_M.gguf'),
  VLM_MODEL_DOWNLOAD_URL: '',
  VLM_HF_REPO: '',
  VLM_HF_REVISION: 'main',
  VLM_HF_TOKEN: '',
  VLM_SERVER_EXECUTABLE: getDefaultVlmServerExecutable(),
  VLM_SERVER_ARGS: '-m "{modelPath}" --host 127.0.0.1 --port {port}',
  VLM_CONCURRENCY: '4',
  MODE: 'balance'
}

function getDefaultVlmServerExecutable() {
  const cudaServer = getPluginResourcePath('vendor', 'llama.cpp-cuda', 'llama-server.exe')
  if (fs.existsSync(cudaServer)) return cudaServer
  const cpuServer = getPluginResourcePath('vendor', 'llama.cpp', 'llama-server.exe')
  if (fs.existsSync(cpuServer)) return cpuServer
  const bundledCudaServer = getResourcePath('vendor', 'llama.cpp-cuda', 'llama-server.exe')
  if (fs.existsSync(bundledCudaServer)) return bundledCudaServer
  return getResourcePath('vendor', 'llama.cpp', 'llama-server.exe')
}

function isBundledLlamaServerPath(inputPath, backend) {
  const normalized = String(inputPath || '').replace(/\\/g, '/').toLowerCase()
  const resourceSuffix = `resources/vendor/${backend}/llama-server.exe`
  const vendorSuffix = `vendor/${backend}/llama-server.exe`
  return normalized === resourceSuffix ||
    normalized.endsWith(`/${resourceSuffix}`) ||
    normalized === vendorSuffix ||
    normalized.endsWith(`/${vendorSuffix}`)
}

function getRuntimeVlmServerExecutable(configuredPath) {
  const cpuServer = fs.existsSync(getPluginResourcePath('vendor', 'llama.cpp', 'llama-server.exe'))
    ? getPluginResourcePath('vendor', 'llama.cpp', 'llama-server.exe')
    : getResourcePath('vendor', 'llama.cpp', 'llama-server.exe')
  const cudaServer = fs.existsSync(getPluginResourcePath('vendor', 'llama.cpp-cuda', 'llama-server.exe'))
    ? getPluginResourcePath('vendor', 'llama.cpp-cuda', 'llama-server.exe')
    : getResourcePath('vendor', 'llama.cpp-cuda', 'llama-server.exe')
  if (fs.existsSync(cudaServer) && (!configuredPath || isBundledLlamaServerPath(configuredPath, 'llama.cpp-cuda'))) {
    return cudaServer
  }
  if (
    fs.existsSync(cudaServer) &&
    (!configuredPath || pathKey(configuredPath) === pathKey(cpuServer) || isBundledLlamaServerPath(configuredPath, 'llama.cpp'))
  ) {
    return cudaServer
  }
  if (fs.existsSync(cpuServer) && (!configuredPath || isBundledLlamaServerPath(configuredPath, 'llama.cpp'))) {
    return cpuServer
  }
  const configuredExists = Boolean(configuredPath && fs.existsSync(configuredPath))
  if (configuredPath && configuredExists) return configuredPath
  return configuredPath || getDefaultVlmServerExecutable()
}

function isDirectory(inputPath) {
  try {
    return fs.statSync(inputPath).isDirectory()
  } catch {
    return false
  }
}

function isFile(inputPath) {
  try {
    return fs.statSync(inputPath).isFile()
  } catch {
    return false
  }
}

function findFileByName(dir, fileName) {
  if (!dir || !fileName) return ''
  const directPath = path.join(dir, fileName)
  if (isFile(directPath)) return directPath
  try {
    const matched = fs
      .readdirSync(dir, { withFileTypes: true })
      .find(entry => entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase())
    return matched ? path.join(dir, matched.name) : ''
  } catch {
    return ''
  }
}

function looksLikeDefaultAnalysisModelDir(inputPath) {
  const resolved = path.resolve(inputPath || '')
  const parentName = path.basename(path.dirname(resolved)).toLowerCase()
  return path.basename(resolved).toLowerCase() === 'analysis-models' &&
    ['wallpaper-player', 'wallpaper player', '.tmp-wallpaper-player'].includes(parentName)
}

function looksLikeDefaultAnalysisResultDir(inputPath) {
  const resolved = path.resolve(inputPath || '')
  const parentName = path.basename(path.dirname(resolved)).toLowerCase()
  return path.basename(resolved).toLowerCase() === 'analysis-results' &&
    ['wallpaper-player', 'wallpaper player', '.tmp-wallpaper-player'].includes(parentName)
}

function resolveRuntimeModelStorageDir(configuredDir) {
  const configured = typeof configuredDir === 'string' && configuredDir.trim()
    ? path.resolve(configuredDir)
    : ''
  if (configured && isDirectory(configured)) return configured
  if (configured && !looksLikeDefaultAnalysisModelDir(configured)) return configured

  const settingsDir = getAnalysisModelDirectory()
  if (settingsDir && isDirectory(settingsDir)) return path.resolve(settingsDir)

  return getDefaultAnalysisModelDirectory()
}

function resolveRuntimeVlmModelPath(configuredPath, modelStorageDir, vlmName) {
  const modelName = path.basename(String(vlmName || '').trim() || LOCAL_DEFAULT_ANALYSIS_ENV.VLM_NAME)
  const fallbackPath = path.join(modelStorageDir, 'vlm', modelName)
  const configured = typeof configuredPath === 'string' && configuredPath.trim()
    ? path.resolve(configuredPath)
    : fallbackPath
  if (isFile(configured)) return configured

  const fileName = path.basename(configured || modelName)
  const candidateDirs = [
    path.join(modelStorageDir, 'vlm'),
    modelStorageDir,
    path.join(getAnalysisModelDirectory(), 'vlm'),
    getAnalysisModelDirectory(),
    path.join(getDefaultAnalysisModelDirectory(), 'vlm'),
    getDefaultAnalysisModelDirectory()
  ]
  const seenDirs = new Set()
  for (const dir of candidateDirs) {
    if (!dir) continue
    const resolvedDir = path.resolve(dir)
    const key = pathKey(resolvedDir)
    if (seenDirs.has(key)) continue
    seenDirs.add(key)
    const matched = findFileByName(resolvedDir, fileName)
    if (matched) return matched
  }

  if (!configuredPath || looksLikeDefaultAnalysisModelDir(configured)) {
    return fallbackPath
  }
  return configured
}

const LOCAL_VLM_SETUP_HINT = [
  '本地 VLM 需要一个支持图片输入的 OpenAI 兼容服务。',
  '可选方案：1. 使用 Ollama/LM Studio 启动 qwen2-vl 等视觉模型，并把 VLM 服务地址改到对应 /v1；2. 使用 llama.cpp/其他服务加载 GGUF 视觉模型，并监听当前 VLM 地址；3. 若使用远端视觉模型，在设置里填写远端 VLM_BASE_URL、VLM_NAME 和 API Key。'
].join(' ')

function getPluginResourcePath(...segments) {
  return path.join(__dirname, 'resources', ...segments)
}

function getVideoComprehensionRoot() {
  const pluginRoot = getPluginResourcePath('video comprehension', 'video comprehension')
  if (fs.existsSync(pluginRoot)) return pluginRoot
  return getResourcePath('video comprehension', 'video comprehension')
}

function getBundledVideoComprehensionRoot() {
  const pluginRoot = getPluginResourcePath('video-comprehension-runtime')
  if (fs.existsSync(pluginRoot)) return pluginRoot
  return path.join(__dirname, '..', '..', 'video-comprehension-runtime')
}

function getRuntimeVideoComprehensionRoot() {
  return path.join(getDefaultAnalysisRuntimeDirectory(), 'project')
}

function isAsarPath(inputPath) {
  return path.resolve(inputPath).split(path.sep).includes('app.asar')
}

async function hasCompleteVideoComprehensionProject(root) {
  try {
    await Promise.all(REQUIRED_VIDEO_COMPREHENSION_FILES.map(item => fsp.access(path.join(root, item))))
    const cliText = await fsp.readFile(path.join(root, 'video_comprehension', 'cli.py'), 'utf-8')
    const configText = await fsp.readFile(path.join(root, 'video_comprehension', 'config.py'), 'utf-8')
    if (!cliText.includes('VIDEO_COMPREHENSION_ENV')) return false
    if (!configText.includes('VIDEO_COMPREHENSION_OUTPUT_DIR')) return false
    return true
  } catch {
    return false
  }
}

async function copyDirectoryFromPossiblyAsar(sourceDir, targetDir) {
  await fsp.mkdir(targetDir, { recursive: true })
  const entries = await fsp.readdir(sourceDir, { withFileTypes: true })
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name)
    const targetPath = path.join(targetDir, entry.name)
    if (entry.isDirectory()) {
      await copyDirectoryFromPossiblyAsar(sourcePath, targetPath)
    } else if (entry.isFile()) {
      await fsp.mkdir(path.dirname(targetPath), { recursive: true })
      await fsp.writeFile(targetPath, await fsp.readFile(sourcePath))
    }
  }
}

async function resolveVideoComprehensionRoot() {
  const resourceRoot = getVideoComprehensionRoot()
  if (await hasCompleteVideoComprehensionProject(resourceRoot)) {
    return { root: resourceRoot, source: 'resources' }
  }

  const bundledRoot = getBundledVideoComprehensionRoot()
  if (await hasCompleteVideoComprehensionProject(bundledRoot)) {
    const runtimeRoot = getRuntimeVideoComprehensionRoot()
    if (!(await hasCompleteVideoComprehensionProject(runtimeRoot))) {
      if (!isPathInside(getDefaultAnalysisRuntimeDirectory(), runtimeRoot) || path.basename(runtimeRoot) !== 'project') throw new Error('分析运行目录无效')
      await fsp.rm(runtimeRoot, { recursive: true, force: true })
      await copyDirectoryFromPossiblyAsar(bundledRoot, runtimeRoot)
    }
    if (await hasCompleteVideoComprehensionProject(runtimeRoot)) {
      return { root: runtimeRoot, source: isAsarPath(bundledRoot) ? 'asar_fallback' : 'bundled_fallback' }
    }
  }

  return {
    root: resourceRoot,
    source: 'missing',
    checkedPaths: [resourceRoot, bundledRoot, getRuntimeVideoComprehensionRoot()]
  }
}

function getOutputsDir() {
  return path.join(getDefaultAnalysisRuntimeDirectory(), 'outputs')
}

function getEnvPath() {
  return path.join(getDefaultAnalysisRuntimeDirectory(), '.env')
}

function getLegacyEnvPath() {
  return path.join(getVideoComprehensionRoot(), '.env')
}

function parseEnvText(text) {
  const values = {}
  const unsupportedKeys = []
  for (const rawLine of String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separatorIndex = line.indexOf('=')
    if (separatorIndex < 0) continue
    const key = line.slice(0, separatorIndex).trim()
    let value = line.slice(separatorIndex + 1).trim()
    // Arguments contain their own path quotes; only unwrap a complete env value.
    if (key === 'VLM_SERVER_ARGS' && value.startsWith('"')) {
      try { const decoded = JSON.parse(value); if (typeof decoded === 'string') value = decoded }
      catch { if (/^"[^"]*"$/.test(value)) value = value.slice(1, -1) }
    } else if (/^"[^"]*"$/.test(value) || /^'[^']*'$/.test(value)) value = value.slice(1, -1)
    if (ANALYSIS_ENV_KEYS.includes(key)) {
      values[key] = value
    } else {
      unsupportedKeys.push(key)
    }
  }
  return { values, unsupportedKeys }
}

function envToRuntimeConfig(values, meta = {}) {
  const merged = { ...LOCAL_DEFAULT_ANALYSIS_ENV, ...values }
  const modelStorageDir = resolveRuntimeModelStorageDir(merged.MODEL_STORAGE_DIR)
  const llmProvider = ['local', 'api'].includes(String(merged.LLM_PROVIDER || '').toLowerCase())
    ? String(merged.LLM_PROVIDER).toLowerCase()
    : LOCAL_DEFAULT_ANALYSIS_ENV.LLM_PROVIDER
  const vlmProvider = ['local', 'api'].includes(String(merged.VLM_PROVIDER || '').toLowerCase())
    ? String(merged.VLM_PROVIDER).toLowerCase()
    : LOCAL_DEFAULT_ANALYSIS_ENV.VLM_PROVIDER
  return {
    mode: merged.MODE,
    maxDurationSeconds: Number(merged.MAX_DURATION_SECONDS) || Number(LOCAL_DEFAULT_ANALYSIS_ENV.MAX_DURATION_SECONDS),
    modelStorageDir,
    llmProvider,
    llmBaseUrl: merged.LLM_BASE_URL,
    llmName: merged.LLM_NAME,
    llmApiKey: merged.LLM_API_KEY,
    vlmBaseUrl: merged.VLM_BASE_URL,
    vlmName: merged.VLM_NAME,
    vlmApiKey: merged.VLM_API_KEY,
    vlmProvider,
    vlmModelPath: resolveRuntimeVlmModelPath(merged.VLM_MODEL_PATH, modelStorageDir, merged.VLM_NAME),
    vlmModelDownloadUrl: merged.VLM_MODEL_DOWNLOAD_URL,
    vlmHfRepo: merged.VLM_HF_REPO,
    vlmHfRevision: merged.VLM_HF_REVISION || LOCAL_DEFAULT_ANALYSIS_ENV.VLM_HF_REVISION,
    vlmHfToken: merged.VLM_HF_TOKEN,
    vlmServerExecutable: getRuntimeVlmServerExecutable(merged.VLM_SERVER_EXECUTABLE),
    vlmServerArgs: merged.VLM_SERVER_ARGS,
    vlmConcurrency: Number(merged.VLM_CONCURRENCY) || Number(LOCAL_DEFAULT_ANALYSIS_ENV.VLM_CONCURRENCY),
    envPath: getEnvPath(),
    ...meta
  }
}

function validateRuntimeConfig(config) {
  if (Object.values(config).some(value => typeof value === 'string' && /[\r\n\0]/.test(value))) {
    throw new Error('分析配置字段不能包含换行或空字符')
  }
  const mode = String(config?.mode || '').trim().toLowerCase()
  const llmProvider = String(config?.llmProvider || LOCAL_DEFAULT_ANALYSIS_ENV.LLM_PROVIDER).trim().toLowerCase()
  const vlmProvider = String(config?.vlmProvider || LOCAL_DEFAULT_ANALYSIS_ENV.VLM_PROVIDER).trim().toLowerCase()
  const maxDurationSeconds = Number(config?.maxDurationSeconds)
  const vlmConcurrency = Number(config?.vlmConcurrency)
  const modelStorageDir = typeof config?.modelStorageDir === 'string' && config.modelStorageDir.trim()
    ? resolveRuntimeModelStorageDir(config.modelStorageDir)
    : resolveRuntimeModelStorageDir(getAnalysisModelDirectory())
  const vlmModelPath = resolveRuntimeVlmModelPath(
    config?.vlmModelPath,
    modelStorageDir,
    config?.vlmName || LOCAL_DEFAULT_ANALYSIS_ENV.VLM_NAME
  )
  const requiredStrings = [
    ['LLM 服务地址', config?.llmBaseUrl],
    ['LLM 模型名称', config?.llmName],
    ['LLM API Key', config?.llmApiKey],
    ['VLM 服务地址', config?.vlmBaseUrl],
    ['VLM 模型名称', config?.vlmName],
    ['VLM API Key', config?.vlmApiKey]
  ]

  if (!['fast', 'balance', 'quantity'].includes(mode)) {
    throw new Error('分析质量只能是 fast、balance 或 quantity')
  }
  if (!['local', 'api'].includes(llmProvider)) {
    throw new Error('文本模型来源只能是本地模型或外接 API')
  }
  if (!['local', 'api'].includes(vlmProvider)) {
    throw new Error('视觉模型来源只能是本地模型或外接 API')
  }
  if (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0) {
    throw new Error('最大分析时长必须大于 0')
  }
  if (!Number.isInteger(vlmConcurrency) || vlmConcurrency <= 0 || vlmConcurrency > 32) {
    throw new Error('视觉分析并发数必须是 1 到 32 的整数')
  }
  for (const [label, value] of requiredStrings) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`${label}不能为空`)
    }
  }

  return {
    MAX_DURATION_SECONDS: String(Math.round(maxDurationSeconds)),
    MODEL_STORAGE_DIR: modelStorageDir,
    LLM_PROVIDER: llmProvider,
    LLM_BASE_URL: config.llmBaseUrl.trim(),
    LLM_NAME: config.llmName.trim(),
    LLM_API_KEY: config.llmApiKey.trim(),
    VLM_BASE_URL: config.vlmBaseUrl.trim(),
    VLM_NAME: config.vlmName.trim(),
    VLM_API_KEY: config.vlmApiKey.trim(),
    VLM_PROVIDER: vlmProvider,
    VLM_MODEL_PATH: vlmModelPath,
    VLM_MODEL_DOWNLOAD_URL: typeof config.vlmModelDownloadUrl === 'string' ? config.vlmModelDownloadUrl.trim() : '',
    VLM_HF_REPO: typeof config.vlmHfRepo === 'string' ? config.vlmHfRepo.trim() : '',
    VLM_HF_REVISION: typeof config.vlmHfRevision === 'string' && config.vlmHfRevision.trim()
      ? config.vlmHfRevision.trim()
      : LOCAL_DEFAULT_ANALYSIS_ENV.VLM_HF_REVISION,
    VLM_HF_TOKEN: typeof config.vlmHfToken === 'string' ? config.vlmHfToken.trim() : '',
    VLM_SERVER_EXECUTABLE: getRuntimeVlmServerExecutable(
      typeof config.vlmServerExecutable === 'string' && config.vlmServerExecutable.trim()
        ? config.vlmServerExecutable.trim()
        : LOCAL_DEFAULT_ANALYSIS_ENV.VLM_SERVER_EXECUTABLE
    ),
    VLM_SERVER_ARGS: typeof config.vlmServerArgs === 'string' && config.vlmServerArgs.trim()
      ? config.vlmServerArgs.trim()
      : LOCAL_DEFAULT_ANALYSIS_ENV.VLM_SERVER_ARGS,
    VLM_CONCURRENCY: String(vlmConcurrency),
    MODE: mode
  }
}

function renderEnv(values) {
  return `${ANALYSIS_ENV_KEYS.map(key => `${key}=${key === 'VLM_SERVER_ARGS' ? JSON.stringify(values[key]) : values[key]}`).join('\n')}\n`
}

const runtimeConfigStore = new RuntimeConfigStore({ filename: getEnvPath, legacyFilename: getLegacyEnvPath })

function decodeRuntimeConfig(text) {
  const parsed = text === null ? { values: LOCAL_DEFAULT_ANALYSIS_ENV, unsupportedKeys: [] } : parseEnvText(text)
  return envToRuntimeConfig(parsed.values, { usingDefaults: text === null, unsupportedKeys: parsed.unsupportedKeys })
}

function ensureRuntimeEnvPath() {
  return runtimeConfigStore.materialize(() => renderEnv(validateRuntimeConfig(envToRuntimeConfig(LOCAL_DEFAULT_ANALYSIS_ENV))))
}

function getVideoAnalysisRuntimeConfig() { return runtimeConfigStore.read(decodeRuntimeConfig) }

function updateVideoAnalysisRuntimeConfig(update, options = {}) {
  return runtimeConfigStore.update(text => {
    const current = decodeRuntimeConfig(text), patch = update({ ...current })
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || typeof patch.then === 'function') throw new TypeError('分析配置修改无效')
    const values = validateRuntimeConfig({ ...current, ...patch,
      modelStorageDir: patch.modelStorageDir || current.modelStorageDir || getAnalysisModelDirectory() })
    const config = envToRuntimeConfig(values, { usingDefaults: false, unsupportedKeys: [] })
    return { text: renderEnv(values), value: config, previous: current }
  }, mutation => updateSettingsAndFlush(settings => {
    const desired = {}
    for (const config of [mutation.previous, mutation.value]) {
      const provider = config.llmProvider === 'api' ? 'api' : 'local'
      desired[provider] = { llmBaseUrl: config.llmBaseUrl || '', llmName: config.llmName || '', llmApiKey: config.llmApiKey || '' }
    }
    const section = settings.videoAnalysis || {}, profiles = {}
    for (const [provider, profile] of Object.entries(desired)) {
      if (Object.keys(profile).some(key => section.llmProfiles?.[provider]?.[key] !== profile[key])) profiles[provider] = profile
    }
    const patch = {}
    if (Object.keys(profiles).length) patch.llmProfiles = profiles
    if (options.modelDirectory && pathKey(section.modelDir || '') !== pathKey(options.modelDirectory)) patch.modelDir = options.modelDirectory
    return { patch: Object.keys(patch).length ? { videoAnalysis: patch } : {} }
  }))
}

function saveVideoAnalysisRuntimeConfig(config, options) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || typeof config.then === 'function') return Promise.reject(new TypeError('分析配置修改无效'))
  const patch = { ...config }
  return updateVideoAnalysisRuntimeConfig(() => patch, options)
}

function resetVideoAnalysisRuntimeConfig() {
  const directory = getDefaultAnalysisModelDirectory()
  return saveVideoAnalysisRuntimeConfig({ ...envToRuntimeConfig(LOCAL_DEFAULT_ANALYSIS_ENV), modelStorageDir: directory }, { modelDirectory: directory })
}

function getAnalysisResultDirectory() {
  const configuredDir = loadSettings()?.videoAnalysis?.outputDir
  if (!configuredDir) return getDefaultAnalysisResultDirectory()
  const resolvedDir = path.resolve(configuredDir)
  if (isDirectory(resolvedDir) || !looksLikeDefaultAnalysisResultDir(resolvedDir)) return resolvedDir
  return getDefaultAnalysisResultDirectory()
}

function getAnalysisModelDirectory() {
  const configuredDir = loadSettings()?.videoAnalysis?.modelDir
  if (!configuredDir) return getDefaultAnalysisModelDirectory()
  const resolvedDir = path.resolve(configuredDir)
  if (isDirectory(resolvedDir) || !looksLikeDefaultAnalysisModelDir(resolvedDir)) return resolvedDir
  return getDefaultAnalysisModelDirectory()
}

function sanitizeFileName(name) {
  return String(name || '视频')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || '视频'
}

function getVideoStableId(videoPath) {
  return crypto
    .createHash('sha1')
    .update(path.resolve(videoPath), 'utf8')
    .digest('hex')
    .slice(0, 10)
}

function getSavedAnalysisResultPath(videoPath, outputDir = getAnalysisResultDirectory()) {
  const parsed = path.parse(path.basename(videoPath))
  return path.join(outputDir, `${sanitizeFileName(parsed.name)}分析结果-${getVideoStableId(videoPath)}.json`)
}

async function removeLegacyAnalysisResults(videoPath, keepPath, outputDir = getAnalysisResultDirectory()) {
  const parsed = path.parse(path.basename(videoPath))
  const prefix = `${sanitizeFileName(parsed.name)}分析结果`
  let entries = []
  try {
    entries = await fsp.readdir(outputDir, { withFileTypes: true })
  } catch {
    return
  }

  const keepKey = pathKey(keepPath)
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.json') return
    if (!entry.name.startsWith(prefix)) return
    const candidatePath = path.join(outputDir, entry.name)
    if (pathKey(candidatePath) === keepKey) return
    const payload = await readJson(candidatePath)
    if (!payload?.sourceVideoPath || pathKey(payload.sourceVideoPath) !== pathKey(videoPath)) return
    await fsp.unlink(candidatePath).catch(() => {})
  }))
}

const analysisSaveQueues = new Map()
function saveAnalysisResult(videoPath, analysis, options = {}) {
  if (!analysis?.available) return Promise.resolve(null)
  const outputDir = getAnalysisResultDirectory(), resultPath = getSavedAnalysisResultPath(videoPath, outputDir)
  const check = async () => {
    if (options.signal?.aborted) throw options.signal.reason
    await options.authorize?.()
    if (options.signal?.aborted) throw options.signal.reason
  }
  const save = (analysisSaveQueues.get(resultPath) || Promise.resolve()).catch(() => {}).then(async () => {
    await check(); await fsp.mkdir(outputDir, { recursive: true }); await check()
    const temporary = resultPath + '.' + crypto.randomUUID() + '.tmp'
    let previous = null, committed = false
    try { previous = await fsp.readFile(resultPath) } catch (error) { if (error.code !== 'ENOENT') throw error }
    try {
      const payload = { savedAt: new Date().toISOString(), sourceVideoPath: path.resolve(videoPath), resultFileName: path.basename(resultPath), analysis }
      await fsp.writeFile(temporary, JSON.stringify(payload, null, 2), 'utf8')
      await check(); await fsp.rename(temporary, resultPath); committed = true
      await check()
      if (!options.signal) await removeLegacyAnalysisResults(videoPath, resultPath, outputDir)
      await check()
      return resultPath
    } catch (error) {
      if (committed) {
        if (previous) { await fsp.writeFile(temporary, previous); await fsp.rename(temporary, resultPath) }
        else await fsp.unlink(resultPath).catch(() => {})
      }
      throw error
    } finally { await fsp.unlink(temporary).catch(() => {}) }
  })
  analysisSaveQueues.set(resultPath, save)
  const release = () => { if (analysisSaveQueues.get(resultPath) === save) analysisSaveQueues.delete(resultPath) }
  save.then(release, release)
  return save
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

function rememberAnalysisEvent(payload) {
  if (!payload?.videoPath) return
  const key = pathKey(payload.videoPath)
  recentAnalysisEvents.set(key, {
    ...payload,
    updatedAt: Date.now()
  })
  if (recentAnalysisEvents.size <= RECENT_ANALYSIS_EVENT_LIMIT) return
  const oldestKey = recentAnalysisEvents.keys().next().value
  if (oldestKey) recentAnalysisEvents.delete(oldestKey)
}

function getRecentAnalysisEvent(videoPath) {
  if (!videoPath) return null
  return recentAnalysisEvents.get(pathKey(videoPath)) || null
}

function emitAnalysisEvent(sender, payload) {
  rememberAnalysisEvent(payload)
  const sentWebContents = new Set()
  const sendTo = (target) => {
    if (!target || target.isDestroyed?.()) return
    if (payload.videoPath && !core('media-access').canReadPath(payload.videoPath, target.id)) return
    target.send('video-analysis-event', payload)
    sentWebContents.add(target.id)
  }

  sendTo(sender)
  for (const win of BrowserWindow.getAllWindows()) {
    const webContents = win.webContents
    if (!sentWebContents.has(webContents.id)) sendTo(webContents)
  }
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
  if (job.cancelled || job.abort.signal.aborted || activeJob !== job) return
  if (Buffer.byteLength(job.outputBuffer, 'utf8') + Buffer.byteLength(text, 'utf8') > ANALYSIS_OUTPUT_LIMIT) {
    job.failure = new Error('分析输出过大，已停止任务')
    job.abort.abort(job.failure)
    return
  }
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

async function readLatestJobError(videoPath) {
  const analysis = await findGeneratedAnalysisResult(videoPath)
  const taskDir = analysis?.available ? analysis.taskDir : null
  if (!taskDir) {
    const failedTaskDir = await findTaskDirByManifestPath(videoPath)
    return failedTaskDir ? readLatestErrorFromTaskDir(failedTaskDir) : null
  }
  return readLatestErrorFromTaskDir(taskDir)
}

async function readLatestErrorFromTaskDir(taskDir) {
  const errors = await readJson(path.join(taskDir, 'logs', 'errors.json'))
  if (Array.isArray(errors) && errors.length) {
    const latest = errors[errors.length - 1]
    if (latest?.message) return latest.message
  }

  let lines = []
  try {
    lines = String(await fsp.readFile(path.join(taskDir, 'logs', 'pipeline_events.jsonl'), 'utf-8')).trim().split(/\r?\n/)
  } catch {
    return null
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const event = JSON.parse(lines[index])
    if (event?.status === 'error' && event.message) return event.message
  }
  return null
}

function isLocalHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase()
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '0:0:0:0:0:0:0:1' ||
    host === '0.0.0.0' ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  )
}

function getLocalEndpoint(label, baseUrl, modelName) {
  try {
    const url = new URL(baseUrl)
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (!isLocalHost(host)) return null
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
    if (!Number.isInteger(port) || port <= 0) return null
    return {
      label,
      baseUrl,
      modelName,
      host: host === '0.0.0.0' ? '127.0.0.1' : host,
      port
    }
  } catch {
    return null
  }
}

function canConnect(endpoint, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: endpoint.host, port: endpoint.port })
    const finish = (ok) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

async function checkLocalModelServices() {
  const config = await getVideoAnalysisRuntimeConfig()
  const endpoints = [
    config.llmProvider === 'api' ? null : getLocalEndpoint('LLM', config.llmBaseUrl, config.llmName),
    config.vlmProvider === 'api' ? null : getLocalEndpoint('VLM', config.vlmBaseUrl, config.vlmName)
  ].filter(Boolean)

  if (!endpoints.length) return { ok: true }

  const failures = []
  for (const endpoint of endpoints) {
    const connected = await canConnect(endpoint)
    if (!connected) failures.push(endpoint)
  }

  if (!failures.length) return { ok: true }
  const detail = failures
    .map(item => `${item.label} ${item.baseUrl}（${item.modelName}）`)
    .join('；')
  const hasVlmFailure = failures.some(item => item.label === 'VLM')
  return {
    ok: false,
    error: `本地模型服务未启动或端口不可用：${detail}。${hasVlmFailure ? LOCAL_VLM_SETUP_HINT : '请先启动对应的 OpenAI 兼容模型服务，或在设置里改为可用服务地址。'}`
  }
}

async function startVideoAnalysis(videoPath, sender, options = {}) {
  if (analysisClosing) return { accepted: false, reason: 'stopping', error: '分析服务正在关闭' }
  if (activeJob) return { accepted: false, reason: 'already_running', job: getActiveAnalysisJob() }
  const scheduler = core('application/resource-scheduler').mediaScheduler
  const lifecycle = core('process-lifecycle')
  const scanner = core('scanner')
  const job = { jobId: 'analysis_' + Date.now() + '_' + (++activeJobSeq), videoPath: path.resolve(videoPath),
    startedAt: Date.now(), lastEvent: null, outputBuffer: '', process: null, abort: new AbortController(), cancelled: false }
  activeJob = job
  const check = context => {
    context.throwIfAborted()
    if (analysisClosing || activeJob !== job || job.cancelled) throw new Error('分析任务已结束')
  }
  const authorize = options.authorize || (() => scanner.assertAllowedVideoPath(job.videoPath, { audience: sender ? 'desktop' : 'remote', senderId: sender?.id }))
  const timeoutMs = Math.max(1, Math.min(ANALYSIS_WAIT_MS, Number(options.timeoutMs) || ANALYSIS_WAIT_MS))
  job.completion = scheduler.enqueue({ key: 'analysis:' + job.jobId, type: 'analysis', groupLimit: 1,
    priority: 50, timeoutMs, signal: job.abort.signal }, async context => {
    job.context = context
    let child, abortProcess, outputReceived, processError
    try {
      check(context); await authorize(); check(context)
      const project = await resolveVideoComprehensionRoot()
      check(context)
      if (project.source === 'missing') throw new Error('未找到完整的视频理解项目，请检查安装目录或重新安装分析运行文件')
      const serviceCheck = await checkLocalModelServices()
      check(context)
      if (!serviceCheck.ok) throw new Error(serviceCheck.error)
      const modelDir = getAnalysisModelDirectory(), envPath = await ensureRuntimeEnvPath(), outputsDir = getOutputsDir()
      await fsp.mkdir(path.dirname(envPath), { recursive: true }); await fsp.mkdir(outputsDir, { recursive: true })
      check(context); await authorize(); check(context)
      const spec = lifecycle.workerSpawnSpec('uv', ['run', 'video-comprehension', job.videoPath], {
        cwd: project.root, windowsHide: true, detached: process.platform !== 'win32', shell: false,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', VIDEO_COMPREHENSION_ENV: envPath,
          VIDEO_COMPREHENSION_OUTPUT_DIR: outputsDir, HF_HOME: path.join(modelDir, 'huggingface'),
          HUGGINGFACE_HUB_CACHE: path.join(modelDir, 'huggingface', 'hub') }
      })
      child = spawn(spec.file, spec.args, spec.options); job.process = child
      abortProcess = () => { void lifecycle.stopProcessTree(child, { processGroup: process.platform !== 'win32' }).catch(() => {}) }
      context.signal.addEventListener('abort', abortProcess, { once: true })
      child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8')
      outputReceived = chunk => handleProcessOutput(job, sender, chunk)
      child.stdout?.on('data', outputReceived)
      child.stderr?.on('data', outputReceived)
      const closed = await new Promise(resolve => {
        processError = error => { job.failure = error; job.abort.abort(error) }
        child.on('error', processError)
        child.once('close', (code, signal) => resolve({ code, signal }))
      })
      job.process = null
      check(context)
      if (job.failure) throw job.failure
      if (job.outputBuffer.trim()) handleProcessOutput(job, sender, '\n')
      if (closed.code !== 0) throw new Error(await readLatestJobError(job.videoPath) || '视频理解管线退出：' + closed.code)
      const analysis = await findGeneratedAnalysisResult(job.videoPath)
      check(context); await authorize(); check(context)
      if (!analysis?.available) throw new Error('分析流程已结束，但没有找到可保存的分析结果')
      let savedResultPath
      try { savedResultPath = await saveAnalysisResult(job.videoPath, analysis, { signal: context.signal, authorize }) } catch (error) { analysis.saveError = error?.message || '保存分析结果失败' }
      check(context)
      emitAnalysisEvent(sender, { jobId: job.jobId, videoPath: job.videoPath, status: 'success', analysis, savedResultPath })
    } catch (error) {
      const cancelled = job.cancelled || analysisClosing
      const message = cancelled ? '分析已取消' : context.signal.reason?.code === 'task_timeout' ? '分析超过最长等待时间，请缩短视频后重试' : job.failure?.message || error?.message || '分析失败'
      emitAnalysisEvent(sender, { jobId: job.jobId, videoPath: job.videoPath, status: cancelled ? 'cancelled' : 'error', error: message })
    } finally {
      if (abortProcess) context.signal.removeEventListener('abort', abortProcess)
      if (outputReceived) { child?.stdout?.off('data', outputReceived); child?.stderr?.off('data', outputReceived) }
      if (processError) child?.off('error', processError)
      if (activeJob === job) activeJob = null
      job.outputBuffer = ''
    }
  }).catch(error => {
    // A queued job may be cancelled before its worker is entered; an active worker retains ownership until cleanup.
    if (!job.context && activeJob === job) {
      emitAnalysisEvent(sender, { jobId: job.jobId, videoPath: job.videoPath, status: job.cancelled || analysisClosing ? 'cancelled' : 'error', error: error?.message || '分析失败' })
      activeJob = null
    }
  })
  emitAnalysisEvent(sender, { jobId: job.jobId, videoPath: job.videoPath, status: 'started', message: '分析任务已排队' })
  return { accepted: true, job: getActiveAnalysisJob() }
}

function cancelVideoAnalysis(jobId) {
  if (!activeJob) return { cancelled: false, reason: 'not_running' }
  if (jobId && activeJob.jobId !== jobId) return { cancelled: false, reason: 'job_mismatch' }
  const job = activeJob; job.cancelled = true; job.abort.abort(new Error('分析已取消'))
  return { cancelled: true, jobId: job.jobId }
}

async function disposeVideoAnalysis() {
  analysisClosing = true
  await analysisTaskService.dispose()
  const scheduler = core('application/resource-scheduler').mediaScheduler
  cancelVideoAnalysis()
  await activeJob?.completion
  await scheduler.waitForIdle(['analysis'])
}
function disposeRuntimeConfiguration() { return runtimeConfigStore.close() }
function resumeVideoAnalysis() { if (!activeJob) { analysisClosing = false; analysisTaskService.resume(); runtimeConfigStore.resume() } }

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

async function findTaskDirByManifestPath(videoPath) {
  const outputsDir = getOutputsDir()
  let entries = []
  try {
    entries = await fsp.readdir(outputsDir, { withFileTypes: true })
  } catch {
    return null
  }

  const resolvedPath = path.resolve(videoPath)
  const matches = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const taskDir = path.join(outputsDir, entry.name)
    const manifest = await readJson(path.join(taskDir, 'input', 'input_manifest.json'))
    if (!manifest || pathKey(manifest.video_path) !== pathKey(resolvedPath)) continue
    let mtimeMs = 0
    try {
      mtimeMs = (await fsp.stat(taskDir)).mtimeMs
    } catch {}
    matches.push({ taskDir, mtimeMs })
  }

  matches.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return matches[0]?.taskDir || null
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

function matchesCandidateManifestPath(candidate, videoPath) {
  const manifestPath = candidate.manifest?.video_path
  return typeof manifestPath === 'string' && pathKey(manifestPath) === pathKey(videoPath)
}

function matchesCandidateFilenameAndSize(candidate, result, fileName, fileSizeBytes) {
  const manifest = candidate.manifest || {}
  const source = result?.source_video || {}
  const manifestName = typeof manifest.video_path === 'string' ? path.basename(manifest.video_path) : ''
  const sourceName = typeof source.original_filename === 'string' ? source.original_filename : ''
  const manifestSize = Number(manifest.file_size_bytes)
  const sourceSize = Number(source.file_size_bytes)
  const nameMatch = [manifestName, sourceName]
    .filter(Boolean)
    .some(name => name.toLowerCase() === fileName.toLowerCase())
  const sizeMatch = [manifestSize, sourceSize]
    .filter(Number.isFinite)
    .some(size => size === fileSizeBytes)
  return nameMatch && sizeMatch
}

async function findGeneratedAnalysisResult(videoPath) {
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

  let stats = null
  try {
    stats = await fsp.stat(resolvedPath)
  } catch {}

  const pathMatch = candidates.find(candidate => matchesCandidateManifestPath(candidate, resolvedPath))
  if (pathMatch) {
    const result = await readJson(pathMatch.resultPath)
    if (result && typeof result === 'object') return compactResult(result, pathMatch, 'path')
  }

  if (stats?.isFile()) {
    const fileName = path.basename(resolvedPath)
    for (const candidate of candidates) {
      const result = await readJson(candidate.resultPath)
      if (result && matchesCandidateFilenameAndSize(candidate, result, fileName, stats.size)) {
        return compactResult(result, candidate, 'filename_size')
      }
    }

    const hash = await fileSha256(resolvedPath)
    if (hash) {
      for (const candidate of candidates) {
        const manifestHash = candidate.manifest?.file_hash
        if (typeof manifestHash === 'string' && manifestHash === hash) {
          const result = await readJson(candidate.resultPath)
          if (result && typeof result === 'object') return compactResult(result, candidate, 'hash')
        }
      }

      for (const candidate of candidates) {
        const result = await readJson(candidate.resultPath)
        if (result?.source_video?.file_hash === hash) return compactResult(result, candidate, 'hash')
      }
    }
  }

  return {
    available: false,
    reason: 'not_found',
    outputsDir
  }
}

async function collectSavedResults(outputDir) {
  let entries = []
  try {
    entries = await fsp.readdir(outputDir, { withFileTypes: true })
  } catch {
    return []
  }

  const results = []
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.json') continue
    const resultPath = path.join(outputDir, entry.name)
    const payload = await readJson(resultPath)
    if (!payload?.analysis || typeof payload.analysis !== 'object') continue
    results.push({
      resultPath,
      fileName: entry.name,
      savedAt: payload.savedAt || '',
      sourceVideoPath: typeof payload.sourceVideoPath === 'string' ? payload.sourceVideoPath : '',
      analysis: payload.analysis
    })
  }
  return results.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)))
}

function matchesSavedResult(saved, resolvedPath, fileName, fileSizeBytes, currentHash) {
  if (saved.sourceVideoPath && pathKey(saved.sourceVideoPath) === pathKey(resolvedPath)) return true

  const sourceVideo = saved.analysis?.sourceVideo || {}
  const sourceName = typeof sourceVideo.original_filename === 'string' ? sourceVideo.original_filename : ''
  const sourceSize = Number(sourceVideo.file_size_bytes)
  if (sourceName && sourceName.toLowerCase() === fileName.toLowerCase() && sourceSize === fileSizeBytes) return true

  const sourceHash = typeof sourceVideo.file_hash === 'string' ? sourceVideo.file_hash : ''
  return Boolean(currentHash && sourceHash && sourceHash === currentHash)
}

function findMatchingVideoForSavedResult(saved, videoLookup) {
  if (saved.sourceVideoPath) {
    const byPath = videoLookup.byPath.get(pathKey(saved.sourceVideoPath))
    if (byPath) return byPath
  }

  const sourceVideo = saved.analysis?.sourceVideo || {}
  const sourceName = typeof sourceVideo.original_filename === 'string' ? sourceVideo.original_filename : ''
  const sourceSize = Number(sourceVideo.file_size_bytes)
  if (sourceName && Number.isFinite(sourceSize)) {
    const byNameAndSize = videoLookup.byNameAndSize.get(`${sourceName.toLowerCase()}:${sourceSize}`)
    if (byNameAndSize) return byNameAndSize
  }

  return null
}

async function listSavedAnalysisResultsForVideos(videos = []) {
  const normalizedVideos = Array.isArray(videos)
    ? videos
        .map(video => ({
          videoPath: typeof video?.videoPath === 'string' ? video.videoPath : '',
          videoName: typeof video?.videoName === 'string' ? video.videoName : '',
          fileSizeBytes: Number(video?.fileSizeBytes) || 0
        }))
        .filter(video => video.videoPath)
    : []

  if (!normalizedVideos.length) return { success: true, results: [] }

  const videoLookup = {
    byPath: new Map(),
    byNameAndSize: new Map()
  }
  for (const video of normalizedVideos) {
    const resolvedPath = path.resolve(video.videoPath)
    const videoName = video.videoName || path.basename(resolvedPath)
    const fileName = path.basename(resolvedPath)
    const fileSizeBytes = Number(video.fileSizeBytes) || 0
    const normalizedVideo = {
      videoPath: resolvedPath,
      videoName,
      fileName,
      fileSizeBytes
    }
    videoLookup.byPath.set(pathKey(resolvedPath), normalizedVideo)
    if (fileSizeBytes) {
      videoLookup.byNameAndSize.set(`${fileName.toLowerCase()}:${fileSizeBytes}`, normalizedVideo)
    }
  }

  const savedResults = await collectSavedResults(getAnalysisResultDirectory())
  const results = []
  const usedVideoPaths = new Set()
  for (const saved of savedResults) {
    const video = findMatchingVideoForSavedResult(saved, videoLookup)
    if (!video || usedVideoPaths.has(pathKey(video.videoPath))) continue
    usedVideoPaths.add(pathKey(video.videoPath))
    results.push({
      id: `saved-analysis-${Buffer.from(saved.resultPath).toString('base64url')}`,
      videoPath: video.videoPath,
      videoName: video.videoName || video.fileName,
      savedAt: saved.savedAt,
      savedResultPath: saved.resultPath,
      analysis: {
        ...saved.analysis,
        available: saved.analysis.available !== false,
        matchType: saved.analysis.matchType || 'saved_result',
        savedResultPath: saved.resultPath,
        savedAt: saved.savedAt
      }
    })
  }

  results.sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')))
  return { success: true, results }
}

async function deleteSavedAnalysisResult(resultPath) {
  if (typeof resultPath !== 'string' || !resultPath.trim()) {
    return { success: false, error: '分析结果路径无效' }
  }

  const resolvedPath = path.resolve(resultPath)
  const ext = path.extname(resolvedPath).toLowerCase()
  const resultDir = path.resolve(getAnalysisResultDirectory())
  const insideSavedResultDir = isPathInside(resultDir, resolvedPath)

  if (ext !== '.json' || !insideSavedResultDir) {
    return { success: false, error: '只能删除分析结果保存目录下的 JSON 结果文件' }
  }

  try {
    await fsp.unlink(resolvedPath)
    return { success: true, deletedPath: resolvedPath }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

async function findSavedAnalysisResult(resolvedPath, stats, currentHash) {
  const outputDir = getAnalysisResultDirectory()
  const savedResults = await collectSavedResults(outputDir)
  if (!savedResults.length) return null

  const fileName = path.basename(resolvedPath)
  const fileSizeBytes = stats?.isFile() ? stats.size : 0
  const saved = savedResults.find(item => matchesSavedResult(item, resolvedPath, fileName, fileSizeBytes, currentHash))
  if (!saved) return null

  return {
    ...saved.analysis,
    available: saved.analysis.available !== false,
    matchType: saved.analysis.matchType || 'saved_result',
    savedResultPath: saved.resultPath,
    savedAt: saved.savedAt
  }
}

async function findVideoAnalysis(videoPath) {
  const resolvedPath = path.resolve(videoPath)
  const outputsDir = getOutputsDir()

  let stats
  try {
    stats = await fsp.stat(resolvedPath)
  } catch {
    stats = null
  }

  let currentHash = ''
  let hashLoaded = false
  const getCurrentHash = async () => {
    if (hashLoaded) return currentHash
    hashLoaded = true
    currentHash = stats?.isFile() ? await fileSha256(resolvedPath) : ''
    return currentHash
  }

  let savedAnalysis = await findSavedAnalysisResult(resolvedPath, stats, '')
  if (!savedAnalysis) savedAnalysis = await findSavedAnalysisResult(resolvedPath, stats, await getCurrentHash())
  if (savedAnalysis) return savedAnalysis

  return {
    available: false,
    reason: 'not_found',
    outputsDir
  }
}

const analysisTaskService = require('./task-interests').createAnalysisTaskService({ startVideoAnalysis, cancelVideoAnalysis, getActiveAnalysisJob })
module.exports = {
  analysisTaskService,
  findVideoAnalysis,
  listSavedAnalysisResultsForVideos,
  deleteSavedAnalysisResult,
  startVideoAnalysis,
  cancelVideoAnalysis,
  disposeVideoAnalysis,
  disposeRuntimeConfiguration,
  resumeVideoAnalysis,
  getActiveAnalysisJob,
  getRecentAnalysisEvent,
  getOutputsDir,
  getAnalysisResultDirectory,
  getAnalysisModelDirectory,
  getSavedAnalysisResultPath,
  saveAnalysisResult,
  getVideoAnalysisRuntimeConfig,
  saveVideoAnalysisRuntimeConfig,
  updateVideoAnalysisRuntimeConfig,
  resetVideoAnalysisRuntimeConfig,
  getVideoComprehensionRoot
}
