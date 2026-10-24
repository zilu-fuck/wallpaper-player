const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')
const http = require('http')
const net = require('net')
const crypto = require('crypto')
const { spawn } = require('child_process')
const { app } = require('electron')
const log = require('electron-log')
const { execFileTreeAsync } = require('./exec')
const { getUserDataDir } = require('./user-data')
const { getResourcePath } = require('./paths')
const { detectYtDlp, getSystemProxyAsync, getYtDlpStatus } = require('./ytdlp-service')
const { createXunleiManager } = require('./download-xunlei')
const { mediaScheduler, taskError } = require('./application/resource-scheduler')
const { getMediaPressure, onMediaPressureChanged } = require('./media-pressure')
const { stopProcessTree, workerSpawnSpec } = require('./process-lifecycle')
const { DownloadTasks, validGid, digest } = require('./application/download-tasks')

const RPC_TIMEOUT_MS = 5000
const START_TIMEOUT_MS = 10000
const START_DEADLINE_MS = 45000
const BT_PORT_RANGE = process.env.WALLPAPER_PLAYER_BT_PORT_RANGE || '51413-51423'
const PORT_CHECK_CACHE_MS = 5000
const PUBLIC_BT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.theoks.net:6969/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://tracker-udp.gbitt.info:80/announce',
  'https://tracker.tamersunion.org:443/announce',
  'https://tracker.nanoha.org:443/announce'
]

let detectedAria2Path = null
let detectError = ''
let detectPromise = null
let aria2Process = null
let aria2Port = null
let aria2Secret = ''
let startPromise = null
let lastRuntimeError = ''
let lastBtPortStatus = null
let lastBtPortCheckedAt = 0
let downloadClosing = false, sessionExpired = false, engineSequence = 0, disposePromise = null
let engineClosed = Promise.resolve(), policyQueue = Promise.resolve(), policyRunning = false, policyDirty = false, appliedPolicy = null
let preflightCheckedAt = 0, preflightRevision = 0, preflightAppliedRevision = -1
const startupAbort = new AbortController(), activeRpcRequests = new Set()
const DOWNLOAD_SESSION_MS = 24 * 60 * 60 * 1000
const RPC_MAX_BYTES = 8 * 1024 * 1024
const RPC_MAX_READERS = 32
const stoppingError = () => Object.assign(new Error('下载服务正在关闭'), { code: 'download_stopping' })
function checkStartup() { if (downloadClosing || startupAbort.signal.aborted) throw stoppingError() }
function checkPreparation(options = {}) { checkStartup(); options.throwIfAborted?.(); if (options.signal?.aborted) throw options.signal.reason }
function awaitObservation(work, signal) {
  if (!signal) return work
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(work).then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
    if (signal.aborted) abort()
  })
}
function playbackDownloadOptions() {
  return { 'max-concurrent-downloads': getMediaPressure().active ? '1' : '3', 'max-overall-download-limit': getMediaPressure().active ? '2M' : '0' }
}
function updateDownloadPressurePolicy() {
  policyDirty = true
  if (policyRunning) return policyQueue
  policyRunning = true
  policyQueue = (async () => {
    while (policyDirty && !downloadClosing) {
      policyDirty = false
      if (!isProcessRunning()) return
      const child = aria2Process, options = playbackDownloadOptions(), key = JSON.stringify(options)
      if (appliedPolicy?.child === child && appliedPolicy.key === key) continue
      await rpc('aria2.changeGlobalOption', [options])
      if (aria2Process === child) appliedPolicy = { child, key }
    }
  })().catch(() => { appliedPolicy = null }).finally(() => {
    policyRunning = false
    if (policyDirty && !downloadClosing) updateDownloadPressurePolicy()
  })
  return policyQueue
}
const removePressureListener = onMediaPressureChanged(updateDownloadPressurePolicy)

const xunlei = createXunleiManager({ getDownloadStateDir })
const downloadTasks = new DownloadTasks({ filename: () => path.join(getDownloadStateDir(), 'tasks.json'), rpc,
  async stopEngine() {
    const child = aria2Process
    if (!child) return
    sessionExpired = true; lastRuntimeError = '无法确认超时任务已暂停，正在停止自有下载引擎；请稍后明确继续'
    await rpc('aria2.saveSession', [], { timeout: 800 }).catch(() => {})
    await stopProcessTree(child, { processGroup: process.platform !== 'win32' }); await engineClosed
  } })

function getDownloadStateDir() {
  return path.join(getUserDataDir(), 'downloads')
}

function getDefaultDownloadDir() {
  return path.join(getDownloadStateDir(), 'files')
}

function getAria2SessionPath() {
  return path.join(getDownloadStateDir(), 'aria2.session')
}

