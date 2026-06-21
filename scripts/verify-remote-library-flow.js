const assert = require('assert')
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const projectRoot = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wallpaper-player-library-flow-'))
const libraryDir = path.join(tempRoot, 'library')
const videoPath = path.join(libraryDir, 'sample-video.mp4')
const incompatibleVideoPath = path.join(libraryDir, 'vp9-opus-sample.mkv')
const largeVideoPath = path.join(libraryDir, 'large-sample.mp4')
const previewPath = path.join(libraryDir, 'preview.jpg')
const ffmpeg = path.join(projectRoot, 'vendor', 'ffmpeg', 'bin', 'ffmpeg.exe')
const ffprobe = path.join(projectRoot, 'vendor', 'ffmpeg', 'bin', 'ffprobe.exe')

function run(file, args) {
  return execFileSync(file, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function decodePairingPayload(pairingCode) {
  const data = new URL(pairingCode).searchParams.get('data')
  assert.ok(data, 'pairing code should include encoded payload')
  return JSON.parse(Buffer.from(data, 'base64url').toString('utf8'))
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

async function claimDevice(baseUrl, clientId, clientName) {
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
      clientId,
      clientName,
      platform: 'verify'
    })
  })
  assert.strictEqual(pending.status, 200, `${clientName} should request pairing successfully`)
  assert.strictEqual(pending.data.status, 'pending', `${clientName} should wait for desktop approval`)
  assert.ok(pending.data.pairingRequestId, `${clientName} should expose a pairing request id`)
  approvePairingRequest(pending.data.pairingRequestId)
  const claimed = await requestJson(`${baseUrl}/v1/pairing/claim`, {
    method: 'POST',
    body: JSON.stringify({
      pairingId: payload.pairingId,
      oneTimeSecret: payload.oneTimeSecret,
      clientId,
      clientName,
      platform: 'verify'
    })
  })
  assert.strictEqual(claimed.status, 200, `${clientName} should pair successfully`)
  assert.ok(claimed.data.token, `${clientName} should receive a token`)
  assert.strictEqual(claimed.data.pairedDeviceId, clientId)
  return claimed.data.token
}

async function getLibrary(baseUrl, token) {
  return requestJson(`${baseUrl}/v1/library`, {
    headers: { Authorization: `Bearer ${token}` }
  })
}

async function assertUnauthorized(url, options = {}) {
  const response = await requestRaw(url, options)
  assert.strictEqual(response.status, 401)
  return response
}

async function assertJsonError(url, expectedStatus, expectedCode, options = {}) {
  const response = await requestJson(url, options)
  assert.strictEqual(response.status, expectedStatus)
  assert.strictEqual(response.data?.error?.code, expectedCode)
  return response
}

async function waitForTranscodeReady(baseUrl, videoId, token, quality = 'compatible') {
  const statusUrl = `${baseUrl}/v1/videos/${encodeURIComponent(videoId)}/transcode?quality=${encodeURIComponent(quality)}`
  const started = await requestJson(statusUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  })
  assert.strictEqual(started.status, 202)
  assert.ok(['running', 'ready'].includes(started.data.status), 'transcode should start or use ready cache')

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const current = await requestJson(statusUrl, {
      headers: { Authorization: `Bearer ${token}` }
    })
    assert.strictEqual(current.status, 200)
    assert.ok(current.data.progress >= 0 && current.data.progress <= 1)
    if (current.data.status === 'ready') {
      assert.strictEqual(current.data.progress, 1)
      assert.ok(current.data.streamUrl, 'ready transcode should expose a stream url')
      assert.ok(current.data.streamUrl.includes(`quality=${encodeURIComponent(quality)}`), 'ready transcode stream should keep requested quality')
      return current.data.streamUrl
    }
    assert.notStrictEqual(current.data.status, 'error', current.data.error || 'transcode should not fail')
    await new Promise(resolve => setTimeout(resolve, 500))
  }

  throw new Error('transcode did not become ready in time')
}

function probeCodec(filePath, stream) {
  return run(ffprobe, [
    '-v', 'error',
    '-select_streams', stream,
    '-show_entries', 'stream=codec_name',
    '-of', 'csv=p=0',
    filePath
  ]).trim()
}

