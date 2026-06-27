'use strict'

const { buildBaseTitle, cleanTitle, extractPatterns, generateSearchQueries, getNextTargets, isWeakSearchTitle, normalizeSearchTitle } = require('./title-cleaner')
const browserModule = require('./browser')
const llmProvider = require('./llm-provider')
const { getActiveProviderConfig } = require('./config')

// --- Module state ---

let emitEvent = null
const activeTasks = new Map()
const evidenceCache = new Map()
let taskIdCounter = 0
const EVIDENCE_CACHE_TTL_MS = 6 * 60 * 60 * 1000
const EVIDENCE_CACHE_LIMIT = 80

/**
 * Set the event emitter function used to push events to renderer.
 * Called by ipc.js during registration to avoid circular dependency.
 * @param {function} fn
 */
function setEventEmitter(fn) {
  emitEvent = typeof fn === 'function' ? fn : null
}

/**
 * Emit an event to the renderer via the registered emitter.
 * @param {object} payload
 */
function _emit(payload) {
  if (emitEvent) {
    try {
      emitEvent(payload)
    } catch (_) {
      // emitter failed silently
    }
  }
}

function _emitDetail(taskId, detail) {
  _emit({
    type: 'detail',
    taskId,
    stage: detail?.stage || '',
    title: detail?.title || '',
    message: detail?.message || '',
    detail: detail?.detail || '',
    level: detail?.level || 'info',
    items: Array.isArray(detail?.items) ? detail.items : []
  })
}

// --- Task management ---

/**
 * Generate a unique task ID.
 * @returns {string}
 */
