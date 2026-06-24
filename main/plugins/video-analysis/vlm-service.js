const fs = require('fs')
const fsp = require('fs/promises')
const http = require('http')
const https = require('https')
const net = require('net')
const path = require('path')
const { execFileSync, spawn } = require('child_process')
const { BrowserWindow } = require('electron')
const { core } = require('./core')
const { getResourcePath } = core('paths')
const { getAnalysisModelDirectory, getVideoAnalysisRuntimeConfig, saveVideoAnalysisRuntimeConfig } = require('./service')

let vlmProcess = null
let vlmLastOutput = ''
let vlmDownload = null
function getPluginResourcePath(...segments) {
  return path.join(__dirname, 'resources', ...segments)
}

function getPreferredResourcePath(...segments) {
  const pluginPath = getPluginResourcePath(...segments)
  if (fs.existsSync(pluginPath)) return pluginPath
  return getResourcePath(...segments)
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

const BUNDLED_LLAMA_SERVER_PATH = getPreferredResourcePath('vendor', 'llama.cpp', 'llama-server.exe')
const BUNDLED_LLAMA_CUDA_SERVER_PATH = getPreferredResourcePath('vendor', 'llama.cpp-cuda', 'llama-server.exe')
const HF_MODEL_EXTENSIONS = new Set(['.gguf', '.bin', '.safetensors', '.onnx', '.pt', '.pth'])
const DEFAULT_VLM_MODEL_ID = 'huihui-qwen35-9b-claude-opus'
const DEFAULT_VLM_PRECISION = 'Q4_K_M'
const VLM_PRECISION_ALIASES = {
  Q4_KM: 'Q4_K_M',
  Q5_KM: 'Q5_K_M',
  Q3_KM: 'Q3_K_M',
  Q6K: 'Q6_K',
  Q80: 'Q8_0'
}
const VLM_MODEL_PRECISIONS = [
  { id: 'Q4_K_M', name: 'Q4_K_M', note: '推荐，速度和质量平衡' },
  { id: 'Q5_K_M', name: 'Q5_K_M', note: '质量更高，占用更大' },
  { id: 'Q6_K', name: 'Q6_K', note: '质量更高，占用更大' },
  { id: 'Q8_0', name: 'Q8_0', note: '高精度，占用最大' },
  { id: 'BF16', name: 'BF16', note: '原始精度，占用最大' }
]
const VLM_MODEL_PRESETS = [
  {
    id: DEFAULT_VLM_MODEL_ID,
    name: 'Huihui Qwen3.5 9B Claude 4.6 Opus',
    repo: 'mradermacher/Huihui-Qwen3.5-9B-Claude-4.6-Opus-abliterated-GGUF',
    revision: 'main',
    files: {
      Q4_K_M: 'Huihui-Qwen3.5-9B-Claude-4.6-Opus-abliterated.Q4_K_M.gguf',
      Q5_K_M: 'Huihui-Qwen3.5-9B-Claude-4.6-Opus-abliterated.Q5_K_M.gguf',
      Q6_K: 'Huihui-Qwen3.5-9B-Claude-4.6-Opus-abliterated.Q6_K.gguf',
      Q8_0: 'Huihui-Qwen3.5-9B-Claude-4.6-Opus-abliterated.Q8_0.gguf'
    }
  },
  {
    id: 'qwen35-4b-hauhaucs-aggressive',
    name: 'Qwen3.5 4B Uncensored HauhauCS Aggressive',
    repo: 'HauhauCS/Qwen3.5-4B-Uncensored-HauhauCS-Aggressive',
    revision: 'main',
    files: {
      Q4_K_M: 'Qwen3.5-4B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf',
      Q6_K: 'Qwen3.5-4B-Uncensored-HauhauCS-Aggressive-Q6_K.gguf',
      Q8_0: 'Qwen3.5-4B-Uncensored-HauhauCS-Aggressive-Q8_0.gguf',
      BF16: 'Qwen3.5-4B-Uncensored-HauhauCS-Aggressive-BF16.gguf'
    }
  },
  {
    id: 'minicpm-v-46-thinking-max',
    name: 'MiniCPM-V 4.6 Thinking MAX',
    repo: 'prithivMLmods/MiniCPM-V-4.6-Thinking-abliterated-MAX-GGUF',
    revision: 'main',
    files: {
      Q4_K_M: 'MiniCPM-V-4.6-Thinking-abliterated-MAX.Q4_K_M.gguf',
      Q5_K_M: 'MiniCPM-V-4.6-Thinking-abliterated-MAX.Q5_K_M.gguf',
      Q6_K: 'MiniCPM-V-4.6-Thinking-abliterated-MAX.Q6_K.gguf',
      Q8_0: 'MiniCPM-V-4.6-Thinking-abliterated-MAX.Q8_0.gguf',
      BF16: 'MiniCPM-V-4.6-Thinking-abliterated-MAX.BF16.gguf'
    }
  }
]

function emitVlmEvent(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    const webContents = win.webContents
    if (!webContents || webContents.isDestroyed?.()) continue
    webContents.send('video-analysis-vlm-event', payload)
  }
}

