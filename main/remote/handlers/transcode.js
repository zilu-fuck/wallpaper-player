const { URL } = require('url')
const {
  cancelMobileTranscode,
  cleanupTranscodeCache,
  getMobileTranscodeStatus,
  getTranscodedPath,
  listMobileTranscodeTasks,
  startMobileTranscode
} = require('../transcode')
const { readBody, sendError, sendJson } = require('../http-utils')
const { streamFileWithRange } = require('../streaming')

function getQuality(req) {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)
  return url.searchParams.get('quality') || 'compatible'
}

function createTranscodeHandlers({ resolveVideoPath }) {
  async function handleStartTranscode(req, res, videoId) {
    const videoPath = await resolveVideoPath(videoId)
    const quality = getQuality(req)
    await startMobileTranscode(videoId, videoPath, quality)
    sendJson(req, res, 202, getMobileTranscodeStatus(videoId, quality))
  }

  async function handleGetTranscode(req, res, videoId) {
    await resolveVideoPath(videoId)
    const quality = getQuality(req)
    const status = getMobileTranscodeStatus(videoId, quality)
    if (!status) {
      sendError(req, res, 404, 'transcode_not_started', '尚未开始准备兼容格式')
      return
    }
    sendJson(req, res, 200, status)
  }

  async function handleCancelTranscode(req, res, videoId) {
    await resolveVideoPath(videoId)
    const quality = getQuality(req)
    sendJson(req, res, 200, { success: cancelMobileTranscode(videoId, quality) })
  }

  async function handleListTranscodes(req, res) {
    sendJson(req, res, 200, {
      tasks: listMobileTranscodeTasks(),
      checkedAt: Date.now()
    })
  }

  async function handleClearTranscodeCache(req, res) {
    const body = await readBody(req)
    sendJson(req, res, 200, await cleanupTranscodeCache({
      force: Boolean(body.force)
    }))
  }

  async function handleTranscodedStream(req, res, videoId) {
    await resolveVideoPath(videoId)
    const quality = getQuality(req)
    const outputPath = getTranscodedPath(videoId, quality)
    if (!outputPath) {
      sendError(req, res, 409, 'transcode_not_ready', '兼容格式尚未准备完成')
      return
    }
    await streamFileWithRange(req, res, outputPath, 'video/mp4', sendError, '兼容格式不存在')
  }

  return {
    handleStartTranscode,
    handleGetTranscode,
    handleCancelTranscode,
    handleListTranscodes,
    handleClearTranscodeCache,
    handleTranscodedStream
  }
}

module.exports = {
  createTranscodeHandlers
}
