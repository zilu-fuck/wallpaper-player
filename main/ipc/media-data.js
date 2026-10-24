const { ipcMain: appIpcMain } = require('../security/ipc')
const { IPC } = require('../ipc-channels')
const { sanitizeSettingsForRenderer } = require('../settings')
const { createMediaMutationService, resolveDesktopTarget } = require('../application/media-mutations')
const { parseMediaMutationArgs, mediaMutationResultSchema, errorDetails, settingsReplyOptionsSchema } = require('../../packages/contracts')

function registerMediaDataIpc(ipcMain = appIpcMain) {
  function handle(channel, method) {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        const access = { senderId: event?.sender?.id }
        const optionIndex = { setFavorite: 2, setVideoTags: 3, getVideoTags: 1, appendTagsBulk: 2 }[method]
        const reply = args[optionIndex] === undefined ? undefined : settingsReplyOptionsSchema.parse(args[optionIndex])
        const service = createMediaMutationService({
          resolveTarget: input => resolveDesktopTarget(input, access), returnSettings: !reply, returnVersion: Boolean(reply)
        })
        const result = await service[method](...parseMediaMutationArgs(method, args))
        return mediaMutationResultSchema(method).parse({ success: true, ...result.value,
          ...(reply ? { settingsVersion: result.settingsVersion } : { settings: sanitizeSettingsForRenderer(result.settings) }) })
      } catch (error) {
        const details = errorDetails(error.status || 500, error.code || 'operation_failed',
          error.status && error.status < 500 ? error.message : '保存失败，请重试', error.currentRevision)
        return { success: false, code: details.code, error: details.message, retryable: details.retryable,
          ...(details.currentRevision == null ? {} : { currentRevision: details.currentRevision }) }
      }
    })
  }
  handle(IPC.MEDIA_SET_FAVORITE, 'setFavorite')
  handle(IPC.MEDIA_SET_TAGS, 'setVideoTags')
  handle(IPC.MEDIA_GET_TAGS, 'getVideoTags')
  handle(IPC.MEDIA_APPEND_TAGS, 'appendTagsBulk')
}

module.exports = { registerMediaDataIpc }
