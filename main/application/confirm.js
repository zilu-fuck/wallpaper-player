const { dialog } = require('electron')
const { askInApp } = require('../ipc/app-dialogs')

/**
 * 统一的「询问」入口。
 *
 * 优先使用应用内自绘弹窗（与设计系统一致）；
 * 渲染层不可用时回退到系统原生对话框，保证流程不中断。
 *
 * 返回形状与 Electron 的 showMessageBox 一致：{ response, checkboxChecked }
 */
async function ask(win, spec) {
  const inApp = await askInApp(win, spec)
  if (inApp) return inApp
  const result = await dialog.showMessageBox(win, {
    type: spec.tone === 'warning' ? 'warning' : spec.tone === 'error' ? 'error' : 'question',
    title: spec.title,
    message: spec.message || spec.title,
    detail: spec.detail || '',
    buttons: spec.buttons,
    defaultId: Number.isInteger(spec.defaultId) ? spec.defaultId : 0,
    cancelId: Number.isInteger(spec.cancelId) ? spec.cancelId : 0,
    checkboxLabel: spec.checkboxLabel || undefined,
    checkboxChecked: Boolean(spec.checkboxChecked),
    noLink: true
  })
  return { response: result.response, checkboxChecked: Boolean(result.checkboxChecked) }
}

/** 只有一条「知道了」的信息提示。 */
async function notify(win, { tone = 'info', title, message, detail }) {
  await ask(win, { tone, title, message, detail, buttons: ['知道了'], defaultId: 0, cancelId: 0 })
}

module.exports = { ask, notify }
