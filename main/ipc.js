const { app, ipcMain, dialog, shell } = require('electron')
const { pathToFileURL } = require('url')
const path = require('path')
const fsp = require('fs/promises')
const { execFileSync } = require('child_process')
const { IMAGE_EXTENSIONS, NETWORK_VIDEO_EXTENSIONS, VIDEO_EXTENSIONS } = require('./constants')
const { pathKey, isPathInside, isMpvExecutablePath, isPortableApp, isVideoFile } = require('./paths')
const {
  sessionAllowedDirectories,
  sessionPrivateDirectories,
  sessionAllowedMpvPaths,
  addSessionAllowedFile,
  getPlaybackState,
  loadSettings,
  saveSettings,
  sanitizeSettingsForSave,
  sanitizeSettingsForRenderer,
  resolvePathForAccess,
  createPrivacyPassword,
  verifyPrivacyPassword,
  upsertPlaybackState,
  getAllowedVideoDirectories,
  getAllowedDownloadDirectories,
  getPublicDirectories
} = require('./settings')
const {
  assertAllowedVideoPath,
  resolveExistingPath,
  scanWithCache
} = require('./scanner')
const {
  execFileAsync,
  findFfmpeg,
  getThumbnailDir,
  getPreviewFrameDir,
  generatePreviewFrame,
  setMediaPlaybackActive,
  resolveThumbnail
} = require('./thumbnail')
const {
  getUpdateState,
  setUpdateState,
  checkForUpdates,
  getUpdaterDisabledState,
  downloadUpdate,
  installUpdate
} = require('./updater')
const { mpvManager, resolveMpvPath } = require('./mpv-integration')
const { getMainWindow } = require('./window')
const { getVideoMetadata } = require('./video-metadata')
const { pluginRegistry, installPlugin, uninstallPlugin, getExternalPluginsDir } = require('./plugins')
const downloadManager = require('./download-manager')
const { getParserForUrl, parseNetworkResourcePage } = require('./network-resource-parser')

const SECRET_PLACEHOLDER = '***'
const NETWORK_VIDEO_SCHEMES = new Set(['http:', 'https:'])
const STREAM_PLAYLIST_EXTENSIONS = new Set(['.m3u8', '.m3u', '.mpd'])

const MPV_COMMANDS = new Set([
  'seekTo',
  'seekRelative',
  'cyclePause',
  'setPaused',
  'setVolume',
  'setMuted',
  'toggleMute',
  'setSpeed',
  'cycleSpeed',
  'setAudioTrack',
  'cycleAudioTrack',
  'setSubtitleTrack',
  'cycleSubtitleTrack',
  'setSubtitleVisible',
  'toggleSubtitleVisible',
  'setSubtitleScale',
  'setLoopMode',
  'setABLoop',
  'clearABLoop',
  'screenshot'
])
const PRIVACY_UNLOCK_FAILURE_LIMIT = 5
const PRIVACY_UNLOCK_LOCK_MS = 30 * 1000
const privacyUnlockFailures = new Map()
const pendingThumbnailTasks = new Map()

function preserveMaskedPluginSecrets(plugin, nextConfig, currentConfig) {
  if (!nextConfig || typeof nextConfig !== 'object' || Array.isArray(nextConfig)) return nextConfig
  const secretKeys = Array.isArray(plugin?.secretKeys) ? plugin.secretKeys : []
  if (!secretKeys.length) return nextConfig
  const secretKeySet = new Set(secretKeys)
  function mergeValue(nextValue, currentValue, key) {
    if (secretKeySet.has(key) && nextValue === SECRET_PLACEHOLDER) {
      return currentValue
    }
    if (
      nextValue &&
      typeof nextValue === 'object' &&
      !Array.isArray(nextValue) &&
      currentValue &&
      typeof currentValue === 'object' &&
      !Array.isArray(currentValue)
    ) {
      return Object.fromEntries(
        Object.entries(nextValue).map(([childKey, childValue]) => [
          childKey,
          mergeValue(childValue, currentValue[childKey], childKey)
        ])
      )
    }
    return nextValue
  }
  return mergeValue(nextConfig, currentConfig || {}, '')
}

function queueThumbnailTask(videoPath) {
  const key = pathKey(videoPath)
  const pending = pendingThumbnailTasks.get(key)
  if (pending) return pending

  const task = resolveThumbnail(videoPath)
    .finally(() => {
      pendingThumbnailTasks.delete(key)
    })
  pendingThumbnailTasks.set(key, task)
  return task
}

