const { videoAnalysisSettingsSection } = require('./settings')
const { setCoreResolver } = require('./core')

module.exports = {
  id: 'video-analysis',
  name: '视频理解',
  version: '1.0.0',
  enabled: false,
  source: 'official',
  description: '视频理解、视觉模型服务和分析结果面板。下载或选择视觉模型后，就可以给视频生成摘要、标签和时间线。',
  settingsDefaults: {
    videoAnalysis: {
      enabled: false
    }
  },
  settingsSchema: {
    videoAnalysis: {
      type: 'object',
      title: '视频理解基础配置',
      description: '保存启用状态、分析结果目录、模型目录和文本/视觉模型参数。默认配置适合大多数用户。'
    }
  },
  settingsSections: {
    videoAnalysis: videoAnalysisSettingsSection
  },
  permissions: [
    'video:read',
    'settings:readwrite',
    'remote:routes',
    'background:jobs',
    'model-services:manage'
  ],
  setup(ctx) {
    setCoreResolver(ctx.requireCore)
    const {
      findVideoAnalysis,
      listSavedAnalysisResultsForVideos,
      analysisTaskService,
      disposeVideoAnalysis,
      disposeRuntimeConfiguration,
      resumeVideoAnalysis,
      getActiveAnalysisJob
    } = require('./service')
    const { disposeVlmService, resumeVlmService } = require('./vlm-service')
    const { registerVideoAnalysisIpc } = require('./ipc')
    const { registerVideoAnalysisRemoteRoutes } = require('./remote')
    resumeVideoAnalysis()
    resumeVlmService()

    ctx.settings.defineDefaults(module.exports.settingsDefaults)
    ctx.settings.defineSchema(module.exports.settingsSchema)
    ctx.capabilities.provide('video-analysis.results', {
      findVideoAnalysis,
      listSavedAnalysisResultsForVideos
    })
    ctx.capabilities.provide('video-analysis.jobs', {
      startVideoAnalysis: videoPath => analysisTaskService.start(videoPath, 'capability:video-analysis.summary', undefined, {
        authorize: () => ctx.requireCore('scanner').assertAllowedVideoPath(videoPath, { audience: 'remote' })
      }),
      getActiveAnalysisJob
    })

    const revalidate = () => { void analysisTaskService.revalidate().catch(() => {}) }
    const removeAuthorizationListener = ctx.requireCore('remote/authorization').onChanged(revalidate)
    const settingsEvents = ctx.requireCore('settings')
    const subscribeSettings = settingsEvents.onSettingsCommitted || (callback => settingsEvents.onSettingsChanged((_settings, event) => callback(event)))
    const removeSettingsListener = subscribeSettings(event => {
      if (!event?.changedKeys || event.changedKeys.some(key => ['directories', 'privateDirectories', 'remoteAccess'].includes(key))) revalidate()
    })
    const removePrivacyListener = ctx.requireCore('media-access').onChanged(revalidate)
    ctx.lifecycle.onDispose(() => { removeAuthorizationListener(); removeSettingsListener(); removePrivacyListener() })

    registerVideoAnalysisIpc(ctx)
    registerVideoAnalysisRemoteRoutes(ctx)
    ctx.lifecycle.onDispose(async () => {
      const results = await Promise.allSettled([disposeVideoAnalysis(), disposeVlmService()])
      results.push(...await Promise.allSettled([disposeRuntimeConfiguration()]))
      setCoreResolver(null)
      const failed = results.find(result => result.status === 'rejected')
      if (failed) throw failed.reason
    })
  }
}
