const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron')
const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')
const { pathToFileURL } = require('url')
const { execFile, execFileSync } = require('child_process')
const MpvManager = require('./mpv')

// ─── 常量 ──────────────────────────────────────────────
const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.webm', '.mkv', '.avi', '.mov', '.wmv', '.flv',
  '.m4v', '.mpg', '.mpeg', '.3gp', '.ogv', '.ts', '.vob',
  '.rmvb', '.rm', '.asf', '.divx', '.f4v'
])

const DEFAULT_DIR = 'F:\\SteamLibrary\\steamapps\\workshop\\content\\431960'
const sessionAllowedDirectories = new Set()
const sessionAllowedMpvPaths = new Set()

function getResourcePath(...segments) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, ...segments)
  }
  return path.join(__dirname, ...segments)
}

// ─── 设置管理 ──────────────────────────────────────────
function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

function loadSettings() {
  const defaults = {
    theme: 'dark',
    directories: [DEFAULT_DIR],
    defaultDirectory: DEFAULT_DIR
  }

  try {
    const raw = fs.readFileSync(getSettingsPath(), 'utf-8')
    const parsed = JSON.parse(raw)
    return {
      ...defaults,
      ...parsed,
      directories: Array.isArray(parsed.directories) && parsed.directories.length > 0
        ? parsed.directories
        : defaults.directories,
      defaultDirectory: parsed.defaultDirectory || defaults.defaultDirectory
    }
  } catch {
    return defaults
  }
}

function saveSettings(settings) {
  const dir = path.dirname(getSettingsPath())
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const merged = {
    ...loadSettings(),
    ...settings
  }
  if (!Array.isArray(merged.directories) || merged.directories.length === 0) {
    merged.directories = [DEFAULT_DIR]
  }
  if (!merged.defaultDirectory) {
    merged.defaultDirectory = merged.directories[0]
  }
  fs.writeFileSync(getSettingsPath(), JSON.stringify(merged, null, 2))
}