function getPortFromBaseUrl(baseUrl) {
  try {
    const url = new URL(baseUrl)
    return Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  } catch {
    return 5803
  }
}

function getHostFromBaseUrl(baseUrl) {
  try {
    const url = new URL(baseUrl)
    return url.hostname || '127.0.0.1'
  } catch {
    return '127.0.0.1'
  }
}

function canConnect(host, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port })
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

function requestVlmModels(baseUrl, timeoutMs = 1200) {
  return new Promise((resolve) => {
    let url
    try {
      url = new URL('/v1/models', baseUrl)
    } catch {
      resolve({ ok: false, error: 'VLM 服务地址格式不正确' })
      return
    }
    const client = url.protocol === 'https:' ? https : http
    const request = client.get(url, (response) => {
      response.resume()
      resolve({ ok: response.statusCode === 200, statusCode: response.statusCode })
    })
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('timeout'))
    })
    request.on('error', (err) => {
      resolve({ ok: false, error: err.message })
    })
  })
}

async function waitForVlmReady(baseUrl, timeoutMs = 240000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const result = await requestVlmModels(baseUrl, 1500)
    if (result.ok) return true
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  return false
}

function isLlamaServerExecutable(executablePath) {
  return path.basename(String(executablePath || '')).toLowerCase().includes('llama-server')
}

function normalizePathKey(inputPath) {
  return path.resolve(String(inputPath || '')).toLowerCase()
}

function getPreferredBundledLlamaServer(configuredPath) {
  if (
    fs.existsSync(BUNDLED_LLAMA_CUDA_SERVER_PATH) &&
    (!configuredPath || isBundledLlamaServerPath(configuredPath, 'llama.cpp-cuda'))
  ) {
    return BUNDLED_LLAMA_CUDA_SERVER_PATH
  }
  if (
    fs.existsSync(BUNDLED_LLAMA_CUDA_SERVER_PATH) &&
    (!configuredPath || normalizePathKey(configuredPath) === normalizePathKey(BUNDLED_LLAMA_SERVER_PATH) || isBundledLlamaServerPath(configuredPath, 'llama.cpp'))
  ) {
    return BUNDLED_LLAMA_CUDA_SERVER_PATH
  }
  if (
    fs.existsSync(BUNDLED_LLAMA_SERVER_PATH) &&
    (!configuredPath || isBundledLlamaServerPath(configuredPath, 'llama.cpp'))
  ) {
    return BUNDLED_LLAMA_SERVER_PATH
  }
  const configuredExists = Boolean(configuredPath && fs.existsSync(configuredPath))
  if (configuredPath && configuredExists) return configuredPath
  return configuredPath || BUNDLED_LLAMA_SERVER_PATH
}

function hasMmprojArg(args) {
  const values = new Set(['--mmproj', '-mm', '--mmproj-url', '-mmu', '--mmproj-auto', '--no-mmproj', '--no-mmproj-auto'])
  return args.some(arg => values.has(String(arg).toLowerCase()))
}

function hasAnyArg(args, names) {
  const values = new Set(names.map(name => String(name).toLowerCase()))
  return args.some(arg => values.has(String(arg).toLowerCase()))
}

