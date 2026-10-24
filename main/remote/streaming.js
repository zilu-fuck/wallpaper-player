const { pipeline } = require('stream/promises')
const fsp = require('fs/promises')
const path = require('path')
const { acquireRemoteStream } = require('../media-pressure')
const activeStreams = new Set()

function trackNetworkStream(owner, controller) {
  let settle, done = false
  const record = { owner, controller, settled: new Promise(resolve => { settle = resolve }) }
  activeStreams.add(record)
  return () => { if (!done) { done = true; activeStreams.delete(record); settle() } }
}

const STREAM_HIGH_WATER_MARK = 1024 * 1024

const VIDEO_CONTENT_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.ts': 'video/mp2t',
  '.ogv': 'video/ogg'
}

const IMAGE_CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp'
}

function parseRange(range, total) {
  const match = String(range).split(',')[0].trim().match(/^bytes=(\d*)-(\d*)$/)
  if (!match || (!match[1] && !match[2])) return null
  const totalBytes = BigInt(total)
  let start, end
  if (!match[1]) {
    const suffix = BigInt(match[2]); if (suffix === 0n) return null
    start = suffix < totalBytes ? totalBytes - suffix : 0n; end = totalBytes - 1n
  } else {
    start = BigInt(match[1]); end = match[2] ? BigInt(match[2]) : totalBytes - 1n
    if (end >= totalBytes) end = totalBytes - 1n
  }
  if (start > end || start >= totalBytes) return null
  return { start: Number(start), end: Number(end) }
}

async function streamFileWithRange(req, res, filePath, contentType, sendError, notFoundMessage = '文件不存在', options = {}) {
  const controller = new AbortController()
  const closeResponse = () => { if (!res.writableFinished && !res.destroyed) res.destroy() }
  controller.signal.addEventListener('abort', closeResponse, { once: true })
  const abort = () => controller.abort()
  const responseClosed = () => { if (!res.writableFinished) abort() }
  req.once('aborted', abort); res.once('close', responseClosed)
  let settle
  const record = { controller, owner: options.owner, filePath, settled: new Promise(resolve => { settle = resolve }) }
  activeStreams.add(record)
  let handle, readable, releasePressure
  try {
    if (req.aborted || res.destroyed) return
    handle = await fsp.open(filePath, 'r')
    if (controller.signal.aborted || res.destroyed) return
    const stat = await handle.stat()
    if (options.beforeHeaders) await options.beforeHeaders({ handle, stat })
    if (controller.signal.aborted || res.destroyed || res.writableEnded) return
    if (!stat.isFile()) { sendError(req, res, 404, 'file_not_found', notFoundMessage); return }
    const total = stat.size
    if (!Number.isSafeInteger(total) || total < 0) throw new Error('invalid_file_size')
    const range = !options.ignoreRange && typeof req.headers.range === 'string' ? parseRange(req.headers.range, total) : undefined
    if (range === null) { res.writeHead(416, { 'Content-Range': 'bytes */' + total }); res.end(); return }
    const extraHeaders = options.headers?.(stat) || {}
    if (extraHeaders.ETag && req.headers['if-none-match'] === extraHeaders.ETag) {
      res.writeHead(304, extraHeaders); res.end(); return
    }
    const headers = { 'Content-Type': contentType, 'Content-Length': range ? range.end - range.start + 1 : total,
      'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      ...(range ? { 'Content-Range': 'bytes ' + range.start + '-' + range.end + '/' + total } : {}), ...extraHeaders }
    res.writeHead(range ? 206 : 200, headers)
    if (req.method === 'HEAD' || total === 0) { res.end(); return }
    readable = handle.createReadStream({ ...(range || {}), highWaterMark: options.highWaterMark || STREAM_HIGH_WATER_MARK, autoClose: false })
    if (options.playback || String(contentType).startsWith('video/')) releasePressure = acquireRemoteStream()
    await pipeline(readable, res, { signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted || req.aborted || res.destroyed || error.code === 'ERR_STREAM_PREMATURE_CLOSE') return
    if (res.headersSent) res.destroy()
    else if (error.status >= 400 && error.status < 500) sendError(req, res, error.status, error.code || 'file_not_found', notFoundMessage)
    else if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) sendError(req, res, 404, 'file_not_found', notFoundMessage)
    else sendError(req, res, 500, 'file_read_failed', '无法读取媒体文件')
  } finally {
    if (readable) {
      const closed = readable.closed ? Promise.resolve() : new Promise(resolve => readable.once('close', resolve))
      readable.destroy(); await closed
    }
    if (handle && handle.fd !== -1) await handle.close().catch(() => {})
    activeStreams.delete(record); settle()
    releasePressure?.()
    controller.signal.removeEventListener('abort', closeResponse)
    req.off('aborted', abort); res.off('close', responseClosed)
  }
}

function getImageContentType(filePath) {
  return IMAGE_CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
}

function getVideoContentType(filePath) {
  return VIDEO_CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
}

module.exports = {
  IMAGE_CONTENT_TYPES,
  VIDEO_CONTENT_TYPES,
  STREAM_HIGH_WATER_MARK,
  getImageContentType,
  getVideoContentType,
  streamFileWithRange,
  trackNetworkStream,
  getStreamDiagnostics: () => ({ active: activeStreams.size }),
  getActiveFilePaths: () => [...activeStreams].map(stream => stream.filePath).filter(Boolean),
  closeActiveFileStreams: owner => { for (const stream of activeStreams) if (!owner || stream.owner === owner) stream.controller.abort() },
  waitForFileStreams: async owner => {
    while (true) {
      const streams = [...activeStreams].filter(stream => !owner || stream.owner === owner)
      if (!streams.length) return
      await Promise.all(streams.map(stream => stream.settled))
    }
  }
}
