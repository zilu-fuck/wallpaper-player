const {
  createFileTarget,
  createMediaMutationService,
  createNetworkTarget
} = require('../application/media-mutations')
const { getFavoriteKeyForVideoId, getPathForVideoId } = require('./video-index')
const { getRemoteNetworkItemById } = require('./handlers/network-resources')

function createRemoteMediaMutationService({ resolveVideoPath, actor = 'remote' }) {
  const access = { audience: 'remote' }
  return createMediaMutationService({
    actor,
    returnSettings: false,
    async resolveTarget(videoId) {
      const item = getRemoteNetworkItemById(videoId)
      if (item) return createNetworkTarget(item)
      const videoPath = await resolveVideoPath(videoId)
      const favoriteKey = getFavoriteKeyForVideoId(videoId)
      if (!favoriteKey) throw Object.assign(new Error('视频不存在'), { status: 404, code: 'video_not_found' })
      return createFileTarget(videoPath, {
        access, favoriteKey, rawPath: getPathForVideoId(videoId)
      })
    }
  })
}

module.exports = { createRemoteMediaMutationService }
