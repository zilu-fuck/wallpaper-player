const assert = require('assert')
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const projectRoot = path.resolve(__dirname, '..')
const ffmpeg = path.join(projectRoot, 'vendor', 'ffmpeg', 'bin', 'ffmpeg.exe')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wallpaper-player-metadata-'))
const libraryDir = path.join(tempRoot, 'library')
const videoPath = path.join(libraryDir, 'metadata-sample.mp4')

function run(file, args) {
  return execFileSync(file, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

async function main() {
  assert.ok(fs.existsSync(ffmpeg), `missing ffmpeg: ${ffmpeg}`)
  fs.mkdirSync(libraryDir, { recursive: true })
  run(ffmpeg, [
    '-hide_banner',
    '-y',
    '-f', 'lavfi',
    '-i', 'testsrc=size=424x240:rate=12',
    '-f', 'lavfi',
    '-i', 'sine=frequency=440:sample_rate=44100',
    '-t', '1',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    videoPath
  ])

  process.chdir(tempRoot)
  const { sessionAllowedDirectories, saveSettings } = require(path.join(projectRoot, 'main', 'settings'))
  const { getVideoMetadata } = require(path.join(projectRoot, 'main', 'video-metadata'))
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

  const metadata = await getVideoMetadata(videoPath)
  assert.strictEqual(metadata.available, true)
  assert.strictEqual(metadata.width, 424)
  assert.strictEqual(metadata.height, 240)
  assert.strictEqual(metadata.videoCodec, 'h264')
  assert.strictEqual(metadata.audioCodec, 'aac')
  assert.ok(metadata.durationSeconds > 0)

  const firstScan = await scanWithCache(libraryDir, true)
  assert.strictEqual(firstScan.count, 1)
  assert.strictEqual(firstScan.videos[0].media?.videoCodec, 'h264')

  const indexPath = getScanIndexPath(libraryDir)
  assert.ok(fs.existsSync(indexPath), 'scan index should be persisted')
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
  assert.strictEqual(Object.keys(index.entries).length, 1)

  directoryScanCache.clear()
  const secondScan = await scanWithCache(libraryDir, false)
  assert.strictEqual(secondScan.count, 1)
  assert.strictEqual(secondScan.indexed, true)
  assert.strictEqual(secondScan.refreshing, true)
  assert.strictEqual(secondScan.videos[0].media?.width, 424)
  await waitForBackgroundScanRefreshes()

  fs.rmSync(videoPath, { force: true })
  directoryScanCache.clear()
  const staleIndexScan = await scanWithCache(libraryDir, false)
  assert.strictEqual(staleIndexScan.count, 0)
  assert.strictEqual(staleIndexScan.indexed, undefined)
  await waitForBackgroundScanRefreshes()

  unwatchAllDirectories()
  console.log('video metadata cache verification passed')
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
