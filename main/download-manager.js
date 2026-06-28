const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')
const http = require('http')
const net = require('net')
const crypto = require('crypto')
const { spawn, execFile } = require('child_process')
const { promisify } = require('util')
const { app } = require('electron')
const log = require('electron-log')
const { getResourcePath, isExistingFile } = require('./paths')
const { detectYtDlp, getSystemProxy, getYtDlpStatus } = require('./ytdlp-service')

const execFileAsync = promisify(execFile)
const fallbackUserDataDir = path.join(process.cwd(), '.tmp-wallpaper-player')
const RPC_TIMEOUT_MS = 5000
const START_TIMEOUT_MS = 10000
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
let detectedXunlei = null
let xunleiDetectError = ''
let xunleiDetectPromise = null

function getUserDataDir() {
  return app?.getPath ? app.getPath('userData') : fallbackUserDataDir
}

function getDownloadStateDir() {
  return path.join(getUserDataDir(), 'downloads')
}

function getDefaultDownloadDir() {
  return path.join(getDownloadStateDir(), 'files')
}

function getAria2SessionPath() {
  return path.join(getDownloadStateDir(), 'aria2.session')
}

function getXunleiTasksPath() {
  return path.join(getDownloadStateDir(), 'xunlei-tasks.json')
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

async function canRunCommand(command) {
  try {
    await execFileAsync(command, ['--version'], {
      timeout: 2500,
      windowsHide: true,
      encoding: 'utf-8'
    })
    return true
  } catch {
    return false
  }
}

async function detectAria2c(refresh = false) {
  if (!refresh && detectedAria2Path) return detectedAria2Path
  if (detectPromise) return detectPromise

  detectPromise = (async () => {
    detectedAria2Path = null
    detectError = ''
    const tried = []

    for (const candidate of getCandidatePaths()) {
      const normalized = String(candidate).trim()
      if (!normalized) continue
      if (tried.includes(normalized)) continue
      tried.push(normalized)

      const looksLikePath = path.isAbsolute(normalized) || normalized.includes(path.sep) || normalized.includes('/')
      if (looksLikePath) {
        const resolved = path.resolve(normalized)
        if (isExistingFile(resolved)) {
          detectedAria2Path = resolved
          return detectedAria2Path
        }
        continue
      }

      if (await canRunCommand(normalized)) {
        detectedAria2Path = normalized
        return detectedAria2Path
      }
    }

    detectError = '未检测到内置 aria2c。请重新执行 npm run prepare-vendor，或把 aria2c 加入 PATH。'
    return null
  })().finally(() => {
    detectPromise = null
  })

  return detectPromise
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

async function checkBtPortStatus(refresh = false) {
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
    const tcpAvailable = await isPortAvailable(port, '0.0.0.0')
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
  if (!isProcessRunning()) {
    throw new Error('aria2 引擎未运行')
  }
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    method,
    params: getRpcTokenParams(params)
  })

  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port: aria2Port,
      path: '/jsonrpc',
      method: 'POST',
      timeout: options.timeout || RPC_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (response) => {
      let raw = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { raw += chunk })
      response.on('end', () => {
        try {
          const parsed = JSON.parse(raw)
          if (parsed.error) {
            reject(new Error(parsed.error.message || `aria2 RPC 错误: ${parsed.error.code}`))
            return
          }
          resolve(parsed.result)
        } catch (err) {
          reject(err)
        }
      })
    })

    request.on('timeout', () => {
      request.destroy(new Error('aria2 RPC 响应超时'))
    })
    request.on('error', reject)
    request.write(body)
    request.end()
  })
}