function normalizeNetworkResourceInput(input = {}) {
  const rawUrl = typeof input.url === 'string' ? input.url.trim() : ''
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('网络地址无效')
  }
  if (!NETWORK_VIDEO_SCHEMES.has(parsed.protocol)) {
    throw new Error('仅支持 http/https 视频地址')
  }

  const url = parsed.toString()
  const parser = getParserForUrl(url)
  const extension = path.extname(parsed.pathname || '').toLowerCase()
  if (!parser && extension && !NETWORK_VIDEO_EXTENSIONS.has(extension)) {
    throw new Error('当前链接不是支持的视频格式或可解析网页')
  }

  const fallbackTitle = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '') || parsed.hostname || '网络视频'
  const explicitTitle = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : ''
  return {
    id: typeof input.id === 'string' && input.id.trim()
      ? input.id.trim()
      : Buffer.from(url).toString('base64url'),
    kind: input.kind === 'webpage' || parser ? 'webpage' : 'direct',
    title: (explicitTitle || (parser ? '' : fallbackTitle)).slice(0, 120),
    url,
    playbackUrl: typeof input.playbackUrl === 'string' ? input.playbackUrl.trim() : '',
    httpHeaders: input.httpHeaders && typeof input.httpHeaders === 'object' && !Array.isArray(input.httpHeaders)
      ? input.httpHeaders
      : null,
    parser: typeof input.parser === 'string' && input.parser.trim()
      ? input.parser.trim()
      : (parser?.id || ''),
    page: input.page && typeof input.page === 'object' && !Array.isArray(input.page)
      ? input.page
      : null,
    createdAt: typeof input.createdAt === 'string' && input.createdAt.trim()
      ? input.createdAt.trim()
      : new Date().toISOString()
  }
}

async function enrichNetworkResource(resource) {
  if (resource.kind !== 'webpage') return resource
  const parsed = await parseNetworkResourcePage(resource.url)
  return {
    ...resource,
    title: resource.title || parsed.title,
    playbackUrl: parsed.playbackUrl,
    httpHeaders: parsed.httpHeaders || resource.httpHeaders || null,
    parser: parsed.parser,
    page: parsed.page
  }
}

function isWebpageShellResource(resource) {
  return resource?.kind === 'webpage' &&
    !resource?.playbackUrl &&
    resource?.page?.openMode === 'webview'
}

function normalizeNetworkResourceUrl(value) {
  try {
    return new URL(String(value || '').trim()).toString()
  } catch {
    return ''
  }
}

function normalizeStoredHttpHeaders(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return null
  return {
    referer: typeof headers.referer === 'string' ? headers.referer.trim() : '',
    userAgent: typeof headers.userAgent === 'string' ? headers.userAgent.trim() : ''
  }
}

function getKnownNetworkResource(url, settings = loadSettings()) {
  const target = normalizeNetworkResourceUrl(url).toLowerCase()
  if (!target) return null
  const resource = Array.isArray(settings.networkResources)
    ? settings.networkResources.find(item => String(item?.url || '').trim().toLowerCase() === target)
    : null

  if (resource) {
    return {
      ...resource,
      playbackUrl: '',
      httpHeaders: normalizeStoredHttpHeaders(resource.httpHeaders)
    }
  }

  const resources = Array.isArray(settings.networkResources) ? settings.networkResources : []
  for (const parent of resources) {
    const episodes = Array.isArray(parent?.page?.episodes) ? parent.page.episodes : []
    const episode = episodes.find(item => normalizeNetworkResourceUrl(item?.url).toLowerCase() === target)
    if (!episode) continue
    return {
      ...parent,
      id: `${parent.id || parent.url}:${episode.index || episode.url}`,
      title: episode.title || parent.title || '',
      url: normalizeNetworkResourceUrl(episode.url),
      playbackUrl: '',
      httpHeaders: normalizeStoredHttpHeaders(episode.httpHeaders) || normalizeStoredHttpHeaders(parent.httpHeaders),
      page: {
        ...(parent.page || {}),
        openMode: episode.openMode || parent.page?.openMode || '',
        currentEpisodeIndex: episode.index || null,
        currentEpisodeTitle: episode.title || parent.page?.currentEpisodeTitle || ''
      }
    }
  }

  return null
}

async function resolveNetworkResourcePlayback(resourceOrUrl, options = {}) {
  const resource = typeof resourceOrUrl === 'string'
    ? normalizeNetworkResourceInput({ url: resourceOrUrl, title: options?.title })
    : normalizeNetworkResourceInput(resourceOrUrl)
  const parser = getParserForUrl(resource.url)
  if (resource.kind !== 'webpage' && !parser) {
    return { ...resource, playbackUrl: resource.url }
  }
  return enrichNetworkResource({
    ...resource,
    kind: 'webpage',
    playbackUrl: '',
    parser: resource.parser || parser?.id || ''
  })
}

