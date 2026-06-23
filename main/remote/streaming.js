const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')

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

async function streamFileWithRange(req, res, filePath, contentType, sendError, notFoundMessage = '文件不存在') {
  const stat = await fsp.stat(filePath)
  if (!stat.isFile()) {
    sendError(req, res, 404, 'file_not_found', notFoundMessage)
    return
  }
  const total = stat.size
  const range = req.headers.range

  if (typeof range === 'string') {
    const requestedRange = range.replace(/^bytes=/, '').split(',')[0]?.trim() || ''
    const match = requestedRange.match(/^(\d*)-(\d*)$/)
    if (!match) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` })
      res.end()
      return
    }

    let start
    let end
    if (!match[1] && match[2]) {
      const suffixLength = Number(match[2])
      start = Math.max(total - suffixLength, 0)
      end = total - 1
    } else {
      start = match[1] ? Number(match[1]) : 0
      end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` })
      res.end()
      return
    }

    res.writeHead(206, {
      'Content-Type': contentType,
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    fs.createReadStream(filePath, { start, end, highWaterMark: STREAM_HIGH_WATER_MARK }).pipe(res)
    return
  }

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': total,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  fs.createReadStream(filePath, { highWaterMark: STREAM_HIGH_WATER_MARK }).pipe(res)
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
  streamFileWithRange
}
