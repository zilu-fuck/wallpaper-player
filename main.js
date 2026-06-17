const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron')
const path = require('path')
const fs = require('fs')
const { execFile, execFileSync } = require('child_process')
const MpvManager = require('./mpv')

// ─── 常量 ──────────────────────────────────────────────
const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.webm', '.mkv', '.avi', '.mov', '.wmv', '.flv',
  '.m4v', '.mpg', '.mpeg', '.3gp', '.ogv', '.ts', '.vob',
  '.rmvb', '.rm', '.asf', '.divx', '.f4v'
])

const DEFAULT_DIR = 'F:\\SteamLibrary\\steamapps\\workshop\\content\\431960'

// ─── 设置管理 ──────────────────────────────────────────
function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(getSettingsPath(), 'utf-8')
    return JSON.parse(raw)
  } catch {
    return {
      directories: [DEFAULT_DIR],
      defaultDirectory: DEFAULT_DIR
    }
  }
}

function saveSettings(settings) {
  const dir = path.dirname(getSettingsPath())
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2))
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

function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

// ─── 扫描目录 ──────────────────────────────────────────
function scanDirectory(dirPath, baseDir, depth = 0) {
  const results = []
  if (depth > 8) return results

  let entries
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true })
  } catch {
    return results
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name)

    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
        results.push(...scanDirectory(fullPath, baseDir, depth + 1))
      }
    } else if (entry.isFile() && isVideoFile(entry.name)) {
      try {
        const stats = fs.statSync(fullPath)
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

// ─── FFmpeg 缩略图 ─────────────────────────────────────
let ffmpegPath = null

function findFfmpeg() {
  if (ffmpegPath) return ffmpegPath

  const candidates = [
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

function getVideoDuration(ffprobePath, videoPath) {
  return new Promise((resolve) => {
    const probe = ffprobePath || ffmpegPath?.replace('ffmpeg', 'ffprobe') || 'ffprobe'
    execFile(probe, [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', videoPath
    ], { timeout: 10000 }, (err, stdout) => {
      if (err) return resolve(0)
      resolve(parseFloat(stdout.trim()) || 0)
    })
  })
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
          "default-src 'self' 'unsafe-inline' 'unsafe-eval' file: data:; " +
          "img-src 'self' file: data: blob:; " +
          "media-src 'self' file: data: blob:; " +
          "font-src 'self' file: data:; " +
          "connect-src 'self' ws: wss: file:;"
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
      if (!fs.existsSync(dirPath)) {
        return { error: `目录不存在: ${dirPath}` }
      }
      const videos = scanDirectory(dirPath, dirPath)
      return { videos, count: videos.length }
    } catch (err) {
      return { error: err.message }
    }
  })

  // 生成视频缩略图
  ipcMain.handle('generate-thumbnail', async (_event, videoPath) => {
    try {
      const thumbPath = await generateThumbnail(videoPath)
      return { thumbPath }
    } catch (err) {
      return { error: err.message }
    }
  })

  // 批量生成缩略图
  ipcMain.handle('generate-thumbnails', async (event, videoPaths) => {
    const results = {}
    const concurrency = 4
    let index = 0

    async function worker() {
      while (index < videoPaths.length) {
        const i = index++
        const vp = videoPaths[i]
        try {
          results[vp] = await generateThumbnail(vp)
        } catch {
          results[vp] = null
        }
        // 通知进度
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('thumbnail-progress', {
            completed: Object.keys(results).length,
            total: videoPaths.length
          })
        }
      }
    }

    const workers = Array.from({ length: concurrency }, () => worker())
    await Promise.all(workers)

    return results
  })

  // 获取设置
  ipcMain.handle('get-settings', async () => {
    return loadSettings()
  })

  // 保存设置
  ipcMain.handle('save-settings', async (_event, settings) => {
    saveSettings(settings)
    return { success: true }
  })

  // 选择目录对话框
  ipcMain.handle('select-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: '选择视频目录'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // 在文件管理器中显示文件
  ipcMain.handle('show-in-folder', async (_event, filePath) => {
    shell.showItemInFolder(filePath)
    return { success: true }
  })

  // 获取文件协议 URL
  ipcMain.handle('get-file-url', async (_event, filePath) => {
    const url = 'file:///' + filePath.replace(/\\/g, '/')
    return url
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
    const mpvPath = mpvManager.getMpvPath()
    if (mpvPath) {
      try {
        const stdout = execFileSync(mpvPath, ['--version'], { timeout: 5000, encoding: 'utf-8' })
        const versionLine = stdout.split('\n')[0]
        return { available: true, path: mpvPath, version: versionLine }
      } catch {
        return { available: true, path: mpvPath, version: 'unknown' }
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
      if (!mpvManager.getMpvPath()) {
        return { success: false, error: 'mpv 未安装' }
      }
      await mpvManager.play(filePath)
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
    return result.filePaths[0]
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
