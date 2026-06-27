'use strict'

const https = require('https')
const http = require('http')

/**
 * Extract JSON from raw text, handling markdown code blocks.
 * @param {string} text
 * @returns {object|null}
 */
function tryParseJSON(text) {
  if (!text || typeof text !== 'string') return null

  // Try direct parse first
  try {
    return JSON.parse(text)
  } catch (_) {
    // fall through
  }

  // Extract from markdown code blocks (```json ... ```)
  const blockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/)
  if (blockMatch) {
    try {
      return JSON.parse(blockMatch[1].trim())
    } catch (_) {
      // fall through
    }
  }

  // Extract from inline ```...```
  const inlineMatch = text.match(/```([\s\S]*?)```/)
  if (inlineMatch) {
    try {
      return JSON.parse(inlineMatch[1].trim())
    } catch (_) {
      // fall through
    }
  }

  // Try to find a JSON object in the text
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0])
    } catch (_) {
      // fall through
    }
  }

  return null
}

/**
 * Make an HTTP(S) request with timeout and abort support.
 * @param {string} url
 * @param {object} body
 * @param {object} [reqOptions]
 * @param {object} [reqOptions.headers]
 * @param {number} [reqOptions.timeout]
 * @param {AbortSignal} [reqOptions.signal]
 * @returns {Promise<{ statusCode: number, body: string }>}
 */
function makeRequest(url, body, options) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url)
    const isHttps = urlObj.protocol === 'https:'
    const mod = isHttps ? https : http

    const timeout = (options && options.timeout) || 30000
    const signal = options && options.signal
    function createAbortError() {
      const error = new Error('Request was aborted')
      error.code = 'TASK_CANCELLED'
      return error
    }
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'WallpaperPlayer-AISearch/1.0',
      ...((options && options.headers && typeof options.headers === 'object') ? options.headers : {})
    }

    const req = mod.request(
      url,
      {
        method: 'POST',
        headers,
        timeout
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const bodyStr = Buffer.concat(chunks).toString('utf-8')
          resolve({ statusCode: res.statusCode, body: bodyStr })
        })
        res.on('error', reject)
      }
    )

    req.on('error', (err) => {
      const code = err && (err.code || (err.errors && err.errors[0] && err.errors[0].code))
      const label = code || (err && err.message) || 'unknown'
      const message = `无法连接到 LLM 服务 (${urlObj.hostname}): ${label}`
      const wrapped = new Error(message)
      wrapped.code = code
      wrapped.originalError = err
      reject(wrapped)
    })
    req.on('timeout', () => {
      req.destroy()
      reject(new Error(`Request timed out after ${timeout}ms`))
    })

    // Support AbortSignal
    if (signal) {
      if (signal.aborted) {
        req.destroy()
        reject(createAbortError())
        return
      }
      signal.addEventListener('abort', () => {
        req.destroy()
        reject(createAbortError())
      }, { once: true })
    }

    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body))
    }
    req.end()
  })
}

/**
 * Build prompt with video info and web evidence.
 * @param {object} videoInfo
 * @param {Array} evidence
 * @param {string} [intent] - resolved search intent from pipeline
 * @returns {string}
 */
function buildPrompt(videoInfo, evidence, intent) {
  const title = videoInfo.title || ''
  const tags = Array.isArray(videoInfo.tags) ? videoInfo.tags.join(', ') : ''
  const group = videoInfo.group || ''
  const duration = videoInfo.duration || ''
  const resolution = videoInfo.resolution || ''
  const resolvedIntent = intent || videoInfo.searchIntent || 'auto'

  const stableEvidence = normalizeEvidenceForPrompt(evidence)
  const evidenceText = stableEvidence.length > 0
    ? stableEvidence.map((e, i) => {
      return `[来源 ${i + 1}]
标题: ${e.title || ''}
网址: ${e.url || ''}
摘要: ${e.snippet || ''}
内容: ${e.bodyText || ''}`
    }).join('\n\n')
    : '未收集到网页证据。'

  // 根据搜索意图动态调整任务描述
  const taskSection = _buildTaskSection(resolvedIntent)
  const fieldGuidance = _buildFieldGuidance(resolvedIntent)

  return `你是一个视频作品识别助手。根据视频文件信息和网页搜索证据，识别这个视频属于什么作品，并找出相关系列信息。

## 任务
${taskSection}

仅返回 JSON 对象（不要输出其他文字）：
{
  "candidates": [
    {
      "candidateTitle": "该视频的准确标题",
      "relationship": "sequel|prequel|same_series|spin_off|uncertain",
      "confidence": 0.0-1.0,
      "evidence": ["支持该结论的来源引用"],
      "conflicts": ["矛盾的证据"],
      "reason": "结论的简要说明",
      "sourceUrls": ["优先填写真实可播放的视频页、播放页或剧集详情页 URL，来源不限；其次才是资料页 URL"]
    }
  ]
}

## 字段要求
${fieldGuidance}

## 视频信息
- 标题: ${title}
${tags ? `- 标签: ${tags}` : ''}
${group ? `- 分组: ${group}` : ''}
${duration ? `- 时长: ${duration}` : ''}
${resolution ? `- 分辨率: ${resolution}` : ''}

## 网页搜索证据
${evidenceText}`
}

