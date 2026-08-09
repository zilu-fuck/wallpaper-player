const path = require('path')
const fsp = require('fs/promises')
const crypto = require('crypto')
const { spawn } = require('child_process')
const { isExistingFile } = require('./paths')

// 迅雷客户端接管适配：检测本机迅雷、生成接管任务并持久化。
// 与 aria2 引擎（download-manager.js）解耦，通过 createXunleiManager 注入目录依赖。

function createXunleiManager({ getDownloadStateDir }) {
  let detectedXunlei = null
  let xunleiDetectError = ''
  let xunleiDetectPromise = null

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

  async function detect(refresh = false) {
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

  function getStatus() {
    return detectedXunlei || {
      available: false,
      path: '',
      name: '迅雷',
      error: xunleiDetectError || ''
    }
  }

  async function loadTasks() {
    try {
      const parsed = JSON.parse(await fsp.readFile(getXunleiTasksPath(), 'utf-8'))
      return Array.isArray(parsed?.tasks) ? parsed.tasks : []
    } catch {
      return []
    }
  }

  async function saveTasks(tasks) {
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

  function getXunleiProtocolUrl(input) {
    return String(input || '').trim()
  }

  async function addTask({ url, dir, assertDownloadDirectory }) {
    const input = String(url || '').trim()
    if (!input) throw new Error('请输入链接或磁链')
    const lower = input.toLowerCase()
    if (!lower.startsWith('magnet:?') && !/^https?:\/\//i.test(input)) {
      throw new Error('迅雷接管仅支持 magnet 或 http/https 链接')
    }
    const targetDir = await assertDownloadDirectory(dir)
    const xunlei = await detect()
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
    const current = await loadTasks()
    await saveTasks([task, ...current.filter(item => item?.gid !== task.gid)])

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

  async function removeTask(gid) {
    const normalizedGid = String(gid || '').trim()
    if (!normalizedGid) throw new Error('下载任务无效')
    const tasks = await loadTasks()
    await saveTasks(tasks.filter(task => task?.gid !== normalizedGid))
  }

  return {
    addTask,
    detect,
    getStatus,
    loadTasks,
    normalizeTask,
    removeTask
  }
}

module.exports = { createXunleiManager }
