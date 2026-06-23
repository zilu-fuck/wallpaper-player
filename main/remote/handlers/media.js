const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const { resolveThumbnail } = require('../../thumbnail')
const { getVideoMetadata } = require('../../video-metadata')
const { sendError, sendJson } = require('../http-utils')
const { getImageContentType, getVideoContentType, streamFileWithRange } = require('../streaming')

const THUMBNAIL_HIGH_WATER_MARK = 256 * 1024

function createMediaHandlers({ resolveVideoPath }) {
  async function handleThumbnail(req, res, videoId) {
    const videoPath = await resolveVideoPath(videoId)
    const thumbnailPath = await resolveThumbnail(videoPath)
    if (!thumbnailPath) {
      sendError(req, res, 404, 'thumbnail_not_found', '缩略图不存在')
      return
    }

    const resolvedThumb = path.resolve(thumbnailPath)
    const stat = await fsp.stat(resolvedThumb)
    if (!stat.isFile()) {
      sendError(req, res, 404, 'thumbnail_not_found', '缩略图不存在')
      return
    }

    const contentType = getImageContentType(resolvedThumb)
    const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, {
        'ETag': etag,
        'Cache-Control': 'private, max-age=3600'
      })
      res.end()
      return
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Cache-Control': 'private, max-age=3600',
      'ETag': etag,
      'X-Content-Type-Options': 'nosniff'
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    fs.createReadStream(resolvedThumb, { highWaterMark: THUMBNAIL_HIGH_WATER_MARK }).pipe(res)
  }

  async function handleStream(req, res, videoId) {
    const videoPath = await resolveVideoPath(videoId)
    await streamFileWithRange(req, res, videoPath, getVideoContentType(videoPath), sendError, '视频不存在')
  }

  async function handleGetVideoMetadata(req, res, videoId) {
    const videoPath = await resolveVideoPath(videoId)
    sendJson(req, res, 200, {
      media: await getVideoMetadata(videoPath),
      checkedAt: Date.now()
    })
  }

  return {
    handleThumbnail,
    handleStream,
    handleGetVideoMetadata
  }
}

module.exports = {
  createMediaHandlers
}
