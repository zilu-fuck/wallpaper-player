// 启动期的设置恢复/损坏提示必须留在系统对话框：
// 这时主窗口还没创建（createWindow 在 prepareSettingsForStartup 之后才调用），
// 没有渲染层可以承载应用内弹窗。这是唯一保留原生 dialog 的确认场景。
async function prepareSettingsForStartup({ dialog, settings = require('../settings') }) {
  let failure
  const initialize = () => settings.initializeSettings ? settings.initializeSettings() : settings.loadSettings()
  try { await initialize(); return true } catch (error) { failure = error }
  if (failure.code === 'app_quitting') return false
  if (failure.code === 'settings_backup_available') {
    const result = await dialog.showMessageBox({ type: 'warning', title: '设置需要恢复',
      message: failure.message,
      detail: `备份时间：${failure.backupModifiedAt}\n备份：${failure.backupPath}\n\n恢复会保留损坏原件。备份可能早于最近一次修改，恢复后请核对目录隐私、配对与远程设置。`,
      buttons: ['退出并保留文件', '从备份恢复并启动'], defaultId: 0, cancelId: 0, noLink: true })
    if (result.response !== 1) return false
    try { await settings.recoverSettingsBackup(failure.recoveryId); await initialize(); return true }
    catch (error) { failure = error }
  }
  if (failure.code === 'app_quitting') return false
  await dialog.showMessageBox({ type: 'error', title: '设置无法读取', message: failure.message || '设置读取失败',
    detail: `原文件未使用默认设置覆盖。\n设置：${failure.settingsPath || ''}\n备份：${failure.backupPath || ''}\n\n修复文件或使用支持该格式的应用后重新启动。`,
    buttons: ['退出'], defaultId: 0, cancelId: 0, noLink: true })
  return false
}
module.exports = { prepareSettingsForStartup }
