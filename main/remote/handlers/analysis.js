const { loadSettings } = require('../../settings')
const { pathKey } = require('../../paths')
const {
  findVideoAnalysis,
  getActiveAnalysisJob,
  getRecentAnalysisEvent,
  startVideoAnalysis
} = require('../../video-analysis')
const { sendJson } = require('../http-utils')

function sanitizeRemoteAnalysis(analysis) {
  if (!analysis || typeof analysis !== 'object') return null
  const timeline = Array.isArray(analysis.timeline)
    ? analysis.timeline.map(item => ({
        start_time: Number(item?.start_time) || 0,
        end_time: Number(item?.end_time) || 0,
        title: typeof item?.title === 'string' ? item.title : '',
        description: typeof item?.description === 'string' ? item.description : '',
        confidence: Number(item?.confidence) || 0,
        vlm_status: typeof item?.vlm_status === 'string' ? item.vlm_status : ''
      }))
    : []
  const characters = Array.isArray(analysis.characters)
    ? analysis.characters.map(item => ({
        name: typeof item?.name === 'string' ? item.name : '',
        identity_status: typeof item?.identity_status === 'string' ? item.identity_status : '',
        description: typeof item?.description === 'string' ? item.description : '',
        confidence: Number(item?.confidence) || 0
      })).filter(item => item.name || item.description)
    : []
  const sourceVideo = analysis.sourceVideo && typeof analysis.sourceVideo === 'object'
    ? {
        original_filename: typeof analysis.sourceVideo.original_filename === 'string'
          ? analysis.sourceVideo.original_filename
          : '',
        duration: Number(analysis.sourceVideo.duration) || 0,
        file_size_bytes: Number(analysis.sourceVideo.file_size_bytes) || 0
      }
    : {}

  return {
    available: analysis.available !== false,
    reason: typeof analysis.reason === 'string' ? analysis.reason : '',
    error: typeof analysis.error === 'string' ? analysis.error : '',
    savedAt: typeof analysis.savedAt === 'string' ? analysis.savedAt : '',
    matchType: typeof analysis.matchType === 'string' ? analysis.matchType : '',
    sourceVideo,
    summary: typeof analysis.summary === 'string' ? analysis.summary : '',
    tags: Array.isArray(analysis.tags) ? analysis.tags.filter(item => typeof item === 'string') : [],
    keywords: Array.isArray(analysis.keywords) ? analysis.keywords.filter(item => typeof item === 'string') : [],
    timeline,
    characters,
    quality: analysis.quality && typeof analysis.quality === 'object' ? analysis.quality : {},
    naming: analysis.naming && typeof analysis.naming === 'object' ? analysis.naming : {}
  }
}

function sanitizeRemoteAnalysisEvent(event) {
  if (!event || typeof event !== 'object') return null
  return {
    type: typeof event.type === 'string' ? event.type : '',
    stage: typeof event.stage === 'string' ? event.stage : '',
    status: typeof event.status === 'string' ? event.status : '',
    message: typeof event.message === 'string' ? event.message : '',
    createdAt: typeof event.createdAt === 'string' ? event.createdAt : ''
  }
}

function sanitizeRemoteAnalysisJob(job, videoPath) {
  if (!job?.running) return null
  const sameVideo = job.videoPath && pathKey(job.videoPath) === pathKey(videoPath)
  if (!sameVideo) {
    return {
      running: true,
      currentVideo: false,
      startedAt: job.startedAt || 0
    }
  }

  return {
    running: true,
    currentVideo: true,
    jobId: job.jobId || '',
    startedAt: job.startedAt || 0,
    lastEvent: sanitizeRemoteAnalysisEvent(job.lastEvent)
  }
}

function sanitizeRemoteRecentAnalysisEvent(recent, videoPath) {
  if (!recent || (recent.videoPath && pathKey(recent.videoPath) !== pathKey(videoPath))) return null
  return {
    jobId: recent.jobId || '',
    status: typeof recent.status === 'string' ? recent.status : '',
    message: typeof recent.message === 'string' ? recent.message : '',
    error: typeof recent.error === 'string' ? recent.error : '',
    updatedAt: recent.updatedAt || 0,
    event: sanitizeRemoteAnalysisEvent(recent.event),
    analysis: sanitizeRemoteAnalysis(recent.analysis)
  }
}

function createAnalysisHandlers({ resolveVideoPath }) {
  async function getRemoteVideoAnalysisPayload(videoId) {
    const videoPath = await resolveVideoPath(videoId)
    const settings = loadSettings()
    const enabled = Boolean(settings.videoAnalysis?.enabled)
    const job = getActiveAnalysisJob()
    const sanitizedJob = sanitizeRemoteAnalysisJob(job, videoPath)
    const analysis = enabled && !sanitizedJob?.currentVideo
      ? await findVideoAnalysis(videoPath)
      : { available: false, reason: enabled ? 'running' : 'disabled' }
    const recent = sanitizeRemoteRecentAnalysisEvent(getRecentAnalysisEvent(videoPath), videoPath)
    return {
      enabled,
      analysis: sanitizeRemoteAnalysis(analysis),
      job: sanitizedJob,
      recent,
      checkedAt: Date.now()
    }
  }

  async function handleGetVideoAnalysis(req, res, videoId) {
    sendJson(req, res, 200, await getRemoteVideoAnalysisPayload(videoId))
  }

  async function handleStartVideoAnalysis(req, res, videoId) {
    const videoPath = await resolveVideoPath(videoId)
    const settings = loadSettings()
    if (!settings.videoAnalysis?.enabled) {
      sendJson(req, res, 200, {
        accepted: false,
        reason: 'disabled',
        error: '请先在电脑端设置里开启视频理解',
        ...(await getRemoteVideoAnalysisPayload(videoId))
      })
      return
    }

    const result = await startVideoAnalysis(videoPath)
    sendJson(req, res, result.accepted ? 202 : 200, {
      ...result,
      job: sanitizeRemoteAnalysisJob(result.job, videoPath),
      ...(await getRemoteVideoAnalysisPayload(videoId))
    })
  }

  return {
    handleGetVideoAnalysis,
    handleStartVideoAnalysis
  }
}

module.exports = {
  createAnalysisHandlers,
  sanitizeRemoteAnalysis,
  sanitizeRemoteAnalysisEvent,
  sanitizeRemoteAnalysisJob,
  sanitizeRemoteRecentAnalysisEvent
}