function scoreMmprojCandidate(candidate) {
  const name = candidate.name.toLowerCase()
  let score = 0
  if (name.includes('mmproj')) score += 4
  if (name.includes('projector')) score += 3
  if (name.includes('f16')) score += 2
  if (name.endsWith('.gguf')) score += 1
  return score
}

function findAutoMmprojPath(modelPath) {
  if (!modelPath || !fs.existsSync(modelPath)) return ''
  let entries = []
  try {
    entries = fs.readdirSync(path.dirname(modelPath), { withFileTypes: true })
  } catch {
    return ''
  }
  const modelPathKey = path.resolve(modelPath).toLowerCase()
  const candidates = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const fullPath = path.join(path.dirname(modelPath), entry.name)
    const lowerName = entry.name.toLowerCase()
    if (path.resolve(fullPath).toLowerCase() === modelPathKey) continue
    if (path.extname(entry.name).toLowerCase() !== '.gguf') continue
    if (!lowerName.includes('mmproj') && !lowerName.includes('projector')) continue
    let size = 0
    try {
      size = fs.statSync(fullPath).size
    } catch {}
    candidates.push({ name: entry.name, path: fullPath, size })
  }
  candidates.sort((a, b) => scoreMmprojCandidate(b) - scoreMmprojCandidate(a) || b.size - a.size || a.name.localeCompare(b.name))
  return candidates[0]?.path || ''
}

function buildServerArgs(config, serverExecutable) {
  const args = splitCommandLine(renderArgsTemplate(config.vlmServerArgs, config))
  const autoMmprojPath = findAutoMmprojPath(config.vlmModelPath)
  if (!isLlamaServerExecutable(serverExecutable)) {
    return { args, autoMmprojPath: '' }
  }
  if (autoMmprojPath && !hasMmprojArg(args)) {
    args.push('--mmproj', autoMmprojPath)
  }
  if (!hasAnyArg(args, ['--reasoning', '-rea'])) {
    args.push('--reasoning', 'off')
  }
  if (!hasAnyArg(args, ['--reasoning-budget'])) {
    args.push('--reasoning-budget', '0')
  }
  if (!hasAnyArg(args, ['--reasoning-format'])) {
    args.push('--reasoning-format', 'none')
  }
  if (normalizePathKey(serverExecutable) === normalizePathKey(BUNDLED_LLAMA_CUDA_SERVER_PATH) && !hasAnyArg(args, ['--gpu-layers', '--n-gpu-layers', '-ngl'])) {
    args.push('--n-gpu-layers', '999')
  }
  if (autoMmprojPath && !hasAnyArg(args, ['--image-min-tokens'])) {
    args.push('--image-min-tokens', '1024')
  }
  return { args, autoMmprojPath }
}

async function getVlmServiceState() {
  const config = await getVideoAnalysisRuntimeConfig()
  const serverExecutable = getPreferredBundledLlamaServer(config.vlmServerExecutable)
  const host = getHostFromBaseUrl(config.vlmBaseUrl)
  const port = getPortFromBaseUrl(config.vlmBaseUrl)
  const modelExists = Boolean(config.vlmModelPath && fs.existsSync(config.vlmModelPath))
  const connected = config.vlmProvider === 'api'
    ? await canConnect(host === '0.0.0.0' ? '127.0.0.1' : host, port)
    : (await requestVlmModels(config.vlmBaseUrl)).ok
  const autoMmprojPath = config.vlmProvider === 'api' ? '' : findAutoMmprojPath(config.vlmModelPath)

  return {
    provider: config.vlmProvider,
    baseUrl: config.vlmBaseUrl,
    modelName: config.vlmName,
    modelPath: config.vlmModelPath,
    modelDownloadUrl: config.vlmModelDownloadUrl,
    hfRepo: config.vlmHfRepo,
    hfRevision: config.vlmHfRevision,
    hfTokenConfigured: Boolean(config.vlmHfToken),
    serverExecutable,
    serverArgs: config.vlmServerArgs,
    autoMmprojPath,
    modelExists,
    running: Boolean(vlmProcess && !vlmProcess.killed),
    connected,
    downloading: Boolean(vlmDownload),
    download: vlmDownload ? vlmDownload.progress : null,
    lastOutput: vlmLastOutput
  }
}

