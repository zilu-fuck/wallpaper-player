const assert = require('assert')
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const root = path.resolve(__dirname, '..')
const ffmpeg = path.join(root, 'vendor', 'ffmpeg', 'bin', 'ffmpeg.exe')
const ffprobe = path.join(root, 'vendor', 'ffmpeg', 'bin', 'ffprobe.exe')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wallpaper-player-transcode-verify-'))
const sourcePath = path.join(tempRoot, 'source.mkv')
const incompatibleSourcePath = path.join(tempRoot, 'source-vp9-opus.mkv')
const outputPath = path.join(tempRoot, 'mobile-output.tmp')
const incompatibleOutputPath = path.join(tempRoot, 'mobile-vp9-output.tmp')

function run(file, args) {
  return execFileSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

try {
  assert.ok(fs.existsSync(ffmpeg), `missing ffmpeg: ${ffmpeg}`)
  assert.ok(fs.existsSync(ffprobe), `missing ffprobe: ${ffprobe}`)

  run(ffmpeg, [
    '-hide_banner',
    '-y',
    '-f', 'lavfi',
    '-i', 'testsrc=size=320x240:rate=15',
    '-f', 'lavfi',
    '-i', 'sine=frequency=1000:sample_rate=44100',
    '-t', '1',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    sourcePath
  ])

  run(ffmpeg, [
    '-hide_banner',
    '-y',
    '-f', 'lavfi',
    '-i', 'testsrc=size=426x240:rate=15',
    '-f', 'lavfi',
    '-i', 'sine=frequency=660:sample_rate=48000',
    '-t', '1',
    '-c:v', 'libvpx-vp9',
    '-b:v', '250k',
    '-c:a', 'libopus',
    incompatibleSourcePath
  ])

  run(ffmpeg, [
    '-hide_banner',
    '-y',
    '-i', sourcePath,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-vf', 'scale=trunc(if(gte(iw\\,ih)\\,min(iw\\,1920)\\,min(iw\\,1080))/2)*2:trunc(if(gte(iw\\,ih)\\,min(ih\\,1080)\\,min(ih\\,1920))/2)*2:force_original_aspect_ratio=decrease',
    '-f', 'mp4',
    outputPath
  ])

  run(ffmpeg, [
    '-hide_banner',
    '-y',
    '-i', incompatibleSourcePath,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '24',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-vf', 'scale=trunc(if(gte(iw\\,ih)\\,min(iw\\,1280)\\,min(iw\\,720))/2)*2:trunc(if(gte(iw\\,ih)\\,min(ih\\,720)\\,min(ih\\,1280))/2)*2:force_original_aspect_ratio=decrease',
    '-f', 'mp4',
    incompatibleOutputPath
  ])

  const stat = fs.statSync(outputPath)
  assert.ok(stat.isFile() && stat.size > 0, 'transcoded output should exist')
  const incompatibleStat = fs.statSync(incompatibleOutputPath)
  assert.ok(incompatibleStat.isFile() && incompatibleStat.size > 0, 'incompatible transcoded output should exist')

  const videoCodec = run(ffprobe, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name',
    '-of', 'csv=p=0',
    outputPath
  ]).trim()
  const audioCodec = run(ffprobe, [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name',
    '-of', 'csv=p=0',
    outputPath
  ]).trim()

  assert.strictEqual(videoCodec, 'h264')
  assert.strictEqual(audioCodec, 'aac')
  assert.strictEqual(run(ffprobe, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name',
    '-of', 'csv=p=0',
    incompatibleOutputPath
  ]).trim(), 'h264')
  assert.strictEqual(run(ffprobe, [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name',
    '-of', 'csv=p=0',
    incompatibleOutputPath
  ]).trim(), 'aac')
  console.log('mobile transcode command verification passed')
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
