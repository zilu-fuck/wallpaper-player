const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron')
const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')
const { pathToFileURL } = require('url')
const { execFile, execFileSync } = require('child_process')
const { autoUpdater } = require('electron-updater')
const log = require('electron-log')
const MpvManager = require('./mpv')

// ─── 常量 ──────────────────────────────────────────────
const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.webm', '.mkv', '.avi', '.mov', '.wmv', '.flv',
  '.m4v', '.mpg', '.mpeg', '.3gp', '.ogv', '.ts', '.vob',
  '.rmvb', '.rm', '.asf', '.divx', '.f4v'
])
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'])

const sessionAllowedDirectories = new Set()
const sessionAllowedMpvPaths = new Set()
let updateCheckTimer = null

function getResourcePath(...segments) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, ...segments)
  }
  return path.join(__dirname, ...segments)
}

function isPortableApp() {
  return Boolean(process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR)
}

// ─── 设置管理 ──────────────────────────────────────────
function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

function loadSettings() {
  const defaults = {
    theme: 'dark',
    directories: [],
    defaultDirectory: '',
    favorites: [],
    customTags: {}
  }

  try {
    const raw = fs.readFileSync(getSettingsPath(), 'utf-8')
    const parsed = JSON.parse(raw)
    const directories = normalizeDirectoryList(parsed.directories)
    const defaultDirectory = typeof parsed.defaultDirectory === 'string' && directories.includes(parsed.defaultDirectory)
      ? parsed.defaultDirectory
      : directories[0] || ''

    return {
      ...defaults,
      ...parsed,
      directories,
      defaultDirectory,
      favorites: Array.isArray(parsed.favorites) ? parsed.favorites : defaults.favorites,
      customTags: normalizeCustomTags(parsed.customTags)
    }
  } catch {
    return defaults
  }
}

function normalizeCustomTags(customTags) {
  if (!customTags || typeof customTags !== 'object' || Array.isArray(customTags)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(customTags)
      .filter(([key]) => typeof key === 'string' && key.trim())
      .map(([key, tags]) => [
        key,
        Array.isArray(tags)
          ? [...new Set(tags.filter(tag => typeof tag === 'string' && tag.trim()).map(tag => tag.trim()))]
          : []
      ])
      .filter(([, tags]) => tags.length > 0)
  )
}

function saveSettings(settings) {
  const dir = path.dirname(getSettingsPath())
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const merged = {
    ...loadSettings(),
    ...settings
  }
  merged.directories = normalizeDirectoryList(merged.directories)
  if (!merged.defaultDirectory || !merged.directories.includes(merged.defaultDirectory)) {
    merged.defaultDirectory = merged.directories[0] || ''
  }
  if (!Array.isArray(merged.favorites)) {
    merged.favorites = []
  }
  merged.customTags = normalizeCustomTags(merged.customTags)
  fs.writeFileSync(getSettingsPath(), JSON.stringify(merged, null, 2))
}

