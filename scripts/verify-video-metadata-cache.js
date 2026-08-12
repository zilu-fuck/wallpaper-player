const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createFixtureVideo, runExec } = require('./verify-helpers')
const { normalizedPathKey } = require('../main/paths')

const projectRoot = path.resolve(__dirname, '..')
const ffmpeg = path.join(projectRoot, 'vendor', 'ffmpeg', 'bin', 'ffmpeg.exe')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wallpaper-player-metadata-'))
const libraryDir = path.join(tempRoot, 'library')
const videoPath = path.join(libraryDir, 'metadata-sample.mp4')
const transportStreamPath = path.join(libraryDir, 'transport-stream.ts')
const typeScriptPath = path.join(libraryDir, 'source-code.ts')

function run(file, args) {
  return runExec(file, args, { cwd: projectRoot })
}

async function main() {
  assert.ok(fs.existsSync(ffmpeg), `missing ffmpeg: ${ffmpeg}`)
  await createFixtureVideo({
    ffmpeg,
    destPath: videoPath,
    size: '424x240',
    rate: 12,
    frequency: 440,
    sampleRate: 44100,
    duration: 1,
    vcodec: 'libx264',
    acodec: 'aac'
  })
  await run(ffmpeg, [
    '-hide_banner',
    '-y',
    '-f', 'lavfi',
    '-i', 'testsrc=size=320x180:rate=12',
    '-t', '1',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-f', 'mpegts',
    transportStreamPath
  ])
  fs.writeFileSync(typeScriptPath, 'export const fileTree = { type: "source" }\n', 'utf8')

  process.chdir(tempRoot)
  const { sessionAllowedDirectories, saveSettings } = require(path.join(projectRoot, 'main', 'settings'))
  const { getVideoMetadata } = require(path.join(projectRoot, 'main', 'video-metadata'))
  const { isVideoContentFile } = require(path.join(projectRoot, 'main', 'paths'))
  const {
    directoryScanCache,
    getScanIndexPath,
    scanWithCache,
    unwatchAllDirectories,
    waitForBackgroundScanRefreshes
  } = require(path.join(projectRoot, 'main', 'scanner'))

  sessionAllowedDirectories.add(libraryDir)
  saveSettings({
    directories: [libraryDir],
    defaultDirectory: libraryDir
  })

  assert.strictEqual(await isVideoContentFile(transportStreamPath), true)
  assert.strictEqual(await isVideoContentFile(typeScriptPath), false)

  const metadata = await getVideoMetadata(videoPath)
  assert.strictEqual(metadata.available, true)
  assert.strictEqual(metadata.width, 424)
  assert.strictEqual(metadata.height, 240)
  assert.strictEqual(metadata.videoCodec, 'h264')
  assert.strictEqual(metadata.audioCodec, 'aac')
  assert.ok(metadata.durationSeconds > 0)
  const transportMetadata = await getVideoMetadata(transportStreamPath)
  assert.strictEqual(transportMetadata.available, true)
  assert.strictEqual(transportMetadata.videoCodec, 'h264')

  const firstScan = await scanWithCache(libraryDir, true)
  assert.strictEqual(firstScan.count, 2)
  // 扫描器返回的 fullPath 是 realpath 后的，与 fixture 字面量在 subst/junction
  // 环境下不同，按归一化路径键比较
  const firstVideo = firstScan.videos.find(item => normalizedPathKey(item.fullPath) === normalizedPathKey(videoPath))
  assert.ok(firstVideo?.media?.videoCodec === 'h264', 'scanned video media should come from cache')
  assert.ok(firstScan.videos.some(item => normalizedPathKey(item.fullPath) === normalizedPathKey(transportStreamPath)))
  assert.ok(!firstScan.videos.some(item => normalizedPathKey(item.fullPath) === normalizedPathKey(typeScriptPath)))

  const indexPath = getScanIndexPath(libraryDir)
  assert.ok(fs.existsSync(indexPath), 'scan index should be persisted')
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
  assert.strictEqual(Object.keys(index.entries).length, 2)

  directoryScanCache.clear()
  const secondScan = await scanWithCache(libraryDir, false)
  assert.strictEqual(secondScan.count, 2)
  assert.strictEqual(secondScan.indexed, true)
  assert.strictEqual(secondScan.refreshing, true)
  assert.strictEqual(secondScan.videos[0].media?.width, 424)
  await waitForBackgroundScanRefreshes()

  fs.rmSync(videoPath, { force: true })
  fs.rmSync(transportStreamPath, { force: true })
  directoryScanCache.clear()
  const staleIndexScan = await scanWithCache(libraryDir, false)
  assert.strictEqual(staleIndexScan.count, 0)
  assert.strictEqual(staleIndexScan.indexed, undefined)
  await waitForBackgroundScanRefreshes()
}

async function cleanup() {
  try {
    const { unwatchAllDirectories } = require(path.join(projectRoot, 'main', 'scanner'))
    unwatchAllDirectories()
  } catch {}
  process.chdir(projectRoot)
  fs.rmSync(tempRoot, { recursive: true, force: true })
}

main()
  .then(() => {
    console.log('video metadata cache verification passed')
  })
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await cleanup()
    // 显式退出：未 await 的 ffmpeg 子进程或 fs.watch 句柄会阻止进程自然退出，
    // 否则断言失败时 CI 步骤会无限挂起
    process.exit(process.exitCode || 0)
  })