function normalizeHuggingFaceRepo(input) {
  const value = String(input || '').trim()
  if (!value) return ''
  try {
    const url = new URL(value)
    if (!url.hostname.endsWith('huggingface.co')) return value
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts[0] === 'models') parts.shift()
    return parts.slice(0, 2).join('/')
  } catch {
    return value.replace(/^models\//, '').replace(/^\/+|\/+$/g, '')
  }
}

function getHuggingFaceResolveUrl(repo, revision, filename) {
  return `https://huggingface.co/${repo}/resolve/${encodeURIComponent(revision || 'main')}/${filename.split('/').map(encodeURIComponent).join('/')}`
}

function getHuggingFaceApiUrl(repo, revision) {
  const encodedRepo = repo.split('/').map(encodeURIComponent).join('/')
  const url = new URL(`https://huggingface.co/api/models/${encodedRepo}`)
  url.searchParams.set('blobs', 'false')
  if (revision) url.searchParams.set('revision', revision)
  return url.toString()
}

function normalizePrecision(input) {
  const raw = String(input || DEFAULT_VLM_PRECISION).trim()
  const normalized = raw.toUpperCase().replace(/[-.\s]/g, '_')
  return VLM_PRECISION_ALIASES[normalized.replace(/_/g, '')] || VLM_PRECISION_ALIASES[normalized] || normalized
}

function getVlmModelOptions() {
  return {
    defaultModelId: DEFAULT_VLM_MODEL_ID,
    defaultPrecision: DEFAULT_VLM_PRECISION,
    precisions: VLM_MODEL_PRECISIONS,
    models: VLM_MODEL_PRESETS.map(preset => ({
      id: preset.id,
      name: preset.name,
      repo: preset.repo,
      revision: preset.revision,
      precisions: Object.keys(preset.files)
    }))
  }
}

function resolveVlmModelPreset(modelId, precision) {
  const preset = VLM_MODEL_PRESETS.find(item => item.id === modelId) || VLM_MODEL_PRESETS[0]
  const normalizedPrecision = normalizePrecision(precision)
  const filename = preset.files[normalizedPrecision] || preset.files[DEFAULT_VLM_PRECISION]
  const resolvedPrecision = preset.files[normalizedPrecision] ? normalizedPrecision : DEFAULT_VLM_PRECISION
  if (!filename) {
    throw new Error(`模型 ${preset.name} 没有可下载的 ${precision || DEFAULT_VLM_PRECISION} 精度文件`)
  }
  return {
    id: preset.id,
    name: preset.name,
    repo: preset.repo,
    revision: preset.revision || 'main',
    precision: resolvedPrecision,
    filename,
    downloadUrl: getHuggingFaceResolveUrl(preset.repo, preset.revision || 'main', filename)
  }
}

async function applyVlmModelPreset(modelId, precision) {
  const current = await getVideoAnalysisRuntimeConfig()
  const selected = resolveVlmModelPreset(modelId, precision)
  const modelDir = path.join(current.modelStorageDir || getAnalysisModelDirectory(), 'vlm')
  const modelPath = path.join(modelDir, path.basename(selected.filename))
  const config = await saveVideoAnalysisRuntimeConfig({
    ...current,
    vlmProvider: 'local',
    vlmName: path.basename(selected.filename),
    vlmModelPath: modelPath,
    vlmModelDownloadUrl: selected.downloadUrl,
    vlmHfRepo: selected.repo,
    vlmHfRevision: selected.revision
  })
  return { selected, config }
}

function readJsonUrl(url, token) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume()
        readJsonUrl(new URL(response.headers.location, url).toString(), token).then(resolve, reject)
        return
      }
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`Hugging Face 请求失败：HTTP ${response.statusCode} ${body.slice(0, 200)}`))
          return
        }
        try {
          resolve(JSON.parse(body))
        } catch (err) {
          reject(new Error(`Hugging Face 响应解析失败：${err.message}`))
        }
      })
    })
    request.setTimeout(15000, () => {
      request.destroy(new Error('连接 Hugging Face 超时，请检查网络或代理'))
    })
    request.on('error', reject)
  })
}

