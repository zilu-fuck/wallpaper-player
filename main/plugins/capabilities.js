const { getPublicVideoDirectories, loadSettings } = require('../settings')
const { scanWithCache, assertAllowedVideoPath } = require('../scanner')
const { mpvManager } = require('../mpv-integration')
const { getPathForVideoId, rememberVideos, getVideoId } = require('../remote/video-index')

function sanitizeVideoSummary(video) {
  return {
    id: getVideoId(video.fullPath),
    name: video.name || video.fileName || '',
    fileName: video.fileName || '',
    extension: video.extension || '',
    size: Number(video.size) || 0,
    modified: Number(video.modified) || 0,
    tags: Array.isArray(video.tags) ? video.tags.filter(tag => typeof tag === 'string') : [],
    group: video.group || ''
  }
}

async function listVideoLibrary(options = {}) {
  const limit = Math.max(1, Math.min(500, Number(options.limit) || 100))
  const items = []
  for (const directory of getPublicVideoDirectories()) {
    const result = await scanWithCache(directory)
    if (Array.isArray(result?.videos)) {
      rememberVideos(result.videos)
      for (const video of result.videos) {
        if (items.length >= limit) break
        items.push(sanitizeVideoSummary(video))
      }
    }
    if (items.length >= limit) break
  }
  return {
    items,
    count: items.length,
    scannedAt: Date.now()
  }
}

async function resolveVideoPathById(videoId) {
  const videoPath = getPathForVideoId(videoId)
  if (!videoPath) {
    throw Object.assign(new Error('Video is not indexed'), { code: 'video_not_found' })
  }
  return assertAllowedVideoPath(videoPath)
}

async function playVideo(videoId, options = {}) {
  const videoPath = await resolveVideoPathById(videoId)
  await mpvManager.play(videoPath, {
    mode: options.mode || loadSettings().playbackMode || 'order',
    resume: options.resume !== false
  })
  return { success: true, videoId }
}

function createCoreCapabilities(pluginRegistry) {
  return {
    'video-library.query': {
      list: listVideoLibrary,
      resolveVideoPathById
    },
    'player.control': {
      playVideo
    },
    'video-analysis.summary': {
      async get(videoId) {
        const videoPath = await resolveVideoPathById(videoId)
        const analysis = pluginRegistry.getCapability('video-analysis.results')
        if (!analysis?.findVideoAnalysis) {
          return { available: false, reason: 'video_analysis_unavailable' }
        }
        return analysis.findVideoAnalysis(videoPath)
      },
      async start(videoId) {
        if (!loadSettings().videoAnalysis?.enabled) {
          return { accepted: false, reason: 'disabled', error: '请先在电脑端设置里开启视频理解' }
        }
        const videoPath = await resolveVideoPathById(videoId)
        const jobs = pluginRegistry.getCapability('video-analysis.jobs')
        if (!jobs?.startVideoAnalysis) {
          return { accepted: false, reason: 'video_analysis_unavailable' }
        }
        return jobs.startVideoAnalysis(videoPath)
      }
    }
  }
}

module.exports = {
  createCoreCapabilities,
  listVideoLibrary,
  resolveVideoPathById,
  playVideo
}
