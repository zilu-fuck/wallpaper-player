const { URL } = require('url')
const {
  cleanupTranscodeCache,
  getFreshTranscodedPath,
  normalizeQuality
} = require('../transcode')
const { readBody, sendError, sendJson } = require('../http-utils')
const { streamFileWithRange } = require('../streaming')
const { transcodeService, requestTaskOwner } = require('../../application/transcode-service')

function getQuality(req) {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)
  return normalizeQuality(url.searchParams.get('quality') || 'compatible')
}

function createTranscodeHandlers({ resolveVideoPath, authorizeMedia = () => true }) {
  async function handleStartTranscode(req, res, videoId) {
    const videoPath = await resolveVideoPath(videoId)
    const quality = getQuality(req)
    const interestId = new URL(req.url, 'http://localhost').searchParams.get('interestId') || undefined
    const status = await transcodeService.start(videoId, videoPath, quality, requestTaskOwner(req), interestId)
    if (await authorizeMedia(req, res)) { await resolveVideoPath(videoId); return sendJson(req, res, 202, status) }
  }

  async function handleGetTranscode(req, res, videoId) {
    await resolveVideoPath(videoId)
    const quality = getQuality(req)
    const interestId = new URL(req.url, 'http://localhost').searchParams.get('interestId') || undefined
    let status = transcodeService.get(videoId, quality, requestTaskOwner(req), interestId)
    if (status?.status === 'ready') {
      await getFreshTranscodedPath(videoId, quality)
      status = transcodeService.get(videoId, quality, requestTaskOwner(req), interestId)
    }
    if (!status) {
      sendError(req, res, 404, 'transcode_not_started', '尚未开始准备兼容格式')
      return
    }
    return sendJson(req, res, 200, status)
  }

  async function handleCancelTranscode(req, res, videoId) {
    await resolveVideoPath(videoId)
    const quality = getQuality(req)
    const interestId = new URL(req.url, 'http://localhost').searchParams.get('interestId') || undefined
    return sendJson(req, res, 200, await transcodeService.cancel(videoId, quality, requestTaskOwner(req), interestId))
  }

  async function handleListTranscodes(req, res) {
    const tasks = await Promise.all(transcodeService.list(requestTaskOwner(req)).map(async task => {
      try {
        await resolveVideoPath(task.id)
        return task
      } catch {
        return null
      }
    }))
    return sendJson(req, res, 200, {
      tasks: tasks.filter(Boolean),
      checkedAt: Date.now()
    })
  }

  async function handleClearTranscodeCache(req, res) {
    const body = await readBody(req)
    return sendJson(req, res, 200, await cleanupTranscodeCache({
      force: Boolean(body.force)
    }))
  }

  async function handleTranscodedStream(req, res, videoId) {
    await resolveVideoPath(videoId)
    const quality = getQuality(req)
    const outputPath = await getFreshTranscodedPath(videoId, quality)
    if (!outputPath) {
      sendError(req, res, 409, 'transcode_not_ready', '兼容格式尚未准备完成')
      return
    }
    await streamFileWithRange(req, res, outputPath, 'video/mp4', sendError, '兼容格式不存在', {
      owner: req.remoteServer,
      beforeHeaders: async ({ handle }) => {
        if (await authorizeMedia(req, res)) {
          await resolveVideoPath(videoId)
          if (await getFreshTranscodedPath(videoId, quality, handle) !== outputPath) throw Object.assign(new Error('兼容格式已失效'), { status: 409, code: 'transcode_not_ready' })
        }
      }
    })
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