function isProcessRunning() {
  return Boolean(aria2Process && aria2Process.exitCode == null && !aria2Process.killed)
}

function getBtPortNumbers() {
  const value = String(BT_PORT_RANGE || '').trim()
  const rangeMatch = value.match(/^(\d+)\s*-\s*(\d+)$/)
  if (rangeMatch) {
    const start = Math.max(1, Math.min(65535, Number(rangeMatch[1])))
    const end = Math.max(1, Math.min(65535, Number(rangeMatch[2])))
    const min = Math.min(start, end)
    const max = Math.max(start, end)
    return Array.from({ length: Math.min(64, max - min + 1) }, (_, index) => min + index)
  }
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? [port] : [51413]
}

function getCandidatePaths() {
  const exeName = process.platform === 'win32' ? 'aria2c.exe' : 'aria2c'
  return [
    process.env.WALLPAPER_PLAYER_ARIA2C,
    getResourcePath('vendor', 'aria2', exeName),
    getResourcePath('vendor', 'aria2', 'aria2c.exe'),
    getResourcePath('vendor', 'aria2', 'aria2c'),
    getResourcePath('vendor', exeName),
    getResourcePath('vendor', 'aria2c.exe'),
    getResourcePath('vendor', 'aria2c'),
    exeName,
    'aria2c'
  ].filter(Boolean)
}

async function canRunCommand(command, options = {}) {
  try {
    await execFileTreeAsync(command, ['--version'], {
      timeout: Math.max(1, Math.min(2500, (options.deadlineAt || Infinity) - Date.now())), maxBuffer: 128 * 1024,
      signal: options.signal || startupAbort.signal,
      windowsHide: true,
      encoding: 'utf-8'
    })
    return true
  } catch {
    checkPreparation(options)
    return false
  }
}

async function detectAria2c(refresh = false, options = {}) {
  checkPreparation(options)
  if (!refresh && detectedAria2Path) return detectedAria2Path
  if (!options.signal && detectPromise) return detectPromise

  const work = (async () => {
    detectError = ''
    const tried = []

    for (const candidate of getCandidatePaths()) {
      checkPreparation(options)
      const normalized = String(candidate).trim()
      if (!normalized) continue
      if (tried.includes(normalized)) continue
      tried.push(normalized)

      const looksLikePath = path.isAbsolute(normalized) || normalized.includes(path.sep) || normalized.includes('/')
      if (looksLikePath) {
        const resolved = path.resolve(normalized)
        const exists = await fsp.stat(resolved).then(stat => stat.isFile(), () => false)
        checkPreparation(options)
        if (exists) {
          detectedAria2Path = resolved
          return detectedAria2Path
        }
        continue
      }

      if (await canRunCommand(normalized, options)) {
        checkPreparation(options)
        detectedAria2Path = normalized
        return detectedAria2Path
      }
    }

    checkPreparation(options)
    detectedAria2Path = null
    detectError = '未检测到内置 aria2c。请重新执行 npm run prepare-vendor，或把 aria2c 加入 PATH。'
    return null
  })()
  if (options.signal) return work
  detectPromise = work
  try { return await work } finally { if (detectPromise === work) detectPromise = null }
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address && typeof address === 'object' ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

function getRpcTokenParams(params = []) {
  return [`token:${aria2Secret}`, ...params]
}

function isPortAvailable(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, host, () => {
      server.close(() => resolve(true))
    })
  })
}

async function checkBtPortStatus(refresh = false, options = {}) {
  checkPreparation(options)
  const now = Date.now()
  if (!refresh && lastBtPortStatus && now - lastBtPortCheckedAt < PORT_CHECK_CACHE_MS) {
    return lastBtPortStatus
  }

  const ports = getBtPortNumbers()
  if (isProcessRunning()) {
    lastBtPortStatus = {
      range: BT_PORT_RANGE,
      ports: ports.map(port => ({
        port,
        tcpAvailable: false,
        listening: true
      })),
      available: true,
      usablePort: ports[0] || null,
      checkedAt: new Date(now).toISOString(),
      note: 'aria2 已启动并使用该 BT 端口范围；如速度仍慢，重点检查公网 NAT、路由器端口映射和资源热度。'
    }
    lastBtPortCheckedAt = now
    return lastBtPortStatus
  }

  const checked = []
  for (const port of ports) {
    checkPreparation(options)
    const tcpAvailable = await isPortAvailable(port, '0.0.0.0')
    checkPreparation(options)
    checked.push({
      port,
      tcpAvailable
    })
  }

  const usablePorts = checked.filter(item => item.tcpAvailable).map(item => item.port)
  lastBtPortStatus = {
    range: BT_PORT_RANGE,
    ports: checked,
    available: usablePorts.length > 0,
    usablePort: usablePorts[0] || null,
    checkedAt: new Date(now).toISOString(),
    note: usablePorts.length > 0
      ? 'BT 监听端口可绑定；如速度仍慢，可能是路由器 NAT 或资源本身较冷。'
      : 'BT 监听端口可能被占用或被安全软件拦截，建议放行 aria2c 或更换端口。'
  }
  lastBtPortCheckedAt = now
  return lastBtPortStatus
}

