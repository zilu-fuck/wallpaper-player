'use strict'

const DEFAULT_CONFIG = {
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

const CONFIG_SCHEMA = {
  llmProvider: { type: 'string', enum: ['local', 'dify', 'cloud'] },
  difyEndpoint: { type: 'string' },
  difyApiKey: { type: 'string' },
  cloudBaseUrl: { type: 'string' },
  cloudApiKey: { type: 'string' },
  cloudModelName: { type: 'string' },
  localBaseUrl: { type: 'string' },
  localModelName: { type: 'string' },
  localApiKey: { type: 'string' },
  maxPages: { type: 'number', min: 1, max: 50 },
  timeout: { type: 'number', min: 5, max: 300 },
  trustedSiteRules: { type: 'object' },
  trustedMinEvidence: { type: 'number', min: 1, max: 20 },
  trustedConfidenceThreshold: { type: 'number', min: 0.1, max: 1 },
  feedbackMemory: { type: 'array' }
}

function validateConfig(config) {
  const errors = []
  const sanitized = {}

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { valid: false, errors: ['Config must be a non-null object'], sanitized: { ...DEFAULT_CONFIG } }
  }

  for (const [key, rule] of Object.entries(CONFIG_SCHEMA)) {
    const value = config[key]
    const def = DEFAULT_CONFIG[key]

    if (value === undefined || value === null) {
      sanitized[key] = def
      continue
    }

    switch (rule.type) {
      case 'string': {
        if (typeof value !== 'string') {
          errors.push(`"${key}" must be a string`)
          sanitized[key] = def || ''
        } else {
          sanitized[key] = value
        }
        break
      }
      case 'number': {
        const num = Number(value)
        if (!Number.isFinite(num)) {
          errors.push(`"${key}" must be a number`)
          sanitized[key] = def
        } else if (rule.min !== undefined && num < rule.min) {
          errors.push(`"${key}" must be >= ${rule.min}`)
          sanitized[key] = def
        } else if (rule.max !== undefined && num > rule.max) {
          errors.push(`"${key}" must be <= ${rule.max}`)
          sanitized[key] = def
        } else {
          sanitized[key] = num
        }
        break
      }
      case 'object': {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          errors.push(`"${key}" must be an object`)
          sanitized[key] = def
        } else {
          sanitized[key] = value
        }
        break
      }
      case 'array': {
        sanitized[key] = Array.isArray(value) ? value : def
        break
      }
      default: {
        sanitized[key] = def
        break
      }
    }
  }

  const requiredByProvider = {
    dify: ['difyEndpoint', 'difyApiKey'],
    cloud: ['cloudBaseUrl', 'cloudApiKey', 'cloudModelName'],
    local: ['localBaseUrl', 'localModelName']
  }

  const provider = sanitized.llmProvider
  for (const key of requiredByProvider[provider] || []) {
    if (!sanitized[key]) {
      errors.push(`"${key}" is required when llmProvider is "${provider}"`)
    }
  }

  return { valid: errors.length === 0, errors, sanitized }
}

function getActiveProviderConfig(config) {
  const merged = { ...DEFAULT_CONFIG, ...(config || {}) }
  const provider = merged.llmProvider

  switch (provider) {
    case 'dify':
      return {
        type: 'dify',
        endpoint: merged.difyEndpoint,
        apiKey: merged.difyApiKey,
        modelName: ''
      }
    case 'cloud':
      return {
        type: 'cloud',
        endpoint: merged.cloudBaseUrl,
        apiKey: merged.cloudApiKey,
        modelName: merged.cloudModelName
      }
    case 'local':
    default: {
      let endpoint = (merged.localBaseUrl || '').replace(/\/+$/, '')
      // Most local OpenAI-compatible servers (Ollama, LM Studio, etc.) use /v1 prefix
      if (endpoint && !endpoint.endsWith('/v1')) {
        endpoint = `${endpoint}/v1`
      }
      return {
        type: 'local',
        endpoint,
        apiKey: merged.localApiKey,
        modelName: merged.localModelName
      }
    }
  }
}

module.exports = {
  validateConfig,
  getActiveProviderConfig,
  DEFAULT_CONFIG
}
