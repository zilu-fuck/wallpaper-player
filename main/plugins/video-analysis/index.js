const { videoAnalysisSettingsSection } = require('./settings')
const { setCoreResolver } = require('./core')

module.exports = {
  id: 'video-analysis',
  name: '视频理解',
  version: '1.0.0',
  enabled: false,
  source: 'official',
  description: '官方视频理解、VLM 服务和分析结果插件。',
  settingsDefaults: {
    videoAnalysis: {
      enabled: false
    }
  },
  settingsSchema: {
    videoAnalysis: {
      type: 'object',
      description: '视频理解开关、结果目录、模型目录和 LLM/VLM 配置。'
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
      startVideoAnalysis,
      cancelVideoAnalysis,
      getActiveAnalysisJob
    } = require('./service')
    const { disposeVlmService } = require('./vlm-service')
    const { registerVideoAnalysisIpc } = require('./ipc')
    const { registerVideoAnalysisRemoteRoutes } = require('./remote')

    ctx.settings.defineDefaults(module.exports.settingsDefaults)
    ctx.settings.defineSchema(module.exports.settingsSchema)
    ctx.capabilities.provide('video-analysis.results', {
      findVideoAnalysis,
      listSavedAnalysisResultsForVideos
    })
    ctx.capabilities.provide('video-analysis.jobs', {
      startVideoAnalysis,
      getActiveAnalysisJob
    })

    registerVideoAnalysisIpc(ctx)
    registerVideoAnalysisRemoteRoutes(ctx)
    ctx.lifecycle.onDispose(() => {
      cancelVideoAnalysis()
      disposeVlmService()
      setCoreResolver(null)
    })
  }
}