// ─── 工具函数 ──────────────────────────────────────────
function isVideoFile(filePath) {
  return VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

function getThumbnailDir() {
  const dir = path.join(app.getPath('userData'), 'thumbnails')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function normalizeDirectoryList(directories) {
  return Array.isArray(directories)
    ? directories.filter(dir => typeof dir === 'string' && dir.trim())
    : []
}

function getAllowedVideoDirectories() {
  const settings = loadSettings()
  return [
    ...normalizeDirectoryList(settings.directories),
    ...sessionAllowedDirectories
  ].map(dir => path.resolve(dir))
}

function pathKey(inputPath) {
  const resolved = path.resolve(inputPath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isExistingFile(inputPath) {
  try {
    return fs.statSync(inputPath).isFile()
  } catch {
    return false
  }
}

function sanitizeSettingsForSave(settings) {
  const current = loadSettings()
  const sanitized = { ...settings }

  if (Object.hasOwn(sanitized, 'directories')) {
    const allowedDirectoryKeys = new Set([
      ...normalizeDirectoryList(current.directories),
      ...sessionAllowedDirectories
    ].map(pathKey))

    sanitized.directories = normalizeDirectoryList(sanitized.directories)
      .map(dir => path.resolve(dir))
      .filter(dir => allowedDirectoryKeys.has(pathKey(dir)))
  }

  if (Object.hasOwn(sanitized, 'defaultDirectory')) {
    const directories = normalizeDirectoryList(sanitized.directories ?? current.directories)
      .map(dir => path.resolve(dir))
    const defaultDirectory = typeof sanitized.defaultDirectory === 'string'
      ? path.resolve(sanitized.defaultDirectory)
      : ''

    sanitized.defaultDirectory = directories.some(dir => pathKey(dir) === pathKey(defaultDirectory))
      ? defaultDirectory
      : directories[0]
  }

  if (Object.hasOwn(sanitized, 'mpvPath') && sanitized.mpvPath) {
    const mpvPath = path.resolve(sanitized.mpvPath)
    const currentMpvPath = current.mpvPath ? path.resolve(current.mpvPath) : null
    const canSaveMpvPath = (
      (currentMpvPath && pathKey(currentMpvPath) === pathKey(mpvPath)) ||
      sessionAllowedMpvPaths.has(pathKey(mpvPath))
    )

    sanitized.mpvPath = canSaveMpvPath && isExistingFile(mpvPath)
      ? mpvPath
      : current.mpvPath
  }

  return sanitized
}

function isPathInside(parentPath, targetPath) {
  const relative = path.relative(parentPath, targetPath)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function resolveExistingPath(inputPath) {
  if (typeof inputPath !== 'string' || !inputPath.trim()) {
    throw new Error('路径无效')
  }
  const resolved = path.resolve(inputPath)
  await fsp.access(resolved)
  return resolved
}

async function assertAllowedDirectory(dirPath) {
  const resolved = await resolveExistingPath(dirPath)
  const stats = await fsp.stat(resolved)
  if (!stats.isDirectory()) {
    throw new Error('路径不是目录')
  }
  return resolved
}

async function assertAllowedVideoPath(filePath) {
  const resolved = await resolveExistingPath(filePath)
  const stats = await fsp.stat(resolved)
  if (!stats.isFile() || !isVideoFile(resolved)) {
    throw new Error('路径不是支持的视频文件')
  }

  const allowedDirs = getAllowedVideoDirectories()

  if (!allowedDirs.some(dir => isPathInside(dir, resolved))) {
    throw new Error('文件不在已添加的视频目录中')
  }

  return resolved
}

// ─── 扫描目录 ──────────────────────────────────────────
async function scanDirectory(dirPath, baseDir, depth = 0) {
  const results = []
  if (depth > 8) return results

  let entries
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: true })
  } catch {
    return results
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name)

    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
        results.push(...await scanDirectory(fullPath, baseDir, depth + 1))
      }
    } else if (entry.isFile() && isVideoFile(entry.name)) {
      try {
        const stats = await fsp.stat(fullPath)
        const relDir = path.relative(baseDir, dirPath)
        const group = relDir ? relDir.split(path.sep)[0] : path.basename(baseDir)

        results.push({
          id: Buffer.from(path.relative(baseDir, fullPath)).toString('base64url'),
          name: path.basename(entry.name, path.extname(entry.name)),
          fullPath,
          extension: path.extname(entry.name).toLowerCase(),
          size: stats.size,
          modified: stats.mtimeMs,
          group
        })
      } catch {
        // skip files with stat errors
      }
    }
  }

  return results
}

async function resolveMpvPath() {
  const settings = loadSettings()
  if (settings.mpvPath) {
    if (fs.existsSync(settings.mpvPath)) {
      mpvManager.setMpvPath(settings.mpvPath)
      return settings.mpvPath
    }
    mpvManager.setMpvPath(null)
  }

  const current = mpvManager.getMpvPath()
  if (current) {
    if (current === 'mpv' || current === 'mpv.exe' || fs.existsSync(current)) {
      return current
    }
    mpvManager.setMpvPath(null)
  }

  return mpvManager.findMpv(null)
}

// ─── FFmpeg 缩略图 ─────────────────────────────────────
let ffmpegPath = null

function findFfmpeg() {
  if (ffmpegPath) return ffmpegPath

  const candidates = [
    getResourcePath('vendor', 'ffmpeg', 'bin', 'ffmpeg.exe'),
    getResourcePath('vendor', 'ffmpeg', 'ffmpeg.exe'),
    'ffmpeg',
    'ffmpeg.exe',
    path.join(app.getAppPath(), 'ffmpeg.exe'),
    path.join(app.getAppPath(), 'ffmpeg'),
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe'
  ]

  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['-version'], { timeout: 5000, stdio: 'ignore' })
      ffmpegPath = candidate
      return candidate
    } catch {
      continue
    }
  }

  return null
}

