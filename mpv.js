const { spawn, execFileSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const https = require('https')
const http = require('http')
const net = require('net')
const { app } = require('electron')
const { getSystemProxy } = require('./main/ytdlp-service')
const {
  destroyMpvHostWindow,
  getMpvHostHandle,
  hideMpvHostWindow,
  setMpvHostBounds,
  setMpvHostMainWindow,
  showMpvHostWindow,
  syncMpvHostWindowBounds
} = require('./main/mpv-host')
const { getMainWindow } = require('./main/window')

const MPV_DOWNLOAD_URL =
  'https://github.com/mpv-player/mpv/releases/download/v0.41.0/mpv-v0.41.0-x86_64-pc-windows-msvc.zip'
const MPV_FALLBACK_URL =
  'https://github.com/mpv-player/mpv/releases/download/v0.40.0/mpv-v0.40.0-x86_64-pc-windows-msvc.zip'

function getResourcePath(...segments) {
  return app.isPackaged
    ? path.join(process.resourcesPath, ...segments)
    : path.join(__dirname, ...segments)
}

function createDefaultState() {
  return {
    filePath: null,
    timePos: 0,
    duration: 0,
    paused: false,
    volume: 100,
    muted: false,
    speed: 1,
    audioId: null,
    subtitleId: null,
    subtitleVisible: true,
    subtitleScale: 1,
    loopFile: 'no',
    abLoopA: null,
    abLoopB: null,
    playlistPos: 0,
    playlistCount: 0,
    eofReached: false,
    trackList: []
  }
}

function toNumber(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function toNullableNumber(value) {
  if (value == null || value === '' || value === 'no') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function normalizeTrackSelection(value) {
  if (value == null || value === '' || value === 'auto') return 'auto'
  if (value === 'off' || value === 'no') return 'no'
  const n = Number(value)
  return Number.isFinite(n) ? n : value
}

function normalizeHostBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') return null

  const x = Number(bounds.x)
  const y = Number(bounds.y)
  const width = Number(bounds.width)
  const height = Number(bounds.height)

  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return null
  }

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height))
  }
}

function pathIdentity(filePath) {
  if (isRemoteMediaUrl(filePath)) return String(filePath || '').trim()
  const resolved = path.resolve(String(filePath || ''))
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isRemoteMediaUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function normalizeHttpHeaders(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return null
  const referer = typeof headers.referer === 'string' ? headers.referer.trim() : ''
  const userAgent = typeof headers.userAgent === 'string' ? headers.userAgent.trim() : ''
  return {
    referer,
    userAgent
  }
}

function normalizeMediaTarget(value) {
  const target = String(value || '').trim()
  return isRemoteMediaUrl(target) ? target : path.resolve(target)
}

function getProxyEnv(proxy) {
  const normalizedProxy = String(proxy || '').trim()
  if (!normalizedProxy) return process.env
  return {
    ...process.env,
    HTTP_PROXY: process.env.HTTP_PROXY || process.env.http_proxy || normalizedProxy,
    HTTPS_PROXY: process.env.HTTPS_PROXY || process.env.https_proxy || normalizedProxy,
    ALL_PROXY: process.env.ALL_PROXY || process.env.all_proxy || normalizedProxy
  }
}

function getMediaTitle(value) {
  if (isRemoteMediaUrl(value)) {
    try {
      const parsed = new URL(value)
      const name = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '')
      return name || parsed.hostname || '网络视频'
    } catch {
      return '网络视频'
    }
  }
  return path.basename(value)
}

function normalizePlaylistOptions(filePath, options = {}) {
  const current = normalizeMediaTarget(filePath)
  const currentKey = pathIdentity(current)
  const rawPlaylist = Array.isArray(options.playlist) ? options.playlist : []
  const paths = []
  const seen = new Set()

  for (const item of rawPlaylist) {
    if (typeof item !== 'string' || !item.trim()) continue
    const resolved = normalizeMediaTarget(item)
    const key = pathIdentity(resolved)
    if (seen.has(key)) continue
    seen.add(key)
    paths.push(resolved)
  }

  let startIndex = Number(options.playlistIndex)
  if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex >= paths.length || pathIdentity(paths[startIndex]) !== currentKey) {
    startIndex = paths.findIndex(item => pathIdentity(item) === currentKey)
  }

  if (startIndex < 0) {
    paths.unshift(current)
    startIndex = 0
  }

  return {
    paths: paths.length > 0 ? paths : [current],
    startIndex
  }
}

