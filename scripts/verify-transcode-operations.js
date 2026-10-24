const assert = require('assert'), fs = require('fs'), path = require('path')
const { createFixtureVideo, runExec, removeTempRootWithRetry } = require('./verify-helpers')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp', 'refactor-tests')
fs.mkdirSync(parent, { recursive: true })
const fixture = fs.mkdtempSync(path.join(parent, 'transcode-operations-'))
const ffmpeg = path.join(root, 'vendor/ffmpeg/bin/ffmpeg.exe'), ffprobe = path.join(root, 'vendor/ffmpeg/bin/ffprobe.exe')
const until = async predicate => { const deadline = Date.now() + 15000
  while (!predicate()) { if (Date.now() > deadline) throw new Error('real transcode did not finish'); await new Promise(done => setTimeout(done, 10)) } }
async function main() {
  process.chdir(fixture)
  process.env.WALLPAPER_PLAYER_FFMPEG_PATH = ffmpeg; process.env.WALLPAPER_PLAYER_FFPROBE_PATH = ffprobe
  const worker = require('../main/remote/transcode'), compatible = path.join(fixture, 'compatible.mkv'), unsupported = path.join(fixture, 'unsupported.mkv')
  try {
    await createFixtureVideo({ ffmpeg, destPath: compatible, size: '320x240', rate: 15, duration: 1, vcodec: 'libx264', acodec: 'aac', extraArgs: ['-pix_fmt', 'yuv420p'] })
    await createFixtureVideo({ ffmpeg, destPath: unsupported, size: '320x240', rate: 15, duration: 1, vcodec: 'libvpx-vp9', acodec: 'libopus', extraArgs: ['-b:v', '250k'] })
    const remux = await worker.startMobileTranscode('remux', compatible)
    await until(() => worker.getMobileTranscodeStatus('remux')?.status === 'ready')
    assert.strictEqual(remux.operation, 'remux')
    const remuxOutput = worker.getTranscodedPath('remux')
    const packets = file => JSON.parse(runExec(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_packets',
      '-show_entries', 'packet=data_hash', '-show_data_hash', 'sha256', '-of', 'json', file])).packets.map(packet => packet.data_hash)
    assert.deepStrictEqual(packets(remuxOutput), packets(compatible), 'remux must preserve encoded video packets')
    const encoded = await worker.startMobileTranscode('encoded', unsupported)
    await until(() => worker.getMobileTranscodeStatus('encoded')?.status === 'ready')
    assert.strictEqual(encoded.operation, 'reencode')
    const output = worker.getTranscodedPath('encoded')
    const codecs = JSON.parse(runExec(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,pix_fmt', '-of', 'json', output])).streams
    assert.strictEqual(codecs.find(stream => stream.codec_type === 'video').codec_name, 'h264')
    assert.strictEqual(codecs.find(stream => stream.codec_type === 'video').pix_fmt, 'yuv420p')
    assert.strictEqual(codecs.find(stream => stream.codec_type === 'audio').codec_name, 'aac')
    for (let index = 0; index < 260; index++) {
      await worker.startMobileTranscode('alias_' + index, compatible)
      await until(() => worker.getMobileTranscodeStatus('alias_' + index)?.status === 'ready')
    }
    assert.ok(worker.getTranscodeDiagnostics().tasks <= 256, 'completed task history has a memory bound')
    assert.strictEqual(worker.selectTranscodeOperation({ streams: [{ codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 3840, height: 2160 }] }, 'compatible'), 'reencode')
    assert.strictEqual(worker.selectTranscodeOperation({ streams: [{ codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p10le', width: 640, height: 360 }] }, 'compatible'), 'reencode')
    const quality = await worker.startMobileTranscode('quality', compatible, '720p')
    await until(() => quality.process)
    assert.strictEqual(quality.operation, 'reencode')
    await worker.disposeTranscodes()
    const diagnostic = worker.getTranscodeDiagnostics()
    assert.ok(diagnostic.tasks <= 256)
    assert.deepStrictEqual({ ...diagnostic, tasks: 0 }, { tasks: 0, preparing: 0, running: 0, processes: 0, closing: true })
    assert.strictEqual(quality.process, null, 'shutdown waits for the actual FFmpeg process to close')
    await assert.rejects(worker.startMobileTranscode('after-exit', compatible), error => error.code === 'transcode_stopping')
    console.log('transcode operations passed: actual FFmpeg worker, packet-preserving H264/AAC remux, VP9/Opus reencode to H264/AAC, oversized/10-bit/quality decisions and actual process shutdown')
  } finally { await worker.disposeTranscodes(); await worker.cleanupTranscodeCache({ force: true }) }
}
main().finally(async () => { process.chdir(root); assert.strictEqual(path.dirname(path.resolve(fixture)), parent); await removeTempRootWithRetry(fixture) })
  .catch(error => { console.error(error); process.exitCode = 1 })
