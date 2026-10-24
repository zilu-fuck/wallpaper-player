const { ipcMain: appIpcMain } = require('../security/ipc')
const { IPC, EVENT } = require('../ipc-channels')
const {
  createMediaAccessPolicy,
  captureDesktopPrivacyRequest,
  lockDesktopPrivacy,
  onPrivacyStateChanged,
  unlockDesktopPrivacy
} = require('../security/media-access')
const { createFailureLimiter } = require('../rate-limiter')
const {
  createPrivacyPassword,
  loadSettings,
  updateSettingsAndFlush,
  verifyPrivacyPassword
} = require('../settings')
const { createPrivacyAttemptQueue, privacyPasswordText } = require('../security/privacy-password')
const attempts = createPrivacyAttemptQueue()

// 与远程 HTTP 侧共用同一套限流规则：5 次失败后锁定 30 秒
const privacyUnlockLimiter = createFailureLimiter({ limit: 5, lockMs: 30 * 1000 })

function getPrivacyUnlockKey(event) {
  return String(event?.sender?.id || 'main')
}

function registerPrivacyIpc(ipcMain = appIpcMain) {
  onPrivacyStateChanged(({ sender, unlocked }) => {
    if (!sender?.isDestroyed?.()) sender?.send?.(EVENT.PRIVACY_STATE_CHANGED, { unlocked })
  })
  ipcMain.handle(IPC.PRIVACY_SET_PASSWORD, async (event, password, options = {}) => {
    try {
      const check = captureDesktopPrivacyRequest(event?.sender)
      password = privacyPasswordText(password)
      return await attempts('set-password', async () => {
        check()
        const settings = loadSettings()
        if (settings.privacy?.passwordSet) {
          return { success: false, error: '隐私密码已设置' }
        }
        const privacy = await createPrivacyPassword(password, check)
        await updateSettingsAndFlush(current => {
          check()
          if (current.privacy?.passwordSet) throw new Error('隐私密码已设置')
          return { patch: { privacy } }
        })
        check()
        if (!options.verifyOnly) unlockDesktopPrivacy(event?.sender)
        return { success: true, privacy: { passwordSet: true } }
      })
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.PRIVACY_UNLOCK, async (event, password, options = {}) => {
    try {
      const check = captureDesktopPrivacyRequest(event?.sender)
      password = privacyPasswordText(password)
      return await attempts('unlock:' + getPrivacyUnlockKey(event), async () => {
        check()
        const unlockKey = getPrivacyUnlockKey(event)
        const waitMs = privacyUnlockLimiter.getWaitMs(unlockKey)
        if (waitMs > 0) {
          return { success: false, error: `密码错误次数过多，请 ${Math.ceil(waitMs / 1000)} 秒后再试` }
        }
        const settings = loadSettings()
        if (!settings.privacy?.passwordSet) {
          return { success: false, error: '请先设置隐私密码' }
        }
        const correct = await verifyPrivacyPassword(password, settings.privacy, check)
        check()
        const latest = loadSettings().privacy
        if (latest.salt !== settings.privacy.salt || latest.passwordHash !== settings.privacy.passwordHash) throw new Error('隐私密码已变化，请重新验证')
        if (!correct) {
          const lockedMs = privacyUnlockLimiter.recordFailure(unlockKey)
          if (lockedMs > 0) {
            return { success: false, error: `密码错误次数过多，请 ${Math.ceil(lockedMs / 1000)} 秒后再试` }
          }
          return { success: false, error: '隐私密码不正确' }
        }
        privacyUnlockLimiter.reset(unlockKey)
        if (!options.verifyOnly) unlockDesktopPrivacy(event?.sender)
        return { success: true }
      })
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.PRIVACY_LOCK, async event => {
    lockDesktopPrivacy(event?.sender)
    const { mpvManager } = require('../mpv-integration')
    const filePath = mpvManager.getState()?.filePath
    if (filePath && createMediaAccessPolicy().isPrivatePath(filePath)) {
      await mpvManager.stop()
    }
    return { success: true }
  })
}

module.exports = { registerPrivacyIpc }