function normalizeEvidenceForPrompt(evidence) {
  if (!Array.isArray(evidence)) return []
  return evidence
    .map((item) => ({
      title: normalizePromptText(item?.title),
      url: normalizePromptText(item?.url),
      snippet: normalizePromptText(item?.snippet),
      siteName: normalizePromptText(item?.siteName),
      bodyText: normalizePromptText(item?.bodyText).slice(0, 900),
      sourceScore: Number(item?.sourceScore) || 0
    }))
    .filter(item => item.title || item.url || item.snippet || item.bodyText)
    .sort((a, b) => (
      b.sourceScore - a.sourceScore ||
      a.url.localeCompare(b.url) ||
      a.title.localeCompare(b.title)
    ))
}

function normalizePromptText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
}

function _buildTaskSection(intent) {
  switch (intent) {
    case 'sequel':
      return '根据以上视频信息和网页证据，确定这个视频之后可继续观看的内容：同季下一集、下一季、续集或后续季。如果当前视频是第一季第一集，必须同时关注第一季第二集和第二季。候选结论应优先返回能直接观看的视频页/播放页。'
    case 'watch_order':
      return '根据以上视频信息和网页证据，确定：\n1. 这个视频属于哪个系列？\n2. 列出该系列所有作品的观看顺序（按时间线或故事顺序排列）。'
    case 'same_series':
      return '根据以上视频信息和网页证据，确定：\n1. 这个视频的准确标题是什么？\n2. 列出同一系列的所有相关作品。'
    case 'auto':
    default:
      return '根据以上视频信息和网页证据，确定：\n1. 这个视频的准确标题是什么？\n2. 它与其他同系列作品的关系是什么？'
  }
}

function _buildFieldGuidance(intent) {
  switch (intent) {
    case 'sequel':
      return [
        '- candidateTitle 必须填写续集/下一季/后续季的作品名称，例如“某作品 第二季”；不要只返回当前视频所属的第一季或原始作品名。',
        '- 如果网页证据包含同季下一集（例如第 2 集 / Episode 2）的播放页，也应作为候选返回；不要只查下一季。',
        '- relationship 应优先为 sequel；如果证据只能确认当前作品或同系列，但不能确认续作，请返回 relationship="uncertain"，confidence 不要超过 0.4。',
        '- evidence 必须引用能证明“存在续集/下一季/后续季”的网页线索，例如第二季、第三季、续作发布日期、季数列表或官方条目。',
        '- sourceUrls 优先填写续作的真实可播放视频页、播放页、剧集详情页或预告片页面，来源不限；不要只填写与续作无关的泛百科跳转页。'
      ].join('\n')
    case 'watch_order':
      return [
        '- candidateTitle 应填写系列名或观看顺序条目的名称。',
        '- evidence 必须引用能证明观看顺序、季数顺序或时间线顺序的线索。',
        '- 如果只能识别当前作品但不能确认观看顺序，请返回 relationship="uncertain"，confidence 不要超过 0.45。'
      ].join('\n')
    case 'same_series':
      return [
        '- candidateTitle 应填写同系列作品或系列总称。',
        '- evidence 必须引用能证明系列关系、同一宇宙、同一 franchise 或相关作品列表的线索。'
      ].join('\n')
    case 'auto':
    default:
      return '- candidateTitle 填写最能回答当前任务的作品名；evidence 和 sourceUrls 只引用能直接支持该候选的线索。sourceUrls 优先填写真实可播放的视频页、播放页、剧集详情页或预告片页面，来源不限；百科资料只能作为辅助来源。'
  }
}

/**
 * Call the selected LLM provider and return structured results.
 * @param {{ type: string, endpoint: string, apiKey: string, modelName: string }} providerConfig
 * @param {string} prompt
 * @param {{ timeout?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<{ candidates: Array, rawResponse: string }>}
 */
