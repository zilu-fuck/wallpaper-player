const path = require('path')
const fsp = require('fs/promises')
const crypto = require('crypto')
const { spawn } = require('child_process')
const { execFileTreeAsync } = require('./exec')
const { publishArtifact } = require('./application/download-service')

// 迅雷客户端接管适配：检测本机迅雷、生成接管任务并持久化。
// 与 aria2 引擎（download-manager.js）解耦，通过 createXunleiManager 注入目录依赖。

function createXunleiManager({ getDownloadStateDir, execute = execFileTreeAsync, launch = spawn }) {
  let detectedXunlei = null
  let xunleiDetectError = ''
  let xunleiDetectPromise = null
  let stateQueue = Promise.resolve()
  const lifecycle = new AbortController(), operations = new Set()
  const track = work => { operations.add(work); return work.finally(() => operations.delete(work)) }
  const check = (options = {}) => { options.throwIfAborted?.(); if (lifecycle.signal.aborted) throw lifecycle.signal.reason; if (options.signal?.aborted) throw options.signal.reason }

  function getXunleiTasksPath() {
    return path.join(getDownloadStateDir(), 'xunlei-tasks.json')
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

  async function getXunleiCandidatePaths(options) {
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
        const { stdout: raw } = await execute(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe'), ['query', 'HKCU\\Software\\Classes\\magnet\\shell\\open\\command', '/ve'], {
          windowsHide: true, signal: options.signal, maxBuffer: 128 * 1024,
          timeout: Math.max(1, Math.min(1500, (options.deadlineAt || Infinity) - Date.now()))
        })
        const command = raw.split(/\r?\n/).find(line => line.includes('REG_SZ'))?.replace(/^.*REG_SZ\s+/, '')
        const exe = extractExecutableFromCommand(command)
        if (exe) candidates.unshift(exe)
      } catch { check(options) }
    }

    return candidates.map(stripQuotes).filter(Boolean)
  }

  async function detect(refresh = false, supplied = {}) {
    const options = { ...supplied, signal: supplied.signal ? AbortSignal.any([supplied.signal, lifecycle.signal]) : lifecycle.signal }
    check(options)
    if (!refresh && detectedXunlei) return detectedXunlei
    if (!supplied.signal && xunleiDetectPromise) return xunleiDetectPromise

    const work = track((async () => {
      xunleiDetectError = ''
      const tried = []
      for (const candidate of await getXunleiCandidatePaths(options)) {
        check(options)
        const normalized = path.resolve(candidate)
        if (tried.includes(normalized)) continue
        tried.push(normalized)
        const exists = await fsp.stat(normalized).then(stat => stat.isFile(), () => false)
        check(options)
        if (exists) {
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
    })())
    if (supplied.signal) return work
    xunleiDetectPromise = work
    try { return await work } finally { if (xunleiDetectPromise === work) xunleiDetectPromise = null }
  }

  function getStatus() {
    return detectedXunlei || {
      available: false,
      path: '',
      name: '迅雷',
      error: xunleiDetectError || ''
    }
  }

  async function readTasks() {
    try {
      const stat = await fsp.stat(getXunleiTasksPath())
      if (!stat.isFile() || stat.size > 512 * 1024) throw new Error('迅雷接管记录超过大小上限')
      const parsed = JSON.parse(await fsp.readFile(getXunleiTasksPath(), 'utf-8'))
      if (parsed.version !== 1 || !Array.isArray(parsed.tasks) || parsed.tasks.length > 80 || parsed.tasks.some(task => !String(task?.gid || '').startsWith('xunlei-'))) throw new Error('迅雷接管记录损坏')
      return parsed.tasks
    } catch (error) {
      if (error.code === 'ENOENT') return []
      if (error instanceof SyntaxError) throw new Error('迅雷接管记录损坏，请保留文件后修复')
      throw error
    }
  }
  async function loadTasks() { await stateQueue.catch(() => {}); return readTasks() }
  function mutateTasks(change) {
    const work = stateQueue.catch(() => {}).then(async () => {
      const tasks = change(await readTasks()), target = getXunleiTasksPath(), temporary = target + '.' + crypto.randomUUID() + '.tmp'
      const serialized = JSON.stringify({ version: 1, tasks })
      if (Buffer.byteLength(serialized) > 512 * 1024) throw new Error('迅雷接管记录超过大小上限')
      await fsp.mkdir(getDownloadStateDir(), { recursive: true })
      try { await fsp.writeFile(temporary, serialized, { flag: 'wx' }); await publishArtifact(temporary, target, () => {}) }
      finally { await fsp.unlink(temporary).catch(() => {}) }
    })
    stateQueue = work; return work
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

  function getXunleiProtocolUrl(input) {
    return String(input || '').trim()
  }

  async function addTaskImpl({ url, dir, assertDownloadDirectory }, options) {
    check(options)
    const input = String(url || '').trim()
    if (!input) throw new Error('请输入链接或磁链')
    const lower = input.toLowerCase()
    if (!lower.startsWith('magnet:?') && !/^https?:\/\//i.test(input)) {
      throw new Error('迅雷接管仅支持 magnet 或 http/https 链接')
    }
    const targetDir = await assertDownloadDirectory(dir)
    check(options)
    const xunlei = await detect(false, options)
    check(options)
    if (!xunlei?.available || !xunlei.path) {
      return {
        success: false,
        xunlei,
        error: xunlei?.error || xunleiDetectError || '未检测到本机迅雷客户端'
      }
    }

    const launchUrl = getXunleiProtocolUrl(input)
    const launchArgs = lower.startsWith('magnet:?')
      ? [launchUrl, '-StartType:magnet']
      : [launchUrl]
    const task = {
      gid: `xunlei-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      engine: 'xunlei',
      name: getDisplayNameFromDownloadInput(input),
      url: input,
      dir: targetDir,
      status: 'external',
      createdAt: new Date().toISOString(),
      handoffState: 'pending',
      message: '已记录迅雷接管请求，尚不能确认客户端是否创建任务；请在迅雷中确认进度和保存目录。'
    }
    await mutateTasks(current => {
      if (current.length >= 80) throw new Error('迅雷接管记录已达 80 条，请先移除旧记录')
      return [task, ...current]
    })
    try {
      check(options)
      await new Promise((resolve, reject) => {
        const child = launch(xunlei.path, launchArgs, { detached: true, stdio: 'ignore', windowsHide: false })
        const timer = setTimeout(() => reject(Object.assign(new Error('迅雷打开结果未确认，请在客户端检查'), { handoffUnknown: true })), 5000)
        child.once('spawn', () => { clearTimeout(timer); resolve() })
        child.on('error', error => { clearTimeout(timer); reject(error) }); child.unref()
      })
      task.handoffState = 'requested'
      task.message = '已请求迅雷打开链接；本应用无法确认外部下载是否建立或完成，请在迅雷中查看并确认保存目录。'
    } catch (error) {
      task.handoffState = error.handoffUnknown ? 'unknown' : 'failed'; task.message = error.message
      await mutateTasks(current => current.map(item => item.gid === task.gid ? task : item))
      return { success: false, task, xunlei, error: error.message }
    }
    await mutateTasks(current => current.map(item => item.gid === task.gid ? task : item))

    return {
      success: true,
      task,
      xunlei
    }
  }

  function normalizeTask(task) {
    return {
      gid: task?.gid || '',
      engine: 'xunlei',
      name: task?.name || '迅雷下载任务',
      status: task?.handoffState === 'failed' ? 'error' : 'external',
      ownership: 'external',
      handoffState: task?.handoffState || 'legacy',
      controls: { pause: false, resume: false, removeRecord: true, stopExternal: false },
      totalLength: 0,
      completedLength: 0,
      downloadSpeed: 0,
      uploadSpeed: 0,
      connections: 0,
      numSeeders: 0,
      seeder: false,
      errorCode: '',
      errorMessage: task?.handoffState === 'failed' ? task.message || '打开迅雷失败' : '',
      dir: typeof task?.dir === 'string' ? task.dir : '',
      files: [],
      bittorrent: null,
      followedBy: [],
      following: '',
      url: task?.url || '',
      createdAt: task?.createdAt || '',
      message: task?.message || '已有迅雷接管请求记录；本应用无法确认外部任务进度，请在迅雷中确认。',
      sourceHealth: {
        kind: 'external',
        label: '迅雷接管',
        detail: '详细速度和进度请在迅雷查看；请确认保存目录一致',
        trackerCount: 0,
        trackerStatus: '外部客户端'
      }
    }
  }

  async function removeTask(gid) {
    check()
    const normalizedGid = String(gid || '').trim()
    if (!normalizedGid) throw new Error('下载任务无效')
    await mutateTasks(tasks => tasks.filter(task => task?.gid !== normalizedGid))
  }

  return {
    addTask: (payload, options = {}) => track(addTaskImpl(payload, options)),
    detect,
    getStatus,
    loadTasks,
    normalizeTask,
    removeTask,
    async dispose() { lifecycle.abort(new Error('迅雷接管服务正在关闭')); await Promise.allSettled([...operations]); await stateQueue.catch(() => {}) }
  }
}

module.exports = { createXunleiManager }
