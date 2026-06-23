const { claimPairing, getPublicIdentity, revokePairedDeviceByToken } = require('../identity')
const { getLanAddresses, getPrimaryEndpoint } = require('../network')
const { readBody, sendError, sendJson } = require('../http-utils')

const MAX_SPEED_TEST_BYTES = 4 * 1024 * 1024
const DEFAULT_SPEED_TEST_BYTES = 1024 * 1024
const speedTestChunk = Buffer.alloc(64 * 1024, 0x61)

function waitForDrainOrClose(res) {
  if (res.destroyed || res.writableEnded) return Promise.resolve(false)
  return new Promise((resolve) => {
    const cleanup = () => {
      res.off('drain', onDrain)
      res.off('close', onClose)
      res.off('error', onClose)
    }
    const onDrain = () => {
      cleanup()
      resolve(true)
    }
    const onClose = () => {
      cleanup()
      resolve(false)
    }
    res.once('drain', onDrain)
    res.once('close', onClose)
    res.once('error', onClose)
  })
}

function createInfoHandlers({ getRequestToken }) {
  async function handleInfo(req, res, port) {
    sendJson(req, res, 200, {
      ...getPublicIdentity(),
      version: 1,
      endpoint: getPrimaryEndpoint(port),
      endpoints: getLanAddresses(port),
      transport: {
        protocol: 'http',
        range: true,
        tcpNoDelay: true,
        keepAlive: true
      }
    })
  }

  async function handlePairingClaim(req, res) {
    const body = await readBody(req)
    const result = claimPairing({
      pairingId: body.pairingId,
      oneTimeSecret: body.oneTimeSecret,
      clientId: body.clientId,
      clientName: body.clientName,
      platform: body.platform
    })
    sendJson(req, res, 200, result)
  }

  async function handleUnpairCurrentDevice(req, res, url) {
    const token = getRequestToken(req, url, false)
    const revoked = revokePairedDeviceByToken(token)
    if (!revoked) {
      sendError(req, res, 400, 'device_not_paired', '当前设备不是扫码绑定设备，已在手机端本地移除')
      return
    }
    sendJson(req, res, 200, { success: true, device: revoked })
  }

  async function handleSpeedTest(req, res, url) {
    const requestedSize = Number(url.searchParams.get('bytes'))
    const total = Math.max(
      64 * 1024,
      Math.min(Number.isFinite(requestedSize) ? requestedSize : DEFAULT_SPEED_TEST_BYTES, MAX_SPEED_TEST_BYTES)
    )

    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': total,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }

    let remaining = total
    while (remaining > 0) {
      if (res.destroyed || res.writableEnded) return
      const chunk = remaining >= speedTestChunk.length
        ? speedTestChunk
        : speedTestChunk.subarray(0, remaining)
      remaining -= chunk.length
      if (!res.write(chunk)) {
        const canContinue = await waitForDrainOrClose(res)
        if (!canContinue) return
      }
    }
    if (!res.destroyed && !res.writableEnded) res.end()
  }

  return {
    handleInfo,
    handlePairingClaim,
    handleUnpairCurrentDevice,
    handleSpeedTest
  }
}

module.exports = {
  createInfoHandlers
}
