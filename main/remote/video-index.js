const crypto = require('crypto')
const path = require('path')
const { pathKey } = require('../paths')
const { createBoundScopedToken, loadIdentity } = require('./identity')

const idToPath = new Map()
const idToFavoriteKey = new Map()
const THUMBNAIL_TOKEN_TTL_MS = 24 * 60 * 60 * 1000

function getStableId(prefix, value) {
  const identity = loadIdentity()
  const digest = crypto
    .createHmac('sha256', identity.machineSecret)
    .update(pathKey(value))
    .digest('base64url')
    .slice(0, 32)
  return `${prefix}_${digest}`
}

function getVideoId(fullPath) {
  return getStableId('video', fullPath)
}

function getDirectoryId(dirPath) {
  return getStableId('dir', dirPath)
}

function getDirectoryName(dirPath) {
  const resolved = path.resolve(dirPath)
  return path.basename(resolved) || path.parse(resolved).root || '目录'
}

function getFallbackFavoriteKey(fullPath) {
  return `file:${Buffer.from(fullPath).toString('base64url')}`
}

function normalizeTags(tags) {
  return Array.isArray(tags)
    ? [...new Set(tags.filter(tag => typeof tag === 'string' && tag.trim()).map(tag => tag.trim()))]
    : []
}

function toRemoteVideo(video, basePath, context = {}) {
  const id = getVideoId(video.fullPath)
  const favoriteKey = video.favoriteKey || getFallbackFavoriteKey(video.fullPath)
  const systemTags = normalizeTags(video.systemTags ?? video.tags)
  const customTags = normalizeTags(video.customTags)
  const tags = normalizeTags(video.tags)
  const allTags = normalizeTags([...systemTags, ...customTags, ...tags])
  idToPath.set(id, video.fullPath)
  idToFavoriteKey.set(id, favoriteKey)

  return {
    id,
    name: video.name || video.fileName || path.basename(video.fullPath, path.extname(video.fullPath)),
    fileName: video.fileName || path.basename(video.fullPath, path.extname(video.fullPath)),
    extension: video.extension || path.extname(video.fullPath).toLowerCase(),
    size: Number(video.size) || 0,
    modified: Number(video.modified) || 0,
    group: allTags[0] || video.group || '',
    tags: allTags,
    systemTags,
    customTags,
    favorite: Boolean(context.favoriteKeys?.has(favoriteKey) || context.favoriteKeys?.has(video.fullPath)),
    directoryId: context.directoryId || '',
    directoryName: context.directoryName || '',
    thumbnailUrl: `${basePath}/v1/videos/${encodeURIComponent(id)}/thumbnail`,
    thumbnailToken: context.accessToken
      ? createBoundScopedToken('thumbnail', id, context.accessToken, THUMBNAIL_TOKEN_TTL_MS)
      : '',
    streamUrl: `${basePath}/v1/videos/${encodeURIComponent(id)}/stream`
  }
}

function rememberVideos(videos) {
  for (const video of videos) {
    if (video?.fullPath) {
      const id = getVideoId(video.fullPath)
      idToPath.set(id, video.fullPath)
      idToFavoriteKey.set(id, video.favoriteKey || getFallbackFavoriteKey(video.fullPath))
    }
  }
}

function getPathForVideoId(videoId) {
  if (typeof videoId !== 'string' || !videoId.startsWith('video_')) return null
  return idToPath.get(videoId) || null
}

function getFavoriteKeyForVideoId(videoId) {
  if (typeof videoId !== 'string' || !videoId.startsWith('video_')) return null
  return idToFavoriteKey.get(videoId) || null
}

module.exports = {
  getVideoId,
  getDirectoryId,
  getDirectoryName,
  toRemoteVideo,
  rememberVideos,
  getPathForVideoId,
  getFavoriteKeyForVideoId
}