class MpvManager {
  constructor() {
    this.mpvPath = null
    this.process = null
    this.socket = null
    this.sessionId = 0
    this.pipePath = null
    this._ready = false
    this._buffer = ''
    this._nextRequestId = 1
    this._pendingRequests = new Map()
    this._observedProperties = new Map()
    this._currentState = createDefaultState()
    this._activeFilePath = null
    this._playlistPaths = []
    this._playlistIndex = -1
    this._pendingInitialState = null
    this._initialSeekApplied = false
    this._endedEmitted = false
    this._stopping = false
    this._stateEmitTimer = null
    this.eventHandlers = {}
  }

  async findMpv(customPath) {
    if (customPath && fs.existsSync(customPath)) {
      this.mpvPath = customPath
      return this.mpvPath
    }

    const bundledMpv = getResourcePath('vendor', 'mpv', 'mpv.exe')
    if (fs.existsSync(bundledMpv)) {
      this.mpvPath = bundledMpv
      return this.mpvPath
    }

    const appMpv = path.join(app.getPath('userData'), 'mpv', 'mpv.exe')
    if (fs.existsSync(appMpv)) {
      this.mpvPath = appMpv
      return this.mpvPath
    }

    try {
      execFileSync('mpv', ['--version'], { timeout: 5000, stdio: 'ignore' })
      this.mpvPath = 'mpv'
      return this.mpvPath
    } catch {
      return null
    }
  }

  getMpvPath() {
    return this.mpvPath
  }

  setMpvPath(mpvPath) {
    this.mpvPath = mpvPath
  }

  isReady() {
    return this._ready && !!this.mpvPath
  }

  getState() {
    return {
      ...this._currentState,
      filePath: this._activeFilePath,
      trackList: Array.isArray(this._currentState.trackList) ? [...this._currentState.trackList] : [],
      ready: this.isReady()
    }
  }

