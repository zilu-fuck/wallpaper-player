'use strict'

const settingsDefaults = {
  llmProvider: 'local',
  difyEndpoint: '',
  difyApiKey: '',
  cloudBaseUrl: '',
  cloudApiKey: '',
  cloudModelName: '',
  localBaseUrl: 'http://localhost:11434/v1',
  localModelName: '',
  localApiKey: '',
  maxPages: 5,
  timeout: 30,
  trustedSiteRules: {
    sites: [],
    tagBindings: []
  },
  trustedMinEvidence: 4,
  trustedConfidenceThreshold: 0.62,
  feedbackMemory: []
}

const settingsSchema = {
  llmProvider: {
    type: 'enum',
    title: 'LLM 提供商',
    description: '选择使用的 LLM 提供商：本地、Dify 或云端 API。',
    enum: ['local', 'dify', 'cloud']
  },
  difyEndpoint: {
    type: 'string',
    title: 'Dify 端点',
    description: 'Dify API 的 Base URL。'
  },
  difyApiKey: {
    type: 'string',
    title: 'Dify API 密钥',
    description: 'Dify API 的密钥。'
  },
  cloudBaseUrl: {
    type: 'string',
    title: '云端 API Base URL',
    description: '云端 LLM API 的 Base URL。'
  },
  cloudApiKey: {
    type: 'string',
    title: '云端 API 密钥',
    description: '云端 LLM API 的密钥。'
  },
  cloudModelName: {
    type: 'string',
    title: '云端模型名称',
    description: '云端 LLM 的模型名称。'
  },
  localBaseUrl: {
    type: 'string',
    title: '本地 Base URL',
    description: '本地 LLM 服务的 Base URL。'
  },
  localModelName: {
    type: 'string',
    title: '本地模型名称',
    description: '本地 LLM 的模型名称。'
  },
  localApiKey: {
    type: 'string',
    title: '本地 API 密钥',
    description: '本地 LLM API 的密钥（如需要）。'
  },
  maxPages: {
    type: 'number',
    title: '最大分页数',
    description: '搜索返回的最大结果页数。'
  },
  timeout: {
    type: 'number',
    title: '超时时间（秒）',
    description: 'API 请求的超时时间。'
  },
  trustedSiteRules: {
    type: 'object',
    title: '信任来源网站',
    description: '全局信任网站和标签绑定网站。'
  },
  trustedMinEvidence: {
    type: 'number',
    title: '信任来源最低线索数',
    description: '信任来源线索达到该数量后，先基于信任来源推理。'
  },
  trustedConfidenceThreshold: {
    type: 'number',
    title: '信任来源置信阈值',
    description: '信任来源结果低于该置信度时，继续搜索外部资料。'
  }
}

module.exports = {
  id: 'ai-search',
  name: 'AI 搜索',
  version: '0.1.0',
  enabled: false,
  source: 'official',
  description: '基于语义搜索的 AI 视频搜索插件。通过 Dify、云端或本地 LLM 对视频内容进行语义搜索。',
  permissions: [
    'video:index:read',
    'video-analysis:read',
    'settings:readwrite',
    'remote:routes',
    'background:jobs'
  ],
  settingsDefaults,
  settingsSchema,
  setup(ctx) {
    const { registerAiSearchIpc } = require('./ipc')

    ctx.settings.defineDefaults(settingsDefaults)
    ctx.settings.defineSchema(settingsSchema)
    ctx.capabilities.provide('ai-search.engine', {
      // Placeholder — will be wired up in a follow-up module
    })

    registerAiSearchIpc(ctx)
  }
}