async function callLLM(providerConfig, prompt, options) {
  if (!providerConfig || !providerConfig.type) {
    throw new Error('providerConfig with a valid "type" is required')
  }

  const timeout = (options && options.timeout) || 30000
  const signal = options && options.signal

  const { type, endpoint, apiKey, modelName } = providerConfig

  let responsePayload
  let retryErr

  // Attempt the call, with one retry on failure
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      if (signal?.aborted) {
        const error = new Error('Request was aborted')
        error.code = 'TASK_CANCELLED'
        throw error
      }
      switch (type) {
        case 'dify': {
          responsePayload = await callDify(endpoint, apiKey, prompt, { timeout, signal })
          break
        }
        case 'cloud':
        case 'local':
        default: {
          responsePayload = await callOpenAICompatible(type, endpoint, apiKey, modelName, prompt, { timeout, signal })
          break
        }
      }
      break // success, exit retry loop
    } catch (err) {
      retryErr = err
      if (err?.code === 'TASK_CANCELLED' || signal?.aborted) {
        throw err
      }
      if (attempt === 1) {
        // Wait briefly before retry
        await new Promise(r => setTimeout(r, 1000))
      }
    }
  }

  const responseText = typeof responsePayload === 'string' ? responsePayload : responsePayload?.content
  const usage = responsePayload && typeof responsePayload === 'object' ? responsePayload.usage || null : null

  if (!responseText) {
    throw retryErr || new Error('Failed to get response from LLM after retry')
  }

  // Parse the response as JSON
  const parsed = tryParseJSON(responseText)

  if (!parsed || !parsed.candidates) {
    // If parsing fails, wrap raw response in expected format
    return {
      candidates: [],
      rawResponse: responseText,
      usage
    }
  }

  return {
    candidates: Array.isArray(parsed.candidates) ? parsed.candidates : [],
    rawResponse: responseText,
    usage
  }
}

/**
 * Call an OpenAI-compatible API (local or cloud).
 */
async function callOpenAICompatible(type, endpoint, apiKey, modelName, prompt, options) {
  if (!endpoint) throw new Error(`${type} endpoint is required`)

  const url = `${endpoint.replace(/\/+$/, '')}/chat/completions`

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'WallpaperPlayer-AISearch/1.0'
  }

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }

  const body = {
    model: modelName || 'gpt-3.5-turbo',
    messages: [
      {
        role: 'system',
        content: '你是一个精确的视频作品识别助手。始终只返回有效的 JSON 格式结果。'
      },
      {
        role: 'user',
        content: prompt
      }
    ],
    temperature: 0.3,
    max_tokens: 2048
  }
  if (type === 'cloud') {
    body.response_format = { type: 'json_object' }
  }

  const { statusCode, body: responseBody } = await makeRequest(url, body, { ...options, headers })

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`LLM API returned status ${statusCode}: ${responseBody.slice(0, 500)}`)
  }

  const parsed = tryParseJSON(responseBody)
  if (!parsed) {
    throw new Error(`Failed to parse LLM API response as JSON: ${responseBody.slice(0, 500)}`)
  }

  const choices = parsed.choices
  if (!choices || choices.length === 0) {
    throw new Error('LLM API returned no choices')
  }

  const choice = choices[0]
  if (choice.finish_reason === 'length') {
    throw new Error('LLM response was truncated before valid JSON could be returned')
  }

  const message = choice.message
  const content = message && message.content
  if (typeof content !== 'string' || !content.trim()) {
    const finishReason = choice.finish_reason ? ` (finish_reason: ${choice.finish_reason})` : ''
    throw new Error(`LLM API returned empty message content${finishReason}`)
  }

  return {
    content,
    usage: parsed.usage || null
  }
}

/**
 * Call the Dify API.
 */
async function callDify(endpoint, apiKey, prompt, options) {
  if (!endpoint) throw new Error('Dify endpoint is required')
  if (!apiKey) throw new Error('Dify API key is required')

  const url = `${endpoint.replace(/\/+$/, '')}/chat-messages`

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'User-Agent': 'WallpaperPlayer-AISearch/1.0'
  }

  const body = {
    inputs: {},
    query: prompt,
    response_mode: 'blocking',
    user: 'wallpaper-player'
  }

  const { statusCode, body: responseBody } = await makeRequest(url, body, { ...options, headers })

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`Dify API returned status ${statusCode}: ${responseBody.slice(0, 500)}`)
  }

  const parsed = tryParseJSON(responseBody)
  if (!parsed) {
    throw new Error(`Failed to parse Dify API response as JSON: ${responseBody.slice(0, 500)}`)
  }

  // Dify returns the answer in the "answer" field
  return {
    content: parsed.answer || JSON.stringify(parsed),
    usage: null
  }
}

module.exports = {
  callLLM,
  buildPrompt
}