  async download(progressCallback) {
    const mpvDir = path.join(app.getPath('userData'), 'mpv')
    if (!fs.existsSync(mpvDir)) fs.mkdirSync(mpvDir, { recursive: true })

    const archivePath = path.join(mpvDir, 'mpv.zip')
    const mpvExePath = path.join(mpvDir, 'mpv.exe')

    await this._downloadFile(MPV_DOWNLOAD_URL, archivePath, progressCallback)
      .catch(() => this._downloadFile(MPV_FALLBACK_URL, archivePath, progressCallback))

    const extractDir = path.join(mpvDir, '_extract_tmp')
    if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true })
    fs.mkdirSync(extractDir, { recursive: true })

    await this._extractZip(archivePath, extractDir)

    const foundExe = this._findMpvExe(extractDir)
    if (!foundExe) {
      throw new Error('解压后未找到 mpv.exe，请手动下载 mpv 并在设置中指定路径')
    }

    const exeDir = path.dirname(foundExe)
    if (exeDir !== mpvDir) {
      for (const file of fs.readdirSync(exeDir)) {
        const src = path.join(exeDir, file)
        const dst = path.join(mpvDir, file)
        try {
          fs.renameSync(src, dst)
        } catch {
          fs.copyFileSync(src, dst)
          fs.unlinkSync(src)
        }
      }
    }

    try { fs.rmSync(extractDir, { recursive: true, force: true }) } catch {}
    try { fs.unlinkSync(archivePath) } catch {}

    if (!fs.existsSync(mpvExePath)) {
      throw new Error('解压后未找到 mpv.exe，请手动下载 mpv 并在设置中指定路径')
    }

    this.mpvPath = mpvExePath
    return mpvExePath
  }

  _findMpvExe(dir) {
    const direct = path.join(dir, 'mpv.exe')
    if (fs.existsSync(direct)) return direct

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const subDir = path.join(dir, entry.name)
        const sub = path.join(subDir, 'mpv.exe')
        if (fs.existsSync(sub)) return sub

        try {
          const subEntries = fs.readdirSync(subDir, { withFileTypes: true })
          for (const subEntry of subEntries) {
            if (!subEntry.isDirectory()) continue
            const deep = path.join(subDir, subEntry.name, 'mpv.exe')
            if (fs.existsSync(deep)) return deep
          }
        } catch {}
      }
    } catch {}

    return null
  }

  _downloadFile(url, dest, progressCallback) {
    return new Promise((resolve, reject) => {
      const follow = (nextUrl, redirects) => {
        if (redirects > 5) return reject(new Error('Too many redirects'))
        const client = nextUrl.startsWith('https:') ? https : http

        client.get(nextUrl, { headers: { 'User-Agent': 'VideoGallery/1.0' } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            let loc = res.headers.location
            if (loc.startsWith('/')) {
              const u = new URL(nextUrl)
              loc = u.protocol + '//' + u.host + loc
            }
            return follow(loc, redirects + 1)
          }

          if (res.statusCode !== 200) {
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

          res.pipe(file)
          file.on('finish', () => file.close(() => resolve()))
          const cleanup = (err) => {
            file.destroy()
            try { fs.unlinkSync(dest) } catch {}
            reject(err)
          }
          res.on('error', cleanup)
          file.on('error', cleanup)
        }).on('error', reject)
      }

      follow(url, 0)
    })
  }

  async _extractZip(archivePath, targetDir) {
    try {
      execFileSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${targetDir.replace(/'/g, "''")}' -Force`
      ], { timeout: 120000, stdio: 'ignore' })
      return
    } catch {}

    try {
      execFileSync('tar', ['-xf', archivePath, '-C', targetDir], { timeout: 120000, stdio: 'ignore' })
      return
    } catch {}

    throw new Error(
      '无法解压 ZIP 文件。请手动下载 mpv (https://github.com/mpv-player/mpv/releases) 并在设置中指定 mpv.exe 路径'
    )
  }

  async play(filePath, options = {}) {
    if (!this.mpvPath) throw new Error('mpv 未就绪')

    this.stop()
    setMpvHostMainWindow(getMainWindow())
    if (options.hostBounds != null) {
      this.setHostBounds(options.hostBounds)
    }

    const playlist = normalizePlaylistOptions(filePath, options)
    this._activeFilePath = playlist.paths[playlist.startIndex]
    this._playlistPaths = playlist.paths
    this._playlistIndex = playlist.startIndex
    this._currentState = createDefaultState()
    this._currentState.filePath = this._activeFilePath
    this._currentState.playlistPos = playlist.startIndex + 1
    this._currentState.playlistCount = playlist.paths.length
    this._pendingInitialState = this._normalizeInitialState(options)
    this._initialSeekApplied = false
    this._endedEmitted = false
    this._stopping = false

    const pid = process.pid
    const sessionId = ++this.sessionId
    const pipePath = process.platform === 'win32'
      ? `\\\\.\\pipe\\mpvgallery-${pid}-${sessionId}`
      : `/tmp/mpvgallery-${pid}-${sessionId}.sock`
    this.pipePath = pipePath

    if (process.platform !== 'win32') {
      try { fs.unlinkSync(pipePath) } catch {}
    }

    return new Promise((resolve, reject) => {
      let settled = false
      let output = ''

      const finish = (fn, value) => {
        if (settled) return
        settled = true
        fn(value)
      }

      const getExitError = (code) => {
        const detail = output.trim().split(/\r?\n/).filter(Boolean).slice(-4).join('\n')
        return new Error(detail || `mpv 启动失败，退出码 ${code ?? 'unknown'}`)
      }

      const args = [
        ...playlist.paths,
        `--input-ipc-server=${pipePath}`,
        '--no-terminal',
        '--force-window=immediate',
        '--no-resume-playback',
        `--playlist-start=${playlist.startIndex}`,
        `--title=${getMediaTitle(this._activeFilePath)}`,
        '--hr-seek=yes',
        '--vo=gpu',
        '--gpu-context=d3d11',
        '--hwdec=auto-safe',
        '--framedrop=vo',
        '--video-sync=display-resample',
        '--osc=no',
        '--input-default-bindings=yes',
        '--input-cursor=no'
      ]

      const httpHeaders = normalizeHttpHeaders(options.httpHeaders)
      if (httpHeaders?.referer) {
        args.push(`--referrer=${httpHeaders.referer}`)
      }
      if (httpHeaders?.userAgent) {
        args.push(`--user-agent=${httpHeaders.userAgent}`)
      }
      const proxyState = isRemoteMediaUrl(this._activeFilePath)
        ? getSystemProxy(this._activeFilePath)
        : null
      if (proxyState?.enabled && proxyState.proxy) {
        args.push(`--http-proxy=${proxyState.proxy}`)
      }

      syncMpvHostWindowBounds()
      const wid = getMpvHostHandle()
      if (wid) {
        args.splice(playlist.paths.length, 0, `--wid=${wid}`)
      }

      this.process = spawn(this.mpvPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        env: getProxyEnv(proxyState?.proxy)
      })
      const proc = this.process

      proc.stdout.on('data', (data) => { output += data.toString() })
      proc.stderr.on('data', (data) => { output += data.toString() })

      proc.on('error', (err) => {
        this._emit('error', { message: err.message })
        this._rejectAllPending(err)
        hideMpvHostWindow(true)
        finish(reject, err)
      })

      proc.on('exit', (code) => {
        const isCurrentProcess = this.process === proc
        if (!isCurrentProcess) return

        if (code !== 0) {
          const exitError = getExitError(code)
          this._emit('error', { message: exitError.message })
          this._rejectAllPending(exitError)
          hideMpvHostWindow(true)
          finish(reject, exitError)
        } else if (!this._stopping && !this._endedEmitted) {
          this._endedEmitted = true
          this._emit('ended', { reason: 'eof', code })
        }

        this._cleanupConnection(proc, new Error('mpv exited'))
      })

      this._connectWithRetry(pipePath, sessionId, 15, 400)
        .then(async () => {
          if (this.process !== proc || this.sessionId !== sessionId) {
            finish(reject, new Error('mpv session replaced'))
            return
          }
          this._ready = true
          this._buffer = ''
          this._listenEvents()
          await this._registerObservers()
          await this._applyImmediateInitialState()
          await this._applySeekIfNeeded()
          this._emitState()
          showMpvHostWindow()
          finish(resolve)
        })
        .catch((err) => {
          if (this.process === proc && !proc.killed) {
            this._ready = false
            showMpvHostWindow()
            finish(resolve)
          } else {
            finish(reject, err)
          }
        })
    })
  }

  _normalizeInitialState(options) {
    const resume = options?.resume === false ? {} : (options?.resume || options || {})
    return {
      position: toNumber(resume.position, 0),
      volume: resume.volume == null ? null : Math.max(0, Math.min(100, toNumber(resume.volume, 100))),
      speed: resume.speed == null ? null : Math.max(0.1, toNumber(resume.speed, 1)),
      muted: resume.muted == null ? null : Boolean(resume.muted),
      audioId: resume.audioId == null ? null : toNullableNumber(resume.audioId),
      subtitleId: resume.subtitleId == null ? null : toNullableNumber(resume.subtitleId),
      subtitleVisible: resume.subtitleVisible == null ? null : Boolean(resume.subtitleVisible),
      subtitleScale: resume.subtitleScale == null ? null : Math.max(0.1, toNumber(resume.subtitleScale, 1)),
      loopMode: typeof resume.loopMode === 'string' ? resume.loopMode : null,
      abLoopA: resume.abLoopA == null ? null : toNumber(resume.abLoopA, 0),
      abLoopB: resume.abLoopB == null ? null : toNumber(resume.abLoopB, 0)
    }
  }

  async _applyImmediateInitialState() {
    if (!this._pendingInitialState) return
    const state = this._pendingInitialState

    const tasks = []
    if (state.volume != null) tasks.push(this.setVolume(state.volume))
    if (state.speed != null) tasks.push(this.setSpeed(state.speed))
    if (state.muted != null) tasks.push(this.setMuted(state.muted))
    if (state.audioId != null) tasks.push(this.setAudioTrack(state.audioId))
    if (state.subtitleId != null) tasks.push(this.setSubtitleTrack(state.subtitleId))
    if (state.subtitleVisible != null) tasks.push(this.setSubtitleVisible(state.subtitleVisible))
    if (state.subtitleScale != null) tasks.push(this.setSubtitleScale(state.subtitleScale))
    if (state.loopMode != null) tasks.push(this.setLoopMode(state.loopMode))
    if (state.abLoopA != null || state.abLoopB != null) tasks.push(this.setABLoop(state.abLoopA, state.abLoopB))

    await Promise.allSettled(tasks)
  }

  async _applySeekIfNeeded() {
    if (this._initialSeekApplied || !this._pendingInitialState) return
    const position = this._pendingInitialState.position
    if (position <= 0) {
      this._initialSeekApplied = true
      return
    }

    try {
      await this.seekTo(position)
      this._initialSeekApplied = true
    } catch {}
  }

  _connectWithRetry(pipePath, sessionId, retries, delay) {
    return new Promise((resolve, reject) => {
      const tryConnect = (remaining) => {
        if (this.sessionId !== sessionId) return reject(new Error('mpv session replaced'))

        if (this.socket) {
          try { this.socket.destroy() } catch {}
          this.socket = null
        }

        const socket = net.createConnection(pipePath, () => {
          if (this.sessionId !== sessionId || this.socket !== socket) {
            try { socket.destroy() } catch {}
            return reject(new Error('mpv session replaced'))
          }
          socket.setEncoding('utf-8')
          resolve()
        })

        this.socket = socket
        socket.on('error', (err) => {
          if (this.socket !== socket) return
          if (remaining > 0) {
            setTimeout(() => tryConnect(remaining - 1), delay)
          } else {
            reject(err)
          }
        })
      }

      tryConnect(retries)
    })
  }

  _registerObservers() {
    const props = [
      'time-pos',
      'path',
      'duration',
      'pause',
      'volume',
      'mute',
      'speed',
      'aid',
      'sid',
      'sub-visibility',
      'sub-scale',
      'loop-file',
      'ab-loop-a',
      'ab-loop-b',
      'playlist-pos-1',
      'playlist-count',
      'track-list'
    ]

    return Promise.allSettled(props.map((name, index) => this.observeProperty(name, index + 1)))
  }

  _cleanupConnection(proc = this.process, reason = new Error('mpv connection closed'), socket = this.socket) {
    const matchesProcess = proc && this.process === proc
    const matchesSocket = socket && this.socket === socket
    if ((proc || socket) && !matchesProcess && !matchesSocket) return

    if (this.socket && (!socket || this.socket === socket)) {
      try { this.socket.destroy() } catch {}
      this.socket = null
    }
    this.process = null
    this._ready = false
    this._buffer = ''
    this._pendingInitialState = null
    this._initialSeekApplied = false
    this._clearStateEmitTimer()
    this._rejectAllPending(reason)
    this._observedProperties.clear()
    hideMpvHostWindow(true)
  }

  _markSocketClosed(socket, reason = new Error('mpv socket closed')) {
    if (socket && this.socket !== socket) return

    if (this.socket) {
      try { this.socket.destroy() } catch {}
      this.socket = null
    }

    this._ready = false
    this._buffer = ''
    this._rejectAllPending(reason)
    this._observedProperties.clear()
  }

  _rejectAllPending(err) {
    for (const { reject } of this._pendingRequests.values()) {
      try { reject(err) } catch {}
    }
    this._pendingRequests.clear()
  }

  _clearPendingRequests() {
    this._pendingRequests.clear()
    this._observedProperties.clear()
  }

  _send(payload) {
    if (!this.socket || !this._ready) {
      return Promise.reject(new Error('mpv not ready'))
    }

    const requestId = this._nextRequestId++
    const message = JSON.stringify({ request_id: requestId, ...payload })

    return new Promise((resolve, reject) => {
      this._pendingRequests.set(requestId, { resolve, reject })
      try {
        this.socket.write(message + '\n')
      } catch (err) {
        this._pendingRequests.delete(requestId)
        reject(err)
      }
    })
  }

  request(command, args = []) {
    return this._send({ command: [command, ...args] })
  }

  command(command, args = []) {
    return this.request(command, args)
  }

  getProperty(name) {
    return this.request('get_property', [name])
  }

  setProperty(name, value) {
    return this.request('set_property', [name, value])
  }

  observeProperty(name, id) {
    this._observedProperties.set(name, id)
    return this.request('observe_property', [id, name])
  }

  unobserveProperty(name) {
    const id = this._observedProperties.get(name)
    if (id == null) return Promise.resolve()
    this._observedProperties.delete(name)
    return this.request('unobserve_property', [id])
  }

  async seekTo(position) {
    if (position == null || Number.isNaN(Number(position))) return
    return this.setProperty('time-pos', Number(position))
  }

  seekRelative(delta) {
    return this.command('seek', [Number(delta), 'relative'])
  }

  cyclePause() {
    return this.command('cycle', ['pause'])
  }

  setPaused(paused) {
    return this.setProperty('pause', Boolean(paused))
  }

  setVolume(volume) {
    return this.setProperty('volume', Math.max(0, Math.min(100, Number(volume))))
  }

  setMuted(muted) {
    return this.setProperty('mute', Boolean(muted))
  }

  toggleMute() {
    return this.command('cycle', ['mute'])
  }

  setSpeed(speed) {
    return this.setProperty('speed', Math.max(0.1, Number(speed)))
  }

  cycleSpeed() {
    return this.command('cycle-values', ['speed', '0.5', '0.75', '1.0', '1.25', '1.5', '2.0'])
  }

  setAudioTrack(trackId) {
    const normalized = normalizeTrackSelection(trackId)
    if (normalized === 'auto') {
      return this.setProperty('aid', 'auto')
    }
    if (normalized === 'no') {
      return this.setProperty('aid', 'no')
    }
    return this.setProperty('aid', normalized)
  }

  cycleAudioTrack() {
    return this.command('cycle', ['aid'])
  }

  setSubtitleTrack(trackId) {
    const normalized = normalizeTrackSelection(trackId)
    if (normalized === 'no') {
      return this.setProperty('sid', 'no')
    }
    if (normalized === 'auto') {
      return this.setProperty('sid', 'auto')
    }
    return this.setProperty('sid', normalized)
  }

  cycleSubtitleTrack() {
    return this.command('cycle', ['sid'])
  }

  setSubtitleVisible(visible) {
    return this.setProperty('sub-visibility', Boolean(visible))
  }

  toggleSubtitleVisible() {
    return this.command('cycle', ['sub-visibility'])
  }

  setSubtitleScale(scale) {
    return this.setProperty('sub-scale', Math.max(0.1, Number(scale)))
  }

  setLoopMode(mode) {
    const normalized = mode === 'inf' || mode === true ? 'inf' : 'no'
    return this.setProperty('loop-file', normalized)
  }

  setHostBounds(bounds) {
    if (bounds == null) {
      hideMpvHostWindow(true)
      return false
    }

    const nextBounds = normalizeHostBounds(bounds)
    if (!nextBounds) return false

    const result = setMpvHostBounds(nextBounds)
    if (result && this._ready) {
      showMpvHostWindow()
    }
    return result
  }

  setABLoop(a, b) {
    const tasks = [
      this.setProperty('ab-loop-a', a == null ? 'no' : Number(a)),
      this.setProperty('ab-loop-b', b == null ? 'no' : Number(b))
    ]
    return Promise.allSettled(tasks)
  }

  clearABLoop() {
    return this.setABLoop(null, null)
  }

  async screenshot() {
    const dir = path.join(app.getPath('userData'), 'screenshots')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const filePath = path.join(dir, `shot-${stamp}.png`)
    await this.command('screenshot-to-file', [filePath, 'video'])
    return filePath
  }

  _listenEvents() {
    const socket = this.socket
    if (!socket) return

    socket.on('data', (data) => {
      this._buffer += data
      const lines = this._buffer.split('\n')
      this._buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.trim()) continue

        let json
        try {
          json = JSON.parse(line)
        } catch {
          continue
        }

        if (json.request_id != null) {
          const pending = this._pendingRequests.get(json.request_id)
          if (pending) {
            this._pendingRequests.delete(json.request_id)
            if (json.error && json.error !== 'success') {
              pending.reject(new Error(json.error))
            } else {
              pending.resolve(json.data)
            }
          }
        }

        if (json.event) {
          this._handleEvent(json)
          this._emit('mpv-event', json)
        }
      }
    })

    socket.on('close', () => {
      this._markSocketClosed(socket)
    })

    socket.on('error', () => {})
  }

  _handleEvent(json) {
    switch (json.event) {
      case 'property-change':
        this._applyPropertyChange(json.name, json.data)
        if (json.name === 'time-pos') {
          this._emitStateSoon()
        } else {
          this._emitState()
        }
        break
      case 'file-loaded':
        this._currentState.eofReached = false
        this._applySeekIfNeeded().catch(() => {})
        this._emitState()
        break
      case 'end-file':
        this._currentState.eofReached = json.reason === 'eof'
        if (json.reason === 'eof' && this._playlistIndex >= this._playlistPaths.length - 1) {
          this._endedEmitted = true
          this._emit('ended', json)
        }
        this._emitState()
        break
      case 'shutdown':
      case 'idle':
        this._emitState()
        break
      default:
        break
    }
  }

  _applyPropertyChange(name, data) {
    switch (name) {
      case 'time-pos':
        this._currentState.timePos = toNumber(data, 0)
        break
      case 'path':
        if (typeof data === 'string' && data.trim()) {
          this._activeFilePath = normalizeMediaTarget(data)
          this._currentState.filePath = this._activeFilePath
          this._playlistIndex = this._playlistPaths.findIndex(item => pathIdentity(item) === pathIdentity(this._activeFilePath))
        }
        break
      case 'duration':
        this._currentState.duration = toNumber(data, 0)
        break
      case 'pause':
        this._currentState.paused = Boolean(data)
        break
      case 'volume':
        this._currentState.volume = Math.max(0, Math.min(100, toNumber(data, 100)))
        break
      case 'mute':
        this._currentState.muted = Boolean(data)
        break
      case 'speed':
        this._currentState.speed = Math.max(0.1, toNumber(data, 1))
        break
      case 'aid':
        this._currentState.audioId = toNullableNumber(data)
        break
      case 'sid':
        this._currentState.subtitleId = toNullableNumber(data)
        break
      case 'sub-visibility':
        this._currentState.subtitleVisible = Boolean(data)
        break
      case 'sub-scale':
        this._currentState.subtitleScale = Math.max(0.1, toNumber(data, 1))
        break
      case 'loop-file':
        this._currentState.loopFile = data == null ? 'no' : String(data)
        break
      case 'ab-loop-a':
        this._currentState.abLoopA = toNullableNumber(data)
        break
      case 'ab-loop-b':
        this._currentState.abLoopB = toNullableNumber(data)
        break
      case 'playlist-pos-1':
        this._currentState.playlistPos = toNumber(data, 0)
        this._playlistIndex = Math.max(0, this._currentState.playlistPos - 1)
        break
      case 'playlist-count':
        this._currentState.playlistCount = toNumber(data, 0)
        break
      case 'track-list':
        this._currentState.trackList = Array.isArray(data) ? data : []
        break
      case 'eof-reached':
        this._currentState.eofReached = Boolean(data)
        break
      default:
        break
    }
  }

  _emitState() {
    this._emit('state', this.getState())
  }

  _emitStateSoon() {
    if (this._stateEmitTimer) return
    this._stateEmitTimer = setTimeout(() => {
      this._stateEmitTimer = null
      this._emitState()
    }, 500)
  }

  _clearStateEmitTimer() {
    if (!this._stateEmitTimer) return
    clearTimeout(this._stateEmitTimer)
    this._stateEmitTimer = null
  }

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

  stop() {
    this.sessionId++
    this._stopping = true
    const proc = this.process

    this._emit('state', this.getState())

    if (proc) {
      if (this.socket && this._ready) {
        try {
          this.socket.write(JSON.stringify({ command: ['quit'] }) + '\n')
        } catch {}
      }

      setTimeout(() => {
        try {
          if (proc && !proc.killed) proc.kill()
        } catch {}
      }, 1000)
    }

    this._cleanupConnection(proc)
    this._pendingInitialState = null
    this._initialSeekApplied = false
    this._activeFilePath = null
    this._playlistPaths = []
    this._playlistIndex = -1
    this._endedEmitted = false
    this._stopping = false
    this._currentState = createDefaultState()
    hideMpvHostWindow(true)
  }

  isPlaying() {
    return this.process !== null && !this.process.killed
  }

  destroy() {
    this.stop()
    this._clearStateEmitTimer()
    destroyMpvHostWindow()
    this.eventHandlers = {}
  }
}

module.exports = MpvManager
