const { ipcMain: appIpcMain } = require('../security/ipc')
const { IPC, EVENT } = require('../ipc-channels')

// 一次「关闭询问」的挂起状态。主进程提出询问，渲染层作答；
// 窗口销毁或超时则自动按「最小化」处理，绝不让窗口卡在等待里。
const CLOSE_PROMPT_TIMEOUT_MS = 30000
let pendingClosePrompt = null
let closePromptSequence = 0

/**
 * 请渲染层弹出应用内询问框。
 * 返回 null 表示渲染层不可用（窗口在销毁、页面在重载等），调用方应回退到原生对话框。
 */
function askRendererToClose(win) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return null
  return new Promise(resolve => {
    const id = ++closePromptSequence
    const finish = (value) => {
      if (pendingClosePrompt?.id !== id) return
      clearTimeout(pendingClosePrompt.timer)
      win.removeListener('closed', pendingClosePrompt.onClosed)
      pendingClosePrompt = null
      resolve(value)
    }
    const onClosed = () => finish(null)
    const timer = setTimeout(() => finish(null), CLOSE_PROMPT_TIMEOUT_MS)
    pendingClosePrompt = { id, finish, timer, onClosed }
    win.once('closed', onClosed)
    try {
      win.webContents.send(EVENT.WINDOW_CLOSE_PROMPT, { id })
    } catch {
      finish(null)
    }
  })
}

/**
 * 渲染层是否已经装载好。页面重载/崩溃期间发送的事件会丢失，
 * 那种时候直接退回原生对话框更保险。
 */
function canAskRenderer(win) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return false
  if (win.webContents.isLoading()) return false
  return true
}

// 自绘标题栏的窗口动作。这里的职责只有「对主窗口做窗口管理」，
// 关闭仍然走 main/index.js 注册的 close 处理（最小化/退出询问），
// 因此这里调用 win.close() 而不是 app.quit()，保持原有关闭语义不变。
function registerWindowIpc(ipcMain = appIpcMain) {
  // 惰性 require：window.js 需要本模块的 watchWindowState，
  // 顶层互相 require 会形成循环依赖（getMainWindow 变成 undefined）。
  const liveWindow = () => {
    const win = require('../window').getMainWindow()
    if (!win || win.isDestroyed()) return null
    return win
  }

  ipcMain.handle(IPC.WINDOW_GET_STATE, async () => {
    const win = liveWindow()
    if (!win) return { success: false, maximized: false, fullscreen: false }
    return { success: true, maximized: win.isMaximized(), fullscreen: win.isFullScreen() }
  })

  ipcMain.handle(IPC.WINDOW_MINIMIZE, async () => {
    const win = liveWindow()
    if (!win) return { success: false }
    win.minimize()
    return { success: true }
  })

  ipcMain.handle(IPC.WINDOW_TOGGLE_MAXIMIZE, async () => {
    const win = liveWindow()
    if (!win) return { success: false, maximized: false }
    if (win.isFullScreen()) return { success: true, maximized: true, fullscreen: true }
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return { success: true, maximized: win.isMaximized() }
  })

  ipcMain.handle(IPC.WINDOW_CLOSE, async () => {
    const win = liveWindow()
    if (!win) return { success: false }
    win.close()
    return { success: true }
  })

  ipcMain.handle(IPC.WINDOW_CLOSE_DECIDE, async (_event, payload) => {
    if (!pendingClosePrompt || payload?.id !== pendingClosePrompt.id) return { success: false }
    pendingClosePrompt.finish(payload)
    return { success: true }
  })
}

// 把窗口自身的最大化/全屏状态广播给渲染层，用来切换按钮图标与圆角。
// 监听器绑在 webContents 生命周期上，窗口销毁后自动失效。
function watchWindowState(win) {
  if (!win || win.isDestroyed()) return () => {}
  const publish = () => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(EVENT.WINDOW_MAXIMIZED_CHANGED, {
        maximized: win.isMaximized(),
        fullscreen: win.isFullScreen()
      })
    }
  }
  win.on('maximize', publish)
  win.on('unmaximize', publish)
  win.on('enter-full-screen', publish)
  win.on('leave-full-screen', publish)
  return () => {
    if (win.isDestroyed()) return
    win.removeListener('maximize', publish)
    win.removeListener('unmaximize', publish)
    win.removeListener('enter-full-screen', publish)
    win.removeListener('leave-full-screen', publish)
  }
}

module.exports = { registerWindowIpc, watchWindowState, askRendererToClose, canAskRenderer }