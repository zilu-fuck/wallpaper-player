const { EventEmitter } = require('events')
const fsp = require('fs/promises')
const path = require('path')
const { isPathInside, pathKey } = require('../paths')
const {
  getAllowedVideoDirectories,
  isSessionAllowedFile,
  getMediaAccessSettings,
  resolvePathForAccess,
  sessionPrivateDirectories,
  sessionAllowedDirectories
} = require('../settings')

const unlockedSenders = new Set()
const trackedSenders = new WeakSet()
const senderGenerations = new WeakMap()
const privacyEvents = new EventEmitter()

function getDesktopSenderId() {
  return require('../window').getMainWindow()?.webContents?.id
}

function onPrivacyStateChanged(listener) {
  privacyEvents.on('change', listener)
  return () => privacyEvents.off('change', listener)
}

function lockDesktopPrivacy(sender) {
  if (sender) senderGenerations.set(sender, (senderGenerations.get(sender) || 0) + 1)
  unlockedSenders.delete(sender?.id)
  privacyEvents.emit('change', { sender, unlocked: false })
}

function captureDesktopPrivacyRequest(sender) {
  if (!sender || !Number.isInteger(sender.id) || sender.isDestroyed?.()) throw new Error('隐私操作所属窗口已关闭')
  if (!trackedSenders.has(sender)) {
    trackedSenders.add(sender)
    if (!senderGenerations.has(sender)) senderGenerations.set(sender, 0)
    sender.once?.('destroyed', () => lockDesktopPrivacy(sender))
    sender.on?.('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) lockDesktopPrivacy(sender)
    })
    sender.on?.('render-process-gone', () => lockDesktopPrivacy(sender))
  }
  const generation = senderGenerations.get(sender)
  return () => {
    if (sender.isDestroyed?.() || senderGenerations.get(sender) !== generation) throw new Error('隐私操作已因锁定或页面变化取消，请重试')
  }
}

function unlockDesktopPrivacy(sender) {
  if (!sender || !Number.isInteger(sender.id) || sender.isDestroyed?.()) return
  captureDesktopPrivacyRequest(sender)
  unlockedSenders.add(sender.id)
  privacyEvents.emit('change', { sender, unlocked: true })
}

class MediaAccessPolicy {
  constructor({ audience = 'desktop', senderId = getDesktopSenderId(), resolvedRoots } = {}) {
    const settings = resolvedRoots?.private ? null : getMediaAccessSettings()
    this.audience = audience
    this.allowedDirectories = resolvedRoots?.allowed || getAllowedVideoDirectories()
    this.privateDirectories = resolvedRoots?.private || [...new Set([
      ...(settings.privateDirectories || []),
      ...sessionPrivateDirectories
    ].map(resolvePathForAccess))]
    this.privateUnlocked = audience === 'desktop' && unlockedSenders.has(senderId)
  }

  isPrivatePath(inputPath) {
    if (this.privateDirectories.length === 0) return false
    const resolved = resolvePathForAccess(inputPath)
    return this.isPrivateResolvedPath(resolved)
  }

  isPrivateResolvedPath(resolved) {
    return this.privateDirectories.some(directory => isPathInside(directory, resolved))
  }

  canReadPath(inputPath, { allowSessionFile = true } = {}) {
    const resolved = resolvePathForAccess(inputPath)
    return this.canReadResolvedPath(resolved, allowSessionFile)
  }

  canReadResolvedPath(resolved, allowSessionFile) {
    const allowed = this.allowedDirectories.some(directory => isPathInside(directory, resolved)) ||
      (this.audience === 'desktop' && allowSessionFile && isSessionAllowedFile(resolved))
    return allowed && (!this.isPrivateResolvedPath(resolved) || this.privateUnlocked)
  }

  canScanPath(inputPath, rootPath) {
    return Boolean(this.resolveScanPath(inputPath, rootPath))
  }

  resolveScanPath(inputPath, rootPath) {
    const resolved = resolvePathForAccess(inputPath)
    const root = this.privateUnlocked && this.isPrivateResolvedPath(resolved) ? resolvePathForAccess(rootPath) : rootPath
    return this.resolveScanResolvedPath(resolved, root)
  }

  resolveScanResolvedPath(resolved, root) {
    if (!this.canReadResolvedPath(resolved, false)) return null
    // 解锁只能通过明确进入隐私目录查看，公开父目录始终保持公开视图。
    return !this.isPrivateResolvedPath(resolved) || (this.privateUnlocked && this.isPrivateResolvedPath(root)) ? resolved : null
  }

  assertReadPath(inputPath, options) {
    const resolved = resolvePathForAccess(inputPath)
    return this.assertReadResolvedPath(resolved, options)
  }

  assertReadResolvedPath(resolved, options) {
    if (!this.canReadResolvedPath(resolved, options?.allowSessionFile !== false)) {
      const remote = this.audience !== 'desktop'
      throw Object.assign(new Error(remote
        ? '视频不存在或无权访问'
        : this.isPrivateResolvedPath(resolved) ? '请先解锁隐私目录' : '文件不在已添加的视频目录中'), {
        status: remote ? 404 : 403,
        code: remote ? 'video_not_found' : 'media_access_denied'
      })
    }
    return resolved
  }

  scanSignature(rootPath) {
    return this.scanResolvedSignature(this.privateUnlocked ? resolvePathForAccess(rootPath) : rootPath)
  }

  scanResolvedSignature(root) {
    return JSON.stringify([
      this.allowedDirectories.map(pathKey).sort(),
      this.privateDirectories.map(pathKey).sort(),
      this.privateUnlocked && this.isPrivateResolvedPath(root)
    ])
  }
}

async function createMediaAccessPolicyAsync(options = {}) {
  const check = () => { options.throwIfAborted?.(); if (options.signal?.aborted) throw options.signal.reason }
  const capture = () => {
    const settings = getMediaAccessSettings()
    return { allowed: [...settings.directories, ...sessionAllowedDirectories], private: [...settings.privateDirectories, ...sessionPrivateDirectories] }
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    check()
    const roots = capture(), paths = [...new Set([...roots.allowed, ...roots.private])], resolved = new Map()
    let next = 0
    const results = await Promise.allSettled(Array.from({ length: Math.min(8, paths.length) }, async () => {
      while (next < paths.length) {
        check(); const entry = paths[next++]
        const canonical = await fsp.realpath(path.resolve(entry)).catch(() => path.resolve(entry))
        check(); resolved.set(entry, canonical)
      }
    }))
    check()
    const failed = results.find(result => result.status === 'rejected')
    if (failed) throw failed.reason
    if (JSON.stringify(roots) !== JSON.stringify(capture())) continue
    return new MediaAccessPolicy({ ...options, resolvedRoots: { allowed: roots.allowed.map(entry => resolved.get(entry)), private: roots.private.map(entry => resolved.get(entry)) } })
  }
  throw Object.assign(new Error('媒体权限正在改变，请重试'), { code: 'media_policy_changed', status: 409 })
}

function createMediaAccessPolicy(options) {
  return new MediaAccessPolicy(options)
}

module.exports = {
  MediaAccessPolicy,
  createMediaAccessPolicy,
  createMediaAccessPolicyAsync,
  captureDesktopPrivacyRequest,
  lockDesktopPrivacy,
  onPrivacyStateChanged,
  unlockDesktopPrivacy
}
