const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const projectRoot = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wallpaper-player-transcode-concurrency-'))
const videoSame = path.join(tempRoot, 'same.mp4')
const videoA = path.join(tempRoot, 'a.mp4')
const videoB = path.join(tempRoot, 'b.mp4')
const binDir = path.join(tempRoot, 'bin')
const ffmpegStub = path.join(binDir, 'ffmpeg.cmd')
const ffprobeStub = path.join(binDir, 'ffprobe.cmd')

function transcodeOutputPath(videoPath, quality) {
  const digest = require('crypto').createHash('sha256').update(path.resolve(videoPath)).digest('hex')
  return path.join(tempRoot, '.tmp-wallpaper-player', 'remote-transcodes', `${digest}.${quality}.mobile.mp4`)
}

async function waitFor(predicate, timeoutMs = 3000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return false
}

async function main() {
  fs.mkdirSync(binDir, { recursive: true })
  fs.writeFileSync(videoSame, Buffer.alloc(1024, 3))
  fs.writeFileSync(videoA, Buffer.alloc(1024, 1))
  fs.writeFileSync(videoB, Buffer.alloc(1024, 2))
  fs.writeFileSync(ffprobeStub, '@echo off\r\necho 60\r\n')
  fs.writeFileSync(ffmpegStub, '@echo off\r\nping -n 30 127.0.0.1 >nul\r\nexit /b 1\r\n')

  process.chdir(tempRoot)
  process.env.WALLPAPER_PLAYER_FFMPEG_PATH = ffmpegStub
  process.env.WALLPAPER_PLAYER_FFPROBE_PATH = ffprobeStub

  const {
    cancelMobileTranscode,
    getMobileTranscodeStatus,
    startMobileTranscode
  } = require(path.join(projectRoot, 'main', 'remote', 'transcode'))

  const [sameFirst, sameSecond] = await Promise.all([
    startMobileTranscode('video_same_key', videoSame, '720p'),
    startMobileTranscode('video_same_key', videoSame, '720p')
  ])
  assert.strictEqual(sameFirst, sameSecond, 'same video and quality should reuse one transcode task')
  assert.strictEqual(sameFirst.status, 'running', sameFirst.error || 'same-key transcode should start once')
  cancelMobileTranscode('video_same_key', '720p')
  assert.ok(await waitFor(() => !sameFirst.process, 6000), 'same-key transcode should stop after cancellation')

  const cachedOutputPath = transcodeOutputPath(videoSame, '480p')
  fs.mkdirSync(path.dirname(cachedOutputPath), { recursive: true })
  fs.writeFileSync(cachedOutputPath, Buffer.alloc(1024, 4))
  const now = Date.now()
  fs.utimesSync(videoSame, new Date(now - 20000), new Date(now - 20000))
  fs.utimesSync(cachedOutputPath, new Date(now - 10000), new Date(now - 10000))
  const ready = await startMobileTranscode('video_stale_ready', videoSame, '480p')
  assert.strictEqual(ready.status, 'ready', 'fresh cached output should become a ready task')
  fs.utimesSync(videoSame, new Date(now + 10000), new Date(now + 10000))
  const restarted = await startMobileTranscode('video_stale_ready', videoSame, '480p')
  assert.notStrictEqual(restarted, ready, 'stale ready cache should be discarded and recreated')
  assert.strictEqual(restarted.status, 'running', restarted.error || 'stale ready cache should trigger a new transcode')
  assert.ok(!fs.existsSync(cachedOutputPath), 'stale cached output should be removed before retranscoding')
  cancelMobileTranscode('video_stale_ready', '480p')
  assert.ok(await waitFor(() => !restarted.process, 6000), 'stale-cache transcode should stop after cancellation')

  const first = await startMobileTranscode('video_concurrency_a', videoA, '720p')
  assert.strictEqual(first.status, 'running', first.error || 'first transcode should start')
  assert.ok(first.process, 'first transcode should hold an ffmpeg process')
  assert.ok(await waitFor(() => first.process), 'first transcode should still be active during the concurrency check')

  const second = await startMobileTranscode('video_concurrency_b', videoB, '720p')
  assert.strictEqual(second.status, 'queued', 'second concurrent transcode should be queued')
  assert.strictEqual(getMobileTranscodeStatus('video_concurrency_b', '720p').queuePosition, 1, 'second transcode should report queue position')

  cancelMobileTranscode('video_concurrency_a', '720p')
  assert.ok(await waitFor(() => second.process, 6000), 'queued transcode should start after the first is cancelled')
  assert.strictEqual(second.status, 'running', 'queued transcode should become running')
  cancelMobileTranscode('video_concurrency_b', '720p')
  await waitFor(() => !first.process && !second.process, 6000)
  console.log('mobile transcode concurrency verification passed')
}

main()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    process.chdir(projectRoot)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true })
        break
      } catch {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
      }
    }
  })
