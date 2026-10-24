const path = require('path')
const { getThumbnailDir, resolveThumbnail } = require('../../thumbnail')
const { isPathInside } = require('../../paths')
const { resolvePathForAccess } = require('../../settings')
const { createMediaAccessPolicy } = require('../../security/media-access')
const { getVideoMetadata } = require('../../video-metadata')
const { sendError, sendJson } = require('../http-utils')
const { getImageContentType, getVideoContentType, streamFileWithRange } = require('../streaming')
const { clearLibrarySnapshotCache } = require('./library')
const { withRequestSignal } = require('../request-lifecycle')

const THUMBNAIL_HIGH_WATER_MARK = 256 * 1024

function createMediaHandlers({ resolveVideoPath, authorizeThumbnail = () => true, authorizeMedia = () => true }) {
  async function handleThumbnail(req, res, videoId) {
    return withRequestSignal(req, res, signal => handleThumbnailRequest(req, res, videoId, signal))
  }
  async function handleThumbnailRequest(req, res, videoId, signal) {
    const videoPath = await resolveVideoPath(videoId)
    const thumbnailPath = await resolveThumbnail(videoPath, { audience: 'remote', signal, priority: 'visible' })
    if (signal.aborted || res.destroyed) return
    await resolveVideoPath(videoId)
    if (!thumbnailPath) {
      sendError(req, res, 404, 'thumbnail_not_found', '缩略图不存在')
      return
    }

    const resolvedThumb = path.resolve(thumbnailPath)
    await streamFileWithRange(req, res, resolvedThumb, getImageContentType(resolvedThumb), sendError, '缩略图不存在', {
      ignoreRange: true,
      owner: req.remoteServer,
      highWaterMark: THUMBNAIL_HIGH_WATER_MARK,
      beforeHeaders: async () => {
        if (!await authorizeThumbnail(req, res, videoId)) return
        await resolveVideoPath(videoId)
        if (!isPathInside(resolvePathForAccess(getThumbnailDir()), resolvePathForAccess(resolvedThumb))) {
          createMediaAccessPolicy({ audience: 'remote' }).assertReadPath(resolvedThumb)
        }
      },
      headers: stat => ({ ETag: '"' + stat.size.toString(16) + '-' + Math.floor(stat.mtimeMs).toString(16) + '"',
        'Cache-Control': 'private, max-age=3600' })
    })
  }

  async function handleStream(req, res, videoId) {
    const videoPath = await resolveVideoPath(videoId)
    await streamFileWithRange(req, res, videoPath, getVideoContentType(videoPath), sendError, '视频不存在', {
      playback: true,
      owner: req.remoteServer,
      beforeHeaders: async () => { if (await authorizeMedia(req, res)) await resolveVideoPath(videoId) }
    })
  }

  async function handleGetVideoMetadata(req, res, videoId) {
    return withRequestSignal(req, res, signal => handleGetVideoMetadataRequest(req, res, videoId, signal))
  }
  async function handleGetVideoMetadataRequest(req, res, videoId, signal) {
    const videoPath = await resolveVideoPath(videoId)
    const media = await getVideoMetadata(videoPath, { signal, validate: () => resolveVideoPath(videoId) })
    if (signal.aborted || res.destroyed) return
    if (!await authorizeMedia(req, res)) return
    await resolveVideoPath(videoId)
    clearLibrarySnapshotCache()
    return sendJson(req, res, 200, {
      media,
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