async function listHuggingFaceModelFiles(patch = {}) {
  const current = await getVideoAnalysisRuntimeConfig()
  const repo = normalizeHuggingFaceRepo(patch.vlmHfRepo || current.vlmHfRepo)
  const revision = String(patch.vlmHfRevision || current.vlmHfRevision || 'main').trim() || 'main'
  const token = typeof patch.vlmHfToken === 'string' ? patch.vlmHfToken.trim() : current.vlmHfToken
  if (!repo || !repo.includes('/')) {
    return { success: false, error: '请输入 Hugging Face 模型仓库，例如 Qwen/Qwen2-VL-7B-Instruct-GGUF' }
  }

  const payload = await readJsonUrl(getHuggingFaceApiUrl(repo, revision), token)
  const siblings = Array.isArray(payload.siblings) ? payload.siblings : []
  const files = siblings
    .map(item => ({
      name: item.rfilename || item.name || '',
      size: Number(item.size) || 0
    }))
    .filter(item => item.name && HF_MODEL_EXTENSIONS.has(path.extname(item.name).toLowerCase()))
    .map(item => ({
      ...item,
      downloadUrl: getHuggingFaceResolveUrl(repo, revision, item.name)
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const config = await saveVideoAnalysisRuntimeConfig({
    ...current,
    vlmHfRepo: repo,
    vlmHfRevision: revision,
    vlmHfToken: token
  })

  return { success: true, repo, revision, files, config, state: await getVlmServiceState() }
}

async function selectHuggingFaceModelFile(file) {
  const current = await getVideoAnalysisRuntimeConfig()
  const repo = normalizeHuggingFaceRepo(current.vlmHfRepo)
  const revision = current.vlmHfRevision || 'main'
  const filename = typeof file?.name === 'string' ? file.name : ''
  const downloadUrl = typeof file?.downloadUrl === 'string' && file.downloadUrl
    ? file.downloadUrl
    : (repo && filename ? getHuggingFaceResolveUrl(repo, revision, filename) : '')
  if (!filename || !downloadUrl) {
    return { success: false, error: '请选择 Hugging Face 模型文件' }
  }

  const modelDir = current.vlmModelPath ? path.dirname(current.vlmModelPath) : path.join(getAnalysisModelDirectory(), 'vlm')
  const modelPath = path.join(modelDir, path.basename(filename))
  const config = await saveVideoAnalysisRuntimeConfig({
    ...current,
    vlmName: path.basename(filename),
    vlmModelPath: modelPath,
    vlmModelDownloadUrl: downloadUrl
  })
  return { success: true, config, state: await getVlmServiceState() }
}

async function scanModelDirectory(dir, depth = 0, seenPaths = new Set()) {
  if (!dir || seenPaths.has(dir) || depth > 2) return []
  seenPaths.add(dir)
  let entries = []
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const files = []
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await scanModelDirectory(fullPath, depth + 1, seenPaths))
      continue
    }
    if (!entry.isFile()) continue
    if (entry.name.endsWith('.part')) continue
    if (!HF_MODEL_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
    let stat = null
    try {
      stat = await fsp.stat(fullPath)
    } catch {
      continue
    }
    files.push({
      name: entry.name,
      path: fullPath,
      size: stat.size,
      modifiedAt: stat.mtimeMs
    })
  }
  return files
}

async function listLocalVlmModelFiles() {
  const current = await getVideoAnalysisRuntimeConfig()
  const modelRoot = current.modelStorageDir || getAnalysisModelDirectory()
  const dirs = [
    modelRoot,
    path.join(modelRoot, 'vlm'),
    current.vlmModelPath ? path.dirname(current.vlmModelPath) : ''
  ]
  const uniqueDirs = Array.from(new Set(dirs.filter(Boolean).map(item => path.resolve(item))))
  const files = []
  const seenFiles = new Set()
  for (const dir of uniqueDirs) {
    for (const file of await scanModelDirectory(dir)) {
      const key = path.resolve(file.path).toLowerCase()
      if (seenFiles.has(key)) continue
      seenFiles.add(key)
      files.push(file)
    }
  }
  files.sort((a, b) => b.modifiedAt - a.modifiedAt || a.name.localeCompare(b.name))
  return { success: true, files: files.slice(0, 200), state: await getVlmServiceState() }
}

async function selectLocalVlmModelFile(filePath) {
  const resolvedPath = path.resolve(String(filePath || ''))
  if (!resolvedPath || !HF_MODEL_EXTENSIONS.has(path.extname(resolvedPath).toLowerCase())) {
    return { success: false, error: '请选择受支持的 VLM 模型文件' }
  }
  try {
    const stat = await fsp.stat(resolvedPath)
    if (!stat.isFile()) {
      return { success: false, error: '请选择一个模型文件' }
    }
  } catch {
    return { success: false, error: `模型文件不存在：${resolvedPath}` }
  }

  const current = await getVideoAnalysisRuntimeConfig()
  const config = await saveVideoAnalysisRuntimeConfig({
    ...current,
    vlmProvider: 'local',
    vlmName: path.basename(resolvedPath),
    vlmModelPath: resolvedPath
  })
  return { success: true, config, state: await getVlmServiceState() }
}

async function saveVlmServiceConfig(patch) {
  const current = await getVideoAnalysisRuntimeConfig()
  const config = await saveVideoAnalysisRuntimeConfig({
    ...current,
    ...patch
  })
  return { success: true, config, state: await getVlmServiceState() }
}

function splitCommandLine(text) {
  const args = []
  let current = ''
  let quote = ''
  let escaped = false

  const input = String(text || '')
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    const nextChar = input[index + 1]
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (quote && char === '\\' && (nextChar === quote || nextChar === '\\')) {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) {
        quote = ''
      } else {
        current += char
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (current) args.push(current)
  return args
}

function renderArgsTemplate(template, config) {
  const host = getHostFromBaseUrl(config.vlmBaseUrl)
  const port = getPortFromBaseUrl(config.vlmBaseUrl)
  return String(template || '')
    .replaceAll('{modelPath}', config.vlmModelPath || '')
    .replaceAll('{modelName}', config.vlmName || '')
    .replaceAll('{baseUrl}', config.vlmBaseUrl || '')
    .replaceAll('{host}', host)
    .replaceAll('{port}', String(port))
}

async function startVlmService() {
  if (vlmProcess && !vlmProcess.killed) {
    return { success: true, state: await getVlmServiceState() }
  }

  const config = await getVideoAnalysisRuntimeConfig()
  if (config.vlmProvider === 'api') {
    return { success: false, error: '外接 VLM API 不需要由播放器启动' }
  }
  const serverExecutable = getPreferredBundledLlamaServer(config.vlmServerExecutable)
  if (!serverExecutable) {
    return { success: false, error: '请先选择 VLM 服务程序，例如 llama-server.exe 或其他 OpenAI 兼容服务程序' }
  }
  if (!fs.existsSync(serverExecutable)) {
    return {
      success: false,
      error: `VLM 服务程序不存在：${serverExecutable}。请重新安装视频理解插件包，或在插件设置里重新选择 llama-server.exe。`,
      state: await getVlmServiceState()
    }
  }
  if (!config.vlmModelPath || !fs.existsSync(config.vlmModelPath)) {
    return { success: false, error: `VLM 模型文件不存在：${config.vlmModelPath || '未配置'}` }
  }

  const { args, autoMmprojPath } = buildServerArgs(config, serverExecutable)
  const executableExt = path.extname(serverExecutable).toLowerCase()
  const useShell = executableExt === '.bat' || executableExt === '.cmd'
  vlmLastOutput = ''
  vlmProcess = spawn(serverExecutable, args, {
    cwd: path.dirname(serverExecutable),
    windowsHide: true,
    shell: useShell
  })
  const child = vlmProcess

  const appendOutput = (chunk) => {
    vlmLastOutput = `${vlmLastOutput}${chunk}`.slice(-4000)
    emitVlmEvent({ type: 'output', output: vlmLastOutput })
  }
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', appendOutput)
  child.stderr?.on('data', appendOutput)
  child.on('error', (err) => {
    vlmLastOutput = err.message
    emitVlmEvent({ type: 'error', error: err.message })
  })
  child.on('exit', (code, signal) => {
    emitVlmEvent({ type: 'exit', code, signal })
    if (vlmProcess === child) vlmProcess = null
  })

  emitVlmEvent({ type: 'started', autoMmprojPath })
  emitVlmEvent({ type: 'output', output: `启动 VLM 服务：${serverExecutable}\n${args.join(' ')}` })
  const connected = await waitForVlmReady(config.vlmBaseUrl)
  const state = await getVlmServiceState()
  if (!connected) {
    const outputHint = vlmLastOutput ? `最近输出：${vlmLastOutput.slice(-500)}` : ''
    if (vlmProcess === child) {
      vlmProcess = null
      killVlmProcessTree(child)
    }
    return { success: false, error: `VLM 服务已启动，但模型尚未就绪，请检查启动参数和服务输出。${outputHint}`, state }
  }
  return { success: true, state }
}

function killVlmProcessTree(child) {
  if (!child || child.killed) return
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform === 'win32' && child.pid) {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      })
      return
    }
  } catch {}

  try {
    child.kill()
  } catch {}
}