// ─── 工具函数 ──────────────────────────────────────────
function isVideoFile(filePath) {
  return VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

async function readWallpaperMetadata(dirPath) {
  try {
    const projectPath = path.join(dirPath, 'project.json')
    const raw = await fsp.readFile(projectPath, 'utf-8')
    const project = JSON.parse(raw)
    const tags = Array.isArray(project.tags)
      ? project.tags.filter(tag => typeof tag === 'string' && tag.trim()).map(tag => tag.trim())
      : []
    const workshopId = project.workshopid ? String(project.workshopid) : path.basename(dirPath)
    const wallpaperDir = path.resolve(dirPath)
    const previewPath = typeof project.preview === 'string' && project.preview.trim()
      ? path.resolve(dirPath, project.preview)
      : null
    const safePreviewPath = previewPath && isPathInside(wallpaperDir, previewPath) && fs.existsSync(previewPath)
      ? previewPath
      : null

    return {
      projectDir: dirPath,
      title: typeof project.title === 'string' ? project.title.trim() : '',
      description: typeof project.description === 'string' ? project.description : '',
      tags,
      type: typeof project.type === 'string' ? project.type.trim() : '',
      file: typeof project.file === 'string' ? project.file : '',
      previewPath: safePreviewPath,
      workshopId,
      workshopUrl: typeof project.workshopurl === 'string' ? project.workshopurl : ''
    }
  } catch {
    return null
  }
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

function isMpvExecutablePath(inputPath) {
  if (inputPath === 'mpv' || inputPath === 'mpv.exe') return true
  return path.basename(inputPath).toLowerCase() === 'mpv.exe'
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

    sanitized.mpvPath = canSaveMpvPath && isMpvExecutablePath(mpvPath) && isExistingFile(mpvPath)
      ? mpvPath
      : current.mpvPath
  }

  if (Object.hasOwn(sanitized, 'favorites')) {
    sanitized.favorites = Array.isArray(sanitized.favorites)
      ? [...new Set(sanitized.favorites.filter(item => typeof item === 'string' && item.trim()))]
      : current.favorites
  }

  if (Object.hasOwn(sanitized, 'customTags')) {
    sanitized.customTags = sanitized.customTags && typeof sanitized.customTags === 'object' && !Array.isArray(sanitized.customTags)
      ? normalizeCustomTags(sanitized.customTags)
      : current.customTags || {}
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
async function scanDirectory(dirPath, baseDir, depth = 0, inheritedMetadata = null) {
  const results = []
  if (depth > 8) return results

  const metadata = inheritedMetadata || await readWallpaperMetadata(dirPath)

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
        results.push(...await scanDirectory(fullPath, baseDir, depth + 1, metadata))
      }
    } else if (entry.isFile() && isVideoFile(entry.name)) {
      try {
        const stats = await fsp.stat(fullPath)
        const relDir = path.relative(baseDir, dirPath)
        const group = relDir ? relDir.split(path.sep)[0] : path.basename(baseDir)
        const title = metadata?.title || path.basename(entry.name, path.extname(entry.name))
        const workshopId = metadata?.workshopId || (group || path.basename(baseDir))
        const favoriteKey = metadata
          ? `workshop:${workshopId}`
          : `file:${Buffer.from(fullPath).toString('base64url')}`

        results.push({
          id: Buffer.from(path.relative(baseDir, fullPath)).toString('base64url'),
          name: title,
          fileName: path.basename(entry.name, path.extname(entry.name)),
          fullPath,
          extension: path.extname(entry.name).toLowerCase(),
          size: stats.size,
          modified: stats.mtimeMs,
          group: metadata?.tags?.[0] || group,
          tags: metadata?.tags || [],
          wallpaperType: metadata?.type || '',
          previewPath: metadata?.previewPath || null,
          workshopId,
          workshopUrl: metadata?.workshopUrl || '',
          favoriteKey,
          description: metadata?.description || ''
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
    const customPath = path.resolve(settings.mpvPath)
    if (isMpvExecutablePath(customPath) && fs.existsSync(customPath)) {
      mpvManager.setMpvPath(customPath)
      return customPath
    }
    mpvManager.setMpvPath(null)
  }

  const current = mpvManager.getMpvPath()
  if (current) {
    if (isMpvExecutablePath(current) && (current === 'mpv' || current === 'mpv.exe' || fs.existsSync(current))) {
      return current
    }
    mpvManager.setMpvPath(null)
  }

  return mpvManager.findMpv(null)
}

// ─── FFmpeg 缩略图 ─────────────────────────────────────
let ffmpegPath = null
let ffmpegSearchPromise = null
let ffmpegSearchCompleted = false

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (err, stdout, stderr) => {
      if (err) {
        reject(err)
      } else {
        resolve({ stdout, stderr })
      }
    })
  })
}

async function findFfmpeg() {
  if (ffmpegPath) return ffmpegPath
  if (ffmpegSearchCompleted) return null
  if (ffmpegSearchPromise) return ffmpegSearchPromise

  ffmpegSearchPromise = (async () => {
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
        await execFileAsync(candidate, ['-version'], { timeout: 5000 })
        ffmpegPath = candidate
        return candidate
      } catch {
        continue
      }
    }

    return null
  })()

  try {
    return await ffmpegSearchPromise
  } finally {
    ffmpegSearchCompleted = true
    ffmpegSearchPromise = null
  }
}

