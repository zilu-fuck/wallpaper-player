'use strict'

const { BrowserWindow } = require('electron')
const { createSearchTask, cancelSearchTask, cancelAllTasks, setEventEmitter } = require('./search-engine')

const MAX_FEEDBACK_MEMORY = 30

function emitAiSearchEvent(payload) {
  const safe = typeof payload === 'object' && payload !== null ? payload : { type: 'unknown' }
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed() && win.webContents) {
        win.webContents.send('ai-search-event', safe)
      }
    } catch (_) {
      // window was destroyed during iteration
    }
  }
}

function registerAiSearchIpc(ctx) {
  setEventEmitter(emitAiSearchEvent)
  ctx.ipc.handle('ai-search-start', async (_event, videoInfo) => {
    try {
      // 防御：preload 永久暴露 IPC，禁用后不应再执行搜索
      if (typeof ctx.isEnabled === 'function' && !ctx.isEnabled()) {
        return { success: false, error: 'AI 搜索插件未启用' }
      }
      if (!videoInfo || typeof videoInfo !== 'object') {
        return { success: false, error: 'videoInfo must be a non-null object' }
      }
      const hasTitle = typeof videoInfo.title === 'string' && videoInfo.title.trim()
      const hasFileName = typeof videoInfo.fileName === 'string' && videoInfo.fileName.trim()
      if (!hasTitle && !hasFileName) {
        return { success: false, error: 'videoInfo.title or videoInfo.fileName is required' }
      }
      if (!videoInfo.filePath || typeof videoInfo.filePath !== 'string') {
        return { success: false, error: 'videoInfo.filePath is required and must be a string' }
      }

      const config = ctx.plugins.getConfig()
      const { taskId } = createSearchTask(videoInfo, config)
      return { success: true, taskId }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ctx.ipc.handle('ai-search-cancel', async (_event, taskId) => {
    try {
      if (typeof ctx.isEnabled === 'function' && !ctx.isEnabled()) {
        return { success: false, error: 'AI 搜索插件未启用' }
      }
      if (!taskId || typeof taskId !== 'string') {
        return { success: false, error: 'taskId is required and must be a string' }
      }
      cancelSearchTask(taskId)
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ctx.ipc.handle('ai-search-feedback', async (_event, feedback) => {
    try {
      if (typeof ctx.isEnabled === 'function' && !ctx.isEnabled()) {
        return { success: false, error: 'AI 搜索插件未启用' }
      }
      if (!feedback || typeof feedback !== 'object' || Array.isArray(feedback)) {
        return { success: false, error: 'feedback must be a non-null object' }
      }

      const config = ctx.plugins.getConfig()
      const memory = Array.isArray(config.feedbackMemory) ? config.feedbackMemory : []
      const entry = normalizeFeedbackEntry(feedback)
      const entryKey = getFeedbackMemoryKey(entry)
      const keptMemory = memory.filter(item => getFeedbackMemoryKey(item) !== entryKey)
      const nextConfig = {
        ...config,
        feedbackMemory: [entry, ...keptMemory].slice(0, MAX_FEEDBACK_MEMORY)
      }
      const savedConfig = ctx.plugins.saveConfig(nextConfig)
      return {
        success: true,
        feedbackMemory: Array.isArray(savedConfig.feedbackMemory) ? savedConfig.feedbackMemory : nextConfig.feedbackMemory
      }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ctx.lifecycle.onDispose(() => {
    cancelAllTasks()
  })
}

function normalizeFeedbackEntry(feedback) {
  const rating = Math.max(1, Math.min(5, Number(feedback.rating) || 1))
  return {
    rating,
    ok: rating >= 4,
    videoTitle: String(feedback.videoTitle || '').slice(0, 160),
    searchIntent: String(feedback.searchIntent || '').slice(0, 40),
    candidateTitle: String(feedback.candidateTitle || '').slice(0, 160),
    issue: String(feedback.issue || '').slice(0, 240),
    topSourceUrls: Array.isArray(feedback.topSourceUrls)
      ? feedback.topSourceUrls.map(url => String(url || '').slice(0, 500)).filter(Boolean).slice(0, 6)
      : [],
    videoEvidenceCount: Math.max(0, Number(feedback.videoEvidenceCount) || 0),
    createdAt: new Date().toISOString()
  }
}

function getFeedbackMemoryKey(entry) {
  return [
    entry?.videoTitle,
    entry?.searchIntent,
    entry?.candidateTitle
  ].map(value => String(value || '').trim().toLocaleLowerCase()).join('|')
}

module.exports = {
  registerAiSearchIpc,
  emitAiSearchEvent
}
