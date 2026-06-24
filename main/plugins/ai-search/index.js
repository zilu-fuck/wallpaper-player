module.exports = {
  id: 'ai-search',
  name: 'AI 搜索',
  version: '0.1.0',
  enabled: false,
  status: 'planned',
  description: '规划中的语义搜索插件，将依赖核心视频索引和视频理解结果。',
  settingsDefaults: {
    aiSearch: {
      enabled: false
    }
  },
  settingsSchema: {
    aiSearch: {
      type: 'object',
      description: 'AI 搜索索引、召回和结果排序配置。'
    }
  },
  permissions: [
    'video:index:read',
    'video-analysis:read',
    'settings:readwrite'
  ]
}
