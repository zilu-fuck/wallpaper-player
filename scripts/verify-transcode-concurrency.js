const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const projectRoot = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wallpaper-player-transcode-concurrency-'))
const videoA = path.join(tempRoot, 'a.mp4')
const videoB = path.join(tempRoot, 'b.mp4')
const binDir = path.join(tempRoot, 'bin')
const ffmpegStub = path.join(binDir, 'ffmpeg.cmd')
const ffprobeStub = path.join(binDir, 'ffprobe.cmd')

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
  fs.writeFileSync(videoA, Buffer.alloc(1024, 1))
  fs.writeFileSync(videoB, Buffer.alloc(1024, 2))
  fs.writeFileSync(ffprobeStub, '@echo off\r\necho 60\r\n')
  fs.writeFileSync(ffmpegStub, '@echo off\r\nping -n 4 127.0.0.1 >nul\r\nexit /b 0\r\n')

  process.chdir(tempRoot)
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH || ''}`

  const {
    cancelMobileTranscode,
    startMobileTranscode
  } = require(path.join(projectRoot, 'main', 'remote', 'transcode'))

  const first = await startMobileTranscode('video_concurrency_a', videoA, '720p')
  assert.strictEqual(first.status, 'running', 'first transcode should start')
  assert.ok(first.process, 'first transcode should hold an ffmpeg process')
  assert.ok(await waitFor(() => first.process), 'first transcode should still be active during the concurrency check')

  const second = await startMobileTranscode('video_concurrency_b', videoB, '720p')
  assert.strictEqual(second.status, 'error', 'second concurrent transcode should be rejected')
  assert.match(second.error, /另一个视频/, 'second transcode should explain the concurrency limit')

  cancelMobileTranscode('video_concurrency_a', '720p')
  console.log('mobile transcode concurrency verification passed')
}

main()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    process.chdir(projectRoot)
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })
