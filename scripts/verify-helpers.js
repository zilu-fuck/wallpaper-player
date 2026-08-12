const assert = require('assert')
const fs = require('fs')
const { execFileSync } = require('child_process')

// verify-* 脚本共享助手，消除跨脚本复制粘贴。
// 注意：本项目没有测试框架，verify-* 是自研断言脚本，
// 共用助手可以让协议变更只改一处。

function decodePairingPayload(pairingCode) {
  const data = new URL(pairingCode).searchParams.get('data')
  assert.ok(data, 'pairing code should include encoded payload')
  return JSON.parse(Buffer.from(data, 'base64url').toString('utf8'))
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body == null ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers || {})
    }
  })
  const text = await response.text()
  return {
    status: response.status,
    headers: response.headers,
    data: text ? JSON.parse(text) : null
  }
}

async function requestRaw(url, options = {}) {
  const response = await fetch(url, options)
  const body = Buffer.from(await response.arrayBuffer())
  return {
    status: response.status,
    headers: response.headers,
    body
  }
}

// 同步执行外部命令。带 2 分钟超时：CI 上刚下载的 ffmpeg/ffprobe 可能被
// Defender 实时扫描拖慢，无超时的 execFileSync 会让步骤无限挂起。
function runExec(file, args, options = {}) {
  return execFileSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 2 * 60 * 1000,
    ...options
  })
}

// pending→approve→claim 全流程，返回 { token, deviceId }
async function claimDevice({ baseUrl, clientId, clientName, approvePairingRequest, createPairingCode, projectRoot, ttlMs = 60 * 1000 }) {
  const pairing = createPairingCode({
    endpoint: baseUrl,
    endpoints: [baseUrl],
    ttlMs
  })
  const payload = decodePairingPayload(pairing.pairingCode)
  const claimBody = {
    pairingId: payload.pairingId,
    oneTimeSecret: payload.oneTimeSecret,
    clientId,
    clientName: clientName || clientId,
    platform: 'verify'
  }

  const pending = await requestJson(`${baseUrl}/v1/pairing/claim`, {
    method: 'POST',
    body: JSON.stringify(claimBody)
  })
  assert.strictEqual(pending.status, 200, `${clientName || clientId} should request pairing successfully`)
  assert.strictEqual(pending.data.status, 'pending', `${clientName || clientId} should wait for desktop approval`)
  assert.ok(pending.data.pairingRequestId, `${clientName || clientId} should expose a pairing request id`)
  approvePairingRequest(pending.data.pairingRequestId)

  const claimed = await requestJson(`${baseUrl}/v1/pairing/claim`, {
    method: 'POST',
    body: JSON.stringify(claimBody)
  })
  assert.strictEqual(claimed.status, 200, `${clientName || clientId} should pair successfully`)
  assert.ok(claimed.data.token, `${clientName || clientId} should receive a token`)
  if (claimed.data.pairedDeviceId) {
    assert.strictEqual(claimed.data.pairedDeviceId, clientId)
  }
  return {
    token: claimed.data.token,
    deviceId: claimed.data.deviceId || claimed.data.pairedDeviceId || clientId
  }
}

async function removeTempRootWithRetry(targetPath, { attempts = 5, delayMs = 250 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt === attempts - 1 || (error.code !== 'EBUSY' && error.code !== 'ENOTEMPTY' && error.code !== 'EPERM')) {
        throw error
      }
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }
}

// 生成带音轨的 h264/aac 测试视频（ffmpeg lavfi）。
// 返回 runExec 的 promise，调用方必须 await，否则慢环境下后续断言会
// 在文件生成前执行（CI 上 ffmpeg 被 Defender 扫描时尤其明显）。
function createFixtureVideo({ ffmpeg, destPath, size = '320x180', rate = 15, frequency = 880, sampleRate = 44100, duration = 2, vcodec = 'libx264', acodec = 'aac', extraArgs = [] }) {
  fs.mkdirSync(require('path').dirname(destPath), { recursive: true })
  assert.ok(fs.existsSync(ffmpeg), `missing ffmpeg: ${ffmpeg}`)
  return runExec(ffmpeg, [
    '-hide_banner',
    '-y',
    '-f', 'lavfi',
    '-i', `testsrc=size=${size}:rate=${rate}`,
    '-f', 'lavfi',
    '-i', `sine=frequency=${frequency}:sample_rate=${sampleRate}`,
    '-t', String(duration),
    '-c:v', vcodec,
    '-pix_fmt', 'yuv420p',
    '-c:a', acodec,
    ...extraArgs,
    destPath
  ])
}

// 生成单帧图片（preview.jpg 等）。返回 runExec 的 promise，调用方必须 await。
function createFixtureImage({ ffmpeg, destPath, size = '480x270', color = 'navy' }) {
  fs.mkdirSync(require('path').dirname(destPath), { recursive: true })
  assert.ok(fs.existsSync(ffmpeg), `missing ffmpeg: ${ffmpeg}`)
  return runExec(ffmpeg, [
    '-hide_banner',
    '-y',
    '-f', 'lavfi',
    '-i', `color=c=${color}:size=${size}`,
    '-frames:v', '1',
    destPath
  ])
}

module.exports = {
  claimDevice,
  createFixtureImage,
  createFixtureVideo,
  decodePairingPayload,
  removeTempRootWithRetry,
  requestJson,
  requestRaw,
  runExec
}