async function generateThumbnail(videoPath) {
  const thumbDir = getThumbnailDir()
  const thumbName = Buffer.from(videoPath).toString('base64url') + '.jpg'
  const thumbPath = path.join(thumbDir, thumbName)

  if (fs.existsSync(thumbPath)) {
    return thumbPath
  }

  const ffmpeg = await findFfmpeg()
  if (!ffmpeg) {
    return null
  }

  return new Promise((resolve) => {
    // 取视频第 1 秒的帧作为缩略图（跳过可能的黑色片头）
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

async function getExistingPreviewPath(videoPath) {
  let dirPath = path.dirname(videoPath)
  const allowedDirs = getAllowedVideoDirectories()

  while (allowedDirs.some(dir => isPathInside(dir, dirPath))) {
    const metadata = await readWallpaperMetadata(dirPath)
    if (metadata?.previewPath) return metadata.previewPath

    const parentPath = path.dirname(dirPath)
    if (parentPath === dirPath) break
    dirPath = parentPath
  }

  return null
}

// ─── mpv 播放器 ────────────────────────────────────────
const mpvManager = new MpvManager()

async function initMpv() {
  const found = await resolveMpvPath()

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

  function isAppNavigationUrl(url) {
    return (
      url.startsWith('file://') ||
      url.startsWith('http://localhost:5173') ||
      url.startsWith('http://127.0.0.1:5173')
    )
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const currentUrl = mainWindow.webContents.getURL()
    if (url === currentUrl || (!currentUrl && isAppNavigationUrl(url))) return

    event.preventDefault()
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
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

// ─── 自动更新 ──────────────────────────────────────────
function setupAutoUpdater() {
  if (!app.isPackaged || isPortableApp()) {
    console.log('[updater] 跳过自动更新检查')
    return
  }

  autoUpdater.logger = log
  log.transports.file.level = 'info'
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    log.info('[updater] 正在检查更新')
  })

  autoUpdater.on('update-available', (info) => {
    log.info('[updater] 发现新版本:', info.version)
  })

  autoUpdater.on('update-not-available', (info) => {
    log.info('[updater] 当前已是最新版本:', info.version)
  })

  autoUpdater.on('download-progress', (progress) => {
    log.info(
      `[updater] 下载进度 ${progress.percent.toFixed(1)}%，` +
      `${Math.round(progress.bytesPerSecond / 1024)} KB/s`
    )
  })

  autoUpdater.on('update-downloaded', async (info) => {
    log.info('[updater] 更新下载完成:', info.version)

    if (!mainWindow || mainWindow.isDestroyed()) return

    const result = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '发现新版本',
      message: `Wallpaper Player ${info.version} 已下载完成`,
      detail: '重启应用后将自动安装新版本。',
      buttons: ['立即重启安装', '稍后安装'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    })

    if (result.response === 0) {
      autoUpdater.quitAndInstall(false, true)
    }
  })

  autoUpdater.on('error', (error) => {
    log.error('[updater] 自动更新失败:', error)
  })

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((error) => {
      log.error('[updater] 检查更新失败:', error)
    })
  }, 5000)

  updateCheckTimer = setInterval(() => {
    autoUpdater.checkForUpdates().catch((error) => {
      log.error('[updater] 定时检查更新失败:', error)
    })
  }, 6 * 60 * 60 * 1000)
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
      const thumbPath = await getExistingPreviewPath(resolvedPath) || await generateThumbnail(resolvedPath)
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
          results[vp] = await getExistingPreviewPath(resolvedPath) || await generateThumbnail(resolvedPath)
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

  ipcMain.handle('get-thumbnail-url', async (_event, filePath) => {
    const resolvedPath = await resolveExistingPath(filePath)
    const stats = await fsp.stat(resolvedPath)
    const thumbDir = getThumbnailDir()
    const allowedDirs = getAllowedVideoDirectories()
    const canExpose = (
      isPathInside(thumbDir, resolvedPath) ||
      allowedDirs.some(dir => isPathInside(dir, resolvedPath))
    )

    if (!stats.isFile() || !canExpose || !IMAGE_EXTENSIONS.has(path.extname(resolvedPath).toLowerCase())) {
      throw new Error('缩略图路径无效')
    }

    return pathToFileURL(resolvedPath).href
  })

  // 检查 ffmpeg 是否可用
  ipcMain.handle('check-ffmpeg', async () => {
    const ffmpeg = await findFfmpeg()
    if (!ffmpeg) return { available: false }

    try {
      const { stdout } = await execFileAsync(ffmpeg, ['-version'], { timeout: 5000 })
      const versionLine = stdout.split(/\r?\n/).find(line => line.trim()) || 'unknown'
      return { available: true, path: ffmpeg, version: versionLine }
    } catch {
      return { available: false }
    }
  })

  // ─── mpv 相关 IPC ──────────────────────────────────

  // 检查 mpv 状态
  ipcMain.handle('check-mpv', async () => {
    const mpvPath = await resolveMpvPath()
    if (mpvPath) {
      try {
        const stdout = execFileSync(mpvPath, ['--version'], { timeout: 5000, encoding: 'utf-8', stdio: 'pipe' })
        const versionLine = stdout.split(/\r?\n/).find(line => line.trim()) || 'unknown'
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
    if (!isMpvExecutablePath(selectedPath)) return null
    sessionAllowedMpvPaths.add(pathKey(selectedPath))
    return selectedPath
  })
}

// ─── 应用生命周期 ──────────────────────────────────────
app.whenReady().then(async () => {
  setupCSP()
  setupIPC()
  createWindow()
  setupAutoUpdater()
  await initMpv()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch((error) => {
  log.error('[app] 启动失败:', error)
  app.quit()
})

app.on('window-all-closed', () => {
  mpvManager.destroy()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (updateCheckTimer) {
    clearInterval(updateCheckTimer)
    updateCheckTimer = null
  }
  mpvManager.destroy()
})