function generateThumbnail(videoPath) {
  const thumbDir = getThumbnailDir()
  const thumbName = Buffer.from(videoPath).toString('base64url') + '.jpg'
  const thumbPath = path.join(thumbDir, thumbName)

  if (fs.existsSync(thumbPath)) {
    return Promise.resolve(thumbPath)
  }

  return new Promise((resolve) => {
    const ffmpeg = findFfmpeg()
    if (!ffmpeg) {
      return resolve(null)
    }

    // 取视频 10% 处的帧作为缩略图（跳过可能的黑色片头）
    execFile(ffmpeg, [
      '-i', videoPath,
      '-ss', '00:00:01',
      '-vframes', '1',
      '-vf', 'scale=480:-1',
      '-q:v', '3',
      '-y',
      thumbPath
    ], { timeout: 30000 }, (err) => {
      if (err) {
        // 如果 -ss 1 秒失败，尝试第 0 秒
        execFile(ffmpeg, [
          '-i', videoPath,
          '-vframes', '1',
          '-vf', 'scale=480:-1',
          '-q:v', '3',
          '-y',
          thumbPath
        ], { timeout: 30000 }, (err2) => {
          resolve(err2 ? null : thumbPath)
        })
      } else {
        resolve(thumbPath)
      }
    })
  })
}

// ─── mpv 播放器 ────────────────────────────────────────
const mpvManager = new MpvManager()

async function initMpv() {
  const settings = loadSettings()
  const customPath = settings.mpvPath || null
  const found = await mpvManager.findMpv(customPath)

  if (found) {
    console.log('[mpv] 已找到:', found)
  } else {
    console.log('[mpv] 未找到，首次使用时将自动下载')
  }

  // mpv 事件转发到渲染进程
  mpvManager.on('ended', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mpv-ended', data)
    }
  })

  mpvManager.on('mpv-event', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mpv-event', data)
    }
  })

  mpvManager.on('error', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mpv-error', data)
    }
  })
}

// ─── CSP 配置 ──────────────────────────────────────────
function setupCSP() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
          "script-src 'self'; " +
          "style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' file: data: blob:; " +
          "media-src 'self' file: data: blob:; " +
          "font-src 'self' file: data:; " +
          "connect-src 'self' ws: wss:;"
        ]
      }
    })
  })
}

// ─── 窗口管理 ──────────────────────────────────────────
let mainWindow = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: '视频画廊',
    backgroundColor: '#0a0a0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  // 开发模式加载 Vite dev server，生产模式加载构建文件
  const distPath = path.join(__dirname, 'dist', 'index.html')
  if (fs.existsSync(distPath)) {
    mainWindow.loadFile(distPath)
  } else {
    mainWindow.loadURL('http://localhost:5173')
  }

  mainWindow.on('closed', () => { mainWindow = null })
}