function disposeVlmService() {
  if (vlmProcess && !vlmProcess.killed) {
    const child = vlmProcess
    vlmProcess = null
    killVlmProcessTree(child)
  }
}

async function stopVlmService() {
  disposeVlmService()
  return { success: true, state: await getVlmServiceState() }
}

function downloadFile(url, targetPath, token = '') {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http
    const request = client.get(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume()
        downloadFile(new URL(response.headers.location, url).toString(), targetPath, token).then(resolve, reject)
        return
      }
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`下载失败：HTTP ${response.statusCode}`))
        return
      }

      const total = Number(response.headers['content-length']) || 0
      let transferred = 0
      const file = fs.createWriteStream(targetPath)
      response.on('data', (chunk) => {
        transferred += chunk.length
        if (vlmDownload) {
          vlmDownload.progress = {
            percent: total ? Math.round((transferred / total) * 1000) / 10 : 0,
            transferred,
            total
          }
          emitVlmEvent({ type: 'download-progress', progress: vlmDownload.progress })
        }
      })
      response.pipe(file)
      file.on('finish', () => file.close(resolve))
      file.on('error', reject)
    })
    request.setTimeout(30000, () => {
      request.destroy(new Error('模型下载连接超时，请检查网络或代理'))
    })
    request.on('error', reject)
  })
}