async function waitForRpcReady() {
  const startedAt = Date.now()
  while (Date.now() - startedAt < START_TIMEOUT_MS) {
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

async function ensureStarted() {
  if (isProcessRunning()) return getEngineStatus()
  if (startPromise) return startPromise

  startPromise = (async () => {
    const aria2Path = await detectAria2c()
    if (!aria2Path) {
      throw new Error(detectError || '未检测到 aria2c')
    }

    const stateDir = getDownloadStateDir()
    const sessionPath = getAria2SessionPath()
    await fsp.mkdir(stateDir, { recursive: true })
    await fsp.mkdir(getDefaultDownloadDir(), { recursive: true })
    if (!fs.existsSync(sessionPath)) {
      await fsp.writeFile(sessionPath, '', 'utf-8')
    }

    aria2Port = await getFreePort()
    aria2Secret = crypto.randomBytes(24).toString('hex')
    lastRuntimeError = ''

    const args = [
      '--no-conf=true',
      '--enable-rpc=true',
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
      '--max-concurrent-downloads=3',
      '--max-connection-per-server=16',
      '--split=16',
      '--min-split-size=1M',
      '--max-overall-download-limit=0',
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

    aria2Process = spawn(aria2Path, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    })

    aria2Process.stderr?.on('data', (chunk) => {
      const line = String(chunk || '').trim()
      if (line) log.warn('[aria2]', line)
    })
    aria2Process.once('error', (err) => {
      lastRuntimeError = err.message
    })
    aria2Process.once('exit', (code, signal) => {
      if (code != null || signal) {
        lastRuntimeError = `aria2 已退出: ${code ?? signal}`
      }
      aria2Process = null
      aria2Port = null
      aria2Secret = ''
    })

    await waitForRpcReady()
    await checkBtPortStatus(true).catch(() => {})
    return getEngineStatus()
  })().finally(() => {
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

function getDownloadProxy(headers) {
  const targetUrl = headers && typeof headers === 'object' && !Array.isArray(headers) && typeof headers.url === 'string'
    ? headers.url
    : ''
  const proxyState = getSystemProxy(targetUrl)
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
  const [active, waiting, stopped] = await Promise.all([
    rpc('aria2.tellActive', [keys]),
    rpc('aria2.tellWaiting', [0, 100, keys]),
    rpc('aria2.tellStopped', [0, 100, keys])
  ])

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
    xunlei: detectedXunlei || {
      available: false,
      path: '',
      name: '迅雷',
      error: xunleiDetectError || ''
    },
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

async function getSnapshot(options = {}) {
  const start = options.start !== false
  const refresh = Boolean(options.refresh)
  await detectAria2c(refresh)
  await detectYtDlp(refresh).catch(() => null)
  await detectXunlei(refresh).catch(() => null)
  await checkBtPortStatus(refresh).catch((err) => {
    lastBtPortStatus = {
      range: BT_PORT_RANGE,
      ports: [],
      available: false,
      usablePort: null,
      checkedAt: new Date().toISOString(),
      note: err.message || 'BT 端口检测失败'
    }
  })

  if (!detectedAria2Path) {
    return {
      engine: getEngineStatus(),
      tasks: (await loadXunleiTasks()).map(normalizeXunleiTask)
    }
  }

  if (!start && !isProcessRunning()) {
    return {
      engine: getEngineStatus(),
      tasks: (await loadXunleiTasks()).map(normalizeXunleiTask)
    }
  }

  try {
    const [tasks, xunleiTasks] = await Promise.all([
      listTasks(),
      loadXunleiTasks()
    ])
    return {
      engine: getEngineStatus(),
      tasks: [...tasks, ...xunleiTasks.map(normalizeXunleiTask)]
    }
  } catch (err) {
    lastRuntimeError = err.message
    return {
      engine: getEngineStatus(),
      tasks: (await loadXunleiTasks()).map(normalizeXunleiTask)
    }
  }
}

async function assertDownloadDirectory(dir) {
  const resolved = path.resolve(String(dir || '').trim())
  const stats = await fsp.stat(resolved)
  if (!stats.isDirectory()) {
    throw new Error('保存路径不是目录')
  }
  return resolved
}

function stripQuotes(value) {
  return String(value || '').trim().replace(/^"|"$/g, '')
}

function extractExecutableFromCommand(command) {
  const value = String(command || '').trim()
  if (!value) return ''
  const quoted = value.match(/^"([^"]+\.exe)"/i)
  if (quoted) return quoted[1]
  const plain = value.match(/^([^\s]+\.exe)/i)
  return plain ? plain[1] : ''
}

function getXunleiCandidatePaths() {
  const candidates = [
    process.env.WALLPAPER_PLAYER_XUNLEI,
    'E:\\Thunder\\Program\\Thunder.exe',
    'C:\\Program Files\\Thunder Network\\Thunder\\Program\\Thunder.exe',
    'C:\\Program Files (x86)\\Thunder Network\\Thunder\\Program\\Thunder.exe',
    'C:\\Program Files\\Thunder\\Program\\Thunder.exe',
    'C:\\Program Files (x86)\\Thunder\\Program\\Thunder.exe'
  ]

  for (const base of [
    process.env.LOCALAPPDATA,
    process.env.PROGRAMFILES,
    process.env['ProgramFiles(x86)']
  ]) {
    if (!base) continue
    candidates.push(
      path.join(base, 'Thunder', 'Program', 'Thunder.exe'),
      path.join(base, 'Xunlei', 'Program', 'Thunder.exe'),
      path.join(base, '迅雷', 'Program', 'Thunder.exe')
    )
  }

  if (process.platform === 'win32') {
    try {
      const { execFileSync } = require('child_process')
      const raw = execFileSync('reg', ['query', 'HKCU\\Software\\Classes\\magnet\\shell\\open\\command', '/ve'], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 1500
      })
      const command = raw.split(/\r?\n/).find(line => line.includes('REG_SZ'))?.replace(/^.*REG_SZ\s+/, '')
      const exe = extractExecutableFromCommand(command)
      if (exe) candidates.unshift(exe)
    } catch {}
  }

  return candidates.map(stripQuotes).filter(Boolean)
}

async function detectXunlei(refresh = false) {
  if (!refresh && detectedXunlei) return detectedXunlei
  if (xunleiDetectPromise) return xunleiDetectPromise

  xunleiDetectPromise = (async () => {
    detectedXunlei = null
    xunleiDetectError = ''
    const tried = []
    for (const candidate of getXunleiCandidatePaths()) {
      const normalized = path.resolve(candidate)
      if (tried.includes(normalized)) continue
      tried.push(normalized)
      if (isExistingFile(normalized)) {
        detectedXunlei = {
          available: true,
          path: normalized,
          name: '迅雷'
        }
        return detectedXunlei
      }
    }
    xunleiDetectError = '未检测到本机迅雷客户端，请先安装迅雷后再使用接管下载。'
    detectedXunlei = {
      available: false,
      path: '',
      name: '迅雷',
      error: xunleiDetectError
    }
    return detectedXunlei
  })().finally(() => {
    xunleiDetectPromise = null
  })

  return xunleiDetectPromise
}

async function loadXunleiTasks() {
  try {
    const parsed = JSON.parse(await fsp.readFile(getXunleiTasksPath(), 'utf-8'))
    return Array.isArray(parsed?.tasks) ? parsed.tasks : []
  } catch {
    return []
  }
}

async function saveXunleiTasks(tasks) {
  await fsp.mkdir(getDownloadStateDir(), { recursive: true })
  await fsp.writeFile(getXunleiTasksPath(), JSON.stringify({
    version: 1,
    tasks: Array.isArray(tasks) ? tasks.slice(0, 80) : []
  }, null, 2), 'utf-8')
}

function getDisplayNameFromDownloadInput(input) {
  const value = String(input || '').trim()
  if (value.toLowerCase().startsWith('magnet:?')) {
    try {
      const queryIndex = value.indexOf('?')
      const params = new URLSearchParams(queryIndex >= 0 ? value.slice(queryIndex + 1) : '')
      const name = params.get('dn')
      if (name) return name
    } catch {}
    return '迅雷磁链任务'
  }
  try {
    const parsed = new URL(value)
    return decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '') || parsed.hostname || '迅雷下载任务'
  } catch {
    return '迅雷下载任务'
  }
}

function getXunleiProtocolUrl(input, dir) {
  return String(input || '').trim()
}

async function addXunleiTask({ url, dir }) {
  const input = String(url || '').trim()
  if (!input) throw new Error('请输入链接或磁链')
  const lower = input.toLowerCase()
  if (!lower.startsWith('magnet:?') && !/^https?:\/\//i.test(input)) {
    throw new Error('迅雷接管仅支持 magnet 或 http/https 链接')
  }
  const targetDir = await assertDownloadDirectory(dir)
  const xunlei = await detectXunlei()
  if (!xunlei?.available || !xunlei.path) {
    return {
      success: false,
      xunlei,
      error: xunlei?.error || xunleiDetectError || '未检测到本机迅雷客户端'
    }
  }

  const launchUrl = getXunleiProtocolUrl(input, targetDir)
  const launchArgs = lower.startsWith('magnet:?')
    ? [launchUrl, '-StartType:magnet']
    : [launchUrl]
  spawn(xunlei.path, launchArgs, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  }).unref()

  const task = {
    gid: `xunlei-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
    engine: 'xunlei',
    name: getDisplayNameFromDownloadInput(input),
    url: input,
    dir: targetDir,
    status: 'external',
    createdAt: new Date().toISOString(),
    message: '此任务已由迅雷接管，详细速度和进度请在迅雷查看；请在迅雷中确认保存目录一致。'
  }
  const current = await loadXunleiTasks()
  await saveXunleiTasks([task, ...current.filter(item => item?.gid !== task.gid)])

  return {
    success: true,
    task,
    xunlei
  }
}

function normalizeXunleiTask(task) {
  return {
    gid: task?.gid || '',
    engine: 'xunlei',
    name: task?.name || '迅雷下载任务',
    status: 'external',
    totalLength: 0,
    completedLength: 0,
    downloadSpeed: 0,
    uploadSpeed: 0,
    connections: 0,
    numSeeders: 0,
    seeder: false,
    errorCode: '',
    errorMessage: '',
    dir: typeof task?.dir === 'string' ? task.dir : '',
    files: [],
    bittorrent: null,
    followedBy: [],
    following: '',
    url: task?.url || '',
    createdAt: task?.createdAt || '',
    message: task?.message || '此任务已由迅雷接管，详细速度和进度请在迅雷查看；请在迅雷中确认保存目录一致。',
    sourceHealth: {
      kind: 'external',
      label: '迅雷接管',
      detail: '详细速度和进度请在迅雷查看；请确认保存目录一致',
      trackerCount: 0,
      trackerStatus: '外部客户端'
    }
  }
}

async function removeXunleiTask(gid) {
  const normalizedGid = String(gid || '').trim()
  if (!normalizedGid) throw new Error('下载任务无效')
  const tasks = await loadXunleiTasks()
  await saveXunleiTasks(tasks.filter(task => task?.gid !== normalizedGid))
  return getSnapshot({ start: true })
}

async function addUrl({ url, dir, httpHeaders }) {
  const parsed = new URL(String(url || '').trim())
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('仅支持 http/https 下载地址')
  }
  const targetDir = await assertDownloadDirectory(dir)
  await ensureStarted()
  const options = {
    dir: targetDir,
    continue: 'true',
    pause: 'false',
    'auto-file-renaming': 'true',
    'allow-overwrite': 'false'
  }
  const headers = normalizeDownloadHeaders(httpHeaders)
  if (headers.length > 0) options.header = headers
  const proxy = getDownloadProxy({ ...(httpHeaders || {}), url: parsed.toString() })
  if (proxy) options['all-proxy'] = proxy
  const gid = await rpc('aria2.addUri', [
    [parsed.toString()],
    options
  ])
  await rpc('aria2.saveSession').catch(() => {})
  return {
    gid,
    state: await getSnapshot({ start: true })
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

async function addMagnet({ magnet, dir }) {
  const normalizedMagnet = normalizeMagnet(magnet)
  const targetDir = await assertDownloadDirectory(dir)
  await ensureStarted()
  const gid = await rpc('aria2.addUri', [
    [normalizedMagnet],
    {
      dir: targetDir,
      pause: 'false',
      'pause-metadata': 'true',
      'bt-save-metadata': 'true',
      'bt-load-saved-metadata': 'true',
      'bt-remove-unselected-file': 'true',
      'bt-tracker': PUBLIC_BT_TRACKERS.join(','),
      'seed-time': '0',
      continue: 'true'
    }
  ])
  await rpc('aria2.saveSession').catch(() => {})
  return {
    gid,
    state: await getSnapshot({ start: true })
  }
}

async function changeSelectedFiles(gid, fileIndexes) {
  const normalizedGid = String(gid || '').trim()
  const indexes = Array.isArray(fileIndexes)
    ? [...new Set(fileIndexes.map(value => Number(value)).filter(value => Number.isInteger(value) && value > 0))]
    : []
  if (!normalizedGid) throw new Error('下载任务无效')
  if (indexes.length === 0) throw new Error('请至少选择一个文件')
  await ensureStarted()
  await rpc('aria2.changeOption', [
    normalizedGid,
    {
      'select-file': indexes.sort((a, b) => a - b).join(',')
    }
  ])
  await rpc('aria2.saveSession').catch(() => {})
  await rpc('aria2.unpause', [normalizedGid]).catch(() => {})
  return getSnapshot({ start: true })
}

async function pause(gid) {
  const normalizedGid = String(gid || '').trim()
  if (!normalizedGid) throw new Error('下载任务无效')
  await ensureStarted()
  await rpc('aria2.pause', [normalizedGid])
  await rpc('aria2.saveSession').catch(() => {})
  return getSnapshot({ start: true })
}

async function resume(gid) {
  const normalizedGid = String(gid || '').trim()
  if (!normalizedGid) throw new Error('下载任务无效')
  await ensureStarted()
  await rpc('aria2.unpause', [normalizedGid])
  await rpc('aria2.saveSession').catch(() => {})
  return getSnapshot({ start: true })
}

async function remove(gid) {
  const normalizedGid = String(gid || '').trim()
  if (!normalizedGid) throw new Error('下载任务无效')
  if (normalizedGid.startsWith('xunlei-')) {
    return removeXunleiTask(normalizedGid)
  }
  await ensureStarted()
  try {
    await rpc('aria2.remove', [normalizedGid])
  } catch {
    await rpc('aria2.removeDownloadResult', [normalizedGid])
  }
  await rpc('aria2.saveSession').catch(() => {})
  return getSnapshot({ start: true })
}

function disposeDownloadManager() {
  if (!isProcessRunning()) return
  rpc('aria2.saveSession').catch(() => {})
  rpc('aria2.shutdown').catch(() => {
    try {
      aria2Process?.kill()
    } catch {}
  })
}

module.exports = {
  detectAria2c,
  detectXunlei,
  checkBtPortStatus,
  getSnapshot,
  addUrl,
  addMagnet,
  addXunleiTask,
  changeSelectedFiles,
  pause,
  resume,
  remove,
  disposeDownloadManager
}
