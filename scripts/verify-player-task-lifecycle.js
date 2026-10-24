const assert = require('assert'), http = require('http')
const { phone } = require('./mobile-module-harness')
const { createHookHarness, find } = require('./verify-mobile-player-behavior')
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const until = async predicate => {
  const deadline = Date.now() + 5000
  while (!predicate()) { if (Date.now() > deadline) throw new Error('player task lifecycle wait timed out'); await new Promise(resolve => setTimeout(resolve, 5)) }
}
async function main() {
  const control = { requests: [], closed: 0, transcodeGate: null, analysisGate: null, analysisStartGate: null,
    analysisLoseCancel: false, analysisCancelGate: null, analysisReleased: new Set(), analysisInterest: '', ready: false, terminalStatus: null, loseCancel: false }
  const analysis = { enabled: true, analysis: { available: false }, job: { running: true, currentVideo: true }, recent: null, checkedAt: 1 }
  const server = http.createServer(async (req, res) => {
    const record = { method: req.method, path: req.url }; control.requests.push(record)
    res.once('close', () => { if (!res.writableFinished) control.closed++ })
    const json = data => { if (!res.destroyed) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) } }
    if (req.url.includes('/transcode')) {
      if (req.method === 'DELETE') {
        if (control.loseCancel) { control.loseCancel = false; res.destroy(); return }
        json({ success: true, released: true, shared: true, taskCancelled: false }); return
      }
      if (req.method === 'GET' && control.transcodeGate) await control.transcodeGate.promise
      json({ status: control.terminalStatus || (control.ready ? 'ready' : 'queued'), progress: control.ready ? 1 : .2,
        interestId: new URL(req.url, 'http://localhost').searchParams.get('interestId'), canCancel: !control.ready, interestedClients: 1,
        streamUrl: control.ready ? '/v1/videos/a/transcoded' : undefined }); return
    }
    if (req.url.includes('/analysis')) {
      const interestId = new URL(req.url, 'http://localhost').searchParams.get('interestId') || control.analysisInterest || 'legacy'
      if (req.method === 'DELETE') {
        if (control.analysisLoseCancel) { control.analysisLoseCancel = false; res.destroy(); return }
        control.analysisReleased.add(interestId)
        if (control.analysisCancelGate) await control.analysisCancelGate.promise
        json({ success: true, released: true, shared: true, taskCancelled: false }); return
      }
      if (req.method === 'POST') control.analysisInterest = interestId
      if (req.method === 'POST' && control.analysisStartGate) await control.analysisStartGate.promise
      if (req.method === 'GET' && control.analysisGate) await control.analysisGate.promise
      json({ ...analysis, job: { ...analysis.job, jobId: 'analysis-fixture', interestId,
        canCancel: !control.analysisReleased.has(interestId), interestedClients: 2, interestCancelled: control.analysisReleased.has(interestId) }, accepted: req.method === 'POST' }); return
    }
    json({})
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const client = phone(), harness = createHookHarness(client), appListeners = new Set()
  client.stubs['react-native'].AppState = { currentState: 'active', addEventListener(_event, callback) {
    appListeners.add(callback); return { remove: () => appListeners.delete(callback) }
  } }
  const device = await client.load('mobile/src/persistence/devices.ts').saveDevice({ id: 'pc_tasks', name: 'Tasks',
    endpoint: 'http://127.0.0.1:' + server.address().port, token: 'task-token',
    capabilities: require('../packages/contracts').capabilitiesSchema.parse({ taskInterests: true, analysisInterests: true }) })
  client.override('mobile/src/persistence/playback.ts', { openPlaybackSession: async (_device, videoId) => ({ device, videoId, position: 0 }),
    closePlaybackSession() {}, recordPlayback: async () => {}, syncPendingPlayback: async () => ({ message: '' }) })
  const videos = ['a', 'b'].map(id => ({ id, name: id, size: 1, extension: '.mp4', customTags: [], systemTags: [],
    streamUrl: '/v1/videos/' + id + '/stream', thumbnailUrl: '/v1/videos/' + id + '/thumbnail' }))
  const { PlayerScreen } = client.load('mobile/src/screens/PlayerScreen.tsx')
  harness.mount(() => PlayerScreen({ device, video: videos[0], videos, navigation: { canGoBack: true, back() {}, navigate() {} } }))
  await harness.settle()
  const page = index => find(harness.tree(), 'FlatList').props.renderItem({ item: videos[index], index })
  try {
    control.transcodeGate = deferred()
    const start = find(page(0), 'VideoOverlay').props.onTranscode()
    await until(() => control.requests.some(request => request.method === 'GET' && request.path.includes('/transcode')))
    appListeners.forEach(listener => listener('background')); await harness.settle()
    await until(() => control.closed >= 1)
    const pausedRequests = control.requests.length
    await new Promise(resolve => setTimeout(resolve, 1300))
    assert.strictEqual(control.requests.length, pausedRequests, 'background must not continue polling')
    control.ready = true; control.transcodeGate.resolve(); control.transcodeGate = null
    await start
    appListeners.forEach(listener => listener('active'))
    await harness.until(() => find(page(0), 'VideoOverlay').props.transcoding === false)
    assert.strictEqual(control.requests.filter(request => request.method === 'POST' && request.path.includes('/transcode')).length, 1)
    assert.ok(harness.players[harness.players.length - 1].seeks.length === 0)

    control.analysisGate = deferred()
    find(page(0), 'VideoOverlay').props.onAnalysis()
    await until(() => control.requests.some(request => request.method === 'GET' && request.path.includes('/a/analysis')))
    const closedBeforeSwitch = control.closed
    find(harness.tree(), 'FlatList').props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { y: 800 } } })
    await harness.settle(); await until(() => control.closed > closedBeforeSwitch)
    control.analysisGate.resolve(); control.analysisGate = null
    await harness.settle()
    assert.ok(!find(harness.tree(), 'VideoAnalysisSheet'), 'switching videos dismisses the previous analysis sheet')
    control.analysisGate = deferred()
    find(page(1), 'VideoOverlay').props.onAnalysis()
    await harness.settle()
    await until(() => control.requests.some(request => request.method === 'GET' && request.path.includes('/b/analysis')))
    assert.strictEqual(find(harness.tree(), 'VideoAnalysisSheet').props.state, null, 'the next video cannot inherit the previous analysis result')
    control.analysisGate.resolve(); control.analysisGate = null
    await harness.settle()

    control.analysisStartGate = deferred()
    const pendingStart = find(harness.tree(), 'VideoAnalysisSheet').props.onStart()
    await until(() => control.requests.some(request => request.method === 'POST' && request.path.includes('/b/analysis')))
    const closedBeforePause = control.closed
    appListeners.forEach(listener => listener('background')); await harness.settle()
    await until(() => control.closed > closedBeforePause)
    control.analysisStartGate.resolve(); control.analysisStartGate = null
    await pendingStart
    const beforeResume = control.requests.length
    appListeners.forEach(listener => listener('active'))
    try { await harness.until(() => control.requests.length > beforeResume) }
    catch (error) { console.error({ requests: control.requests, listeners: appListeners.size,
      starting: find(harness.tree(), 'VideoAnalysisSheet')?.props.starting }); throw error }
    assert.strictEqual(control.requests.filter(request => request.method === 'POST' && request.path.includes('/b/analysis')).length, 1,
      'an ambiguous accepted start must resume through GET, never repeated POST')
    assert.strictEqual(control.requests.filter(request => request.method === 'DELETE').length, 0, 'leaving only stops observation, not shared server work')
    find(harness.tree(), 'VideoAnalysisSheet').props.onClose(); await harness.settle()
    control.ready = false
    await find(page(1), 'VideoOverlay').props.onTranscode(); await harness.settle()
    control.loseCancel = true
    await find(page(1), 'VideoOverlay').props.onCancelTranscode(); await harness.settle()
    assert.strictEqual(find(page(1), 'VideoOverlay').props.transcoding, true, 'lost cancel confirmation preserves the same interest for retry')
    await find(page(1), 'VideoOverlay').props.onCancelTranscode(); await harness.settle()
    assert.ok(find(page(1), 'VideoOverlay').props.gestureHint.includes('其他设备'))
    const cancelPaths = control.requests.filter(request => request.method === 'DELETE').map(request => request.path)
    assert.strictEqual(cancelPaths.length, 2); assert.strictEqual(cancelPaths[0], cancelPaths[1])
    const beforeCancelledGets = control.requests.filter(request => request.method === 'GET' && request.path.includes('/b/transcode')).length
    control.terminalStatus = 'cancelled'
    await find(page(1), 'VideoOverlay').props.onTranscode(); await harness.settle()
    assert.strictEqual(find(page(1), 'VideoOverlay').props.transcoding, false)
    appListeners.forEach(listener => listener('background')); await harness.settle()
    appListeners.forEach(listener => listener('active')); await harness.settle()
    assert.strictEqual(control.requests.filter(request => request.method === 'GET' && request.path.includes('/b/transcode')).length, beforeCancelledGets,
      'a cancelled terminal task cannot restart polling after returning to the foreground')
    find(page(1), 'VideoOverlay').props.onAnalysis()
    await harness.until(() => find(harness.tree(), 'VideoAnalysisSheet')?.props.state?.job?.canCancel)
    control.analysisLoseCancel = true
    await find(harness.tree(), 'VideoAnalysisSheet').props.onCancel(); await harness.settle()
    await find(harness.tree(), 'VideoAnalysisSheet').props.onCancel(); await harness.settle()
    const cancelledAnalysisPaths = control.requests.filter(request => request.method === 'DELETE' && request.path.includes('/analysis')).map(request => request.path)
    assert.strictEqual(cancelledAnalysisPaths.length, 2); assert.strictEqual(cancelledAnalysisPaths[0], cancelledAnalysisPaths[1], 'an unconfirmed analysis cancellation retries the same nonce')
    assert.ok(find(harness.tree(), 'VideoAnalysisSheet').props.notice.includes('其他设备'))
    await find(harness.tree(), 'VideoAnalysisSheet').props.onStart(); await harness.settle()
    const previousInterest = control.analysisInterest
    assert.ok(!control.analysisReleased.has(previousInterest), 'a new explicit analysis starts with a new nonce')
    control.analysisCancelGate = deferred()
    const oldCancel = find(harness.tree(), 'VideoAnalysisSheet').props.onCancel()
    await until(() => control.analysisReleased.has(previousInterest))
    await find(harness.tree(), 'VideoAnalysisSheet').props.onStart(); await harness.settle()
    assert.notStrictEqual(control.analysisInterest, previousInterest)
    control.analysisCancelGate.resolve(); control.analysisCancelGate = null; await oldCancel; await harness.settle()
    assert.strictEqual(find(harness.tree(), 'VideoAnalysisSheet').props.state.job.canCancel, true, 'an old cancel response cannot clear the newer analysis interest')
    assert.strictEqual(find(harness.tree(), 'VideoAnalysisSheet').props.cancelling, false)
    harness.unmount(); await harness.settle()
    assert.strictEqual(appListeners.size, 0)
    assert.strictEqual(harness.players.filter(player => !player.released).length, 0)
    assert.deepStrictEqual(harness.diagnostics(), { intervals: 0, timers: 0, frames: 0, listeners: 0 })
    console.log('player task lifecycle passed: production screen and actual HTTP, background/socket cancellation, GET-only resume, resource switch isolation, no implicit server cancellation and subscription/player cleanup')
  } finally {
    harness.unmount(); control.transcodeGate?.resolve(); control.analysisGate?.resolve(); control.analysisStartGate?.resolve(); control.analysisCancelGate?.resolve()
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
