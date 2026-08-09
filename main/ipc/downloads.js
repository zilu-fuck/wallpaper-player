const { dialog, ipcMain, shell } = require('electron')
const { IPC } = require('../ipc-channels')
const { pathKey } = require('../paths')
const {
  getPublicDirectories,
  loadSettings,
  resolvePathForAccess,
  saveSettingsAndFlush,
  sanitizeSettingsForRenderer,
  sessionAllowedDirectories
} = require('../settings')
const { getMainWindow } = require('../window')
const downloadManager = require('../download-manager')
const {
  assertAllowedDownloadDirectory,
  assertNetworkResourceDownloadable,
  isPersistentLibraryDirectory,
  isWebpageShellResource,
  normalizeNetworkResourceInput,
  resolveKnownNetworkResourcePlayback
} = require('./network-resource-service')

function registerDownloadIpc() {
  ipcMain.handle(IPC.DOWNLOAD_SELECT_DIRECTORY, async () => {
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
          savedSettings = await saveSettingsAndFlush({
            directories: nextDirectories,
            defaultDirectory: settings.defaultDirectory || publicDirectories[0] || selectedDir
          })
          addedToLibrary = true
        } else {
          const downloadDirectories = settings.downloadDirectories || []
          savedSettings = await saveSettingsAndFlush({
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

  ipcMain.handle(IPC.DOWNLOAD_GET_STATE, async (_event, options = {}) => {
    try {
      const state = await downloadManager.getSnapshot(options)
      return { success: true, ...state }
    } catch (err) {
      return { success: false, error: err.message, engine: null, tasks: [] }
    }
  })

  ipcMain.handle(IPC.DOWNLOAD_ADD_NETWORK_RESOURCE, async (_event, payload = {}) => {
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

  ipcMain.handle(IPC.DOWNLOAD_ADD_URL, async (_event, payload = {}) => {
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

  ipcMain.handle(IPC.DOWNLOAD_ADD_MAGNET, async (_event, payload = {}) => {
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

  ipcMain.handle(IPC.DOWNLOAD_ADD_XUNLEI, async (_event, payload = {}) => {
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

  ipcMain.handle(IPC.DOWNLOAD_SELECT_FILES, async (_event, gid, fileIndexes) => {
    try {
      const state = await downloadManager.changeSelectedFiles(gid, fileIndexes)
      return { success: true, ...state }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.DOWNLOAD_PAUSE, async (_event, gid) => {
    try {
      const state = await downloadManager.pause(gid)
      return { success: true, ...state }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.DOWNLOAD_RESUME, async (_event, gid) => {
    try {
      const state = await downloadManager.resume(gid)
      return { success: true, ...state }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.DOWNLOAD_REMOVE, async (_event, gid) => {
    try {
      const state = await downloadManager.remove(gid)
      return { success: true, ...state }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.DOWNLOAD_OPEN_DIRECTORY, async (_event, dirPath) => {
    try {
      const dir = await assertAllowedDownloadDirectory(dirPath)
      const error = await shell.openPath(dir)
      return { success: !error, error }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })
}

module.exports = { registerDownloadIpc }
