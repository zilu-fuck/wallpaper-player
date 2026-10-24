const { core } = require('./core')
const { loadSettings } = core('settings')
const { pathKey } = core('paths')
const {
  findVideoAnalysis,
  analysisTaskService,
  getRecentAnalysisEvent,
} = require('./service')
const { remoteAnalysisOwner } = require('./task-interests')
const { sendJson } = core('remote/http-utils')

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
      startedAt: job.startedAt || 0,
      interestId: job.interestId, canCancel: false, interestedClients: 0, interestCancelled: job.interestCancelled
    }
  }

  return {
    running: true,
    currentVideo: true,
    jobId: job.jobId || '',
    interestId: job.interestId, canCancel: job.canCancel, interestedClients: job.interestedClients, interestCancelled: job.interestCancelled,
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

function createAnalysisHandlers({ resolveVideoPath, authorizeRequest = () => true }) {
  const requestedInterest = req => new URL(req.url, 'http://localhost').searchParams.get('interestId') || undefined
  async function revalidate(req, res, videoId, videoPath) {
    if (req.aborted || res.destroyed || res.writableEnded || !await authorizeRequest(req, res)) return false
    const currentPath = await resolveVideoPath(videoId)
    if (pathKey(currentPath) !== pathKey(videoPath)) {
      throw Object.assign(new Error('视频不存在或索引尚未加载'), { status: 404, code: 'video_not_found' })
    }
    return !req.aborted && !res.destroyed && !res.writableEnded && await authorizeRequest(req, res)
  }
  async function getRemoteVideoAnalysisPayload(req, res, videoId) {
    const videoPath = await resolveVideoPath(videoId)
    const settings = loadSettings()
    const enabled = Boolean(settings.videoAnalysis?.enabled)
    const { actor } = remoteAnalysisOwner(req)
    const job = analysisTaskService.get(actor, requestedInterest(req))
    const sanitizedJob = sanitizeRemoteAnalysisJob(job, videoPath)
    const analysis = enabled && !sanitizedJob?.currentVideo
      ? await findVideoAnalysis(videoPath)
      : { available: false, reason: enabled ? 'running' : 'disabled' }
    const recent = sanitizeRemoteRecentAnalysisEvent(getRecentAnalysisEvent(videoPath), videoPath)
    if (!await revalidate(req, res, videoId, videoPath)) return null
    return {
      enabled,
      analysis: sanitizeRemoteAnalysis(analysis),
      job: sanitizedJob,
      recent,
      checkedAt: Date.now()
    }
  }

  async function handleGetVideoAnalysis(req, res, videoId) {
    const payload = await getRemoteVideoAnalysisPayload(req, res, videoId)
    if (payload) return sendJson(req, res, 200, payload)
  }

  async function handleStartVideoAnalysis(req, res, videoId) {
    const videoPath = await resolveVideoPath(videoId)
    const settings = loadSettings()
    if (!settings.videoAnalysis?.enabled) {
      const payload = await getRemoteVideoAnalysisPayload(req, res, videoId)
      if (!payload) return
      return sendJson(req, res, 200, {
        accepted: false,
        reason: 'disabled',
        error: '请先在电脑端设置里开启视频理解',
        ...payload
      })
    }
    if (!await revalidate(req, res, videoId, videoPath)) return
    const { actor, tokenHash } = remoteAnalysisOwner(req)
    const result = await analysisTaskService.start(videoPath, actor, requestedInterest(req), { authorize: async () => {
      await core('remote/authorization').refresh?.()
      if (!core('remote/authorization').isAuthorized(tokenHash)) throw Object.assign(new Error('设备未授权'), { status: 401 })
      await core('scanner').assertAllowedVideoPath(videoPath, { audience: 'remote' })
    } })
    const payload = await getRemoteVideoAnalysisPayload(req, res, videoId)
    if (!payload) return
    return sendJson(req, res, result.accepted ? 202 : 200, {
      ...result,
      job: sanitizeRemoteAnalysisJob(result.job, videoPath),
      ...payload
    })
  }

  async function handleCancelVideoAnalysis(req, res, videoId) {
    const videoPath = await resolveVideoPath(videoId)
    if (!await revalidate(req, res, videoId, videoPath)) return
    const { actor } = remoteAnalysisOwner(req)
    const jobId = new URL(req.url, 'http://localhost').searchParams.get('jobId') || undefined
    const job = analysisTaskService.get(actor)
    const differentVideo = job?.running && job.videoPath && pathKey(job.videoPath) !== pathKey(videoPath)
    const result = await analysisTaskService.cancel(actor, differentVideo ? 'different-video' : jobId, requestedInterest(req))
    if (await revalidate(req, res, videoId, videoPath)) return sendJson(req, res, 200, result)
  }

  return {
    handleGetVideoAnalysis,
    handleStartVideoAnalysis,
    handleCancelVideoAnalysis
  }
}

module.exports = {
  createAnalysisHandlers,
  sanitizeRemoteAnalysis,
  sanitizeRemoteAnalysisEvent,
  sanitizeRemoteAnalysisJob,
  sanitizeRemoteRecentAnalysisEvent
}