async function downloadVlmModel(selection = {}) {
  if (vlmDownload) return { success: true, state: await getVlmServiceState() }
  let selected = null
  let config = await getVideoAnalysisRuntimeConfig()
  if (selection?.modelId) {
    const applied = await applyVlmModelPreset(selection.modelId, selection.precision)
    selected = applied.selected
    config = applied.config
  }
  if (!config.vlmModelDownloadUrl) {
    return { success: false, error: '请先填写 VLM 模型下载地址' }
  }
  if (!config.vlmModelPath) {
    return { success: false, error: '请先配置 VLM 模型文件路径' }
  }

  await fsp.mkdir(path.dirname(config.vlmModelPath), { recursive: true })
  const partialPath = `${config.vlmModelPath}.part`
  vlmDownload = {
    progress: { percent: 0, transferred: 0, total: 0 }
  }
  emitVlmEvent({ type: 'download-started', progress: vlmDownload.progress, selected })
  try {
    await fsp.rm(partialPath, { force: true })
    await downloadFile(config.vlmModelDownloadUrl, partialPath, config.vlmHfToken)
    await fsp.rename(partialPath, config.vlmModelPath)
    vlmDownload = null
    emitVlmEvent({ type: 'download-complete', modelPath: config.vlmModelPath, selected })
    return { success: true, config: await getVideoAnalysisRuntimeConfig(), selected, state: await getVlmServiceState() }
  } catch (err) {
    fsp.unlink(partialPath).catch(() => {})
    vlmDownload = null
    emitVlmEvent({ type: 'download-error', error: err.message })
    return { success: false, error: err.message, config: await getVideoAnalysisRuntimeConfig(), selected, state: await getVlmServiceState() }
  } finally {
    vlmDownload = null
  }
}

module.exports = {
  getVlmModelOptions,
  getVlmServiceState,
  saveVlmServiceConfig,
  startVlmService,
  stopVlmService,
  disposeVlmService,
  downloadVlmModel,
  listLocalVlmModelFiles,
  selectLocalVlmModelFile,
  listHuggingFaceModelFiles,
  selectHuggingFaceModelFile
}