async function rpc(method, params = [], options = {}) {
  if (options.signal?.aborted) throw options.signal.reason
  if (downloadClosing && !options.allowClosing) throw stoppingError()
  if (!isProcessRunning() || !aria2Port) throw new Error('aria2 引擎未运行')
  if (activeRpcRequests.size >= RPC_MAX_READERS) throw new Error('下载控制请求过多，请稍后再试')
  const child = aria2Process, port = aria2Port
  const body = JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params: getRpcTokenParams(params) })
  return new Promise((resolve, reject) => {
    let response, timer, settled = false, received = 0
    const closed = stream => !stream || stream.closed ? Promise.resolve() : new Promise(done => stream.once('close', done))
    const abort = () => finish(options.signal.reason)
    const finish = (error, result) => {
      if (settled) return
      settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort)
      const waiting = [closed(request), closed(response)]
      if (error) { response?.destroy(); request.destroy() }
      Promise.all(waiting).then(() => {
        if (error) reject(error)
        else if (child !== aria2Process && !options.allowClosing) reject(new Error('下载会话已改变，请重试'))
        else resolve(result)
      })
    }
    const request = http.request({ hostname: '127.0.0.1', port, path: '/jsonrpc', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, incoming => {
      response = incoming
      const chunks = []
      response.on('data', chunk => {
        if (settled) return
        received += chunk.length
        if (received > RPC_MAX_BYTES) { finish(new Error('下载控制响应过大')); return }
        chunks.push(chunk)
      })
      response.once('aborted', () => finish(new Error('下载控制连接已中断')))
      response.once('error', finish)
      response.once('end', () => {
        if (settled) return
        try {
          let parsed
          try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('下载控制服务响应格式无效') }
          if (parsed.error) throw Object.assign(new Error('aria2 RPC 操作失败：' + (parsed.error.code || '未知错误')), { code: 'aria2_rpc_error', aria2Code: parsed.error.code, rpcMethod: method,
            taskNotFound: typeof parsed.error.message === 'string' && /\bGID\s*#?\s*[0-9a-f]{16}\s+is not found\b/i.test(parsed.error.message) })
          if (response.statusCode !== 200) throw new Error('下载控制服务响应异常')
          finish(null, parsed.result)
        } catch (error) { finish(error) }
      })
    })
    const record = { request, abort: () => finish(stoppingError()) }
    activeRpcRequests.add(record)
    request.once('close', () => activeRpcRequests.delete(record))
    request.on('error', finish)
    timer = setTimeout(() => finish(new Error('aria2 RPC 响应超时')), options.timeout || RPC_TIMEOUT_MS)
    timer.unref?.(); request.end(body)
    options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort()
  })
}

async function waitForRpcReady(check = checkStartup) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < START_TIMEOUT_MS) {
    check()
    if (!isProcessRunning()) {
      throw new Error(lastRuntimeError || 'aria2 引擎启动后立即退出')
    }
    try {
      await rpc('aria2.getVersion', [], { timeout: 800 })
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 180))
    }
  }
  throw new Error('aria2 引擎启动超时')
}

