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
