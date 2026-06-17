const { spawn, execFileSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const https = require('https')
const http = require('http')
const net = require('net')
const { app } = require('electron')

const MPV_DOWNLOAD_URL =
  'https://github.com/mpv-player/mpv/releases/download/v0.41.0/mpv-v0.41.0-x86_64-pc-windows-msvc.zip'
const MPV_FALLBACK_URL =
  'https://github.com/mpv-player/mpv/releases/download/v0.40.0/mpv-v0.40.0-x86_64-pc-windows-msvc.zip'

class MpvManager {
  constructor() {
    this.mpvPath = null
    this.process = null
    this.socket = null
    this.requestId = 0
    this.pipePath = null
    this.eventHandlers = {}
    this._ready = false
  }

  // ─── 查找 mpv ──────────────────────────────────────
  async findMpv(customPath) {
    if (customPath && fs.existsSync(customPath)) {
      this.mpvPath = customPath
      return this.mpvPath
    }

    // 1) userData/mpv/mpv.exe
    const appMpv = path.join(app.getPath('userData'), 'mpv', 'mpv.exe')
    if (fs.existsSync(appMpv)) {
      this.mpvPath = appMpv
      return this.mpvPath
    }

    // 2) 系统 PATH
    try {
      execFileSync('mpv', ['--version'], { timeout: 5000, stdio: 'ignore' })
      this.mpvPath = 'mpv'
      return this.mpvPath
    } catch {
      // not found
    }

    return null
  }

  getMpvPath() {
    return this.mpvPath
  }

  isReady() {
    return this._ready && this.mpvPath
  }

  // ─── 下载 mpv ──────────────────────────────────────
  async download(progressCallback) {
    const mpvDir = path.join(app.getPath('userData'), 'mpv')
    if (!fs.existsSync(mpvDir)) fs.mkdirSync(mpvDir, { recursive: true })

    const archivePath = path.join(mpvDir, 'mpv.zip')
    const mpvExePath = path.join(mpvDir, 'mpv.exe')

    // 下载 ZIP 包（官方源，失败则用备用版本）
    await this._downloadFile(MPV_DOWNLOAD_URL, archivePath, progressCallback)
      .catch(() => this._downloadFile(MPV_FALLBACK_URL, archivePath, progressCallback))

    // 解压到临时目录，再整理到 mpvDir
    const extractDir = path.join(mpvDir, '_extract_tmp')
    if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true })
    fs.mkdirSync(extractDir, { recursive: true })

    await this._extractZip(archivePath, extractDir)

    // 官方 ZIP 可能将文件放在子目录中，找到 mpv.exe 所在位置
    const foundExe = this._findMpvExe(extractDir)
    if (!foundExe) {
      throw new Error('解压后未找到 mpv.exe，请手动下载 mpv 并在设置中指定路径')
    }

    // 将 mpv.exe 及其同目录文件移至 mpvDir
    const exeDir = path.dirname(foundExe)
    if (exeDir !== mpvDir) {
      for (const file of fs.readdirSync(exeDir)) {
        const src = path.join(exeDir, file)
        const dst = path.join(mpvDir, file)
        try {
          fs.renameSync(src, dst)
        } catch {
          // 跨盘符 rename 失败时用 copy + unlink
          fs.copyFileSync(src, dst)
          fs.unlinkSync(src)
        }
      }
    }

    // 清理临时文件
    try { fs.rmSync(extractDir, { recursive: true, force: true }) } catch {}
    try { fs.unlinkSync(archivePath) } catch {}

    if (!fs.existsSync(mpvExePath)) {
      throw new Error('解压后未找到 mpv.exe，请手动下载 mpv 并在设置中指定路径')
    }

    this.mpvPath = mpvExePath
    return mpvExePath
  }

  _findMpvExe(dir) {
    // 先在当前目录查找
    const direct = path.join(dir, 'mpv.exe')
    if (fs.existsSync(direct)) return direct

    // 递归查找（最多深入 2 层）
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const sub = path.join(dir, entry.name, 'mpv.exe')
          if (fs.existsSync(sub)) return sub
          // 再深一层
          try {
            const subEntries = fs.readdirSync(path.join(dir, entry.name), { withFileTypes: true })
            for (const se of subEntries) {
              if (se.isDirectory()) {
                const deep = path.join(dir, entry.name, se.name, 'mpv.exe')
                if (fs.existsSync(deep)) return deep
              }
            }
          } catch {}
        }
      }
    } catch {}
    return null
  }

  _downloadFile(url, dest, progressCallback) {
    return new Promise((resolve, reject) => {
      const follow = (url, redirects) => {
        if (redirects > 5) return reject(new Error('Too many redirects'))
        const client = url.startsWith('https:') ? https : http
        client.get(url, { headers: { 'User-Agent': 'VideoGallery/1.0' } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            let loc = res.headers.location
            if (loc.startsWith('/')) {
              const u = new URL(url)
              loc = u.protocol + '//' + u.host + loc
            }
            return follow(loc, redirects + 1)
          }
          if (res.statusCode !== 200) {
            // 出错时关闭已打开的写入流，防止文件锁泄漏
            try { fs.unlinkSync(dest) } catch {}
            return reject(new Error(`HTTP ${res.statusCode}`))
          }
          const total = parseInt(res.headers['content-length'] || '0', 10)
          let downloaded = 0
          const file = fs.createWriteStream(dest)
          res.on('data', (chunk) => {
            downloaded += chunk.length
            if (progressCallback && total > 0) {
              progressCallback({ downloaded, total, percent: Math.round((downloaded / total) * 100) })
            }
          })
          res.on('end', () => file.close(() => resolve()))
          res.on('error', (err) => { file.destroy(); try { fs.unlinkSync(dest) } catch {}; reject(err) })
          file.on('error', (err) => { file.destroy(); try { fs.unlinkSync(dest) } catch {}; reject(err) })
        }).on('error', reject)
      }
      follow(url, 0)
    })
  }

  async _extractZip(archivePath, targetDir) {
    // PowerShell Expand-Archive（Windows 10+ 内置，无需额外依赖）
    try {
      execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${targetDir.replace(/'/g, "''")}' -Force`
      ], { timeout: 120000, stdio: 'ignore' })
      return
    } catch { /* try fallback */ }

    // 备用: Windows 10+ tar.exe 也支持 ZIP
    try {
      execFileSync('tar', ['-xf', archivePath, '-C', targetDir], { timeout: 120000, stdio: 'ignore' })
      return
    } catch { /* continue */ }

    throw new Error(
      '无法解压 ZIP 文件。请手动下载 mpv (https://github.com/mpv-player/mpv/releases) ' +
      '并在设置中指定 mpv.exe 路径'
    )
  }

  // ─── 启动 mpv 播放 ─────────────────────────────────
  async play(filePath) {
    if (!this.mpvPath) throw new Error('mpv 未就绪')

    // 先停止已有实例
    this.stop()

    const pid = process.pid
    this.pipePath = process.platform === 'win32'
      ? `\\\\.\\pipe\\mpvgallery-${pid}`
      : `/tmp/mpvgallery-${pid}.sock`

    // 清理旧 socket 文件 (Unix)
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(this.pipePath) } catch {}
    }

    return new Promise((resolve, reject) => {
      const args = [
        filePath,
        `--input-ipc-server=${this.pipePath}`,
        '--no-terminal',
        '--force-window=immediate',
        '--window-autofit=yes',
        '--autofit-larger=90%x90%',
        '--no-resume-playback',
        '--title=${filename}',
        '--hr-seek=yes',
        '--hwdec=auto',
      ]

      this.process = spawn(this.mpvPath, args, { stdio: 'ignore', detached: false })

      this.process.on('error', (err) => {
        this._emit('error', { message: err.message })
        reject(err)
      })

      this.process.on('exit', (code) => {
        this._emit('ended', { code })
        this.process = null
        this._disconnectSocket()
      })

      // 等待 IPC pipe 就绪后连接
      this._connectWithRetry(15, 400)
        .then(() => {
          this._ready = true
          this._listenEvents()
          resolve()
        })
        .catch((err) => {
          // mpv 可能已启动但 IPC 不可用，仍然算成功启动
          if (this.process && !this.process.killed) {
            this._ready = false
            resolve()
          } else {
            reject(err)
          }
        })
    })
  }

  _connectWithRetry(retries, delay) {
    return new Promise((resolve, reject) => {
      const tryConnect = (n) => {
        // 销毁上一次失败的 socket，防止泄漏
        if (this.socket) {
          try { this.socket.destroy() } catch {}
          this.socket = null
        }
        this.socket = net.createConnection(this.pipePath, () => {
          this.socket.setEncoding('utf-8')
          resolve()
        })
        this.socket.on('error', (err) => {
          if (n > 0) {
            setTimeout(() => tryConnect(n - 1), delay)
          } else {
            reject(err)
          }
        })
      }
      tryConnect(retries)
    })
  }

  _disconnectSocket() {
    if (this.socket) {
      try { this.socket.destroy() } catch {}
      this.socket = null
    }
    this._ready = false
  }

  // ─── IPC 通信 ──────────────────────────────────────
  send(command, args = []) {
    if (!this.socket || !this._ready) return
    const msg = JSON.stringify({ command: [command, ...args] })
    try { this.socket.write(msg + '\n') } catch {}
  }

  sendProperty(name, value) {
    if (!this.socket || !this._ready) return
    const msg = JSON.stringify({ command: ['set_property', name, value] })
    try { this.socket.write(msg + '\n') } catch {}
  }

  _listenEvents() {
    if (!this.socket) return
    let buffer = ''
    this.socket.on('data', (data) => {
      buffer += data
      const lines = buffer.split('\n')
      buffer = lines.pop()
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const json = JSON.parse(line)
          if (json.event) {
            this._emit('mpv-event', json)
          }
        } catch { /* ignore */ }
      }
    })
    this.socket.on('close', () => { this._disconnectSocket() })
    this.socket.on('error', () => { /* ignore */ })
  }

  // ─── 事件系统 ──────────────────────────────────────
  on(event, handler) {
    if (!this.eventHandlers[event]) this.eventHandlers[event] = []
    this.eventHandlers[event].push(handler)
  }

  off(event, handler) {
    if (!this.eventHandlers[event]) return
    this.eventHandlers[event] = this.eventHandlers[event].filter(h => h !== handler)
  }

  _emit(event, data) {
    const handlers = this.eventHandlers[event]
    if (handlers) handlers.forEach(h => h(data))
  }

  // ─── 停止播放 ──────────────────────────────────────
  stop() {
    this._disconnectSocket()
    if (this.process) {
      try { this.process.kill() } catch {}
      this.process = null
    }
    this._ready = false
  }

  isPlaying() {
    return this.process !== null && !this.process.killed
  }

  // ─── 清理 ──────────────────────────────────────────
  destroy() {
    this.stop()
    this.eventHandlers = {}
  }
}

module.exports = MpvManager