async function ensureStarted(options = {}) {
  checkStartup()
  const expiredAtEntry = sessionExpired
  if (options.resume) sessionExpired = false
  if (sessionExpired) throw new Error('下载运行时间过长，已暂停；请点击继续或重新添加任务')
  if (startPromise) return startPromise
  if (expiredAtEntry && options.resume) { await engineClosed; checkStartup() }
  if (isProcessRunning()) return getEngineStatus()

  const preparation = new AbortController()
  const abortPreparation = () => preparation.abort(stoppingError())
  startupAbort.signal.addEventListener('abort', abortPreparation, { once: true })
  const preparationTimeout = setTimeout(() => preparation.abort(new Error('下载引擎准备超过最长等待时间')), START_DEADLINE_MS)
  preparationTimeout.unref?.()
  const check = () => { checkStartup(); if (preparation.signal.aborted) throw preparation.signal.reason }
  startPromise = (async () => {
    await engineClosed; check()
    const lease = await mediaScheduler.acquire({ key: 'aria2-daemon:' + (++engineSequence), type: 'download-daemon',
      resources: { transfer: 3 }, priority: 20, timeoutMs: DOWNLOAD_SESSION_MS, signal: preparation.signal })
    let launched = false
    try {
    check()
    const aria2Path = await detectAria2c(false, { signal: preparation.signal, throwIfAborted: check })
    check()
    if (!aria2Path) {
      throw new Error(detectError || '未检测到 aria2c')
    }

    const stateDir = getDownloadStateDir()
    const sessionPath = getAria2SessionPath()
    await fsp.mkdir(stateDir, { recursive: true })
    check()
    await fsp.mkdir(getDefaultDownloadDir(), { recursive: true })
    check()
    if (!fs.existsSync(sessionPath)) {
      await fsp.writeFile(sessionPath, '', 'utf-8')
    }

    check()
    await downloadTasks.load(); check()
    aria2Port = await getFreePort()
    check()
    aria2Secret = crypto.randomBytes(24).toString('hex')
    lastRuntimeError = ''

    const args = [
      '--no-conf=true',
      '--enable-rpc=true',
      `--stop-with-process=${process.pid}`,
      '--rpc-listen-all=false',
      `--rpc-listen-port=${aria2Port}`,
      `--rpc-secret=${aria2Secret}`,
      '--rpc-allow-origin-all=false',
      `--dir=${getDefaultDownloadDir()}`,
      `--input-file=${sessionPath}`,
      `--save-session=${sessionPath}`,
      '--save-session-interval=10',
      '--auto-save-interval=10',
      '--continue=true',
      '--pause=true',
      '--max-concurrent-downloads=' + playbackDownloadOptions()['max-concurrent-downloads'],
      '--max-connection-per-server=16',
      '--split=16',
      '--min-split-size=1M',
      '--max-overall-download-limit=' + playbackDownloadOptions()['max-overall-download-limit'],
      '--max-download-limit=0',
      '--disk-cache=64M',
      '--file-allocation=prealloc',
      '--summary-interval=0',
      '--bt-save-metadata=true',
      '--bt-load-saved-metadata=true',
      '--enable-dht=true',
      '--enable-dht6=true',
      '--enable-peer-exchange=true',
      '--bt-enable-lpd=true',
      '--bt-max-peers=96',
      '--bt-tracker-connect-timeout=12',
      '--bt-tracker-timeout=18',
      `--bt-tracker=${PUBLIC_BT_TRACKERS.join(',')}`,
      `--listen-port=${BT_PORT_RANGE}`,
      `--dht-listen-port=${BT_PORT_RANGE}`,
      '--bt-remove-unselected-file=true',
      '--seed-time=0'
    ]

    check()
    const spec = workerSpawnSpec(aria2Path, args, { windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe'] })
    const child = spawn(spec.file, spec.args, spec.options)
    aria2Process = child; launched = true
    const expired = () => {
      if (!downloadClosing && !preparation.signal.aborted) { sessionExpired = true; lastRuntimeError = '下载运行时间过长，已暂停；请点击继续或重新添加任务' }
      void stopProcessTree(child, { processGroup: process.platform !== 'win32' }).catch(() => {})
    }
    lease.signal.addEventListener('abort', expired, { once: true })
    child.stderr?.on('data', chunk => { if (chunk.length) log.warn('[aria2] output received', { bytes: chunk.length }) })
    child.once('error', error => { lastRuntimeError = '下载引擎启动失败：' + (error.code || '未知错误') })
    engineClosed = new Promise(resolve => child.once('close', (code, signal) => {
      downloadTasks.engineStopped()
      lease.signal.removeEventListener('abort', expired); lease.release()
      if (aria2Process === child) {
        if (!downloadClosing && !sessionExpired) lastRuntimeError = 'aria2 已退出：' + (code ?? signal)
        aria2Process = null; aria2Port = null; aria2Secret = ''
      }
      resolve()
    }))

    await waitForRpcReady(check)
    check()
    await downloadTasks.engineStarted(); check()
    await checkBtPortStatus(true).catch(() => {})
    check()
    await updateDownloadPressurePolicy()
    check()
    return getEngineStatus()
    } catch (error) {
      if (launched && aria2Process) { await stopProcessTree(aria2Process, { processGroup: process.platform !== 'win32' }); await engineClosed }
      else lease.release()
      throw error
    }
  })().finally(() => {
    clearTimeout(preparationTimeout); startupAbort.signal.removeEventListener('abort', abortPreparation)
    startPromise = null
  })

  return startPromise
}

function toNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : []
}

function normalizeFile(file) {
  return {
    index: toNumber(file?.index),
    path: typeof file?.path === 'string' ? file.path : '',
    length: toNumber(file?.length),
    completedLength: toNumber(file?.completedLength),
    selected: file?.selected === true || file?.selected === 'true'
  }
}

function normalizeDownloadHeaders(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return []
  const values = []
  const referer = typeof headers.referer === 'string' ? headers.referer.trim() : ''
  const userAgent = typeof headers.userAgent === 'string' ? headers.userAgent.trim() : ''
  if (referer) values.push(`Referer: ${referer}`)
  if (userAgent) values.push(`User-Agent: ${userAgent}`)
  return values
}

async function getDownloadProxy(headers, context = {}) {
  const targetUrl = headers && typeof headers === 'object' && !Array.isArray(headers) && typeof headers.url === 'string'
    ? headers.url
    : ''
  const proxyState = await getSystemProxyAsync(targetUrl, { ...context, signal: context.signal || startupAbort.signal })
  return proxyState.enabled ? proxyState.proxy : ''
}

function getTaskName(task) {
  if (task?.bittorrent?.info?.name) return task.bittorrent.info.name
  const filePath = task?.files?.find(file => file?.path)?.path
  return filePath ? path.basename(filePath) : task?.gid || '下载任务'
}

function getTaskSourceHealth(task) {
  const bittorrent = task?.bittorrent || null
  const announceList = normalizeArray(bittorrent?.announceList).flat().filter(Boolean)
  const trackerCount = announceList.length
  const seeders = toNumber(task?.numSeeders)
  const connections = toNumber(task?.connections)
  const speed = toNumber(task?.downloadSpeed)
  const completed = toNumber(task?.completedLength)
  const followedBy = normalizeArray(task?.followedBy)
  const isBt = Boolean(bittorrent || followedBy.length || task?.following)

  if (!isBt) {
    return {
      kind: 'url',
      label: '直链下载',
      detail: speed > 0 ? 'HTTP/HTTPS 正在传输' : '等待服务器响应',
      trackerCount,
      trackerStatus: '不适用'
    }
  }

  if (followedBy.length > 0 || String(task?.name || '').startsWith('[METADATA]')) {
    return {
      kind: 'bt-metadata',
      label: '解析元数据',
      detail: '正在通过 tracker/DHT 获取文件列表',
      trackerCount,
      trackerStatus: trackerCount > 0 ? `${trackerCount} 个 tracker` : '依赖 DHT'
    }
  }

  if (speed > 0) {
    return {
      kind: 'bt-active',
      label: '资源可用',
      detail: seeders > 0 ? `发现 ${seeders} 个种子` : '已连接到可下载节点',
      trackerCount,
      trackerStatus: trackerCount > 0 ? `${trackerCount} 个 tracker` : 'DHT/PEX'
    }
  }

  if (connections > 0 && seeders <= 0) {
    return {
      kind: 'bt-low',
      label: '连接资源中',
      detail: completed > 0 ? '已有分片，正在等待可用种子' : '已连接节点，但暂未发现可下载分片',
      trackerCount,
      trackerStatus: trackerCount > 0 ? `${trackerCount} 个 tracker` : 'DHT/PEX'
    }
  }

  return {
    kind: 'bt-searching',
    label: '寻找资源',
    detail: trackerCount > 0 ? '正在通过 tracker/DHT/PEX 寻找资源' : '没有 tracker，正在依赖 DHT 寻找资源',
    trackerCount,
    trackerStatus: trackerCount > 0 ? `${trackerCount} 个 tracker` : '仅 DHT'
  }
}

function normalizeTask(task) {
  const files = Array.isArray(task?.files) ? task.files.map(normalizeFile) : []
  const normalized = {
    ...task,
    files
  }
  const sourceHealth = getTaskSourceHealth(normalized)
  return {
    gid: task?.gid || '',
    name: getTaskName(normalized),
    status: task?.status || 'unknown',
    totalLength: toNumber(task?.totalLength),
    completedLength: toNumber(task?.completedLength),
    downloadSpeed: toNumber(task?.downloadSpeed),
    uploadSpeed: toNumber(task?.uploadSpeed),
    connections: toNumber(task?.connections),
    numSeeders: toNumber(task?.numSeeders),
    seeder: task?.seeder === true || task?.seeder === 'true',
    errorCode: task?.errorCode || '',
    errorMessage: task?.errorMessage || '',
    dir: typeof task?.dir === 'string' ? task.dir : '',
    files,
    bittorrent: task?.bittorrent || null,
    followedBy: normalizeArray(task?.followedBy),
    following: task?.following || '',
    sourceHealth
  }
}

async function listTasks(options = {}) {
  if (options.ensure !== false) {
    await ensureStarted()
  }
  const keys = [
    'gid',
    'status',
    'totalLength',
    'completedLength',
    'downloadSpeed',
    'uploadSpeed',
    'connections',
    'numSeeders',
    'seeder',
    'errorCode',
    'errorMessage',
    'dir',
    'files',
    'bittorrent',
    'followedBy',
    'following',
    'infoHash'
  ]
  const results = await Promise.allSettled([
    rpc('aria2.tellActive', [keys], options),
    rpc('aria2.tellWaiting', [0, 100, keys], options),
    rpc('aria2.tellStopped', [0, 100, keys], options)
  ])
  const failure = results.find(result => result.status === 'rejected')
  if (failure) throw failure.reason
  const [active, waiting, stopped] = results.map(result => result.value)

  return [...active, ...waiting, ...stopped]
    .map(normalizeTask)
    .filter(task => task.gid)
}

function getEngineStatus() {
  const available = Boolean(detectedAria2Path)
  const running = isProcessRunning()
  return {
    available,
    running,
    path: detectedAria2Path,
    port: running ? aria2Port : null,
    btPortRange: BT_PORT_RANGE,
    btPortStatus: lastBtPortStatus,
    trackerCount: PUBLIC_BT_TRACKERS.length,
    xunlei: xunlei.getStatus(),
    features: {
      dht: true,
      dht6: true,
      pex: true,
      lsd: true,
      publicTrackers: PUBLIC_BT_TRACKERS.length,
      ytdlp: Boolean(getYtDlpStatus().available)
    },
    ytdlp: getYtDlpStatus(),
    error: available ? lastRuntimeError : detectError,
    sessionPath: getAria2SessionPath(),
    defaultDownloadDir: getDefaultDownloadDir(),
    license: 'aria2 GPL-2.0-or-later；应用通过 vendor/aria2/aria2c.exe 内置并作为独立进程启动。'
  }
}

async function prepareSnapshot(refresh, options) {
  checkPreparation(options)
  if (refresh) preflightRevision++
  if (!refresh && preflightAppliedRevision === preflightRevision && Date.now() - preflightCheckedAt < 30000) return
  const key = 'download-preflight'
  try {
    const enqueue = () => mediaScheduler.enqueue({ key, type: 'download-preflight', resources: { prepare: 1 }, signal: options.signal,
      priority: 30, timeoutMs: 30000 }, async context => {
      do {
        const revision = preflightRevision, force = revision !== preflightAppliedRevision
        const results = await Promise.allSettled([
          getSystemProxyAsync('', { ...context, refresh: force }), detectAria2c(force, context), detectYtDlp(force, context),
          xunlei.detect(force, context), checkBtPortStatus(force, context)
        ])
        context.throwIfAborted(); checkStartup()
        const failure = results.find(result => result.status === 'rejected')
        if (failure) throw failure.reason
        preflightAppliedRevision = revision; preflightCheckedAt = Date.now()
      } while (preflightAppliedRevision !== preflightRevision)
    })
    while (true) {
      checkPreparation(options)
      try { await enqueue(); break } catch (error) {
        if (error.code !== 'task_cancelling') throw error
        await mediaScheduler.waitForKey(key, options)
      }
    }
  } finally { await mediaScheduler.waitForCancelledKey(key) }
}

async function getSnapshot(options = {}) {
  checkPreparation(options)
  const start = options.start !== false, refresh = Boolean(options.refresh), key = 'download-snapshot:' + start + ':' + refresh
  const deadlineAt = Date.now() + 60000
  try {
    while (true) {
      checkPreparation(options)
      if (Date.now() >= deadlineAt) throw taskError('task_timeout', '下载状态读取超过最长等待时间', 504, true)
      try {
        return await mediaScheduler.enqueue({ key, type: 'download-observation', resources: { control: 1 }, priority: 40,
          signal: options.signal, timeoutMs: deadlineAt - Date.now() }, context => readSnapshot({ ...context, start, refresh }))
      } catch (error) {
        if (error.code !== 'task_cancelling') throw error
        await mediaScheduler.waitForKey(key, { signal: options.signal, deadlineAt })
      }
    }
  } finally { await mediaScheduler.waitForCancelledKey(key) }
}

async function readSnapshot(options) {
  checkStartup()
  const start = options.start !== false
  const refresh = Boolean(options.refresh)
  await prepareSnapshot(refresh, options); checkPreparation(options)
  await downloadTasks.load(); checkPreparation(options)

  if (!detectedAria2Path) {
    return {
      engine: getEngineStatus(),
      tasks: [...downloadTasks.decorate(), ...(await xunlei.loadTasks()).map(xunlei.normalizeTask)]
    }
  }

  if (!start && !isProcessRunning()) {
    return {
      engine: getEngineStatus(),
      tasks: [...downloadTasks.decorate(), ...(await xunlei.loadTasks()).map(xunlei.normalizeTask)]
    }
  }

  try {
    if (start) await awaitObservation(ensureStarted(), options.signal)
    checkPreparation(options)
    const results = await Promise.allSettled([
      listTasks({ ensure: false, signal: options.signal }),
      xunlei.loadTasks()
    ])
    checkPreparation(options)
    const failure = results.find(result => result.status === 'rejected')
    if (failure) throw failure.reason
    const [tasks, xunleiTasks] = results.map(result => result.value)
    return {
      engine: getEngineStatus(),
      tasks: [...downloadTasks.decorate(tasks), ...xunleiTasks.map(xunlei.normalizeTask)]
    }
  } catch (err) {
    checkPreparation(options)
    lastRuntimeError = err.message
    return {
      engine: getEngineStatus(),
      tasks: [...downloadTasks.decorate(), ...(await xunlei.loadTasks()).map(xunlei.normalizeTask)]
    }
  }
}

async function assertDownloadDirectory(dir) {
  const resolved = await fsp.realpath(path.resolve(String(dir || '').trim()))
  const stats = await fsp.stat(resolved)
  if (!stats.isDirectory()) {
    throw new Error('保存路径不是目录')
  }
  return resolved
}

// 迅雷接管适配已拆出至 ./download-xunlei

async function addXunleiTask({ url, dir }, options = {}) {
  checkStartup()
  return xunlei.addTask({ url, dir, assertDownloadDirectory }, { ...options, throwIfAborted: () => checkPreparation(options) })
}

async function taskSnapshot() {
  try { return await getSnapshot({ start: false }) }
  catch { return { engine: getEngineStatus(), tasks: [...downloadTasks.decorate(), ...(await xunlei.loadTasks()).map(xunlei.normalizeTask)] } }
}
async function addUrl({ url, dir, httpHeaders, operationId, sourceIdentity }, context = {}) {
  checkPreparation(context)
  const parsed = new URL(String(url || '').trim())
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('仅支持 http/https 下载地址')
  }
  const targetDir = await assertDownloadDirectory(dir)
  checkPreparation(context)
  await ensureStarted({ resume: true })
  const options = {
    dir: targetDir,
    continue: 'true',
    pause: 'false',
    'auto-file-renaming': 'true',
    'allow-overwrite': 'false'
  }
  const headers = normalizeDownloadHeaders(httpHeaders)
  if (headers.length > 0) options.header = headers
  const proxy = await getDownloadProxy({ ...(httpHeaders || {}), url: parsed.toString() }, context)
  checkStartup()
  if (proxy) options['all-proxy'] = proxy
  checkPreparation(context)
  const result = await downloadTasks.submit({ operationId, kind: 'url', name: path.basename(parsed.pathname),
    fingerprint: digest(JSON.stringify(sourceIdentity ? ['network', sourceIdentity, targetDir] : ['url', parsed.toString(), targetDir, headers])) }, (gid, internal) => {
    internal.throwIfAborted(); return rpc('aria2.addUri', [[parsed.toString()], { ...options, gid }])
  }, context)
  await rpc('aria2.saveSession').catch(() => {})
  return {
    ...result, success: result.accepted, error: result.accepted ? undefined : '下载引擎未接受此操作，请查看任务状态',
    state: await taskSnapshot()
  }
}

