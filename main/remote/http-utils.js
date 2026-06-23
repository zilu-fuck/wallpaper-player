const zlib = require('zlib')

const JSON_GZIP_THRESHOLD = 1024
const MAX_BODY_LENGTH = 1024 * 1024

function acceptsGzip(req) {
  return /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''))
}

function sendJson(req, res, status, data) {
  const body = Buffer.from(JSON.stringify(data))
  if (body.length >= JSON_GZIP_THRESHOLD && acceptsGzip(req)) {
    const compressed = zlib.gzipSync(body)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Encoding': 'gzip',
      'Content-Length': compressed.length,
      'Cache-Control': 'no-store',
      'Vary': 'Accept-Encoding'
    })
    res.end(req.method === 'HEAD' ? undefined : compressed)
    return
  }

  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'Vary': 'Accept-Encoding'
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

function sendError(req, res, status, code, message) {
  sendJson(req, res, status, { error: { code, message } })
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    let rejected = false
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      if (rejected) return
      body += chunk
      if (body.length > MAX_BODY_LENGTH) {
        rejected = true
        reject(Object.assign(new Error('请求体过大'), { status: 413, code: 'payload_too_large' }))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (rejected) return
      if (!body) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(body))
      } catch {
        reject(Object.assign(new Error('请求 JSON 无效'), { status: 400, code: 'invalid_json' }))
      }
    })
    req.on('error', (err) => {
      if (rejected) return
      reject(err)
    })
  })
}

module.exports = {
  sendJson,
  sendError,
  readBody
}
