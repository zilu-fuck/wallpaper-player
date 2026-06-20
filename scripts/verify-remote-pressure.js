const assert = require('assert')
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const projectRoot = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wallpaper-player-remote-pressure-'))
const libraryDir = path.join(tempRoot, 'library')
const ffmpeg = path.join(projectRoot, 'vendor', 'ffmpeg', 'bin', 'ffmpeg.exe')

function run(file, args) {
  return execFileSync(file, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function decodePairingPayload(pairingCode) {
  const data = new URL(pairingCode).searchParams.get('data')
  assert.ok(data, 'pairing code should include data')
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
    data: text ? JSON.parse(text) : null
  }
}

async function requestBytes(url, options = {}) {
  const response = await fetch(url, options)
  return {
    status: response.status,
    headers: response.headers,
    bytes: Buffer.from(await response.arrayBuffer()).length
  }
}

async function claimDevice(baseUrl) {
  const { approvePairingRequest, createPairingCode } = require(path.join(projectRoot, 'main', 'remote', 'identity'))
  const pairing = createPairingCode({
    endpoint: baseUrl,
    endpoints: [baseUrl],
    ttlMs: 60 * 1000
  })
  const payload = decodePairingPayload(pairing.pairingCode)
  const pending = await requestJson(`${baseUrl}/v1/pairing/claim`, {
    method: 'POST',
    body: JSON.stringify({
      pairingId: payload.pairingId,
      oneTimeSecret: payload.oneTimeSecret,
      clientId: 'pressure_phone',
      clientName: 'Pressure Phone',
      platform: 'verify'
    })
  })
  assert.strictEqual(pending.status, 200)
  assert.strictEqual(pending.data.status, 'pending')
  assert.ok(pending.data.pairingRequestId)
  approvePairingRequest(pending.data.pairingRequestId)
  const response = await requestJson(`${baseUrl}/v1/pairing/claim`, {
    method: 'POST',
    body: JSON.stringify({
      pairingId: payload.pairingId,
      oneTimeSecret: payload.oneTimeSecret,
      clientId: 'pressure_phone',
      clientName: 'Pressure Phone',
      platform: 'verify'
    })
  })
  assert.strictEqual(response.status, 200)
  assert.ok(response.data.token)
  return response.data.token
}

function createFixtureLibrary() {
  fs.mkdirSync(libraryDir, { recursive: true })
  assert.ok(fs.existsSync(ffmpeg), `missing ffmpeg: ${ffmpeg}`)

  for (let index = 0; index < 3; index += 1) {
    const dir = path.join(libraryDir, `sample-${index}`)
    fs.mkdirSync(dir, { recursive: true })
    run(ffmpeg, [
      '-hide_banner',
      '-y',
      '-f', 'lavfi',
      '-i', `testsrc=size=${320 + index * 16}x180:rate=15`,
      '-f', 'lavfi',
      '-i', `sine=frequency=${660 + index * 110}:sample_rate=44100`,
      '-t', '2',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      path.join(dir, `sample-${index}.mp4`)
    ])
    run(ffmpeg, [
      '-hide_banner',
      '-y',
      '-f', 'lavfi',
      '-i', `color=c=0x${['102030', '203010', '301020'][index]}:size=480x270`,
      '-frames:v', '1',
      path.join(dir, 'preview.jpg')
    ])
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({
      title: `Pressure Sample ${index}`,
      tags: ['Pressure', `Group${index}`],
      type: 'video',
      file: `sample-${index}.mp4`,
      preview: 'preview.jpg'
    }, null, 2))
  }
}

async function runPressure(baseUrl, token, videos) {
  const firstHeap = process.memoryUsage().heapUsed

  for (let round = 0; round < 20; round += 1) {
    const library = await requestJson(`${baseUrl}/v1/library`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    assert.strictEqual(library.status, 200)
    assert.strictEqual(library.data.count, videos.length)
    assert.ok(!JSON.stringify(library.data).includes(libraryDir), 'library response should not leak paths')

    const batch = []
    for (let index = 0; index < 12; index += 1) {
      const video = library.data.items[index % library.data.items.length]
      if (index % 4 === 0) {
        batch.push(requestBytes(`${baseUrl}${video.thumbnailUrl}?thumbnailToken=${encodeURIComponent(video.thumbnailToken)}`))
      } else {
        const start = (round * 128) + (index * 64)
        batch.push(requestBytes(`${baseUrl}${video.streamUrl}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Range: `bytes=${start}-${start + 127}`
          }
        }))
      }
    }

    const results = await Promise.all(batch)
    assert.ok(results.every(result => result.status === 200 || result.status === 206), `round ${round} should serve all pressure requests`)
    assert.ok(results.every(result => result.bytes > 0), `round ${round} should return response bodies`)
  }

  const secondHeap = process.memoryUsage().heapUsed
  const heapGrowth = secondHeap - firstHeap
  assert.ok(heapGrowth < 40 * 1024 * 1024, `heap growth should stay bounded, grew ${heapGrowth} bytes`)
}

async function main() {
  createFixtureLibrary()
  process.chdir(tempRoot)

  const { saveSettings, sessionAllowedDirectories } = require(path.join(projectRoot, 'main', 'settings'))
  const { createRemoteServer } = require(path.join(projectRoot, 'main', 'remote', 'server'))

  sessionAllowedDirectories.add(libraryDir)
  saveSettings({
    directories: [libraryDir],
    defaultDirectory: libraryDir,
    remoteAccess: { enabled: true, port: 38127, keepRunningInTray: true }
  })

  const server = createRemoteServer({ port: 0 })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const token = await claimDevice(baseUrl)
    const library = await requestJson(`${baseUrl}/v1/library`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    assert.strictEqual(library.status, 200)
    assert.strictEqual(library.data.count, 3)

    await runPressure(baseUrl, token, library.data.items)
    console.log('remote pressure verification passed')
  } finally {
    await new Promise(resolve => server.close(resolve))
    const { unwatchAllDirectories } = require(path.join(projectRoot, 'main', 'scanner'))
    unwatchAllDirectories()
  }
}

main()
  .finally(() => {
    process.chdir(projectRoot)
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