function normalizeMagnet(rawMagnet) {
  const magnet = String(rawMagnet || '').trim()
  if (!magnet.toLowerCase().startsWith('magnet:?')) {
    throw new Error('磁链格式无效')
  }

  const queryIndex = magnet.indexOf('?')
  const params = new URLSearchParams(queryIndex >= 0 ? magnet.slice(queryIndex + 1) : '')
  const xtValues = params.getAll('xt').map(value => value.trim().toLowerCase())
  const btihValues = xtValues
    .filter(value => value.startsWith('urn:btih:'))
    .map(value => value.slice('urn:btih:'.length))
  const hasBtih = btihValues.length > 0
  const hasOnlyBtmh = xtValues.length > 0 && xtValues.every(value => value.startsWith('urn:btmh:'))
  if (!hasBtih) {
    throw new Error(hasOnlyBtmh
      ? '当前 aria2 对 BT v2 / btmh 磁链兼容有限，先支持 BT v1 / btih 磁链'
      : '磁链缺少 btih 信息')
  }
  if (btihValues.some(value => /^[0-9a-f]{64}$/i.test(value))) {
    throw new Error('检测到 64 位 BT v2 hash；当前 aria2 兼容性有限，先支持 BT v1 / 40 位 btih 磁链')
  }
  return magnet
}