async function runLightLanPressure(baseUrl, video, expectedCount, phoneAToken, phoneBToken) {
  const libraryReads = []
  for (let index = 0; index < 8; index += 1) {
    libraryReads.push(getLibrary(baseUrl, index % 2 === 0 ? phoneAToken : phoneBToken))
  }
  const libraries = await Promise.all(libraryReads)
  assert.ok(libraries.every(result => result.status === 200 && result.data.count === expectedCount), 'repeated library reads should stay stable')
  assert.ok(libraries.every(result => !JSON.stringify(result.data).includes(videoPath)), 'repeated library reads should not leak paths')

  const mixedReads = []
  for (let index = 0; index < 24; index += 1) {
    const token = index % 2 === 0 ? phoneAToken : phoneBToken
    const thumbnailToken = libraries[index % libraries.length].data.items.find(item => item.id === video.id)?.thumbnailToken
    assert.ok(thumbnailToken, 'pressure fixture video should include a thumbnail token')
    if (index % 3 === 0) {
      mixedReads.push(requestRaw(`${baseUrl}${video.thumbnailUrl}?thumbnailToken=${encodeURIComponent(thumbnailToken)}`))
    } else {
      const start = index * 32
      mixedReads.push(requestRaw(`${baseUrl}${video.streamUrl}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Range: `bytes=${start}-${start + 95}`
        }
      }))
    }
  }

  const mixedResults = await Promise.all(mixedReads)
  assert.ok(mixedResults.every(result => result.status === 200 || result.status === 206), 'mixed thumbnail and range pressure should succeed')
  assert.ok(mixedResults.every(result => result.body.length > 0), 'mixed pressure responses should include bytes')
}

function assertNoDesktopPaths(value, context = 'response') {
  const text = JSON.stringify(value)
  assert.ok(!text.includes(videoPath), `${context} should not expose full video path`)
  assert.ok(!text.includes(largeVideoPath), `${context} should not expose full large video path`)
  assert.ok(!text.includes(libraryDir), `${context} should not expose library directory`)
}

async function createFixtureLibrary() {
  fs.mkdirSync(libraryDir, { recursive: true })
  assert.ok(fs.existsSync(ffmpeg), `missing ffmpeg: ${ffmpeg}`)

  run(ffmpeg, [
    '-hide_banner',
    '-y',
    '-f', 'lavfi',
    '-i', 'testsrc=size=320x180:rate=15',
    '-f', 'lavfi',
    '-i', 'sine=frequency=880:sample_rate=44100',
    '-t', '2',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    videoPath
  ])
  run(ffmpeg, [
    '-hide_banner',
    '-y',
    '-f', 'lavfi',
    '-i', 'testsrc=size=426x240:rate=15',
    '-f', 'lavfi',
    '-i', 'sine=frequency=660:sample_rate=48000',
    '-t', '2',
    '-c:v', 'libvpx-vp9',
    '-b:v', '250k',
    '-c:a', 'libopus',
    incompatibleVideoPath
  ])
  fs.writeFileSync(largeVideoPath, Buffer.alloc((33 * 1024 * 1024) + 128, 0))

  run(ffmpeg, [
    '-hide_banner',
    '-y',
    '-f', 'lavfi',
    '-i', 'color=c=navy:size=480x270',
    '-frames:v', '1',
    previewPath
  ])

  fs.writeFileSync(path.join(libraryDir, 'project.json'), JSON.stringify({
    title: 'LAN Flow Sample',
    tags: ['Flow', 'Verify'],
    type: 'video',
    file: 'sample-video.mp4',
    preview: 'preview.jpg'
  }, null, 2))
}

async function main() {
  await createFixtureLibrary()
  process.chdir(tempRoot)

  const { loadSettings, onSettingsChanged, saveSettings, sessionAllowedDirectories } = require(path.join(projectRoot, 'main', 'settings'))
  const { createScopedToken, listPairedDevices } = require(path.join(projectRoot, 'main', 'remote', 'identity'))
  const { createRemoteServer } = require(path.join(projectRoot, 'main', 'remote', 'server'))
  const { getFavoriteKeyForVideoId } = require(path.join(projectRoot, 'main', 'remote', 'video-index'))

  sessionAllowedDirectories.add(libraryDir)
  saveSettings({
    directories: [libraryDir],
    defaultDirectory: libraryDir,
    remoteAccess: { enabled: true, port: 38127, keepRunningInTray: true },
    favorites: [],
    customTags: {}
  })

  const server = createRemoteServer({ port: 0 })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object', 'server should listen on a local port')
    const baseUrl = `http://127.0.0.1:${address.port}`

    const phoneAToken = await claimDevice(baseUrl, 'verify_phone_a', 'Verify Phone A')
    const phoneBToken = await claimDevice(baseUrl, 'verify_phone_b', 'Verify Phone B')

    const pairedBeforeRevoke = listPairedDevices()
    assert.ok(pairedBeforeRevoke.some(device => device.id === 'verify_phone_a'))
    assert.ok(pairedBeforeRevoke.some(device => device.id === 'verify_phone_b'))

    const library = await getLibrary(baseUrl, phoneAToken)
    assert.strictEqual(library.status, 200)
    assert.strictEqual(library.data.count, 3)
    assertNoDesktopPaths(library.data, 'library response')
    assert.ok(Array.isArray(library.data.directories) && library.data.directories.length === 1)
    assert.ok(library.data.categoryGroups?.system?.some(category => category.name === 'Flow'))

    const video = library.data.items.find(item => item.fileName === 'sample-video')
    const incompatibleVideo = library.data.items.find(item => item.fileName === 'vp9-opus-sample')
    const largeVideo = library.data.items.find(item => item.fileName === 'large-sample')
    assert.ok(video, 'library should include playable fixture video')
    assert.ok(incompatibleVideo, 'library should include incompatible fixture video')
    assert.ok(largeVideo, 'library should include large fixture video')
    assert.ok(video.id.startsWith('video_'))
    assert.strictEqual(video.name, 'LAN Flow Sample')
    assert.strictEqual(video.extension, '.mp4')
    assert.ok(video.thumbnailToken, 'library item should include bound thumbnail token')
    assert.ok(!Object.hasOwn(video, 'fullPath'), 'library item should not include fullPath')
    assert.ok(!Object.hasOwn(video, 'playbackKey'), 'library item should not include playbackKey')
    assert.ok(!Object.hasOwn(video, 'previewPath'), 'library item should not include previewPath')

    const thumbnailUrl = `${baseUrl}${video.thumbnailUrl}?thumbnailToken=${encodeURIComponent(video.thumbnailToken)}`
    const thumbnail = await requestRaw(thumbnailUrl)
    assert.strictEqual(thumbnail.status, 200)
    assert.ok(thumbnail.body.length > 0, 'thumbnail should return bytes')
    assert.match(thumbnail.headers.get('content-type') || '', /^image\//)

    const unboundThumbnailToken = createScopedToken('thumbnail', video.id, 60 * 1000)
    await assertUnauthorized(`${baseUrl}${video.thumbnailUrl}?thumbnailToken=${encodeURIComponent(unboundThumbnailToken)}`)

    const firstRange = await requestRaw(`${baseUrl}${video.streamUrl}`, {
      headers: {
        Authorization: `Bearer ${phoneAToken}`,
        Range: 'bytes=0-1023'
      }
    })
    assert.strictEqual(firstRange.status, 206)
    assert.ok(firstRange.body.length > 0 && firstRange.body.length <= 1024)
    assert.match(firstRange.headers.get('content-range') || '', /^bytes 0-\d+\/\d+$/)
    assert.strictEqual(firstRange.headers.get('accept-ranges'), 'bytes')

    const suffixRange = await requestRaw(`${baseUrl}${video.streamUrl}`, {
      headers: {
        Authorization: `Bearer ${phoneAToken}`,
        Range: 'bytes=-512'
      }
    })
    assert.strictEqual(suffixRange.status, 206)
    assert.ok(suffixRange.body.length > 0 && suffixRange.body.length <= 512)

    const largeFullResponse = await requestRaw(`${baseUrl}${largeVideo.streamUrl}`, {
      headers: { Authorization: `Bearer ${phoneAToken}` }
    })
    assert.strictEqual(largeFullResponse.status, 200, 'large video requests without Range should stream for player probing')
    assert.strictEqual(largeFullResponse.headers.get('accept-ranges'), 'bytes')
    assert.ok(largeFullResponse.body.length > 0)

    const largeRange = await requestRaw(`${baseUrl}${largeVideo.streamUrl}`, {
      headers: {
        Authorization: `Bearer ${phoneAToken}`,
        Range: 'bytes=0-255'
      }
    })
    assert.strictEqual(largeRange.status, 206, 'large video requests with Range should still work')
    assert.strictEqual(largeRange.body.length, 256)

    const repeatedFetches = []
    for (let index = 0; index < 12; index += 1) {
      repeatedFetches.push(requestRaw(`${baseUrl}${video.streamUrl}`, {
        headers: {
          Authorization: `Bearer ${index % 2 === 0 ? phoneAToken : phoneBToken}`,
          Range: `bytes=${index * 64}-${index * 64 + 63}`
        }
      }))
    }
    const repeatedResults = await Promise.all(repeatedFetches)
    assert.ok(repeatedResults.every(result => result.status === 206), 'concurrent small range reads should succeed')
    await runLightLanPressure(baseUrl, video, library.data.count, phoneAToken, phoneBToken)

    const transcodedStreamUrl = await waitForTranscodeReady(baseUrl, video.id, phoneAToken, '720p')
    const transcodedRange = await requestRaw(`${baseUrl}${transcodedStreamUrl}`, {
      headers: {
        Authorization: `Bearer ${phoneAToken}`,
        Range: 'bytes=0-1023'
      }
    })
    assert.strictEqual(transcodedRange.status, 206)
    assert.match(transcodedRange.headers.get('content-type') || '', /^video\/mp4/)
    assert.ok(transcodedRange.body.length > 0 && transcodedRange.body.length <= 1024)

    const incompatibleTranscodedStreamUrl = await waitForTranscodeReady(baseUrl, incompatibleVideo.id, phoneAToken, '720p')
    const incompatibleTranscodedRange = await requestRaw(`${baseUrl}${incompatibleTranscodedStreamUrl}`, {
      headers: {
        Authorization: `Bearer ${phoneAToken}`,
        Range: 'bytes=0-2047'
      }
    })
    assert.strictEqual(incompatibleTranscodedRange.status, 206)
    assert.match(incompatibleTranscodedRange.headers.get('content-type') || '', /^video\/mp4/)
    const { getTranscodedPath } = require(path.join(projectRoot, 'main', 'remote', 'transcode'))
    const incompatibleOutputPath = getTranscodedPath(incompatibleVideo.id, '720p')
    assert.ok(incompatibleOutputPath && fs.existsSync(incompatibleOutputPath), 'incompatible source should produce a cached MP4')
    assert.strictEqual(probeCodec(incompatibleOutputPath, 'v:0'), 'h264')
    assert.strictEqual(probeCodec(incompatibleOutputPath, 'a:0'), 'aac')

    await assertJsonError(
      `${baseUrl}/v1/videos/${encodeURIComponent(video.id)}/play-on-desktop`,
      503,
      'desktop_window_unavailable',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${phoneAToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ position: 1.25 })
      }
    )

    const playbackSave = await requestJson(`${baseUrl}/v1/playback/${encodeURIComponent(video.id)}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${phoneAToken}` },
      body: JSON.stringify({ position: 1.25 })
    })
    assert.strictEqual(playbackSave.status, 200)

    const playbackGet = await requestJson(`${baseUrl}/v1/playback/${encodeURIComponent(video.id)}`, {
      headers: { Authorization: `Bearer ${phoneAToken}` }
    })
    assert.strictEqual(playbackGet.status, 200)
    assert.strictEqual(playbackGet.data.position, 1.25)

    const favorite = await requestJson(`${baseUrl}/v1/videos/${encodeURIComponent(video.id)}/favorite`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${phoneAToken}` }
    })
    assert.strictEqual(favorite.status, 200)
    assert.strictEqual(favorite.data.favorite, true)

    const tags = await requestJson(`${baseUrl}/v1/videos/${encodeURIComponent(video.id)}/tags`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${phoneAToken}` },
      body: JSON.stringify({ tags: ['custom-tag', 'Flow'] })
    })
    assert.strictEqual(tags.status, 200)
    assert.deepStrictEqual(tags.data.customTags, ['custom-tag', 'Flow'])

    const libraryAfterMetadata = await getLibrary(baseUrl, phoneAToken)
    assert.strictEqual(libraryAfterMetadata.status, 200)
    assert.strictEqual(libraryAfterMetadata.data.items[0].favorite, true)
    assert.ok(libraryAfterMetadata.data.items[0].customTags.includes('custom-tag'))
    assert.ok(libraryAfterMetadata.data.categoryGroups.custom.some(category => category.name === 'custom-tag'))
    assertNoDesktopPaths(libraryAfterMetadata.data, 'metadata-updated library response')

    const legacyCustomTags = { ...(loadSettings().customTags || {}) }
    const incompatibleFavoriteKey = getFavoriteKeyForVideoId(incompatibleVideo.id)
    assert.ok(incompatibleFavoriteKey, 'incompatible fixture should have a favorite key')
    legacyCustomTags[incompatibleVideoPath] = ['legacy-path-tag']
    delete legacyCustomTags[incompatibleFavoriteKey]
    saveSettings({ customTags: legacyCustomTags })

    let settingsChangedPayload = null
    const removeSettingsChanged = onSettingsChanged((settings) => {
      settingsChangedPayload = settings
    })
    const bulkTags = await requestJson(`${baseUrl}/v1/videos/tags/bulk`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${phoneAToken}` },
      body: JSON.stringify({ videoIds: [video.id, incompatibleVideo.id], tags: ['bulk-tag'] })
    })
    removeSettingsChanged()
    assert.strictEqual(bulkTags.status, 200)
    assert.strictEqual(bulkTags.data.updatedCount, 2)
    assert.deepStrictEqual(bulkTags.data.tags, ['bulk-tag'])
    assert.ok(settingsChangedPayload?.customTags, 'bulk tag save should notify settings listeners')
    assert.ok(settingsChangedPayload.customTags[incompatibleFavoriteKey]?.includes('legacy-path-tag'), 'bulk tags should preserve legacy path-key tags')
    assert.ok(!Object.hasOwn(settingsChangedPayload.customTags, incompatibleVideoPath), 'bulk tags should migrate legacy path-key tags')

    const libraryAfterBulkTags = await getLibrary(baseUrl, phoneAToken)
    assert.strictEqual(libraryAfterBulkTags.status, 200)
    const bulkTaggedIds = new Set(
      libraryAfterBulkTags.data.items
        .filter(item => item.customTags?.includes('bulk-tag'))
        .map(item => item.id)
    )
    assert.ok(bulkTaggedIds.has(video.id), 'bulk tags should update first selected video')
    assert.ok(bulkTaggedIds.has(incompatibleVideo.id), 'bulk tags should update second selected video')
    const bulkTaggedIncompatible = libraryAfterBulkTags.data.items.find(item => item.id === incompatibleVideo.id)
    assert.ok(bulkTaggedIncompatible.customTags?.includes('legacy-path-tag'), 'bulk tags should keep existing legacy custom tags')
    assert.ok(libraryAfterBulkTags.data.categoryGroups.custom.some(category => category.name === 'bulk-tag'))
    assertNoDesktopPaths(libraryAfterBulkTags.data, 'bulk-tagged library response')

    const unpairA = await requestJson(`${baseUrl}/v1/devices/current`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${phoneAToken}` }
    })
    assert.strictEqual(unpairA.status, 200)
    assert.strictEqual(unpairA.data.device.id, 'verify_phone_a')

    await assertUnauthorized(`${baseUrl}/v1/library`, {
      headers: { Authorization: `Bearer ${phoneAToken}` }
    })
    await assertUnauthorized(thumbnailUrl)
    await assertUnauthorized(`${baseUrl}${video.streamUrl}`, {
      headers: {
        Authorization: `Bearer ${phoneAToken}`,
        Range: 'bytes=0-63'
      }
    })

    const libraryFromPhoneB = await getLibrary(baseUrl, phoneBToken)
    assert.strictEqual(libraryFromPhoneB.status, 200)
    assert.strictEqual(libraryFromPhoneB.data.count, 3)
    assert.strictEqual(libraryFromPhoneB.data.items[0].favorite, true)

    const pairedAfterRevoke = listPairedDevices()
    assert.ok(!pairedAfterRevoke.some(device => device.id === 'verify_phone_a'))
    assert.ok(pairedAfterRevoke.some(device => device.id === 'verify_phone_b'))

    console.log('remote library flow verification passed')
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
