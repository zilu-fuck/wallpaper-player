const { ipcMain: appIpcMain } = require('../security/ipc')
const { IPC, EVENT } = require('../ipc-channels')

// 应用内询问框的主进程侧实现。
//
// 与「关闭询问」同源：主进程提出询问 → 渲染层渲染 → 用户作答后回传。
// 返回 null 表示渲染层此刻不可用（窗口在重载/销毁/崩溃），
// 调用方应回退到系统原生对话框，保证功能不会因为前端异常而丢失。

const ASK_TIMEOUT_MS = 120000
const pendingAsks = new Map()
let askSequence = 0

function rendererCanAnswer(win) {
  if (!win || win.isDestroyed()) return false
  if (win.webContents.isDestroyed()) return false
  if (win.webContents.isLoading()) return false
  return true
}

/**
 * 请渲染层弹出询问框。
 * @param {Electron.BrowserWindow} win
 * @param {{ tone?: string, title: string, message?: string, detail?: string,
 *           buttons: string[], defaultId?: number, cancelId?: number,
 *           checkboxLabel?: string, checkboxChecked?: boolean }} spec
 * @returns {Promise<{ response: number, checkboxChecked: boolean } | null>}
 */
function askInApp(win, spec) {
  if (!rendererCanAnswer(win)) return Promise.resolve(null)
  return new Promise(resolve => {
    const id = ++askSequence
    const settle = (value) => {
      const entry = pendingAsks.get(id)
      if (!entry) return
      clearTimeout(entry.timer)
      win.removeListener('closed', entry.onClosed)
      pendingAsks.delete(id)
      resolve(value)
    }
    const onClosed = () => settle(null)
    const timer = setTimeout(() => settle(null), ASK_TIMEOUT_MS)
    pendingAsks.set(id, { settle, timer, onClosed })
    win.once('closed', onClosed)
    try {
      win.webContents.send(EVENT.APP_ASK, {
        id,
        tone: spec.tone || 'question',
        title: spec.title,
        message: spec.message || '',
        detail: spec.detail || '',
        buttons: Array.isArray(spec.buttons) && spec.buttons.length ? spec.buttons : ['确定'],
        defaultId: Number.isInteger(spec.defaultId) ? spec.defaultId : 0,
        cancelId: Number.isInteger(spec.cancelId) ? spec.cancelId : -1,
        checkboxLabel: spec.checkboxLabel || '',
        checkboxChecked: Boolean(spec.checkboxChecked)
      })
    } catch {
      settle(null)
    }
  })
}

function registerAppDialogIpc(ipcMain = appIpcMain) {
  ipcMain.handle(IPC.APP_ASK_REPLY, async (_event, payload) => {
    const entry = pendingAsks.get(payload?.id)
    if (!entry) return { success: false }
    entry.settle({
      response: Number.isInteger(payload.response) ? payload.response : -1,
      checkboxChecked: Boolean(payload.checkboxChecked)
    })
    return { success: true }
  })
}

/** 窗口销毁前清掉挂起的询问，避免计时器泄漏。 */
function disposeAppDialogs() {
  for (const entry of [...pendingAsks.values()]) {
    clearTimeout(entry.timer)
    entry.settle(null)
  }
  pendingAsks.clear()
}

module.exports = { askInApp, registerAppDialogIpc, disposeAppDialogs, rendererCanAnswer }