async function addMagnet({ magnet, dir, operationId }, context = {}) {
  checkPreparation(context)
  const normalizedMagnet = normalizeMagnet(magnet)
  const targetDir = await assertDownloadDirectory(dir)
  checkPreparation(context)
  await ensureStarted({ resume: true })
  const result = await downloadTasks.submit({ operationId, kind: 'magnet', name: new URL(normalizedMagnet).searchParams.get('dn') || '磁链元数据',
    fingerprint: digest(JSON.stringify(['magnet', normalizedMagnet, targetDir])) }, (gid, internal) => {
    internal.throwIfAborted(); return rpc('aria2.addUri', [
    [normalizedMagnet],
    {
      dir: targetDir,
      gid,
      pause: 'false',
      'pause-metadata': 'true',
      'bt-save-metadata': 'true',
      'bt-load-saved-metadata': 'true',
      'bt-remove-unselected-file': 'true',
      'bt-tracker': PUBLIC_BT_TRACKERS.join(','),
      'seed-time': '0',
      continue: 'true'
    }
  ]) }, context)
  await rpc('aria2.saveSession').catch(() => {})
  return {
    ...result, success: result.accepted, error: result.accepted ? undefined : '下载引擎未接受此操作，请查看任务状态',
    state: await taskSnapshot()
  }
}