function _generateTaskId() {
  taskIdCounter++
  return `ai-search-${Date.now()}-${taskIdCounter}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Create and start a search task (runs pipeline asynchronously).
 * @param {object} videoInfo - { title, filePath, fileMeta }
 * @param {object} config - plugin config
 * @returns {{ taskId: string }}
 */
function createSearchTask(videoInfo, config) {
  const taskId = _generateTaskId()

  const task = {
    id: taskId,
    videoInfo,
    config: config || {},
    cancelled: false,
    abortController: null,
    createdAt: Date.now()
  }

  activeTasks.set(taskId, task)

  _emit({ type: 'task-created', taskId, videoInfo })

  // Run pipeline asynchronously (return immediately)
  _runPipeline(task).catch((err) => {
    if (!task.cancelled) {
      _emit({ type: 'error', taskId, message: err.message || 'Unknown pipeline error' })
    }
  }).finally(() => {
    activeTasks.delete(taskId)
  })

  return { taskId }
}

/**
 * Cancel a running search task.
 * @param {string} taskId
 */
function cancelSearchTask(taskId) {
  const task = activeTasks.get(taskId)
  if (!task) {
    _emit({ type: 'cancelled', taskId })
    return
  }
  task.cancelled = true
  // 若 LLM 请求进行中，立即触发 abort，不再依赖轮询
  if (task.abortController) {
    try { task.abortController.abort() } catch (_) {}
  }
  _emit({ type: 'cancelled', taskId })
}

/**
 * Cancel all active tasks (used during plugin disposal).
 */
function cancelAllTasks() {
  for (const [taskId, task] of activeTasks) {
    task.cancelled = true
    if (task.abortController) {
      try { task.abortController.abort() } catch (_) {}
    }
    _emit({ type: 'cancelled', taskId })
  }
  activeTasks.clear()
}

/**
 * Check if task was cancelled; if so, throw a silent abort.
 * @param {object} task
 */
function _checkCancelled(task) {
  if (task.cancelled) {
    const err = new Error('Task was cancelled')
    err.code = 'TASK_CANCELLED'
    throw err
  }
}

// --- Pipeline ---

async function _runPipeline(task) {
  const { videoInfo, config, id: taskId } = task
  let browser = null

  try {
    // Stage 1: Clean title
    _checkCancelled(task)
    _emit({ type: 'progress', taskId, stage: 'cleaning', message: '清洗标题...' })
    const titleInput = chooseSearchTitle(videoInfo)
    const cleanedTitle = normalizeSearchTitle(titleInput)
    const patterns = extractPatterns(titleInput)
    if (titleInput !== videoInfo.title) {
      _emitDetail(taskId, {
        stage: 'cleaning',
        title: '修正搜索标题',
        message: `原始标题「${videoInfo.title || videoInfo.fileName || ''}」信息不足，改用「${titleInput}」`
      })
    }

    if (!cleanedTitle) {
      throw new Error('Failed to extract a meaningful title from the video filename')
    }

    // Stage 2: Generate search queries
    _checkCancelled(task)
    const userIntent = videoInfo.searchIntent
    const keywords = Array.isArray(videoInfo.keywords) ? videoInfo.keywords.filter(Boolean) : []
    const intent = _determineIntent(patterns, userIntent)
    const sourceProfile = determineSourceProfile(videoInfo, cleanedTitle, keywords)
    const trustedSites = resolveTrustedSites(config, videoInfo)
    const feedbackHints = getFeedbackHints(config, videoInfo, intent)
    const nextTargets = getNextTargets(cleanedTitle)
    const targetRequirements = buildTargetRequirements(cleanedTitle, intent)
    const trustedMinEvidence = clampNumber(config.trustedMinEvidence, 4, 1, 20)
    const trustedConfidenceThreshold = clampNumber(config.trustedConfidenceThreshold, 0.62, 0.1, 1)
    _emit({ type: 'progress', taskId, stage: 'searching', message: '生成搜索查询...' })
    const queries = generateSearchQueries(cleanedTitle, intent, [...keywords, ...feedbackHints.keywords], { sourceProfile })

    if (queries.length === 0) {
      throw new Error('Failed to generate search queries from title')
    }
    if (intent === 'sequel' && nextTargets.length > 0) {
      _emitDetail(taskId, {
        stage: 'searching',
        title: '目标拆解',
        message: '检测到当前视频的季/集信息，搜索目标会同时覆盖下一集和下一季。',
        items: nextTargets.map(target => target.type === 'episode' ? `下一集: 第 ${target.number} 集` : `下一季: 第 ${target.number} 季`)
      })
    }

    // Stage 3: Web browsing
    _checkCancelled(task)
    _emit({ type: 'progress', taskId, stage: 'browsing', message: '浏览网页收集证据...' })
    if (sourceProfile === 'anime') {
      _emitDetail(taskId, {
        stage: 'searching',
        title: '搜索源策略',
        message: '检测到动画/二次元关键词，优先补充 Iwara 与 Pixiv 定向搜索。'
      })
    }
    if (trustedSites.length > 0) {
      _emitDetail(taskId, {
        stage: 'searching',
        title: '信任来源策略',
        message: `优先搜索 ${trustedSites.length} 个信任网站；置信度低于 ${Math.round(trustedConfidenceThreshold * 100)}% 时再搜索外部资料。`,
        items: trustedSites
      })
    }
    if (feedbackHints.items.length > 0) {
      _emitDetail(taskId, {
        stage: 'searching',
        title: '套用搜索记忆',
        message: '根据上次评分，优先避免只找到资料页，追加播放页搜索目标。',
        items: feedbackHints.items
      })
    }

    let trustedEvidence = []
    let externalEvidence = []

    if (browserModule.isAvailable()) {
      try {
        browser = await browserModule.launchBrowser()
        _emitDetail(taskId, {
          stage: 'browsing',
          title: '浏览器已启动',
          message: `准备执行 ${queries.length} 组搜索查询`
        })

        if (trustedSites.length > 0) {
          trustedEvidence = await collectEvidenceForQueries(task, browser, queries, {
            sourceProfile: { mode: 'trusted', baseProfile: sourceProfile, trustedSites },
            label: '信任来源',
            maxPages: Math.min(config.maxPages || 5, 6),
            timeout: config.timeout || 30,
            stopWhen: evidence => getPreparedEvidenceCount(evidence, cleanedTitle) >= trustedMinEvidence
          })
        }
      } catch (err) {
        if (err?.code === 'TASK_CANCELLED') throw err
        console.warn('[ai-search] browser launch failed:', err.message)
        _emit({
          type: 'progress',
          taskId,
          stage: 'browsing',
          message: `浏览器不可用: ${err.message}，将仅基于标题进行分析`
        })
      }
    } else {
      _emit({
        type: 'progress',
        taskId,
        stage: 'browsing',
        message: 'playwright-core 未安装，跳过网页搜索。安装可: npm install playwright-core --save-optional'
      })
    }

    const providerConfig = getActiveProviderConfig(config)
    validateProviderConfig(providerConfig)

    const promptVideoInfo = {
      ...videoInfo,
      title: cleanedTitle,
      fileName: videoInfo.fileName || videoInfo.title || '',
      tags: [...collectVideoTags(videoInfo)]
    }

    let finalEvidenceSource = 'external'
    let reasoningResult = null
    const trustedPrepared = prepareEvidenceForReasoning(trustedEvidence, cleanedTitle, taskId, '信任来源', {
      targetRequirements
    })
    if (trustedSites.length > 0) {
      if (trustedPrepared.selectedEvidence.length >= trustedMinEvidence) {
        _emitDetail(taskId, {
          stage: 'reasoning',
          title: '先用信任来源推理',
          message: `信任来源已有 ${trustedPrepared.selectedEvidence.length} 条精选线索，先不搜索外部资料。`
        })
        reasoningResult = await runReasoning(task, {
          providerConfig,
          promptVideoInfo,
          selectedEvidence: trustedPrepared.selectedEvidence,
          intent,
          cleanedTitle,
          targetRequirements,
          label: '信任来源'
        })
        const topConfidence = getTopConfidence(reasoningResult.candidates)
        const trustedResultHasRequiredVideo = topCandidateHasRequiredVideoGoal(reasoningResult.candidates, intent)
        if (topConfidence >= trustedConfidenceThreshold && trustedResultHasRequiredVideo) {
          finalEvidenceSource = 'trusted'
          _emitDetail(taskId, {
            stage: 'summarizing',
            title: '信任来源置信度足够',
            message: `最高置信度 ${Math.round(topConfidence * 100)}%，不再搜索外部资料。`,
            level: 'success'
          })
        } else if (topConfidence >= trustedConfidenceThreshold) {
          _emitDetail(taskId, {
            stage: 'browsing',
            title: '信任来源缺少真实视频',
            message: `最高置信度 ${Math.round(topConfidence * 100)}%，但没有命中真实视频/播放页，继续搜索外部资料。`,
            level: 'warning'
          })
        } else {
          _emitDetail(taskId, {
            stage: 'browsing',
            title: '信任来源置信度不足',
            message: `最高置信度 ${Math.round(topConfidence * 100)}%，继续搜索外部资料。`,
            level: 'warning'
          })
        }
      } else {
        _emitDetail(taskId, {
          stage: 'browsing',
          title: '信任来源线索不足',
          message: `信任来源精选 ${trustedPrepared.selectedEvidence.length} 条，少于最低要求 ${trustedMinEvidence} 条，继续搜索外部资料。`,
          level: 'warning'
        })
      }
    }

    let combinedEvidence = deduplicateEvidenceByUrl([...trustedEvidence, ...externalEvidence])
    if (finalEvidenceSource !== 'trusted') {
      if (browser) {
        externalEvidence = await collectEvidenceForQueries(task, browser, queries, {
          sourceProfile: { mode: 'external', baseProfile: sourceProfile },
          label: '外部资料',
          maxPages: config.maxPages || 5,
          timeout: config.timeout || 30,
          stopWhen: evidence => hasEnoughEvidenceCoverage(evidence, {
            requireVideo: requiresVerifiedVideoForHighConfidence(intent)
          })
        })
      }
      combinedEvidence = deduplicateEvidenceByUrl([...trustedEvidence, ...externalEvidence])
      const prepared = prepareEvidenceForReasoning(combinedEvidence, cleanedTitle, taskId, trustedSites.length ? '合并来源' : '外部资料', {
        targetRequirements
      })
      reasoningResult = await runReasoning(task, {
        providerConfig,
        promptVideoInfo,
        selectedEvidence: prepared.selectedEvidence,
        intent,
        cleanedTitle,
        targetRequirements,
        label: trustedSites.length ? '信任来源 + 外部资料' : '外部资料'
      })
    }

    if (browser && reasoningResult && shouldCollectPlayableEvidence(reasoningResult.candidates, intent)) {
      const playableResult = await collectPlayableEvidenceForCandidates(task, browser, reasoningResult.candidates, {
        cleanedTitle,
        targetRequirements,
        sourceProfile,
        maxPages: config.maxPages || 5,
        timeout: config.timeout || 30
      })
      if (playableResult.evidence.length > 0) {
        combinedEvidence = deduplicateEvidenceByUrl([...combinedEvidence, ...playableResult.evidence])
        const playableFilterTitles = [cleanedTitle, ...getCandidateTitles(reasoningResult.candidates)]
        const prepared = prepareEvidenceForReasoning(combinedEvidence, playableFilterTitles, taskId, '播放页专项', {
          targetRequirements
        })
        reasoningResult = await runReasoning(task, {
          providerConfig,
          promptVideoInfo,
          selectedEvidence: prepared.selectedEvidence,
          intent,
          cleanedTitle,
          targetRequirements,
          label: '播放页专项'
        })
      }
    }

    if (browser) {
      await browserModule.closeBrowser(browser).catch(() => {})
      browser = null
    }

    const candidates = reasoningResult.candidates
    const selectedEvidence = reasoningResult.selectedEvidence
    _emitDetail(taskId, {
      stage: 'summarizing',
      title: '生成总结',
      message: buildResultSummary(candidates, selectedEvidence)
    })

    // Stage 6: Emit result
    _checkCancelled(task)
    _emit({
      type: 'result',
      taskId,
      candidates,
      evidence: selectedEvidence,
      videoInfo
    })
  } catch (err) {
    if (err.code === 'TASK_CANCELLED') return
    _emit({ type: 'error', taskId, message: err.message })
  } finally {
    if (browser) {
      await browserModule.closeBrowser(browser).catch(() => {})
    }
  }
}

/**
 * Determine search intent: user-provided intent takes priority,
 * fall back to pattern-based inference only when intent is 'auto'.
 * @param {object} patterns
 * @param {string} [userIntent] - intent from frontend ('auto'|'sequel'|'same_series'|'watch_order')
 * @returns {string}
 */
function _determineIntent(patterns, userIntent) {
  if (userIntent && userIntent !== 'auto') return userIntent
  const { specialTypes } = patterns
  if (specialTypes.includes('OVA') || specialTypes.includes('movie') || specialTypes.includes('special')) {
    return 'same_series'
  }
  return 'auto'
}

/**
 * Create an AbortController bound to the task. Cancelling the task
 * immediately aborts the in-flight request via cancelSearchTask().
 * @param {object} task
 * @returns {{ signal: AbortSignal, cleanup: () => void }}
 */
function _createAbortController(task) {
  const controller = new AbortController()
  task.abortController = controller
  return {
    signal: controller.signal,
    cleanup() {
      if (task.abortController === controller) {
        task.abortController = null
      }
    }
  }
}

function buildEvidenceCacheKey(query, options = {}) {
  const normalizedQuery = normalizeCacheQuery(query)
  const parts = [
    `v=${browserModule.SEARCH_SOURCE_VERSION || 1}`,
    `profile=${normalizeSourceProfileKey(options.sourceProfile)}`,
    `maxPages=${options.maxPages || 5}`,
    `q=${normalizedQuery}`
  ]
  return parts.join('|')
}

function normalizeSourceProfileKey(sourceProfile) {
  if (!sourceProfile) return 'general'
  if (typeof sourceProfile === 'string') return sourceProfile
  if (typeof sourceProfile === 'object') {
    const trustedSites = Array.isArray(sourceProfile.trustedSites)
      ? sourceProfile.trustedSites.map(site => browserModule.normalizeHost(site)).filter(Boolean).sort().join(',')
      : ''
    return [
      sourceProfile.mode || 'mixed',
      sourceProfile.baseProfile || 'general',
      trustedSites
    ].join(':')
  }
  return 'general'
}

function normalizeCacheQuery(query) {
  return String(query || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function cloneEvidenceList(evidence) {
  return JSON.parse(JSON.stringify(Array.isArray(evidence) ? evidence : []))
}

function getCachedEvidence(cacheKey) {
  const entry = evidenceCache.get(cacheKey)
  if (!entry) return null
  if (Date.now() - entry.createdAt > EVIDENCE_CACHE_TTL_MS) {
    evidenceCache.delete(cacheKey)
    return null
  }
  evidenceCache.delete(cacheKey)
  evidenceCache.set(cacheKey, entry)
  return cloneEvidenceList(entry.evidence)
}

function setCachedEvidence(cacheKey, evidence) {
  evidenceCache.set(cacheKey, {
    createdAt: Date.now(),
    evidence: cloneEvidenceList(evidence)
  })
  while (evidenceCache.size > EVIDENCE_CACHE_LIMIT) {
    const oldestKey = evidenceCache.keys().next().value
    evidenceCache.delete(oldestKey)
  }
}

async function collectEvidenceForQueries(task, browser, queries, options) {
  const collected = []
  const taskId = task.id
  for (const query of queries) {
    _checkCancelled(task)
    const cacheKey = buildEvidenceCacheKey(query, {
      sourceProfile: options.sourceProfile,
      maxPages: options.maxPages || 5
    })
    const cachedResults = getCachedEvidence(cacheKey)
    if (cachedResults) {
      collected.push(...cachedResults)
      const deduped = deduplicateEvidenceByUrl(collected)
      collected.splice(0, collected.length, ...deduped)
      _emitDetail(taskId, {
        stage: 'browsing',
        title: '命中网页线索缓存',
        message: `「${query}」复用 ${cachedResults.length} 条线索，累计 ${collected.length} 条`
      })
      if (typeof options.stopWhen === 'function' && options.stopWhen(collected)) break
      continue
    }

    const abortHandle = _createAbortController(task)
    try {
      _emitDetail(taskId, {
        stage: 'searching',
        title: `${options.label || '搜索'}查询`,
        message: query
      })
      const results = await browserModule.searchAndCollect(browser, query, {
        maxPages: options.maxPages || 5,
        timeout: options.timeout || 30,
        signal: abortHandle.signal,
        sourceProfile: options.sourceProfile,
        onDetail: (detail) => _emitDetail(taskId, detail)
      })
      setCachedEvidence(cacheKey, results)
      collected.push(...results)
      const deduped = deduplicateEvidenceByUrl(collected)
      collected.splice(0, collected.length, ...deduped)
      _emitDetail(taskId, {
        stage: 'browsing',
        title: `${options.label || '查询'}完成`,
        message: `「${query}」收集到 ${results.length} 条线索，去重后累计 ${collected.length} 条`
      })
      if (typeof options.stopWhen === 'function' && options.stopWhen(collected)) break
    } catch (err) {
      if (err?.code === 'TASK_CANCELLED') throw err
      console.warn(`[ai-search] query failed: ${query}`, err.message)
      _emitDetail(taskId, {
        stage: 'browsing',
        title: `${options.label || '查询'}失败`,
        message: query,
        detail: err.message,
        level: 'warning'
      })
    } finally {
      abortHandle.cleanup()
    }
  }
  return deduplicateEvidenceByUrl(collected)
}

async function collectPlayableEvidenceForCandidates(task, browser, candidates, options) {
  const taskId = task.id
  const queries = buildPlayableSearchQueries(candidates, options.cleanedTitle, options.targetRequirements)
  if (queries.length === 0) return { evidence: [] }

  _emitDetail(taskId, {
    stage: 'searching',
    title: '补搜真实视频',
    message: '当前结论只证明了作品信息，但没有视频链接，继续专项搜索播放页。',
    items: queries.slice(0, 6)
  })

  const evidence = await collectEvidenceForQueries(task, browser, queries, {
    sourceProfile: { mode: 'external', baseProfile: options.sourceProfile },
    label: '播放页专项',
    maxPages: Math.max(options.maxPages || 5, 8),
    timeout: options.timeout || 30,
    stopWhen: collected => hasEnoughPlayableEvidence(collected, options.cleanedTitle, options.targetRequirements)
  })
  const classified = classifyEvidence(evidence)
  const videoCount = classified.filter(isVideoEvidence).length
  _emitDetail(taskId, {
    stage: 'browsing',
    title: '播放页专项完成',
    message: `补搜收集 ${evidence.length} 条线索，其中视频/播放页 ${videoCount} 条。`,
    level: videoCount > 0 ? 'success' : 'warning'
  })
  return { evidence }
}

function buildPlayableSearchQueries(candidates, cleanedTitle, targetRequirements = []) {
  const titles = []
  const topCandidates = Array.isArray(candidates) ? candidates.slice(0, 3) : []
  for (const candidate of topCandidates) {
    const title = String(candidate?.candidateTitle || '').trim()
    if (title) titles.push(title)
  }
  if (cleanedTitle) titles.push(cleanedTitle)

  const queries = []
  const baseTitle = buildBaseTitle(cleanedTitle) || cleanedTitle
  if (baseTitle) {
    for (const target of targetRequirements) {
      const label = formatTargetLabel(target)
      if (!label) continue
      queries.push(`${baseTitle} ${label} 在线观看`)
      queries.push(`${baseTitle} ${label} 在线播放`)
      queries.push(`${baseTitle} ${label} 立即播放`)
      queries.push(`${baseTitle} ${label} vodplay`)
      if (target.type === 'episode') {
        queries.push(`${baseTitle} episode ${target.number} watch online`)
        queries.push(`${baseTitle} ep ${target.number} full episode`)
      }
      if (target.type === 'season') {
        queries.push(`${baseTitle} season ${target.number} watch online`)
        queries.push(`${baseTitle} s${String(target.number).padStart(2, '0')} full episode`)
      }
    }
  }
  for (const title of uniqueStrings(titles)) {
    queries.push(`${title} 在线观看`)
    queries.push(`${title} 在线播放`)
    queries.push(`${title} 立即播放`)
    queries.push(`${title} 完整版`)
    queries.push(`${title} 免费`)
    queries.push(`${title} watch online`)
    queries.push(`${title} full episode`)
    queries.push(`${title} vodplay`)
  }
  return uniqueStrings(queries).slice(0, 24)
}

function hasEnoughPlayableEvidence(evidence, cleanedTitle, targetRequirements = []) {
  const classified = classifyEvidence(evidence)
  const targets = Array.isArray(targetRequirements) ? targetRequirements : []
  if (targets.length > 0) {
    const videoEvidence = classified.filter(isVideoEvidence)
    const targetCoverage = computeTargetCoverage(targets, videoEvidence, classified, {})
    return targetCoverage.missingTargets.length === 0
  }
  const relatedPlayableCount = classified.filter(item => {
    if (!isVideoEvidence(item)) return false
    if (!cleanedTitle) return true
    const text = normalizeConfidenceText([
      item?.title,
      item?.snippet,
      item?.bodyText,
      item?.url
    ].join(' '))
    const tokens = getTitleCoreTokens(cleanedTitle)
    return tokens.length === 0 || tokens.some(token => text.includes(token))
  }).length
  return relatedPlayableCount >= 2
}

function uniqueStrings(values) {
  return [...new Set((values || [])
    .map(value => String(value || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean))]
}

function prepareEvidenceForReasoning(evidence, cleanedTitle, taskId, label, options = {}) {
  let allEvidence = deduplicateEvidenceByUrl(evidence)
  const titleFilteredEvidence = filterEvidenceByTitle(allEvidence, cleanedTitle, {
    targetRequirements: options.targetRequirements
  })
  if (shouldUseTitleFilteredEvidence(allEvidence, titleFilteredEvidence)) {
    if (titleFilteredEvidence.length !== allEvidence.length) {
      _emitDetail(taskId, {
        stage: 'browsing',
        title: `${label}按标题过滤线索`,
        message: `保留 ${titleFilteredEvidence.length} / ${allEvidence.length} 条相关线索`
      })
    }
    allEvidence = titleFilteredEvidence
  }

  const classifiedEvidence = classifyEvidence(allEvidence)
    .sort((a, b) => getEvidenceSortScore(b) - getEvidenceSortScore(a))
  const selectedEvidence = selectEvidenceForReasoning(classifiedEvidence)
  _emitDetail(taskId, {
    stage: 'browsing',
    title: `${label}证据筛选完成`,
    message: `收集 ${classifiedEvidence.length} 条，精选 ${selectedEvidence.length} 条用于推理`,
    items: buildEvidenceSummaryItems(classifiedEvidence)
  })
  return { classifiedEvidence, selectedEvidence }
}

function getPreparedEvidenceCount(evidence, cleanedTitle) {
  const allEvidence = deduplicateEvidenceByUrl(evidence)
  const titleFilteredEvidence = filterEvidenceByTitle(allEvidence, cleanedTitle)
  const effectiveEvidence = shouldUseTitleFilteredEvidence(allEvidence, titleFilteredEvidence)
    ? titleFilteredEvidence
    : allEvidence
  return selectEvidenceForReasoning(classifyEvidence(effectiveEvidence)
    .sort((a, b) => getEvidenceSortScore(b) - getEvidenceSortScore(a))).length
}

function shouldUseTitleFilteredEvidence(allEvidence, titleFilteredEvidence) {
  return titleFilteredEvidence.length > 0 || allEvidence.length === 0
}

function getCandidateTitles(candidates) {
  return (Array.isArray(candidates) ? candidates : [])
    .map(candidate => String(candidate?.candidateTitle || '').trim())
    .filter(Boolean)
}

async function runReasoning(task, options) {
  _checkCancelled(task)
  const taskId = task.id
  _emit({ type: 'progress', taskId, stage: 'reasoning', message: 'LLM 推理中...' })
  _emitDetail(taskId, {
    stage: 'reasoning',
    title: '交给模型推理',
    message: `使用 ${options.selectedEvidence.length} 条${options.label || ''}精选证据生成结论`
  })

  const prompt = llmProvider.buildPrompt(options.promptVideoInfo, options.selectedEvidence, options.intent)
  let llmResult
  const abortHandle = _createAbortController(task)
  try {
    llmResult = await llmProvider.callLLM(options.providerConfig, prompt, {
      timeout: (task.config.timeout || 30) * 1000,
      signal: abortHandle.signal
    })
  } catch (err) {
    if (err?.code === 'TASK_CANCELLED') throw err
    console.error('[ai-search] LLM call failed:', err.message)
    throw new Error(`LLM 调用失败: ${err.message}`)
  } finally {
    abortHandle.cleanup()
  }

  if (!llmResult || !Array.isArray(llmResult.candidates) || llmResult.candidates.length === 0) {
    const raw = (llmResult && llmResult.rawResponse) ? String(llmResult.rawResponse).slice(0, 500) : ''
    const reason = raw ? `LLM 返回无法解析: ${raw}` : 'LLM 未返回任何候选结果'
    throw new Error(`${reason}。请检查模型是否正常工作，或尝试补充关键词。`)
  }
  const cacheUsageItems = buildLlmCacheUsageItems(llmResult.usage)
  if (cacheUsageItems.length > 0) {
    _emitDetail(taskId, {
      stage: 'reasoning',
      title: '模型缓存统计',
      message: 'DeepSeek/OpenAI 兼容接口返回的 token 缓存用量',
      items: cacheUsageItems
    })
  }

  _checkCancelled(task)
  const candidates = llmResult.candidates.map((candidate) => {
    const candidateTargets = getCandidateTargetRequirements(candidate, options.targetRequirements)
    const sourceUrls = buildVerifiedCandidateSourceUrls(candidate, options.selectedEvidence, options.intent, candidateTargets)
    const candidateForScoring = { ...candidate, sourceUrls }
    const confidenceResult = computeConfidenceResult(candidateForScoring, options.selectedEvidence, options.cleanedTitle, options.intent, {
      targetRequirements: candidateTargets
    })
    return {
      ...candidateForScoring,
      confidence: confidenceResult.score,
      confidenceDetails: confidenceResult.details
    }
  })
  applyResultTargetCoverage(candidates, options.selectedEvidence, options.intent, options.targetRequirements)
  return { candidates, selectedEvidence: options.selectedEvidence, llmResult }
}

function validateProviderConfig(providerConfig) {
  if (!providerConfig.endpoint) {
    throw new Error(`AI 搜索未配置 ${providerConfig.type} 服务的端点地址`)
  }
  if (providerConfig.type !== 'dify' && !providerConfig.modelName) {
    throw new Error(`AI 搜索未配置 ${providerConfig.type} 服务的模型名称`)
  }
}

function getTopConfidence(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return 0
  return Math.max(...candidates.map(candidate => Number(candidate.confidence) || 0))
}

function topCandidateHasRequiredVideoGoal(candidates, intent) {
  if (!requiresVerifiedVideoForHighConfidence(intent)) return true
  const topCandidate = getTopCandidate(candidates)
  if (!topCandidate) return false
  const details = topCandidate.confidenceDetails || {}
  if ((Number(details.videoEvidenceCount) || 0) <= 0) return false
  return !Array.isArray(details.resultMissingTargets) || details.resultMissingTargets.length === 0
}

function shouldCollectPlayableEvidence(candidates, intent) {
  if (!requiresVerifiedVideoForHighConfidence(intent)) return false
  const topCandidate = getTopCandidate(candidates)
  if (!topCandidate) return false
  const reason = String(topCandidate?.confidenceDetails?.intentPenaltyReason || '')
  const missingTargets = Array.isArray(topCandidate?.confidenceDetails?.missingTargets)
    ? topCandidate.confidenceDetails.missingTargets
    : []
  const resultMissingTargets = Array.isArray(topCandidate?.confidenceDetails?.resultMissingTargets)
    ? topCandidate.confidenceDetails.resultMissingTargets
    : []
  return (Number(topCandidate?.confidenceDetails?.videoEvidenceCount) || 0) === 0 ||
    reason.includes('缺少真实视频链接') ||
    reason.includes('缺少续作视频链接') ||
    reason.includes('缺少目标视频链接') ||
    missingTargets.length > 0 ||
    resultMissingTargets.length > 0
}

function getTopCandidate(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null
  return candidates.reduce((best, candidate) => {
    return (Number(candidate?.confidence) || 0) > (Number(best?.confidence) || 0) ? candidate : best
  }, candidates[0])
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, number))
}

function resolveTrustedSites(config, videoInfo) {
  const rules = normalizeTrustedSiteRules(config?.trustedSiteRules)
  const tags = collectVideoTags(videoInfo)
  const tagKeys = new Set([...tags].map(tag => tag.toLocaleLowerCase()))
  const sites = new Set(rules.sites)
  for (const binding of rules.tagBindings) {
    const bindingKey = String(binding.tag || '').trim().toLocaleLowerCase()
    if (tags.has(binding.tag) || tagKeys.has(bindingKey)) {
      for (const site of binding.sites) sites.add(site)
    }
  }
  return [...sites]
}

function collectVideoTags(videoInfo) {
  const tags = new Set()
  for (const list of [videoInfo?.tags, videoInfo?.customTags, videoInfo?.systemTags]) {
    if (!Array.isArray(list)) continue
    for (const value of list) {
      const tag = String(value || '').trim()
      if (tag) tags.add(tag)
    }
  }
  return tags
}

function getFeedbackHints(config, videoInfo, intent) {
  const memory = Array.isArray(config?.feedbackMemory) ? config.feedbackMemory : []
  const recentBad = memory
    .filter(entry => entry && Number(entry.rating) > 0 && Number(entry.rating) <= 2)
    .slice(0, 5)
  const keywords = []
  const items = []
  for (const entry of recentBad) {
    const issue = String(entry.issue || '')
    const relevant = !entry.searchIntent || entry.searchIntent === intent || issue
    if (!relevant) continue
    if (/视频|播放|链接|资料|百科|不相关|没找到/.test(issue) || Number(entry.videoEvidenceCount) === 0) {
      keywords.push('在线观看', '在线播放', '完整版', '立即播放', 'vodplay')
      if (intent === 'sequel') keywords.push('下一集', '第二集', '第二季')
      items.push(issue || '上次评分较低：优先补搜真实播放页')
    }
  }
  if (items.length === 0) return { keywords: [], items: [] }
  const title = String(videoInfo?.title || videoInfo?.fileName || '').trim()
  return {
    keywords: uniqueStrings(keywords),
    items: uniqueStrings([`当前视频: ${title}`, ...items]).slice(0, 6)
  }
}

function normalizeTrustedSiteRules(value) {
  if (typeof value === 'string') {
    try {
      return normalizeTrustedSiteRules(JSON.parse(value || '{}'))
    } catch (_) {
      return { sites: [], tagBindings: [] }
    }
  }
  const rules = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const sites = Array.isArray(rules.sites)
    ? [...new Set(rules.sites.map(site => browserModule.normalizeHost(site)).filter(Boolean))]
    : []
  const bindingMap = new Map()
  if (Array.isArray(rules.tagBindings)) {
    for (const binding of rules.tagBindings) {
      const tags = String(binding?.tag || '')
        .split(/[,，;；\n\r]+/)
        .map(tag => tag.trim())
        .filter(Boolean)
      const bindingSites = Array.isArray(binding?.sites)
        ? [...new Set(binding.sites.map(site => browserModule.normalizeHost(site)).filter(Boolean))]
        : []
      for (const tag of tags) {
        if (!bindingSites.length) continue
        const existingSites = bindingMap.get(tag) || []
        bindingMap.set(tag, [...new Set([...existingSites, ...bindingSites])])
      }
    }
  }
  const tagBindings = [...bindingMap.entries()]
    .map(([tag, bindingSites]) => ({ tag, sites: bindingSites }))
  return { sites, tagBindings }
}

function determineSourceProfile(videoInfo, cleanedTitle, keywords) {
  const text = [
    cleanedTitle,
    videoInfo?.fileName,
    videoInfo?.group,
    videoInfo?.description,
    ...collectVideoTags(videoInfo),
    ...(Array.isArray(keywords) ? keywords : [])
  ].join(' ').toLowerCase()

  if (/(动漫|动画|番剧|番组|二次元|新番|里番|anime|animation|pixiv|iwara|mmd|vocaloid|bangumi|myanimelist|anilist)/i.test(text)) {
    return 'anime'
  }
  return 'general'
}

function splitCandidateText(value) {
  return String(value || '')
    .split(/[|/\\,，;；\n\r]+/)
    .map(item => item.trim())
    .filter(Boolean)
}

function scoreTitleCandidate(value) {
  const normalized = normalizeSearchTitle(value)
  if (!normalized || isWeakSearchTitle(normalized)) return 0
  let score = 1
  if (/[\u4e00-\u9fa5]/.test(normalized)) score += 2
  if (/(第\s*[一二三四五六七八九十百千万\d]+\s*季|season\s*\d+|s\d{1,2})/i.test(normalized)) score += 2
  if (normalized.length >= 3 && normalized.length <= 30) score += 2
  if (normalized.length > 50) score -= 2
  if (/[:：]\s*(?:第?\d+|ep|episode|立即播放|在线播放)/i.test(normalized)) score -= 1
  return score
}

function chooseSearchTitle(videoInfo) {
  const primary = normalizeSearchTitle(videoInfo?.title || videoInfo?.fileName || '')
  if (!isWeakSearchTitle(primary)) return primary

  const candidates = []
  for (const item of splitCandidateText(videoInfo?.group)) candidates.push(item)
  for (const tag of collectVideoTags(videoInfo)) {
    for (const item of splitCandidateText(tag)) candidates.push(item)
  }
  for (const keyword of Array.isArray(videoInfo?.keywords) ? videoInfo.keywords : []) {
    for (const item of splitCandidateText(keyword)) candidates.push(item)
  }
  for (const item of splitCandidateText(videoInfo?.description)) candidates.push(item)

  const best = candidates
    .map(value => ({ value: normalizeSearchTitle(value), score: scoreTitleCandidate(value) }))
    .filter(item => item.value && item.score > 0)
    .sort((a, b) => b.score - a.score || a.value.length - b.value.length)[0]

  return best?.value || primary
}

const GENERIC_TITLE_TOKENS = new Set([
  'the',
  'and',
  'with',
  'season',
  'episode',
  'anime',
  'series',
  'movie',
  'journey',
  'end',
  's01e01'
])

function getTitleCoreTokens(title) {
  return String(title || '')
    .toLowerCase()
    .split(/[\s"'()\-_:：,，.。/\\[\]【】]+/)
    .map(token => token.trim())
    .filter(token => token.length >= 4 && !/^\d+$/.test(token) && !GENERIC_TITLE_TOKENS.has(token))
}

function filterEvidenceByTitle(evidence, cleanedTitle, options = {}) {
  const titleList = Array.isArray(cleanedTitle) ? cleanedTitle : [cleanedTitle]
  const tokens = uniqueStrings(titleList.flatMap(getTitleCoreTokens))
  if (!tokens.length) return evidence
  const targetRequirements = normalizeTargetRequirements(options.targetRequirements)
  return evidence.filter(item => {
    if (shouldKeepEvidenceByTarget(item, targetRequirements)) return true
    const text = [
      item.title,
      item.snippet,
      item.siteName,
      item.url
    ].join(' ').toLowerCase()
    return tokens.some(token => text.includes(token))
  })
}

function shouldKeepEvidenceByTarget(item, targetRequirements) {
  if (!isVideoEvidence(item) || targetRequirements.length === 0) return false
  return targetRequirements.some(target => {
    if (isExplicitEarlierSeasonEvidence(item, target)) return false
    return evidenceMatchesTarget(item, target, {})
  })
}

function deduplicateEvidenceByUrl(evidence) {
  const seenUrls = new Set()
  return evidence.filter((e) => {
    if (!e.url || seenUrls.has(e.url)) return false
    seenUrls.add(e.url)
    return true
  })
}

function classifyEvidence(evidence) {
  return evidence.map((e) => {
    const classification = browserModule.classifySource(e.url, e.siteName)
    if (e?.trusted && classification.level !== 'video') {
      return { ...e, sourceLevel: 'trusted', sourceScore: 0.95 }
    }
    return { ...e, sourceLevel: classification.level, sourceScore: classification.score }
  })
}

function hasEnoughEvidenceCoverage(evidence, options = {}) {
  if (evidence.length < 24) return false
  const counts = {}
  for (const item of classifyEvidence(evidence)) {
    counts[item.sourceLevel || 'low'] = (counts[item.sourceLevel || 'low'] || 0) + 1
  }
  const usefulCount = (counts.video || 0) + (counts.trusted || 0) + (counts.official || 0) + (counts.database || 0) + (counts.encyclopedia || 0) + (counts.news || 0)
  if (options.requireVideo && (counts.video || 0) < 1) return false
  return usefulCount >= 12 && ((counts.video || 0) >= 2 || (counts.trusted || 0) >= 4 || (counts.official || 0) >= 3) && ((counts.video || 0) + (counts.database || 0) + (counts.encyclopedia || 0) + (counts.trusted || 0) >= 2)
}

function getEvidenceSortScore(item) {
  let score = Number(item?.sourceScore) || 0
  const text = [
    item?.title,
    item?.url,
    item?.siteName
  ].join(' ').toLowerCase()
  if ((item?.bodyText || '').length > 500) score += 0.08
  if (item?.sourceLevel === 'video') score += 0.18
  if (/trusted|official|database|encyclopedia/.test(item?.sourceLevel || '')) score += 0.05
  if (/在线观看|在线播放|立即播放|免费观看|高清免费|完整版|正片|播放|watch online|full movie|full episode|vodplay|vod-play|voddetail|vod-detail/.test(text)) {
    score += 0.08
  }
  return score
}

function selectEvidenceForReasoning(evidence) {
  const limits = {
    video: 8,
    trusted: 12,
    official: 8,
    database: 6,
    encyclopedia: 4,
    news: 4,
    forum: 2,
    low: 4
  }
  const selected = []
  const counts = {}
  for (const item of evidence) {
    const level = item.sourceLevel || 'low'
    const limit = limits[level] ?? limits.low
    if ((counts[level] || 0) >= limit) continue
    selected.push(item)
    counts[level] = (counts[level] || 0) + 1
    if (selected.length >= 28) break
  }
  return selected
}

function buildEvidenceSummaryItems(evidence) {
  const labels = {
    video: '视频/播放页',
    trusted: '信任来源',
    official: '官方/平台',
    database: '资料库',
    encyclopedia: '百科/维基',
    news: '新闻',
    forum: '社区',
    low: '普通网页'
  }
  const counts = {}
  for (const item of evidence || []) {
    const level = item?.sourceLevel || 'low'
    counts[level] = (counts[level] || 0) + 1
  }
  return Object.entries(labels)
    .filter(([level]) => counts[level])
    .map(([level, label]) => `${label}: ${counts[level]} 条`)
}

function buildResultSummary(candidates, evidence) {
  const count = Array.isArray(candidates) ? candidates.length : 0
  const evidenceCount = Array.isArray(evidence) ? evidence.length : 0
  if (!count) return `没有生成候选结论，参考了 ${evidenceCount} 条精选证据`
  const top = candidates[0] || {}
  const pct = Math.round((Number(top.confidence) || 0) * 100)
  const title = top.candidateTitle || '未知作品'
  const videoCount = Number(top?.confidenceDetails?.videoEvidenceCount) || 0
  const missingTargets = Array.isArray(top?.confidenceDetails?.resultMissingTargets)
    ? top.confidenceDetails.resultMissingTargets
    : (Array.isArray(top?.confidenceDetails?.missingTargets) ? top.confidenceDetails.missingTargets : [])
  if (videoCount <= 0) {
    return `找到 ${count} 个候选结论。最可能是「${title}」，置信度 ${pct}%，但只找到资料线索，尚未找到真实视频/播放页。`
  }
  if (missingTargets.length > 0) {
    return `找到 ${count} 个候选结论。最可能是「${title}」，置信度 ${pct}%，但还缺少 ${missingTargets.join('、')} 的真实视频/播放页。`
  }
  return `找到 ${count} 个候选结论。最可能是「${title}」，置信度 ${pct}%，参考 ${evidenceCount} 条精选证据。`
}

function buildLlmCacheUsageItems(usage) {
  if (!usage || typeof usage !== 'object') return []
  const details = usage.prompt_tokens_details || usage.prompt_cache_details || {}
  const hit = Number(
    usage.prompt_cache_hit_tokens ??
    details.cached_tokens ??
    details.cache_hit_tokens
  )
  const miss = Number(
    usage.prompt_cache_miss_tokens ??
    details.cache_miss_tokens
  )
  const items = []
  if (Number.isFinite(hit)) items.push(`缓存命中 token: ${hit}`)
  if (Number.isFinite(miss)) items.push(`缓存未命中 token: ${miss}`)
  if (items.length === 0 && Number.isFinite(Number(usage.prompt_tokens))) {
    items.push(`提示词 token: ${usage.prompt_tokens}`)
  }
  return items
}

// --- Confidence computation ---

/**
 * Compute a weighted confidence score for a candidate.
 * @param {object} candidate - { candidateTitle, relationship, evidence, conflicts, reason }
 * @param {Array} evidence - classified evidence array with sourceScore
 * @param {string} [originalTitle] - cleaned original video title for similarity comparison
 * @returns {number} combined confidence score 0-1
 */
function computeConfidence(candidate, evidence, originalTitle, intent, options = {}) {
  const result = computeConfidenceResult(candidate, evidence, originalTitle, intent, options)
  return result.score
}

function computeConfidenceResult(candidate, evidence, originalTitle, intent, options = {}) {
  if (!candidate || typeof candidate !== 'object') {
    return { score: 0, details: buildConfidenceDetails() }
  }

  const evidenceList = Array.isArray(evidence) ? evidence : []
  const candidateTitle = candidate.candidateTitle || ''
  const candidateEvidence = Array.isArray(candidate.evidence) ? candidate.evidence : []

  const matchedEvidence = getCandidateMatchedEvidence(candidate, evidenceList)

  // 1. Source quality (0-1): prioritize evidence that actually supports the candidate.
  const qualityEvidence = matchedEvidence.length ? matchedEvidence : evidenceList
  const sourceQuality = qualityEvidence.length > 0
    ? qualityEvidence.reduce((sum, e) => sum + (e.sourceScore || 0.3), 0) / qualityEvidence.length
    : 0.3

  // 2. Multi-source consistency (0-1): count independent supporting hosts instead of
  // diluting the score by every selected evidence item.
  const matchedHosts = new Set(matchedEvidence
    .map(item => getUrlHost(item.url))
    .filter(Boolean))
  const matchedVideoEvidence = matchedEvidence.filter(isVideoEvidence)
  const supportingHosts = new Set([...matchedHosts])
  const multiSourceConsistency = Math.max(
    Math.min(supportingHosts.size / 3, 1),
    Math.min((matchedEvidence.length || candidateEvidence.length) / 5, 1)
  )

  // 3. Title similarity (0-1): compare candidate title with the cleaned original title
  const titleSimilarity = candidateTitle && originalTitle
    ? computeTitleSimilarity(candidateTitle, originalTitle)
    : 0.5

  // 4. Relationship keyword match (0-1)
  const relationshipKeywords = {
    sequel: ['sequel', '续集', '续作', 'second season', '第二季', 'season 2', 'next', '续篇'],
    prequel: ['prequel', '前传', '前作'],
    same_series: ['same series', '同系列', 'series', 'franchise'],
    spin_off: ['spin-off', 'spin off', '衍生', '外传', '番外']
  }

  const keywords = relationshipKeywords[candidate.relationship] || []
  const relationshipText = [
    candidateTitle,
    candidate.relationship,
    candidate.reason,
    ...candidateEvidence,
    ...matchedEvidence.map(item => `${item?.title || ''} ${item?.snippet || ''} ${item?.bodyText || ''}`)
  ].join(' ').toLowerCase()
  const keywordHits = keywords.filter(kw => {
    return relationshipText.includes(String(kw || '').toLowerCase())
  }).length
  let relationshipKeywordMatch = keywords.length > 0
    ? Math.min(keywordHits / keywords.length * 3, 1)
    : 0.5
  if (candidate.relationship === 'same_series' && titleSimilarity >= 0.85 && multiSourceConsistency >= 0.5) {
    relationshipKeywordMatch = Math.max(relationshipKeywordMatch, 0.75)
  }

  // Combined weighted score
  const weights = [0.28, 0.28, 0.28, 0.16]
  const scores = [sourceQuality, multiSourceConsistency, titleSimilarity, relationshipKeywordMatch]

  let combined = scores.reduce((sum, score, i) => sum + score * weights[i], 0)
  const conflicts = Array.isArray(candidate.conflicts) ? candidate.conflicts.filter(Boolean).length : 0
  if (conflicts === 0 && titleSimilarity >= 0.88 && multiSourceConsistency >= 0.5) combined += 0.08
  if (supportingHosts.size >= 3 && sourceQuality >= 0.7) combined += 0.04
  if (conflicts > 0) combined -= Math.min(conflicts * 0.08, 0.24)
  const targetRequirements = Array.isArray(options.targetRequirements) ? options.targetRequirements : []
  const targetCoverage = computeTargetCoverage(targetRequirements, matchedVideoEvidence, matchedEvidence, candidate)
  const intentPenalty = getIntentConfidencePenalty(candidate, matchedEvidence, intent, targetCoverage)
  combined -= intentPenalty.penalty

  // Leave a little uncertainty even for very strong web matches.
  const score = Math.max(0, Math.min(intentPenalty.maxScore, combined))
  return {
    score,
    details: buildConfidenceDetails({
      sourceQuality,
      multiSourceConsistency,
      titleSimilarity,
      relationshipKeywordMatch,
      supportingHosts,
      matchedEvidence,
      matchedVideoEvidence,
      targetCoverage,
      conflicts,
      adjustments: Math.max(-0.4, combined - scores.reduce((sum, scoreValue, i) => sum + scoreValue * weights[i], 0)),
      intentPenalty
    })
  }
}

function scoreCandidatesForTest(candidates, evidence, cleanedTitle, intent, targetRequirements) {
  const selectedEvidence = Array.isArray(evidence) ? evidence : []
  const scored = (Array.isArray(candidates) ? candidates : []).map((candidate) => {
    const candidateTargets = getCandidateTargetRequirements(candidate, targetRequirements)
    const sourceUrls = buildVerifiedCandidateSourceUrls(candidate, selectedEvidence, intent, candidateTargets)
    const candidateForScoring = { ...candidate, sourceUrls }
    const confidenceResult = computeConfidenceResult(candidateForScoring, selectedEvidence, cleanedTitle, intent, {
      targetRequirements: candidateTargets
    })
    return {
      ...candidateForScoring,
      confidence: confidenceResult.score,
      confidenceDetails: confidenceResult.details
    }
  })
  applyResultTargetCoverage(scored, selectedEvidence, intent, targetRequirements)
  return scored
}

const SEQUEL_SIGNAL_RE = /续集|续作|下一季|后续季|第二季|第2季|第三季|第3季|第四季|第4季|第二集|第2集|第2话|episode\s*2|ep\s*2|season\s*[2-9]|s0?[2-9]|sequel|next season|renewed|returning/i
const SEQUEL_TITLE_RE = /续集|续作|下一季|后续季|第二季|第2季|第三季|第3季|第四季|第4季|第二集|第2集|第2话|episode\s*2|ep\s*2|season\s*[2-9]|s0?[2-9]|sequel|next season/i

function getIntentConfidencePenalty(candidate, matchedEvidence, intent, targetCoverage = null) {
  const matchedVideoEvidence = matchedEvidence.filter(isVideoEvidence)
  const hasVideoEvidence = matchedVideoEvidence.length > 0
  const evidenceText = normalizeConfidenceText(matchedEvidence.map(getEvidenceClaimText).join(' '))

  if (intent === 'sequel') {
    const hasTargetVideoSignal = Array.isArray(targetCoverage?.matchedTargets) && targetCoverage.matchedTargets.length > 0
    const hasSequelSignal = hasTargetVideoSignal || SEQUEL_SIGNAL_RE.test(evidenceText)
    const candidateLooksLikeSequel = SEQUEL_TITLE_RE.test(normalizeConfidenceText(candidate?.candidateTitle))
    const relationship = String(candidate?.relationship || '').toLowerCase()
    if (relationship !== 'sequel') {
      return {
        penalty: hasSequelSignal && candidateLooksLikeSequel ? 0.2 : 0.35,
        maxScore: hasSequelSignal && candidateLooksLikeSequel ? 0.68 : 0.42,
        reason: hasSequelSignal && candidateLooksLikeSequel ? '续集任务但候选关系不是续集' : '候选不是续作'
      }
    }
    if (!hasSequelSignal) {
      return { penalty: 0.28, maxScore: 0.55, reason: '缺少续集证据' }
    }
    if (!hasVideoEvidence) {
      return { penalty: 0.24, maxScore: 0.64, reason: '缺少真实视频链接' }
    }
    if (targetCoverage?.missingTargets?.length) {
      const missingCount = targetCoverage.missingTargets.length
      const totalCount = targetCoverage.targets.length || missingCount
      const partialHit = targetCoverage.matchedTargets.length > 0
      return {
        penalty: partialHit ? Math.min(0.12 * missingCount, 0.28) : 0.28,
        maxScore: partialHit ? (totalCount > 1 ? 0.78 : 0.7) : 0.64,
        reason: `缺少目标视频链接: ${targetCoverage.missingTargets.join('、')}`
      }
    }
    if (targetCoverage?.targets?.length && targetCoverage.matchedTargets?.length === targetCoverage.targets.length) {
      return { penalty: 0, maxScore: 0.96, reason: '' }
    }
    if (!hasSequelVideoEvidence(candidate, matchedVideoEvidence, matchedEvidence)) {
      return { penalty: 0.24, maxScore: 0.64, reason: '缺少续作视频链接' }
    }
    return { penalty: 0, maxScore: 0.96, reason: '' }
  }

  if (intent === 'watch_order') {
    const hasOrderSignal = /观看顺序|时间线|顺序|先看|后看|watch order|timeline|chronological|release order|season guide/i.test(evidenceText)
    if (!hasOrderSignal) {
      return { penalty: 0.25, maxScore: 0.5, reason: '缺少观看顺序证据' }
    }
    if (!hasVideoEvidence) {
      return { penalty: 0.18, maxScore: 0.66, reason: '缺少真实视频链接' }
    }
    return { penalty: 0, maxScore: 0.96, reason: '' }
  }

  if (!hasVideoEvidence) {
    return { penalty: 0.16, maxScore: 0.68, reason: '缺少真实视频链接' }
  }
  return { penalty: 0, maxScore: 0.96, reason: '' }
}

function requiresVerifiedVideoForHighConfidence(intent) {
  return ['auto', 'sequel', 'same_series', 'watch_order'].includes(intent || 'auto')
}

function buildTargetRequirements(cleanedTitle, intent) {
  if (intent !== 'sequel') return []
  return getNextTargets(cleanedTitle)
    .filter(target => target && (target.type === 'episode' || target.type === 'season') && Number.isFinite(target.number))
    .map(target => ({
      type: target.type,
      number: target.number,
      label: formatTargetLabel(target)
    }))
    .filter(target => target.label)
}

function getCandidateTargetRequirements(candidate, targetRequirements) {
  const targets = normalizeTargetRequirements(targetRequirements)
  if (targets.length <= 1) return targets
  const candidateText = normalizeConfidenceText([
    candidate?.candidateTitle,
    candidate?.reason,
    ...(Array.isArray(candidate?.evidence) ? candidate.evidence : [])
  ].join(' '))
  const matchedTargets = targets.filter(target => targetTextMatchesTarget(candidateText, target))
  return matchedTargets.length > 0 ? matchedTargets : targets
}

function applyResultTargetCoverage(candidates, evidence, intent, targetRequirements) {
  if (intent !== 'sequel' || !Array.isArray(candidates) || candidates.length === 0) return
  const targets = normalizeTargetRequirements(targetRequirements)
  if (targets.length === 0) return
  const candidateUrls = new Set(candidates
    .flatMap(candidate => Array.isArray(candidate?.sourceUrls) ? candidate.sourceUrls : [])
    .map(normalizeEvidenceUrl)
    .filter(Boolean))
  const classifiedEvidence = classifyEvidence(Array.isArray(evidence) ? evidence : [])
  const videoEvidence = classifiedEvidence.filter(item => {
    if (!isVideoEvidence(item)) return false
    const url = normalizeEvidenceUrl(item?.url)
    return url && candidateUrls.has(url)
  })
  const coverage = computeTargetCoverage(targets, videoEvidence, classifiedEvidence, {})
  for (const candidate of candidates) {
    candidate.confidenceDetails = {
      ...(candidate.confidenceDetails || {}),
      resultTargetCount: coverage.targets.length,
      resultMatchedTargets: coverage.matchedTargets,
      resultMissingTargets: coverage.missingTargets
    }
  }
}

function formatTargetLabel(target) {
  if (!target || !Number.isFinite(Number(target.number))) return ''
  if (target.type === 'episode') return `第${target.number}集`
  if (target.type === 'season') return `第${target.number}季`
  return ''
}

function normalizeTargetRequirements(targetRequirements) {
  return Array.isArray(targetRequirements)
    ? targetRequirements
      .filter(target => target && (target.type === 'episode' || target.type === 'season') && Number.isFinite(Number(target.number)))
      .map(target => ({
        type: target.type,
        number: Number(target.number),
        label: target.label || formatTargetLabel(target)
      }))
      .filter(target => target.label)
    : []
}

function computeTargetCoverage(targetRequirements, matchedVideoEvidence, matchedEvidence, candidate) {
  const targets = normalizeTargetRequirements(targetRequirements)
  if (targets.length === 0) {
    return { targets: [], matchedTargets: [], missingTargets: [] }
  }
  const matchedTargets = []
  for (const target of targets) {
    const hasTargetVideo = matchedVideoEvidence.some(item => {
      if (isExplicitEarlierSeasonEvidence(item, target)) return false
      return evidenceMatchesTarget(item, target, candidate) && matchedEvidence.some(evidenceItem => {
        return normalizeEvidenceUrl(evidenceItem?.url) === normalizeEvidenceUrl(item?.url)
      })
    })
    if (hasTargetVideo) matchedTargets.push(target.label)
  }
  const matchedSet = new Set(matchedTargets)
  return {
    targets: targets.map(target => target.label),
    matchedTargets,
    missingTargets: targets.map(target => target.label).filter(label => !matchedSet.has(label))
  }
}

function hasSequelVideoEvidence(candidate, matchedVideoEvidence, matchedEvidence) {
  const sourceUrls = new Set((Array.isArray(candidate?.sourceUrls) ? candidate.sourceUrls : [])
    .map(normalizeEvidenceUrl)
    .filter(Boolean))
  return matchedVideoEvidence.some(item => {
    const itemUrl = normalizeEvidenceUrl(item?.url)
    if (!itemUrl) return false
    if (isExplicitEarlierSeasonEvidence(item)) return false
    if (isSequelEvidenceItem(candidate, item)) return true
    return sourceUrls.has(itemUrl) && matchedEvidence.some(evidenceItem => {
      return normalizeEvidenceUrl(evidenceItem?.url) === itemUrl
    })
  })
}

function isSequelEvidenceItem(candidate, item) {
  const candidateTitle = normalizeConfidenceText(candidate?.candidateTitle)
  const text = normalizeConfidenceText(getEvidenceClaimText(item))
  if (candidateTitle && text.includes(candidateTitle)) return true
  return SEQUEL_TITLE_RE.test(text)
}

function evidenceMatchesTarget(item, target, candidate) {
  const text = normalizeConfidenceText([
    getEvidenceClaimText(item),
    item?.url
  ].join(' '))
  return targetTextMatchesTarget(text, target)
}

function targetTextMatchesTarget(text, target) {
  const number = Number(target?.number)
  if (!Number.isFinite(number)) return false
  const zh = formatTargetLabel(target)
  if (zh && text.includes(normalizeConfidenceText(zh))) return true
  const zhNumber = numberToChineseText(number)
  if (zhNumber) {
    const zhLabel = target.type === 'episode' ? `第${zhNumber}集` : `第${zhNumber}季`
    if (text.includes(normalizeConfidenceText(zhLabel))) return true
  }
  if (target.type === 'episode') {
    const padded = String(number).padStart(2, '0')
    return new RegExp(`(?:第\\s*${number}\\s*[集话卷]|第\\s*${padded}\\s*[集话卷]|episode\\s*0?${number}\\b|ep\\s*0?${number}\\b|e0?${number}\\b)`, 'i').test(text)
  }
  if (target.type === 'season') {
    const padded = String(number).padStart(2, '0')
    return new RegExp(`(?:第\\s*${number}\\s*季|season\\s*0?${number}\\b|s0?${number}\\b|s${padded}\\b)`, 'i').test(text)
  }
  return false
}

function numberToChineseText(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0 || number > 99) return ''
  const digits = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九']
  if (number <= 10) return number === 10 ? '十' : digits[number]
  const tens = Math.floor(number / 10)
  const ones = number % 10
  if (tens === 1) return `十${ones ? digits[ones] : ''}`
  return `${digits[tens]}十${ones ? digits[ones] : ''}`
}

function isExplicitEarlierSeasonEvidence(item, target = null) {
  if (target?.type === 'episode') return false
  const text = normalizeConfidenceText(getEvidenceClaimText(item))
  return /第一季|第1季|season\s*1|s0?1/i.test(text) && !SEQUEL_TITLE_RE.test(text)
}

function getEvidenceClaimText(item) {
  return [
    item?.title,
    item?.snippet,
    item?.bodyText
  ].join(' ')
}

function buildVerifiedCandidateSourceUrls(candidate, evidence, intent, targetRequirements = []) {
  const evidenceList = Array.isArray(evidence) ? evidence : []
  const evidenceUrlMap = new Map()
  for (const item of evidenceList) {
    const normalized = normalizeEvidenceUrl(item?.url)
    if (normalized && !evidenceUrlMap.has(normalized)) {
      evidenceUrlMap.set(normalized, item.url)
    }
  }

  const verifiedCandidateUrls = uniqueNormalizedUrls((Array.isArray(candidate?.sourceUrls) ? candidate.sourceUrls : [])
    .map(url => evidenceUrlMap.get(normalizeEvidenceUrl(url)))
    .filter(Boolean))
  const candidateForMatching = { ...candidate, sourceUrls: verifiedCandidateUrls }
  const matchedEvidence = getCandidateMatchedEvidence(candidateForMatching, evidenceList)
  const videoUrls = matchedEvidence
    .filter(item => {
      if (!isVideoEvidence(item)) return false
      if (intent !== 'sequel') return true
      if (Array.isArray(targetRequirements) && targetRequirements.length > 0) {
        return targetRequirements.some(target => evidenceMatchesTarget(item, target, candidate))
      }
      return hasSequelVideoEvidence(candidate, [item], matchedEvidence)
    })
    .map(item => item.url)
  const supportingUrls = matchedEvidence
    .filter(item => ['trusted', 'official', 'database', 'encyclopedia', 'news'].includes(item?.sourceLevel || 'low'))
    .map(item => item.url)
  const verifiedNonVideoUrls = verifiedCandidateUrls.filter(url => {
    const item = evidenceList.find(e => normalizeEvidenceUrl(e?.url) === normalizeEvidenceUrl(url))
    return item && !isVideoEvidence(item)
  })
  const limit = intent === 'sequel' || intent === 'watch_order' ? 8 : 6
  return uniqueNormalizedUrls([
    ...videoUrls,
    ...verifiedNonVideoUrls,
    ...supportingUrls
  ]).slice(0, limit)
}

function uniqueNormalizedUrls(urls) {
  const seen = new Set()
  const result = []
  for (const url of urls) {
    const normalized = normalizeEvidenceUrl(url)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(url)
  }
  return result
}

function buildConfidenceDetails(details = {}) {
  const supportingHosts = details.supportingHosts instanceof Set ? [...details.supportingHosts] : []
  const intentPenalty = details.intentPenalty && typeof details.intentPenalty === 'object'
    ? details.intentPenalty
    : {}
  return {
    sourceQuality: roundConfidencePart(details.sourceQuality),
    multiSourceConsistency: roundConfidencePart(details.multiSourceConsistency),
    titleSimilarity: roundConfidencePart(details.titleSimilarity),
    relationshipMatch: roundConfidencePart(details.relationshipKeywordMatch),
    supportingSourceCount: supportingHosts.length,
    supportingSources: supportingHosts.slice(0, 6),
    matchedEvidenceCount: Array.isArray(details.matchedEvidence) ? details.matchedEvidence.length : 0,
    videoEvidenceCount: Array.isArray(details.matchedVideoEvidence) ? details.matchedVideoEvidence.length : 0,
    targetCount: Array.isArray(details.targetCoverage?.targets) ? details.targetCoverage.targets.length : 0,
    matchedTargets: Array.isArray(details.targetCoverage?.matchedTargets) ? details.targetCoverage.matchedTargets : [],
    missingTargets: Array.isArray(details.targetCoverage?.missingTargets) ? details.targetCoverage.missingTargets : [],
    conflictCount: Number(details.conflicts) || 0,
    adjustment: roundConfidencePart(details.adjustments || 0),
    intentPenalty: roundConfidencePart(intentPenalty.penalty || 0),
    intentMaxScore: roundConfidencePart(intentPenalty.maxScore || 0.96),
    intentPenaltyReason: intentPenalty.reason || ''
  }
}

function isVideoEvidence(item) {
  if (!item) return false
  if (item.sourceLevel === 'video') return true
  return typeof browserModule.isVideoPageUrl === 'function' && browserModule.isVideoPageUrl(item.url)
}

function roundConfidencePart(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.round(number * 100) / 100
}

function getCandidateMatchedEvidence(candidate, evidence) {
  const title = normalizeConfidenceText(candidate?.candidateTitle)
  const sourceUrls = new Set((Array.isArray(candidate?.sourceUrls) ? candidate.sourceUrls : [])
    .map(normalizeEvidenceUrl)
    .filter(Boolean))
  const evidenceClaims = Array.isArray(candidate?.evidence)
    ? candidate.evidence.map(normalizeConfidenceText).filter(Boolean)
    : []
  return evidence.filter(item => {
    const itemUrl = normalizeEvidenceUrl(item?.url)
    if (itemUrl && sourceUrls.has(itemUrl)) return true
    const text = normalizeConfidenceText([
      item?.title,
      item?.snippet,
      item?.bodyText,
      item?.url
    ].join(' '))
    if (title && text.includes(title)) return true
    return evidenceClaims.some(claim => claim.length >= 4 && text.includes(claim))
  })
}

function computeTitleSimilarity(candidateTitle, originalTitle) {
  const candidate = normalizeConfidenceText(candidateTitle)
  const original = normalizeConfidenceText(originalTitle)
  if (!candidate || !original) return 0
  const dice = _stringSimilarity(candidate, original)
  if (candidate === original) return 1
  if (candidate.length >= 4 && original.includes(candidate)) return Math.max(dice, 0.92)
  if (original.length >= 4 && candidate.includes(original)) return Math.max(dice, 0.88)
  return dice
}

function normalizeConfidenceText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[《》「」『』"'“”‘’()[\]【】:_\-.,，。:：/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function getUrlHost(value) {
  try {
    const url = new URL(String(value || ''))
    return url.hostname.replace(/^www\./, '').toLowerCase()
  } catch (_) {
    return ''
  }
}

function normalizeEvidenceUrl(value) {
  try {
    const url = new URL(String(value || ''))
    url.hash = ''
    normalizeEvidenceSearchParams(url)
    url.hostname = url.hostname.replace(/^www\./, '').toLowerCase()
    url.pathname = url.pathname.replace(/\/+$/, '')
    return url.toString()
  } catch (_) {
    return ''
  }
}

const TRACKING_QUERY_PARAM_RE = /^(?:utm_|spm|from|source|ref|ref_|fbclid|gclid|yclid|mc_|igshid|share|share_source|feature|si$)/i
const IDENTITY_QUERY_PARAMS = new Set([
  'v',
  'id',
  'aid',
  'bvid',
  'cid',
  'sid',
  'season_id',
  'ep_id',
  'episode_id',
  'page',
  'p',
  'list',
  'playlist',
  'vid',
  'video',
  'video_id',
  'ep',
  'episode'
])

function normalizeEvidenceSearchParams(url) {
  const kept = []
  for (const [key, value] of url.searchParams.entries()) {
    const normalizedKey = key.toLowerCase()
    if (!value) continue
    if (TRACKING_QUERY_PARAM_RE.test(normalizedKey)) continue
    if (IDENTITY_QUERY_PARAMS.has(normalizedKey) || isKnownIdentityQuery(url.hostname, normalizedKey)) {
      kept.push([normalizedKey, value])
    }
  }
  kept.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
  url.search = ''
  for (const [key, value] of kept) {
    url.searchParams.append(key, value)
  }
}

function isKnownIdentityQuery(hostname, key) {
  const host = String(hostname || '').replace(/^www\./, '').toLowerCase()
  if (host.endsWith('youtube.com')) return key === 'v' || key === 'list'
  if (host.endsWith('bilibili.com')) return key === 'aid' || key === 'bvid' || key === 'cid' || key === 'p'
  if (host.endsWith('iqiyi.com')) return key === 'vfrm' || key === 'vfrmblk' || key === 'vfrmrst'
  return false
}

/**
 * Simple string similarity (Dice coefficient on bigrams).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function _stringSimilarity(a, b) {
  if (!a || !b) return 0
  if (a === b) return 1

  const bigrams = new Map()
  for (let i = 0; i < a.length - 1; i++) {
    const bigram = a.substring(i, i + 2)
    bigrams.set(bigram, (bigrams.get(bigram) || 0) + 1)
  }

  let intersectionSize = 0
  for (let i = 0; i < b.length - 1; i++) {
    const bigram = b.substring(i, i + 2)
    const count = bigrams.get(bigram) || 0
    if (count > 0) {
      bigrams.set(bigram, count - 1)
      intersectionSize++
    }
  }

  return (2.0 * intersectionSize) / (Math.max(a.length - 1, 1) + Math.max(b.length - 1, 1))
}

module.exports = {
  createSearchTask,
  cancelSearchTask,
  cancelAllTasks,
  setEventEmitter,
  buildPlayableSearchQueries,
  computeConfidence,
  computeConfidenceResult,
  scoreCandidatesForTest
}