async function resolveKnownNetworkResourcePlayback(resourceOrUrl, options = {}) {
  const requested = typeof resourceOrUrl === 'string'
    ? normalizeNetworkResourceInput({ url: resourceOrUrl, title: options?.title })
    : normalizeNetworkResourceInput(resourceOrUrl)
  const settings = options.settings || loadSettings()
  const knownResource = getKnownNetworkResource(requested.url, settings)
  if (!knownResource) {
    throw new Error('网络资源未添加到库中')
  }
  return resolveNetworkResourcePlayback(knownResource, { refresh: true })
}

function assertNetworkResourceDownloadable(url) {
  let parsed
  try {
    parsed = new URL(String(url || '').trim())
  } catch {
    throw new Error('网络地址无效')
  }
  const extension = path.extname(parsed.pathname || '').toLowerCase()
  if (STREAM_PLAYLIST_EXTENSIONS.has(extension)) {
    throw new Error('当前下载中心先支持直链视频文件；m3u8/mpd 可以播放，完整离线下载需要后续接入 HLS/DASH 下载流程。')
  }
}

function isKnownNetworkResource(url, settings = loadSettings()) {
  return Boolean(getKnownNetworkResource(url, settings))
}

async function assertAllowedDownloadDirectory(dirPath) {
  if (typeof dirPath !== 'string' || !dirPath.trim()) {
    throw new Error('请选择保存目录')
  }
  const resolvedPath = await resolveExistingPath(dirPath)
  const stats = await fsp.stat(resolvedPath)
  if (!stats.isDirectory()) {
    throw new Error('保存路径不是目录')
  }

  const allowedDirs = getAllowedDownloadDirectories()
  if (!allowedDirs.some(dir => isPathInside(dir, resolvedPath))) {
    throw new Error('保存目录不在已选择或已添加的视频目录中')
  }
  return resolvedPath
}

function isPersistentLibraryDirectory(dirPath, settings = loadSettings()) {
  const resolvedPath = resolvePathForAccess(dirPath)
  return (settings.directories || []).some(dir => isPathInside(resolvePathForAccess(dir), resolvedPath))
}

async function runThumbnailWorkers(videoPaths, concurrency, onProgress) {
  const results = {}
  const uniquePaths = []
  const seen = new Set()
  for (const videoPath of videoPaths) {
    if (typeof videoPath !== 'string' || !videoPath.trim()) continue
    const key = pathKey(videoPath)
    if (seen.has(key)) continue
    seen.add(key)
    uniquePaths.push(videoPath)
  }

  let index = 0
  let completed = 0
  async function worker() {
    while (index < uniquePaths.length) {
      const videoPath = uniquePaths[index++]
      try {
        results[videoPath] = await queueThumbnailTask(videoPath)
      } catch {
        results[videoPath] = null
      }
      completed += 1
      onProgress?.(completed, uniquePaths.length)
    }
  }

  onProgress?.(0, uniquePaths.length, true)
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()))
  onProgress?.(completed, uniquePaths.length, true)
  return results
}

function getPrivacyUnlockKey(event) {
  return String(event?.sender?.id || 'main')
}

function getPrivacyUnlockWaitMs(key) {
  const current = privacyUnlockFailures.get(key)
  if (!current || !current.lockUntil) return 0
  const waitMs = current.lockUntil - Date.now()
  if (waitMs <= 0) {
    privacyUnlockFailures.delete(key)
    return 0
  }
  return waitMs
}

function recordPrivacyUnlockFailure(key) {
  const current = privacyUnlockFailures.get(key) || { count: 0, lockUntil: 0 }
  const nextCount = current.count + 1
  const next = {
    count: nextCount,
    lockUntil: nextCount >= PRIVACY_UNLOCK_FAILURE_LIMIT ? Date.now() + PRIVACY_UNLOCK_LOCK_MS : 0
  }
  privacyUnlockFailures.set(key, next)
  return next.lockUntil ? PRIVACY_UNLOCK_LOCK_MS : 0
}