async function changeSelectedFiles(gid, fileIndexes, options = {}) {
  const normalizedGid = String(gid || '').trim()
  if (normalizedGid.startsWith('xunlei-')) throw new Error('外部下载需在迅雷中选择文件')
  const indexes = Array.isArray(fileIndexes)
    ? [...new Set(fileIndexes.map(value => Number(value)).filter(value => Number.isInteger(value) && value > 0))]
    : []
  if (!normalizedGid) throw new Error('下载任务无效')
  validGid(normalizedGid)
  if (indexes.length === 0) throw new Error('请至少选择一个文件')
  await ensureStarted()
  const result = await downloadTasks.control(normalizedGid, 'select', indexes, options)
  return { ...(await taskSnapshot()), ...result, success: result.accepted }
}

async function pause(gid, options = {}) {
  const normalizedGid = String(gid || '').trim()
  if (normalizedGid.startsWith('xunlei-')) throw new Error('外部下载需在迅雷中暂停')
  if (!normalizedGid) throw new Error('下载任务无效')
  validGid(normalizedGid)
  await ensureStarted()
  const result = await downloadTasks.control(normalizedGid, 'pause', undefined, options)
  return { ...(await taskSnapshot()), ...result, success: result.accepted }
}

async function resume(gid, options = {}) {
  const normalizedGid = String(gid || '').trim()
  if (normalizedGid.startsWith('xunlei-')) throw new Error('外部下载需在迅雷中继续')
  if (!normalizedGid) throw new Error('下载任务无效')
  validGid(normalizedGid)
  await ensureStarted({ resume: true })
  const result = await downloadTasks.control(normalizedGid, 'resume', undefined, options)
  return { ...(await taskSnapshot()), ...result, success: result.accepted }
}

