const { dialog, ipcMain, shell } = require('electron')
const { pathToFileURL } = require('url')
const fsp = require('fs/promises')
const { IPC } = require('../ipc-channels')
const { VIDEO_EXTENSIONS } = require('../constants')
const { isVideoContentFile, pathKey } = require('../paths')
const {
  addSessionAllowedFile,
  getPlaybackState,
  loadSettings,
  resolvePathForAccess,
  saveSettingsAndFlush,
  sessionAllowedDirectories,
  sessionPrivateDirectories,
  upsertPlaybackState
} = require('../settings')
const { assertAllowedVideoPath, resolveExistingPath } = require('../scanner')
const { getMainWindow } = require('../window')
const {
  isKnownNetworkResource,
  normalizeNetworkResourceInput
} = require('./network-resource-service')

function registerFileIpc() {
  ipcMain.handle(IPC.SELECT_DIRECTORY, async () => {
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

  ipcMain.handle(IPC.SELECT_VIDEO_DIRECTORY, async () => {
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

  ipcMain.handle(IPC.OPEN_VIDEO_FILE, async () => {
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
    if (!(await isVideoContentFile(selectedPath))) return null

    addSessionAllowedFile(selectedPath)
    return selectedPath
  })

  ipcMain.handle(IPC.ALLOW_VIDEO_FILE, async (_event, filePath) => {
    try {
      const resolvedPath = await resolveExistingPath(filePath)
      const stats = await fsp.stat(resolvedPath)
      if (!stats.isFile() || !(await isVideoContentFile(resolvedPath))) {
        return { success: false, error: '文件不是受支持的视频' }
      }

      addSessionAllowedFile(resolvedPath)
      return { success: true, path: resolvedPath }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.SHOW_IN_FOLDER, async (_event, filePath) => {
    try {
      const resolvedPath = await assertAllowedVideoPath(filePath)
      shell.showItemInFolder(resolvedPath)
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.GET_FILE_URL, async (_event, filePath) => {
    const resolvedPath = await assertAllowedVideoPath(filePath)
    return pathToFileURL(resolvedPath).href
  })

  ipcMain.handle(IPC.GET_PLAYBACK_STATE, async (_event, filePath) => {
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

  ipcMain.handle(IPC.SAVE_PLAYBACK_STATE, async (_event, filePath, statePatch) => {
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
      await saveSettingsAndFlush({ playbackStates })
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })
}

module.exports = { registerFileIpc }
