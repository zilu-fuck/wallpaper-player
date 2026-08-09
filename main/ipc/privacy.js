const { ipcMain } = require('electron')
const { IPC } = require('../ipc-channels')
const { createFailureLimiter } = require('../rate-limiter')
const {
  createPrivacyPassword,
  loadSettings,
  saveSettingsAndFlush,
  verifyPrivacyPassword
} = require('../settings')

// 与远程 HTTP 侧共用同一套限流规则：5 次失败后锁定 30 秒
const privacyUnlockLimiter = createFailureLimiter({ limit: 5, lockMs: 30 * 1000 })

function getPrivacyUnlockKey(event) {
  return String(event?.sender?.id || 'main')
}

function registerPrivacyIpc() {
  ipcMain.handle(IPC.PRIVACY_SET_PASSWORD, async (_event, password) => {
    try {
      const settings = loadSettings()
      if (settings.privacy?.passwordSet) {
        return { success: false, error: '隐私密码已设置' }
      }
      const privacy = createPrivacyPassword(password)
      await saveSettingsAndFlush({ privacy })
      return { success: true, privacy: { passwordSet: true } }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.PRIVACY_UNLOCK, async (event, password) => {
    try {
      const unlockKey = getPrivacyUnlockKey(event)
      const waitMs = privacyUnlockLimiter.getWaitMs(unlockKey)
      if (waitMs > 0) {
        return { success: false, error: `密码错误次数过多，请 ${Math.ceil(waitMs / 1000)} 秒后再试` }
      }
      const settings = loadSettings()
      if (!settings.privacy?.passwordSet) {
        return { success: false, error: '请先设置隐私密码' }
      }
      if (!verifyPrivacyPassword(password, settings.privacy)) {
        const lockedMs = privacyUnlockLimiter.recordFailure(unlockKey)
        if (lockedMs > 0) {
          return { success: false, error: `密码错误次数过多，请 ${Math.ceil(lockedMs / 1000)} 秒后再试` }
        }
        return { success: false, error: '隐私密码不正确' }
      }
      privacyUnlockLimiter.reset(unlockKey)
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })
}

module.exports = { registerPrivacyIpc }