async function remove(gid, options = {}) {
  const normalizedGid = String(gid || '').trim()
  if (!normalizedGid) throw new Error('下载任务无效')
  if (normalizedGid.startsWith('xunlei-')) {
    await xunlei.removeTask(normalizedGid)
    return getSnapshot({ start: false })
  }
  validGid(normalizedGid)
  await ensureStarted()
  const result = await downloadTasks.control(normalizedGid, 'remove', undefined, options)
  return { ...(await taskSnapshot()), ...result, success: result.accepted }
}

function disposeDownloadManager() {
  if (disposePromise) return disposePromise
  downloadClosing = true; removePressureListener()
  const taskCleanup = downloadTasks.dispose()
  if (!aria2Process || startPromise) startupAbort.abort(stoppingError())
  const requests = [...activeRpcRequests]
  const rpcClosed = requests.map(record => record.request.closed ? Promise.resolve() : new Promise(resolve => record.request.once('close', resolve)))
  for (const record of requests) record.abort()
  disposePromise = (async () => {
    await Promise.all(rpcClosed)
    await taskCleanup
    const child = aria2Process
    if (child && isProcessRunning()) {
      await rpc('aria2.saveSession', [], { timeout: 1000, allowClosing: true }).catch(() => {})
      await rpc('aria2.shutdown', [], { timeout: 600, allowClosing: true }).catch(() => {})
      startupAbort.abort(stoppingError())
      await stopProcessTree(child, { processGroup: process.platform !== 'win32' })
    }
    startupAbort.abort(stoppingError())
    await startPromise?.catch(() => {})
    await engineClosed
    await policyQueue.catch(() => {})
    await xunlei.dispose?.()
    await mediaScheduler.waitForIdle(['download-daemon'])
  })()
  return disposePromise
}

module.exports = {
  detectAria2c,
  detectXunlei: xunlei.detect,
  checkBtPortStatus,
  getSnapshot,
  addUrl,
  addMagnet,
  addXunleiTask,
  changeSelectedFiles,
  pause,
  resume,
  remove,
  disposeDownloadManager,
  getDownloadDiagnostics: () => ({ closing: downloadClosing, starting: Boolean(startPromise), running: isProcessRunning(), rpc: activeRpcRequests.size, expired: sessionExpired })
}