function setupIPC() {
  ipcMain.handle('scan-directory', async (_event, dirPath, force) => {
    try {
      return await scanWithCache(dirPath, force)
    } catch (err) {
      return { error: err.message }
    }
  })

  ipcMain.handle('generate-thumbnail', async (_event, videoPath) => {
    try {
      const thumbPath = await queueThumbnailTask(videoPath)
      return { thumbPath }
    } catch (err) {
      return { error: err.message }
    }
  })

  ipcMain.handle('get-video-metadata', async (_event, videoPath, options = {}) => {
    try {
      const resolvedPath = await assertAllowedVideoPath(videoPath)
      return { success: true, media: await getVideoMetadata(resolvedPath, options) }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('generate-thumbnails', async (_event, payload) => {
    const videoPaths = Array.isArray(payload) ? payload : payload?.paths
    const requestId = Array.isArray(payload) ? null : payload?.requestId
    if (!Array.isArray(videoPaths)) {
      return {}
    }

    const concurrency = 3
    let lastProgressAt = 0

    function sendThumbnailProgress(completed, total, force = false) {
      const win = getMainWindow()
      if (!win || win.isDestroyed()) return
      const now = Date.now()
      if (!force && now - lastProgressAt < 120) return
      lastProgressAt = now
      win.webContents.send('thumbnail-progress', {
        completed,
        total,
        requestId
      })
    }

    return runThumbnailWorkers(videoPaths, concurrency, sendThumbnailProgress)
  })

  ipcMain.handle('get-settings', async () => {
    return sanitizeSettingsForRenderer(loadSettings())
  })

  ipcMain.handle('get-app-version', async () => {
    return app.getVersion()
  })

  ipcMain.handle('plugins-list', async () => {
    return pluginRegistry.listPlugins()
  })

  ipcMain.handle('plugins-set-enabled', async (_event, pluginId, enabled) => {
    try {
      return await pluginRegistry.setPluginEnabled(pluginId, enabled)
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('plugins-install', async (_event, sourceType = 'file') => {
    try {
      const win = getMainWindow()
      const installDirectory = sourceType === 'directory'
      const result = await dialog.showOpenDialog(win, {
        title: installDirectory ? '选择插件文件夹' : '选择插件包或 plugin.json',
        properties: installDirectory ? ['openDirectory'] : ['openFile'],
        filters: installDirectory
          ? undefined
          : [
              { name: '插件包或清单', extensions: ['zip', 'json'] },
              { name: '所有文件', extensions: ['*'] }
            ]
      })
      if (result.canceled || !result.filePaths.length) {
        return { success: false, canceled: true }
      }
      return await installPlugin(result.filePaths[0])
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('plugins-uninstall', async (_event, pluginId) => {
    try {
      return await uninstallPlugin(pluginId)
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('plugins-open-directory', async () => {
    try {
      const dir = getExternalPluginsDir()
      await fsp.mkdir(dir, { recursive: true })
      const error = await shell.openPath(dir)
      return { success: !error, error, dir }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('plugins-save-config', async (_event, pluginId, config) => {
    try {
      const plugin = pluginRegistry.getPlugin(pluginId)
      if (!plugin) return { success: false, error: '插件不存在' }
      const settings = loadSettings()
      const currentConfig = settings.plugins?.[plugin.id]?.config || {}
      const nextConfig = pluginRegistry.normalizePluginConfig(
        plugin,
        preserveMaskedPluginSecrets(plugin, config, currentConfig)
      )
      if (plugin.id === 'ai-search' && config && !Object.prototype.hasOwnProperty.call(config, 'feedbackMemory') && Array.isArray(currentConfig.feedbackMemory)) {
        nextConfig.feedbackMemory = currentConfig.feedbackMemory
      }
      const saved = saveSettings(sanitizeSettingsForSave({
        plugins: {
          [plugin.id]: {
            ...(settings.plugins?.[plugin.id] || {}),
            config: nextConfig,
            updatedAt: new Date().toISOString()
          }
        }
      }))
      return {
        success: true,
        plugin: pluginRegistry.listPlugins().find(item => item.id === plugin.id)
      }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('save-settings', async (_event, settings) => {
    const saved = saveSettings(sanitizeSettingsForSave(settings))
    return { success: true, settings: sanitizeSettingsForRenderer(saved) }
  })

  ipcMain.handle('network-resource-add', async (_event, input) => {
    try {
      const resource = await enrichNetworkResource(normalizeNetworkResourceInput(input))
      const settings = loadSettings()
      const current = Array.isArray(settings.networkResources) ? settings.networkResources : []
      const exists = current.some(item => String(item.url).toLowerCase() === resource.url.toLowerCase())
      const next = exists
        ? current.map(item => String(item.url).toLowerCase() === resource.url.toLowerCase() ? { ...item, ...resource } : item)
        : [resource, ...current]
      const saved = saveSettings({ networkResources: next })
      return { success: true, resource, settings: sanitizeSettingsForRenderer(saved) }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('network-resource-update', async (_event, input = {}) => {
    try {
      const id = String(input.id || '').trim()
      if (!id) {
        return { success: false, error: '未选择要修改的网络资源' }
      }
      const resource = await enrichNetworkResource(normalizeNetworkResourceInput(input))
      const settings = loadSettings()
      const current = Array.isArray(settings.networkResources) ? settings.networkResources : []
      const index = current.findIndex(item => String(item.id || '') === id)
      if (index === -1) {
        return { success: false, error: '没有找到要修改的网络资源' }
      }
      const duplicate = current.some((item, itemIndex) => (
        itemIndex !== index &&
        String(item.url || '').trim().toLowerCase() === resource.url.toLowerCase()
      ))
      if (duplicate) {
        return { success: false, error: '已有相同地址的网络资源' }
      }
      const updated = {
        ...current[index],
        kind: resource.kind,
        title: resource.title,
        url: resource.url,
        playbackUrl: resource.playbackUrl,
        httpHeaders: resource.httpHeaders,
        parser: resource.parser,
        page: resource.page
      }
      const next = [...current]
      next[index] = updated
      const saved = saveSettings({ networkResources: next })
      return { success: true, resource: updated, settings: sanitizeSettingsForRenderer(saved) }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('network-resource-resolve', async (_event, input = {}) => {
    try {
      const resource = await resolveKnownNetworkResourcePlayback(input)
      return { success: true, resource }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('network-resource-remove', async (_event, resourceId) => {
    try {
      const id = String(resourceId || '').trim()
      if (!id) {
        return { success: false, error: '未选择要移除的网络资源' }
      }
      const settings = loadSettings()
      const current = Array.isArray(settings.networkResources) ? settings.networkResources : []
      const next = current.filter(item => String(item.id || '') !== id)
      if (next.length === current.length) {
        return { success: false, error: '没有找到要移除的网络资源' }
      }
      const saved = saveSettings({ networkResources: next })
      return { success: true, removedCount: current.length - next.length, settings: sanitizeSettingsForRenderer(saved) }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('network-resources-remove', async (_event, resourceIds) => {
    try {
      const ids = new Set((Array.isArray(resourceIds) ? resourceIds : [])
        .map(item => String(item || '').trim())
        .filter(Boolean))
      if (ids.size === 0) {
        return { success: false, error: '未选择要移除的网络资源' }
      }
      const settings = loadSettings()
      const current = Array.isArray(settings.networkResources) ? settings.networkResources : []
      const next = current.filter(item => !ids.has(String(item.id || '')))
      if (next.length === current.length) {
        return { success: false, error: '没有找到要移除的网络资源' }
      }
      const saved = saveSettings({ networkResources: next })
      return {
        success: true,
        removedCount: current.length - next.length,
        settings: sanitizeSettingsForRenderer(saved)
      }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('download-select-directory', async () => {
    try {
      const win = getMainWindow()
      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory'],
        title: '选择下载保存目录'
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true }
      }
      const selectedDir = resolvePathForAccess(result.filePaths[0])
      sessionAllowedDirectories.add(selectedDir)
      const settings = loadSettings()
      let savedSettings = null
      let addedToLibrary = false
      const alreadyInLibrary = isPersistentLibraryDirectory(selectedDir, settings)

      if (!alreadyInLibrary) {
        const response = await dialog.showMessageBox(win, {
          type: 'question',
          buttons: ['加入视频库', '下载完成后再说'],
          defaultId: 0,
          cancelId: 1,
          title: '保存目录',
          message: '是否将保存目录加入视频库？',
          detail: '加入后，下载完成会自动刷新这个目录；不加入也可以下载完成后在下载中心手动加入。',
          noLink: true
        })
        if (response.response === 0) {
          const nextDirectories = settings.directories.includes(selectedDir)
            ? settings.directories
            : [...settings.directories, selectedDir]
          const publicDirectories = getPublicDirectories(nextDirectories, settings.privateDirectories || [])
          savedSettings = saveSettings({
            directories: nextDirectories,
            defaultDirectory: settings.defaultDirectory || publicDirectories[0] || selectedDir
          })
          addedToLibrary = true
        } else {
          const downloadDirectories = settings.downloadDirectories || []
          savedSettings = saveSettings({
            downloadDirectories: downloadDirectories.some(dir => pathKey(resolvePathForAccess(dir)) === pathKey(selectedDir))
              ? downloadDirectories
              : [...downloadDirectories, selectedDir]
          })
        }
      }

      return {
        success: true,
        path: selectedDir,
        libraryDirectory: alreadyInLibrary || addedToLibrary,
        settings: savedSettings ? sanitizeSettingsForRenderer(savedSettings) : null
      }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('download-get-state', async (_event, options = {}) => {
    try {
      const state = await downloadManager.getSnapshot(options)
      return { success: true, ...state }
    } catch (err) {
      return { success: false, error: err.message, engine: null, tasks: [] }
    }
  })

  ipcMain.handle('download-add-network-resource', async (_event, payload = {}) => {
    try {
      const resource = normalizeNetworkResourceInput(payload.resource || payload)
      const settings = loadSettings()
      const downloadResource = await resolveKnownNetworkResourcePlayback(resource, { settings })
      if (isWebpageShellResource(downloadResource)) {
        return { success: false, error: '当前网页资源没有可直接下载的视频地址，请在内置网页中观看。' }
      }
      const downloadUrl = downloadResource.playbackUrl || downloadResource.url
      assertNetworkResourceDownloadable(downloadUrl)
      const dir = await assertAllowedDownloadDirectory(payload.dir)
      const result = await downloadManager.addUrl({
        url: downloadUrl,
        dir,
        httpHeaders: downloadResource.httpHeaders
      })
      return {
        success: true,
        ...result,
        libraryDirectory: isPersistentLibraryDirectory(dir, settings)
      }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('download-add-url', async (_event, payload = {}) => {
    try {
      const resource = normalizeNetworkResourceInput({ url: payload.url })
      assertNetworkResourceDownloadable(resource.url)
      const dir = await assertAllowedDownloadDirectory(payload.dir)
      const result = await downloadManager.addUrl({
        url: resource.url,
        dir
      })
      return {
        success: true,
        ...result,
        libraryDirectory: isPersistentLibraryDirectory(dir)
      }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('download-add-magnet', async (_event, payload = {}) => {
    try {
      const dir = await assertAllowedDownloadDirectory(payload.dir)
      const result = await downloadManager.addMagnet({
        magnet: payload.magnet,
        dir
      })
      return {
        success: true,
        ...result,
        libraryDirectory: isPersistentLibraryDirectory(dir)
      }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('download-add-xunlei', async (_event, payload = {}) => {
    try {
      const dir = await assertAllowedDownloadDirectory(payload.dir)
      const input = typeof payload.magnet === 'string' && payload.magnet.trim()
        ? payload.magnet
        : payload.url
      const result = await downloadManager.addXunleiTask({
        url: input,
        dir
      })
      if (!result?.success) return result
      return {
        success: true,
        task: result.task,
        xunlei: result.xunlei,
        state: await downloadManager.getSnapshot({ start: true }),
        libraryDirectory: isPersistentLibraryDirectory(dir)
      }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('download-get-xunlei-state', async (_event, options = {}) => {
    try {
      return {
        success: true,
        xunlei: await downloadManager.detectXunlei(Boolean(options.refresh))
      }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('download-select-files', async (_event, gid, fileIndexes) => {
    try {
      const state = await downloadManager.changeSelectedFiles(gid, fileIndexes)
      return { success: true, ...state }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('download-pause', async (_event, gid) => {
    try {
      const state = await downloadManager.pause(gid)
      return { success: true, ...state }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('download-resume', async (_event, gid) => {
    try {
      const state = await downloadManager.resume(gid)
      return { success: true, ...state }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('download-remove', async (_event, gid) => {
    try {
      const state = await downloadManager.remove(gid)
      return { success: true, ...state }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('download-open-directory', async (_event, dirPath) => {
    try {
      const dir = await assertAllowedDownloadDirectory(dirPath)
      const error = await shell.openPath(dir)
      return { success: !error, error }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('privacy-set-password', async (_event, password) => {
    try {
      const settings = loadSettings()
      if (settings.privacy?.passwordSet) {
        return { success: false, error: '隐私密码已设置' }
      }
      const privacy = createPrivacyPassword(password)
      saveSettings({ privacy })
      return { success: true, privacy: { passwordSet: true } }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('privacy-unlock', async (event, password) => {
    try {
      const unlockKey = getPrivacyUnlockKey(event)
      const waitMs = getPrivacyUnlockWaitMs(unlockKey)
      if (waitMs > 0) {
        return { success: false, error: `密码错误次数过多，请 ${Math.ceil(waitMs / 1000)} 秒后再试` }
      }
      const settings = loadSettings()
      if (!settings.privacy?.passwordSet) {
        return { success: false, error: '请先设置隐私密码' }
      }
      if (!verifyPrivacyPassword(password, settings.privacy)) {
        const lockedMs = recordPrivacyUnlockFailure(unlockKey)
        if (lockedMs > 0) {
          return { success: false, error: `密码错误次数过多，请 ${Math.ceil(lockedMs / 1000)} 秒后再试` }
        }
        return { success: false, error: '隐私密码不正确' }
      }
      privacyUnlockFailures.delete(unlockKey)
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('select-directory', async () => {
    const win = getMainWindow()
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: '选择视频目录'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const selectedDir = resolvePathForAccess(result.filePaths[0])
    sessionAllowedDirectories.add(selectedDir)
    return selectedDir
  })

  ipcMain.handle('select-video-directory', async () => {
    const win = getMainWindow()
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: '选择视频目录'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const selectedDir = resolvePathForAccess(result.filePaths[0])
    const response = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['添加', '取消'],
      defaultId: 0,
      cancelId: 1,
      title: '添加目录',
      message: '是否将这个目录设为隐私目录？',
      detail: '隐私目录默认不会出现在侧栏和手机远程库中。你可以在侧栏临时显示后进入或移除。',
      checkboxLabel: '设为隐私目录',
      checkboxChecked: false,
      noLink: true
    })
    if (response.response === 1) return null
    sessionAllowedDirectories.add(selectedDir)
    if (response.checkboxChecked) {
      sessionPrivateDirectories.add(pathKey(selectedDir))
    } else {
      sessionPrivateDirectories.delete(pathKey(selectedDir))
    }
    return {
      path: selectedDir,
      privateDirectory: Boolean(response.checkboxChecked)
    }
  })

  ipcMain.handle('open-video-file', async () => {
    const win = getMainWindow()
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      title: '打开视频文件',
      filters: [
        { name: '视频文件', extensions: Array.from(VIDEO_EXTENSIONS).map(ext => ext.slice(1)) },
        { name: '所有文件', extensions: ['*'] }
      ]
    })

    if (result.canceled || result.filePaths.length === 0) return null
    const selectedPath = resolvePathForAccess(result.filePaths[0])
    if (!isVideoFile(selectedPath)) return null

    addSessionAllowedFile(selectedPath)
    return selectedPath
  })

  ipcMain.handle('allow-video-file', async (_event, filePath) => {
    try {
      const resolvedPath = await resolveExistingPath(filePath)
      const stats = await fsp.stat(resolvedPath)
      if (!stats.isFile() || !isVideoFile(resolvedPath)) {
        return { success: false, error: '文件不是受支持的视频' }
      }

      addSessionAllowedFile(resolvedPath)
      return { success: true, path: resolvedPath }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('show-in-folder', async (_event, filePath) => {
    try {
      const resolvedPath = await assertAllowedVideoPath(filePath)
      shell.showItemInFolder(resolvedPath)
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('get-file-url', async (_event, filePath) => {
    const resolvedPath = await assertAllowedVideoPath(filePath)
    return pathToFileURL(resolvedPath).href
  })

  ipcMain.handle('get-playback-state', async (_event, filePath) => {
    try {
      if (typeof filePath === 'string' && filePath.trim()) {
        try {
          const resource = normalizeNetworkResourceInput({ url: filePath })
          if (isKnownNetworkResource(resource.url)) {
            const settings = loadSettings()
            return getPlaybackState(settings.playbackStates, resource.url)
          }
        } catch {}
      }
      const resolvedPath = await assertAllowedVideoPath(filePath)
      const settings = loadSettings()
      return getPlaybackState(settings.playbackStates, resolvedPath)
    } catch {
      return null
    }
  })

  ipcMain.handle('save-playback-state', async (_event, filePath, statePatch) => {
    try {
      if (typeof filePath !== 'string' || !filePath.trim()) {
        return { success: false, error: '文件路径无效' }
      }

      const settings = loadSettings()
      let target = ''
      try {
        const resource = normalizeNetworkResourceInput({ url: filePath })
        if (isKnownNetworkResource(resource.url, settings)) {
          target = resource.url
        }
      } catch {}
      if (!target) {
        target = await assertAllowedVideoPath(filePath)
      }
      const playbackStates = upsertPlaybackState(settings.playbackStates, target, statePatch)
      saveSettings({ playbackStates })
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('mpv-play-url', async (_event, url, options = {}) => {
    try {
      const settings = loadSettings()
      const resource = options?.temporary === true
        ? await resolveNetworkResourcePlayback({ url, title: options?.title, kind: options?.kind }, { refresh: true })
        : await resolveKnownNetworkResourcePlayback({ url, title: options?.title }, { settings })

      const mpvPath = await resolveMpvPath()
      if (!mpvPath) {
        return { success: false, error: 'mpv 未安装' }
      }

      const playOptions = options && typeof options === 'object' ? options : {}
      const resume = playOptions.resume === false
        ? false
        : getPlaybackState(settings.playbackStates, resource.url)
      setMediaPlaybackActive(true)
      await mpvManager.play(resource.playbackUrl || resource.url, {
        hostBounds: playOptions.hostBounds,
        playlist: [resource.playbackUrl || resource.url],
        playlistIndex: 0,
        resume,
        httpHeaders: resource.httpHeaders
      })
      return { success: true }
    } catch (err) {
      setMediaPlaybackActive(false)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('get-thumbnail-url', async (_event, filePath) => {
    const resolvedPath = await resolveExistingPath(filePath)
    const stats = await fsp.stat(resolvedPath)
    const thumbDir = getThumbnailDir()
    const previewFrameDir = getPreviewFrameDir()
    const allowedDirs = getAllowedVideoDirectories()
    const canExpose = (
      isPathInside(thumbDir, resolvedPath) ||
      isPathInside(previewFrameDir, resolvedPath) ||
      allowedDirs.some(dir => isPathInside(dir, resolvedPath))
    )

    if (!stats.isFile() || !canExpose || !IMAGE_EXTENSIONS.has(path.extname(resolvedPath).toLowerCase())) {
      throw new Error('缩略图路径无效')
    }

    return pathToFileURL(resolvedPath).href
  })

  ipcMain.handle('generate-preview-frame', async (_event, videoPath, seconds) => {
    try {
      const framePath = await generatePreviewFrame(videoPath, seconds)
      return { framePath }
    } catch (err) {
      return { error: err.message }
    }
  })

  ipcMain.handle('set-media-playback-active', async (_event, active) => {
    setMediaPlaybackActive(active)
    return { success: true }
  })

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

  ipcMain.handle('updater-get-status', async () => getUpdateState())

  ipcMain.handle('updater-check', async () => {
    if (!app.isPackaged || isPortableApp()) {
      return setUpdateState('disabled', getUpdaterDisabledState())
    }

    await checkForUpdates()
    return getUpdateState()
  })

  ipcMain.handle('updater-download', async () => {
    if (!app.isPackaged || isPortableApp()) {
      return setUpdateState('disabled', getUpdaterDisabledState())
    }

    await downloadUpdate()
    return getUpdateState()
  })

  ipcMain.handle('updater-install', async () => {
    return installUpdate()
  })

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

  ipcMain.handle('download-mpv', async () => {
    try {
      const mpvPath = await mpvManager.download((progress) => {
        const win = getMainWindow()
        if (win && !win.isDestroyed()) {
          win.webContents.send('mpv-download-progress', progress)
        }
      })
      return { success: true, path: mpvPath }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('mpv-play', async (_event, filePath, options = {}) => {
    try {
      const resolvedPath = await assertAllowedVideoPath(filePath)
      addSessionAllowedFile(resolvedPath)
      const mpvPath = await resolveMpvPath()
      if (!mpvPath) {
        return { success: false, error: 'mpv 未安装' }
      }

      const settings = loadSettings()
      const playOptions = options && typeof options === 'object' ? options : {}
      const playlist = []
      if (Array.isArray(playOptions.playlist)) {
        for (const item of playOptions.playlist) {
          try {
            playlist.push(await assertAllowedVideoPath(item))
          } catch {}
        }
      }
      const playlistIndex = Number.isInteger(Number(playOptions.playlistIndex))
        ? Number(playOptions.playlistIndex)
        : undefined
      const resume = playOptions.resume === false
        ? false
        : getPlaybackState(settings.playbackStates, resolvedPath)
      setMediaPlaybackActive(true)
      await mpvManager.play(resolvedPath, {
        hostBounds: playOptions.hostBounds,
        playlist,
        playlistIndex,
        resume
      })
      return { success: true }
    } catch (err) {
      setMediaPlaybackActive(false)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('mpv-set-host-bounds', async (_event, bounds) => {
    try {
      return mpvManager.setHostBounds(bounds)
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('mpv-stop', async () => {
    mpvManager.stop()
    setMediaPlaybackActive(false)
    return { success: true }
  })

  ipcMain.handle('mpv-is-playing', async () => {
    return mpvManager.isPlaying()
  })

  ipcMain.handle('mpv-get-state', async () => {
    return mpvManager.getState()
  })

  ipcMain.handle('mpv-command', async (_event, method, ...args) => {
    if (!MPV_COMMANDS.has(method)) {
      throw new Error(`Unsupported mpv command: ${method}`)
    }
    const fn = mpvManager[method]
    if (typeof fn !== 'function') {
      throw new Error(`Unsupported mpv command: ${method}`)
    }
    return fn.apply(mpvManager, args)
  })

  ipcMain.handle('select-mpv-path', async () => {
    const win = getMainWindow()
    const result = await dialog.showOpenDialog(win, {
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

module.exports = { setupIPC }
