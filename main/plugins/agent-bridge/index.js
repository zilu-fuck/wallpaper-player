module.exports = {
  id: 'agent-bridge',
  name: 'Agent Bridge',
  version: '0.1.0',
  enabled: false,
  status: 'planned',
  description: '规划中的受控 Agent 接口插件，只暴露明确授权的视频库、分析和播放命令。',
  settingsDefaults: {
    agentBridge: {
      enabled: false
    }
  },
  settingsSchema: {
    agentBridge: {
      type: 'object',
      description: 'Agent Bridge 允许的受控能力、访问凭证和审计配置。'
    }
  },
  permissions: [
    'agent:commands',
    'video:index:read',
    'video-analysis:read',
    'player:control'
  ]
}
