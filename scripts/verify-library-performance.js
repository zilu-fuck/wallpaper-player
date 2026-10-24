const assert = require('assert')
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const os = require('os')
const { performance, monitorEventLoopDelay } = require('perf_hooks')
const { execFile, spawn } = require('child_process')
const { promisify } = require('util')
const { requestJson, claimDevice, removeTempRootWithRetry } = require('./verify-helpers')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]

async function hotProbe(fixture) {
  process.chdir(fixture)
  const started = performance.now()
  const library = require(path.join(root, 'main/application/library-service'))
  const result = await library.queryLibrary({ limit: 200 }, '')
  const elapsed = performance.now() - started
  const scanner = require(path.join(root, 'main/scanner'))
  await scanner.waitForBackgroundScanRefreshes(); scanner.unwatchAllDirectories()
  process.stdout.write(JSON.stringify({ hotIndexedFirstPageMs: elapsed, count: result.count }) + '\n')
}
async function desktopProbe(fixture) {
  const started = performance.now(), env = { ...process.env, WALLPAPER_DESKTOP_LIBRARY_FIXTURE: fixture }
  delete env.ELECTRON_RUN_AS_NODE
  return new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [...process.argv.slice(2), path.join(__dirname, 'probe-desktop-library-startup.js'), fixture],
      { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', errors = '', evidence, timedOut = false
    const timeout = setTimeout(() => { timedOut = true; child.kill() }, 45000)
    child.stdout.on('data', chunk => {
      output += chunk
      const match = output.match(/DESKTOP_EVIDENCE:(.+)\r?\n/)
      if (!evidence && match) evidence = { desktopInteractiveMs: performance.now() - started, ...JSON.parse(match[1]) }
    })
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-6000) })
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('exit', code => {
      clearTimeout(timeout)
      if (timedOut || code || !evidence) reject(new Error('desktop probe ' + (timedOut ? 'timed out' : 'failed (' + code + ')') + ': ' + errors + output.slice(-3000)))
      else resolve(evidence)
    })
  })
}
async function measure(size) {
  fs.mkdirSync(parent, { recursive: true })
  const fixture = fs.mkdtempSync(path.join(parent, 'library-performance-'))
  process.chdir(fixture)
  // Each run must get its own settings, identity and snapshot singleton.
  for (const key of Object.keys(require.cache)) if (key.startsWith(path.join(root, 'main') + path.sep)) delete require.cache[key]
  const settings = require(path.join(root, 'main/settings')), scanner = require(path.join(root, 'main/scanner'))
  const library = require(path.join(root, 'main/application/library-service'))
  const identity = require(path.join(root, 'main/remote/identity'))
  const { createRemoteServer } = require(path.join(root, 'main/remote/server'))
  let server, delay
  try {
    const directory = path.join(fixture, '视频库'); await fsp.mkdir(directory)
    const header = Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex')
    let next = 0
    await Promise.all(Array.from({ length: 48 }, async () => {
      while (next < size) { const index = next++; await fsp.writeFile(path.join(directory, `视频-${index}.mp4`), header) }
    }))
    await settings.saveSettingsAndFlush({ directories: [directory], defaultDirectory: directory })
    const scanStart = performance.now(), scanned = await scanner.scanWithCache(directory, true)
    const coldScanMs = performance.now() - scanStart
    assert.strictEqual(scanned.videos.length, size)
    const customTags = Object.fromEntries(scanned.videos.filter((_, index) => index % 5 === 0).map((video, index) =>
      [video.fullPath, ['常用', '标签-' + index]]))
    await settings.saveSettingsAndFlush({ customTags })
    server = createRemoteServer({ port: 0 }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const endpoint = `http://127.0.0.1:${server.address().port}`
    const paired = await claimDevice({ baseUrl: endpoint, clientId: 'performance-phone', ...identity })
    const headers = { Authorization: 'Bearer ' + paired.token }
    const query = body => requestJson(endpoint + '/v1/library/query', { method: 'POST', headers, body: JSON.stringify(body) })
    const firstStarted = performance.now(), first = await query({ limit: 200 })
    const firstQueryMs = performance.now() - firstStarted
    assert.strictEqual(first.status, 200); assert.strictEqual(first.data.items.length, 200)
    delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable()
    const times = [], byteSizes = [], searchTimes = []
    for (let round = 0; round < 40; round++) {
      const started = performance.now(), response = await query({ limit: 200, query: round % 2 ? '视频' : '', sort: ['name', 'date', 'size', 'type'][round % 4] })
      times.push(performance.now() - started); byteSizes.push(Buffer.byteLength(JSON.stringify(response.data)))
      assert.strictEqual(response.status, 200)
      const searchStarted = performance.now()
      await query({ limit: 200, query: '视频-' + round, includeTags: [{ type: 'custom', name: '常用' }] })
      searchTimes.push(performance.now() - searchStarted)
    }
    const revisionStarted = performance.now()
    const revision = await requestJson(endpoint + '/v1/library/revision', { headers })
    assert.strictEqual(revision.data.revision, first.data.revision)
    const revisionMs = performance.now() - revisionStarted
    const diagnostics = library.getLibraryDiagnostics()
    assert.strictEqual(diagnostics.builds, 1, 'requests must reuse the resident index')
    delay.disable()
    const child = await promisify(execFile)(process.execPath, [__filename, '--hot-probe', fixture], { cwd: root, windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 })
    const hot = JSON.parse(child.stdout.trim().split(/\r?\n/).pop())
    assert.strictEqual(hot.count, size)
    let desktop = {}
    if (size === 10000) {
      const warmup = await desktopProbe(fixture), samples = []
      for (let run = 0; run < 3; run++) samples.push(await desktopProbe(fixture))
      desktop = { desktopWarmupMs: warmup.desktopInteractiveMs, desktopWarmup: warmup,
        desktopWarmupWithinBudget: warmup.desktopInteractiveMs <= 2000,
        desktopInteractiveMs: percentile(samples.map(sample => sample.desktopInteractiveMs), .95), desktopSamples: samples }
    }
    const result = { size, fixture: '24-byte MP4 headers on local disk; real scanner/settings/HTTP; no decoder or native UI',
      coldScanMs, firstQueryMs, queryP95Ms: percentile(times, .95), searchP95Ms: percentile(searchTimes, .95),
      responseP95Bytes: percentile(byteSizes, .95), revisionMs, eventLoopP95Ms: delay.percentile(95) / 1e6,
      snapshotBuilds: diagnostics.builds, ...hot, ...desktop }
    // Preserve the measured phases even when a budget assertion fails.
    fs.writeFileSync(path.join(parent, `library-performance-latest-${size}.json`), JSON.stringify(result, null, 2) + '\n')
    assert.ok(result.queryP95Ms <= 500, JSON.stringify(result))
    assert.ok(result.searchP95Ms <= 150, JSON.stringify(result))
    assert.ok(result.eventLoopP95Ms <= 50, JSON.stringify(result))
    if (size === 10000) assert.ok(result.desktopInteractiveMs <= 2000, JSON.stringify(result))
    console.log(JSON.stringify(result))
    return result
  } finally {
    delay?.disable()
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    await scanner.waitForBackgroundScanRefreshes(); scanner.unwatchAllDirectories()
    await require(path.join(root, 'main/video-metadata')).disposeVideoMetadata(); await settings.flushSettingsWrites()
    process.chdir(root)
    assert.strictEqual(path.dirname(path.resolve(fixture)), parent); assert.ok(path.basename(fixture).startsWith('library-performance-'))
    await removeTempRootWithRetry(fixture)
  }
}
async function main() {
  if (process.argv[2] === '--hot-probe') return hotProbe(process.argv[3])
  const results = []
  for (const size of [5000, 10000]) results.push(await measure(size))
  assert.ok(results[1].responseP95Bytes < results[0].responseP95Bytes * 1.2, 'page response size must stay bounded as the library doubles')
  const evidence = { date: new Date().toISOString(), platform: process.platform, node: process.version,
    cpu: os.cpus()[0]?.model, memoryGb: os.totalmem() / 1024 ** 3, results,
    pending: ['desktop first-launch stability (separate warmup and its phases are recorded, not included in three scored starts)',
      'native phone first screen and scroll frames', 'playback/thumb contention and PSS', 'installed/portable Windows device matrix'] }
  fs.writeFileSync(path.join(parent, 'library-performance-evidence.json'), JSON.stringify(evidence, null, 2))
  console.log('library performance passed; native UI, decoder contention and device budgets remain separate acceptance gates')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
