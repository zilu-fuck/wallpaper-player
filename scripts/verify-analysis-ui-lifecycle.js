const assert = require('assert')
const { phone } = require('./mobile-module-harness')
const { createHookHarness } = require('./verify-mobile-player-behavior')
function nodes(tree, predicate) {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(node => nodes(node, predicate))
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)]
}
async function desktop() {
  const client = phone(), harness = createHookHarness(client), requests = [], listeners = new Set()
  let nextCancel = { success: true, released: true, taskCancelled: false, shared: true }
  const api = {
    getVideoAnalysisJob: async () => ({ running: false }),
    onVideoAnalysisEvent: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    startVideoAnalysis: (videoPath, interestId) => new Promise(resolve => requests.push({ videoPath, interestId, resolve })),
    cancelVideoAnalysis: async (jobId, interestId) => { assert.ok(interestId); return nextCancel }
  }
  client.control.globals.window = { electronAPI: api }
  const { useVideoAnalysisTasks } = client.load('src/hooks/useVideoAnalysisTasks.js')
  const options = { settings: { videoAnalysis: { enabled: true } }, plugins: [{ id: 'video-analysis', enabled: true }], pluginsLoaded: true, videos: [] }
  harness.mount(() => useVideoAnalysisTasks(options)); await harness.settle()
  const video = { fullPath: 'E:/fixture/source.mp4', name: 'source' }
  const emit = payload => listeners.forEach(listener => listener({ videoPath: video.fullPath, ...payload }))
  try {
    harness.tree().queueVideoAnalysis(video); await harness.until(() => requests.length === 1)
    emit({ jobId: 'early', status: 'success', analysis: { available: true, summary: 'completed-before-ACK' } })
    requests[0].resolve({ accepted: true, job: { jobId: 'early', canCancel: true, interestId: requests[0].interestId } })
    await harness.until(() => harness.tree().analysisTasks[0].status === 'success')
    const id = harness.tree().analysisTasks[0].id
    harness.tree().retryAnalysisTask(id); await harness.until(() => requests.length === 2)
    assert.notStrictEqual(requests[0].interestId, requests[1].interestId)
    emit({ jobId: 'early', status: 'running', event: { message: 'late old progress' } }); await harness.settle()
    assert.strictEqual(harness.tree().analysisTasks[0].status, 'starting')
    requests[1].resolve({ accepted: true, job: { jobId: 'new', canCancel: true, interestId: requests[1].interestId } })
    await harness.until(() => harness.tree().analysisTasks[0].jobId === 'new')
    await harness.tree().cancelRunningAnalysisTask(); await harness.settle()
    assert.strictEqual(harness.tree().analysisTasks[0].canCancel, false)
    emit({ jobId: 'new', status: 'running', event: { message: 'shared progress' } }); await harness.settle()
    assert.ok(harness.tree().analysisTasks[0].message.includes('其他设备'))
    emit({ jobId: 'new', status: 'success', analysis: { available: true } }); await harness.settle()
    assert.strictEqual(harness.tree().analysisTasks[0].status, 'success')

    harness.tree().retryAnalysisTask(id); await harness.until(() => requests.length === 3)
    nextCancel = { success: true, released: false, taskCancelled: false, shared: false }
    await harness.tree().cancelRunningAnalysisTask(); await harness.settle()
    requests[2].resolve({ accepted: false, reason: 'task_interest_closed' }); await harness.settle()
    assert.strictEqual(harness.tree().analysisTasks[0].status, 'cancelled')
    emit({ jobId: 'late-unowned', status: 'started' }); await harness.settle()
    assert.strictEqual(harness.tree().analysisTasks[0].status, 'cancelled')
    harness.unmount(); assert.strictEqual(listeners.size, 0)
  } finally { harness.unmount() }
}
async function mobileSheet() {
  const client = phone(), harness = createHookHarness(client, { realComponents: ['VideoAnalysisSheet'] })
  Object.assign(client.stubs['react-native'], { Pressable: 'Pressable', Text: 'Text', ScrollView: 'ScrollView', ActivityIndicator: 'ActivityIndicator' })
  client.stubs['lucide-react-native'] = { Brain: 'Brain', ChevronDown: 'ChevronDown', PlayCircle: 'PlayCircle', RefreshCw: 'RefreshCw' }
  client.override('mobile/src/theme-context.tsx', { useTheme: () => ({ colors: client.load('mobile/src/theme.ts').darkColors }) })
  const { VideoAnalysisSheet } = client.load('mobile/src/components/player/VideoAnalysisSheet.tsx')
  let canCancel = true, cancelled = 0, supportsCancellation = true
  const render = () => VideoAnalysisSheet({ visible: true, video: { id: 'one', name: 'one' }, loading: false, starting: false, currentTime: 0, selectedTags: [], onSelectionChange() {},
    state: { enabled: true, analysis: null, recent: null, checkedAt: 1, job: { running: true, currentVideo: true, canCancel } },
    onStart() {}, onCancel: supportsCancellation ? () => cancelled++ : undefined, onRefresh() {}, onClose() {}, onSeek() {} })
  harness.mount(render); await harness.settle()
  const cancelButton = nodes(harness.tree(), node => node.props?.accessibilityLabel === '取消本次分析')[0]
  assert.ok(cancelButton); cancelButton.props.onPress(); assert.strictEqual(cancelled, 1)
  canCancel = false; harness.mount(render); await harness.settle()
  assert.strictEqual(nodes(harness.tree(), node => node.props?.accessibilityLabel === '取消本次分析').length, 0)
  const join = nodes(harness.tree(), node => node.type === 'Pressable' && nodes(node, child => child.type === 'Text' && child.props.children === '加入当前分析').length)[0]
  assert.ok(join); assert.strictEqual(join.props.disabled, false)
  supportsCancellation = false; harness.mount(render); await harness.settle()
  assert.strictEqual(nodes(harness.tree(), node => node.props?.accessibilityLabel === '取消本次分析').length, 0)
  harness.unmount()
}
desktop().then(mobileSheet).then(() => console.log('analysis UI lifecycle passed: production desktop hooks/job-ID events, completion before ACK, retry/late/cancel isolation, shared-owner observation and real mobile sheet cancellation/join/legacy controls')).catch(error => { console.error(error); process.exitCode = 1 })
