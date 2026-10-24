const http = require('http'), https = require('https'), fs = require('fs'), fsp = require('fs/promises'), path = require('path'), crypto = require('crypto')
const { pipeline } = require('stream/promises')
const { mediaScheduler } = require('./resource-scheduler')
const { getMediaPressure } = require('../media-pressure')

const DEFAULT_DEADLINE_MS = 24 * 60 * 60 * 1000
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024 * 1024
const delay = (ms, signal) => new Promise((resolve, reject) => {
  const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason) }
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
})
const closed = stream => !stream || stream.closed ? Promise.resolve() : new Promise(resolve => stream.once('close', resolve))

function downloadArtifact(url, targetPath, options = {}) {
  if (!path.isAbsolute(targetPath)) return Promise.reject(new Error('下载保存位置无效'))
  const initial = new URL(url)
  if (!['http:', 'https:'].includes(initial.protocol)) return Promise.reject(new Error('下载地址必须是 HTTP 或 HTTPS'))
  return (options.scheduler || mediaScheduler).enqueue({ key: options.key, type: options.type || 'download-file', resources: { transfer: 1 },
    priority: 10, timeoutMs: options.timeoutMs || DEFAULT_DEADLINE_MS, signal: options.signal }, async context => {
    let request, response, file, headersTimer, headerError, ownsFile = false, redirectCount = 0, received = 0, total = 0
    const abort = () => { request?.destroy(context.signal.reason); response?.destroy(context.signal.reason); file?.destroy(context.signal.reason) }
    const clearUpstream = async () => {
      const pending = [closed(request), closed(response)]
      if (response && !response.closed) response.destroy()
      if (request && !request.closed) request.destroy()
      await Promise.all(pending); request = null; response = null
    }
    context.signal.addEventListener('abort', abort, { once: true })
    const maxBytes = options.maxBytes || MAX_DOWNLOAD_BYTES
    try {
      let current = initial
      headersTimer = setTimeout(() => { headerError = new Error('下载连接等待超时'); request?.destroy(headerError); response?.destroy(headerError) }, options.headersTimeoutMs || 30000)
      headersTimer.unref?.()
      while (true) {
        context.throwIfAborted()
        if (headerError) throw headerError
        response = await new Promise((resolve, reject) => {
          const headers = options.token && current.origin === initial.origin ? { Authorization: 'Bearer ' + options.token } : {}
          const upstream = (current.protocol === 'https:' ? https : http).get(current, { headers, signal: context.signal,
            timeout: options.idleTimeoutMs || 30000, highWaterMark: 256 * 1024 }, incoming => {
            incoming.on('error', () => {}); resolve(incoming)
          })
          request = upstream
          upstream.once('timeout', () => upstream.destroy(new Error('下载读取超时')))
          upstream.on('error', reject)
        })
        if (headerError) throw headerError
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          if (++redirectCount > (options.maxRedirects || 5)) throw new Error('下载重定向次数过多')
          const next = new URL(response.headers.location, current)
          if (!['http:', 'https:'].includes(next.protocol) || (current.protocol === 'https:' && next.protocol !== 'https:')) throw new Error('下载重定向地址不安全')
          await clearUpstream(); current = next; continue
        }
        if (response.statusCode !== 200) throw new Error('下载失败：HTTP ' + response.statusCode)
        clearTimeout(headersTimer)
        total = Number(response.headers['content-length']) || 0
        if (total > maxBytes) throw new Error('下载文件超过大小上限')
        await fsp.mkdir(path.dirname(targetPath), { recursive: true })
        context.throwIfAborted()
        file = fs.createWriteStream(targetPath, { flags: 'wx' })
        file.once('open', () => { ownsFile = true })
        let nextProgressAt = 0, rateWindow = Date.now(), rateBytes = 0
        const body = async function* () {
          for await (const chunk of response) {
            context.throwIfAborted(); received += chunk.length
            if (received > maxBytes) throw new Error('下载文件超过大小上限')
            if (getMediaPressure().active) {
              rateBytes += chunk.length
              const due = rateWindow + rateBytes / (options.playbackBytesPerSecond || 1024 * 1024) * 1000
              while (due > Date.now() && getMediaPressure().active) await delay(Math.min(250, due - Date.now()), context.signal)
              if (Date.now() - rateWindow > 1000) { rateWindow = Date.now(); rateBytes = 0 }
            } else { rateWindow = Date.now(); rateBytes = 0 }
            if (Date.now() >= nextProgressAt) { options.onProgress?.({ transferred: received, total }); nextProgressAt = Date.now() + 200 }
            yield chunk
          }
        }
        await pipeline(body(), file, { signal: context.signal })
        context.throwIfAborted()
        if (!received || (total && total !== received)) throw new Error('下载文件不完整')
        await options.validate?.(targetPath)
        context.throwIfAborted()
        options.onProgress?.({ transferred: received, total: total || received })
        return { path: targetPath, bytes: received }
      }
    } catch (error) {
      if (file && !file.closed) { const finished = closed(file); file.destroy(); await finished }
      if (ownsFile) await fsp.unlink(targetPath).catch(() => {})
      throw error
    } finally {
      clearTimeout(headersTimer); context.signal.removeEventListener('abort', abort)
      await clearUpstream()
    }
  })
}

async function publishArtifact(temporary, target, check, onCommitted = () => {}) {
  const backup = target + '.' + crypto.randomUUID() + '.backup'
  let backedUp = false, published = false, committed = false
  try {
    check()
    try { await fsp.rename(target, backup); backedUp = true } catch (error) { if (error.code !== 'ENOENT') throw error }
    check(); await fsp.rename(temporary, target); published = true; check()
    committed = true; onCommitted()
  } catch (error) {
    if (published) await fsp.unlink(target).catch(() => {})
    if (backedUp) { await fsp.rename(backup, target); backedUp = false }
    throw error
  } finally { if (backedUp && committed) await fsp.unlink(backup).catch(() => {}) }
}
module.exports = { downloadArtifact, publishArtifact }