// ─── IPC 处理器 ────────────────────────────────────────
function setupIPC() {
  // 扫描指定目录的视频文件
  ipcMain.handle('scan-directory', async (_event, dirPath) => {
    try {
      const resolvedDir = await assertAllowedDirectory(dirPath)
      const allowedDirs = getAllowedVideoDirectories()

      if (allowedDirs.length > 0 && !allowedDirs.some(dir => isPathInside(dir, resolvedDir))) {
        return { error: `目录未添加到库中: ${dirPath}` }
      }

      const videos = await scanDirectory(resolvedDir, resolvedDir)
      return { videos, count: videos.length }
    } catch (err) {
      return { error: err.message }
    }
  })

  // 生成视频缩略图
  ipcMain.handle('generate-thumbnail', async (_event, videoPath) => {
    try {
      const resolvedPath = await assertAllowedVideoPath(videoPath)
      const thumbPath = await generateThumbnail(resolvedPath)
      return { thumbPath }
    } catch (err) {
      return { error: err.message }
    }
  })

  // 批量生成缩略图
  ipcMain.handle('generate-thumbnails', async (_event, payload) => {
    const videoPaths = Array.isArray(payload) ? payload : payload?.paths
    const requestId = Array.isArray(payload) ? null : payload?.requestId
    if (!Array.isArray(videoPaths)) {
      return {}
    }

    const results = {}
    const concurrency = 4
    let index = 0
    let completed = 0
    let lastProgressAt = 0

    function sendThumbnailProgress(force = false) {
      if (!mainWindow || mainWindow.isDestroyed()) return
      const now = Date.now()
      if (!force && now - lastProgressAt < 120) return
      lastProgressAt = now
      mainWindow.webContents.send('thumbnail-progress', {
        completed,
        total: videoPaths.length,
        requestId
      })
    }

    async function worker() {
      while (index < videoPaths.length) {
        const i = index++
        const vp = videoPaths[i]
        try {
          const resolvedPath = await assertAllowedVideoPath(vp)
          results[vp] = await generateThumbnail(resolvedPath)
        } catch {
          results[vp] = null
        }
        completed++
        sendThumbnailProgress(completed === videoPaths.length)
      }
    }

    sendThumbnailProgress(true)
    const workers = Array.from({ length: concurrency }, () => worker())
    await Promise.all(workers)
    sendThumbnailProgress(true)

    return results
  })

  // 获取设置
  ipcMain.handle('get-settings', async () => {
    return loadSettings()
  })

  // 保存设置
  ipcMain.handle('save-settings', async (_event, settings) => {
    saveSettings(sanitizeSettingsForSave(settings))
    return { success: true }
  })

  // 选择目录对话框
  ipcMain.handle('select-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: '选择视频目录'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const selectedDir = path.resolve(result.filePaths[0])
    sessionAllowedDirectories.add(selectedDir)
    return selectedDir
  })

  // 在文件管理器中显示文件
  ipcMain.handle('show-in-folder', async (_event, filePath) => {
    try {
      const resolvedPath = await assertAllowedVideoPath(filePath)
      shell.showItemInFolder(resolvedPath)
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  // 获取文件协议 URL
  ipcMain.handle('get-file-url', async (_event, filePath) => {
    const resolvedPath = await assertAllowedVideoPath(filePath)
    return pathToFileURL(resolvedPath).href
  })

  // 检查 ffmpeg 是否可用
  ipcMain.handle('check-ffmpeg', async () => {
    return new Promise((resolve) => {
      const ffmpeg = findFfmpeg()
      if (!ffmpeg) return resolve({ available: false })

      execFile(ffmpeg, ['-version'], { timeout: 5000 }, (err, stdout) => {
        if (err) return resolve({ available: false })
        const versionLine = stdout.split('\n')[0]
        resolve({ available: true, version: versionLine })
      })
    })
  })

  // ─── mpv 相关 IPC ──────────────────────────────────

  // 检查 mpv 状态
  ipcMain.handle('check-mpv', async () => {
    const mpvPath = await resolveMpvPath()
    if (mpvPath) {
      try {
        const stdout = execFileSync(mpvPath, ['--version'], { timeout: 5000, encoding: 'utf-8', stdio: 'pipe' })
        const versionLine = stdout.split('\n')[0]
        return { available: true, path: mpvPath, version: versionLine }
      } catch {
        return { available: false, path: mpvPath, version: 'unknown' }
      }
    }
    return { available: false, path: null }
  })

  // 下载 mpv
  ipcMain.handle('download-mpv', async () => {
    try {
      const mpvPath = await mpvManager.download((progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('mpv-download-progress', progress)
        }
      })
      return { success: true, path: mpvPath }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  // 用 mpv 播放视频
  ipcMain.handle('mpv-play', async (_event, filePath) => {
    try {
      const resolvedPath = await assertAllowedVideoPath(filePath)
      const mpvPath = await resolveMpvPath()
      if (!mpvPath) {
        return { success: false, error: 'mpv 未安装' }
      }
      await mpvManager.play(resolvedPath)
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  // 停止 mpv 播放
  ipcMain.handle('mpv-stop', async () => {
    mpvManager.stop()
    return { success: true }
  })

  // 查询 mpv 是否正在播放
  ipcMain.handle('mpv-is-playing', async () => {
    return mpvManager.isPlaying()
  })

  // 选择 mpv.exe 路径
  ipcMain.handle('select-mpv-path', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      title: '选择 mpv.exe',
      filters: [{ name: '可执行文件', extensions: ['exe'] }, { name: '所有文件', extensions: ['*'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const selectedPath = path.resolve(result.filePaths[0])
    sessionAllowedMpvPaths.add(pathKey(selectedPath))
    return selectedPath
  })
}

// ─── 应用生命周期 ──────────────────────────────────────
app.whenReady().then(async () => {
  setupCSP()
  setupIPC()
  createWindow()
  await initMpv()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  mpvManager.destroy()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  mpvManager.destroy()
})
