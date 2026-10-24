const assert = require('assert'), fs = require('fs'), path = require('path')
const { phone } = require('./mobile-module-harness')
const { createHookHarness, find, activePage } = require('./verify-mobile-player-behavior')
const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children), ...nodes(tree.props?.footer)]
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

async function sheetScreen() {
  const client = phone(), harness = createHookHarness(client), appListeners = new Set(), backs = new Set()
  const native = client.stubs['react-native']
  native.AppState.addEventListener = (_, callback) => { appListeners.add(callback); return { remove: () => appListeners.delete(callback) } }
  native.BackHandler.addEventListener = (_, callback) => { backs.add(callback); return { remove: () => backs.delete(callback) } }
  client.override('mobile/src/components/AccessibleModal.tsx', { AccessibleModal: 'AccessibleModal' })
  let openedSessions = 0, navigated = 0, writes = 0, additions = 0, transcodes = 0, clipboard = null, add = null
  client.stubs['expo-clipboard'].setStringAsync = () => clipboard?.promise || Promise.resolve()
  client.override('mobile/src/persistence/playback.ts', {
    openPlaybackSession: async (device, videoId) => { openedSessions++; return { device, videoId, position: 0 } },
    closePlaybackSession() {}, recordPlayback: async () => {}, syncPendingPlayback: async () => ({ message: '' })
  })
  const realApi = client.load('mobile/src/services/api.ts')
  client.override('mobile/src/services/api.ts', { ...realApi,
    getVideoAnalysis: async () => ({ enabled: true, analysis: { available: true, tags: ['候选标签'], keywords: [], timeline: [] }, job: null, recent: null }),
    addTagsToVideos: async () => { additions++; return await add.promise }, startTranscode: async () => { transcodes++; return { status: 'error' } }
  })
  client.override('mobile/src/services/tag-editing.ts', {
    openTagEdit: async (device, video) => ({ device, video: { ...video }, revision: 0 }),
    saveTagEdit: async (_, tags) => { writes++; return { customTags: tags, customTagsRevision: writes } }
  })
  const { PlayerScreen } = client.load('mobile/src/screens/PlayerScreen.tsx')
  const videos = ['a', 'b'].map(id => ({ id, name: id, streamUrl: '/v1/videos/' + id + '/stream', thumbnailUrl: '', customTags: ['原标签'], extension: '.mp4', size: 1 }))
  const device = { id: 'panel-device', bindingId: 'panel-binding', endpoint: 'http://127.0.0.1:1', token: 'fixture', capabilities: { analysisInterests: true } }
  const render = () => PlayerScreen({ device, video: videos[0], videos, navigation: { canGoBack: true, back() { navigated++ }, navigate() { navigated++ } } })
  harness.mount(render); await harness.settle()
  const player = harness.players[0]
  player.status = 'readyToPlay'; player.listeners.sourceLoad({ videoSource: player.source, duration: 100, availableVideoTracks: [] }); await harness.settle()
  let index = 0
  const overlay = () => find(find(harness.tree(), 'FlatList').props.renderItem({ item: videos[index], index }), 'VideoOverlay').props
  const panel = type => find(harness.tree(), type)?.props
  const countWindows = () => nodes(harness.tree()).filter(node => node.type === 'AccessibleModal').length
  overlay().onMore(); await harness.settle()
  assert.strictEqual(countWindows(), 1); assert.ok(panel('PlayerMoreSheet'))
  assert.ok(!find(activePage(harness, videos[0]), 'PlayerMoreSheet'), 'the native sheet owner must be outside virtualized video pages')
  const firstMore = panel('PlayerMoreSheet'), firstModal = panel('AccessibleModal')
  assert.strictEqual(find(harness.tree(), 'FlatList').props.importantForAccessibility, 'no-hide-descendants')
  await overlay().onTags(); await harness.settle()
  assert.strictEqual(countWindows(), 1); assert.ok(!panel('PlayerMoreSheet'))
  firstMore.onClose(); firstModal.onClose(); await harness.settle()
  assert.ok(panel('TagEditorSheet'), 'late close from an older native window cannot close a newer sheet')
  const staleTag = panel('TagEditorSheet')
  staleTag.editor.setText('尚未提交的输入'); staleTag.editor.toggle('选择中的标签'); await harness.settle()
  appListeners.forEach(listener => listener('background')); await harness.settle(); assert.strictEqual(countWindows(), 0)
  appListeners.forEach(listener => listener('active')); await harness.settle(); assert.strictEqual(countWindows(), 1)
  assert.strictEqual(panel('TagEditorSheet').editor.text, '尚未提交的输入')
  assert.ok(panel('TagEditorSheet').editor.tags.includes('选择中的标签'))
  assert.strictEqual(openedSessions, 1); assert.strictEqual(harness.players.length, 1)
  await [...backs].at(-1)(); await harness.settle()
  assert.strictEqual(countWindows(), 0); assert.strictEqual(navigated, 0, 'back closes the sheet before leaving the player')
  assert.strictEqual(find(harness.tree(), 'FlatList').props.importantForAccessibility, 'auto')
  overlay().onMore(); await harness.settle(); clipboard = deferred()
  const copying = panel('PlayerMoreSheet').onCopyName()
  panel('PlayerMoreSheet').onClose(); overlay().onMore(); await harness.settle()
  clipboard.resolve(); await copying; await harness.settle()
  assert.ok(panel('PlayerMoreSheet'), 'a late clipboard ACK cannot close a reopened more sheet')
  const staleMore = panel('PlayerMoreSheet')
  overlay().onAnalysis(); await harness.settle()
  assert.ok(panel('VideoAnalysisSheet')); assert.ok(!panel('PlayerMoreSheet')); assert.strictEqual(countWindows(), 1)
  staleMore.onQualitySelect('720p'); await harness.settle(); assert.strictEqual(transcodes, 0)
  let analysis = panel('VideoAnalysisSheet')
  analysis.onSelectionChange(['候选标签']); await harness.settle()
  appListeners.forEach(listener => listener('background')); await harness.settle()
  appListeners.forEach(listener => listener('active')); await harness.settle()
  assert.deepStrictEqual(Array.from(panel('VideoAnalysisSheet').selectedTags), ['候选标签'])
  add = deferred(); analysis = panel('VideoAnalysisSheet')
  const failed = analysis.onAddTags(['候选标签']); const duplicate = analysis.onAddTags(['候选标签'])
  await harness.settle(); assert.strictEqual(additions, 1, 'same-frame repeated presses share one pending tag addition')
  add.reject(new Error('fixture write failure')); await Promise.all([failed, duplicate]); await harness.settle()
  assert.deepStrictEqual(Array.from(panel('VideoAnalysisSheet').selectedTags), ['候选标签'])
  assert.ok(panel('VideoAnalysisSheet').notice.includes('fixture write failure'))
  add = deferred(); const saved = panel('VideoAnalysisSheet').onAddTags(['候选标签'])
  add.resolve({ updated: [{ customTags: ['候选标签'], customTagsRevision: 1 }], failed: [] }); await saved; await harness.settle()
  assert.deepStrictEqual(Array.from(panel('VideoAnalysisSheet').selectedTags), [])
  const oldAnalysis = panel('VideoAnalysisSheet')
  find(harness.tree(), 'FlatList').props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { y: 800 } } }); index = 1; await harness.settle()
  await overlay().onTags(); await harness.settle(); assert.strictEqual(panel('TagEditorSheet').video.id, 'b')
  await staleTag.onSave(['must-not-write-b']); oldAnalysis.onClose(); oldAnalysis.onSeek(90); await harness.settle()
  assert.strictEqual(writes, 0, 'old native editor callbacks cannot save to the new current tag session')
  assert.strictEqual(panel('TagEditorSheet').video.id, 'b')
  panel('TagEditorSheet').onClose(); overlay().onMore(); await harness.settle()
  panel('PlayerMoreSheet').onQualitySelect('720p'); await harness.until(() => transcodes === 1)
  overlay().onMore(); await harness.settle()
  await panel('PlayerMoreSheet').onHideFromPlaylist(); await harness.settle()
  assert.deepStrictEqual(Array.from(find(harness.tree(), 'FlatList').props.data, video => video.id), ['a'], 'the live more-sheet action must remove the requested playlist item')
  harness.unmount(); await harness.settle()
  assert.strictEqual(appListeners.size, 0); assert.strictEqual(backs.size, 0)
  assert.deepStrictEqual(harness.diagnostics(), { intervals: 0, timers: 0, frames: 0, listeners: 0 })
  return { singleNativeOwner: true, outsideVirtualizedPages: true, backKeepsPlayer: true, tagDraftSurvivesBackground: true,
    analysisSelectionSurvivesBackground: true, lateCloseClipboardAndMutationEventsRejected: true, failedAddKeepsSelection: true,
    totalAddRequestsWithOneRetry: additions, liveQualityRequests: transcodes, playlistHideApplied: true }
}

async function themeAndFrame() {
  for (const mode of ['dark', 'light']) {
    const client = phone(), harness = createHookHarness(client, { realComponents: ['PlayerMoreSheet'] })
    const colors = client.load('mobile/src/theme.ts').themeColors[mode]
    client.override('mobile/src/theme-context.tsx', { useTheme: () => ({ colors }) })
    Object.assign(client.stubs['react-native'], { KeyboardAvoidingView: 'KeyboardAvoidingView', Pressable: 'Pressable', Text: 'Text', ScrollView: 'ScrollView' })
    client.stubs['react-native-safe-area-context'].useSafeAreaInsets = () => ({ top: 24, bottom: 24, left: 0, right: 0 })
    client.stubs['lucide-react-native'] = new Proxy({}, { get: (_, name) => name })
    const { PlayerSheetFrame } = client.load('mobile/src/components/player/PlayerSheetFrame.tsx')
    let closed = 0
    harness.mount(() => PlayerSheetFrame({ title: '管理标签', onClose() { closed++ }, notice: '可见操作结果', children: 'scroll-content', footer: 'save' }))
    const all = nodes(harness.tree()), dragHeader = all.find(node => node.props?.onMoveShouldSetPanResponder)
    assert.strictEqual(harness.tree().props.behavior, 'padding', 'both platforms must avoid the keyboard even when the native modal does not resize')
    assert.strictEqual(harness.tree().props.keyboardVerticalOffset, 48, 'the Android translucent modal must include its safe-area origin and navigation inset')
    assert.ok(dragHeader); assert.strictEqual(harness.tree().props.onMoveShouldSetPanResponder, undefined, 'scrollable content cannot be intercepted by the drag-to-close responder')
    all.find(node => node.props?.accessibilityLabel === '关闭管理标签').props.onPress(); assert.strictEqual(closed, 1)
    assert.ok(all.find(node => node.props?.accessibilityLiveRegion === 'polite'))
    const { AccessibleModal } = client.load('mobile/src/components/AccessibleModal.tsx')
    client.stubs['react-native'].Modal = 'Modal'; client.stubs['react-native-safe-area-context'].SafeAreaView = 'SafeAreaView'
    const modal = AccessibleModal({ label: '管理标签', children: 'content', onClose() { closed++ }, supportedOrientations: ['portrait', 'landscape-left'] })
    assert.deepStrictEqual(Array.from(modal.props.supportedOrientations), ['portrait', 'landscape-left'])
    modal.props.onRequestClose(); assert.strictEqual(closed, 2)
    harness.unmount()
    const menuHarness = createHookHarness(client, { realComponents: ['PlayerMoreSheet'] })
    Object.assign(client.stubs['react-native'], { Pressable: 'Pressable', Text: 'Text' })
    const { PlayerMoreSheet } = client.load('mobile/src/components/player/PlayerMoreSheet.tsx')
    const hits = []
    const commands = ['收藏', '管理标签', '视频分析', '缓存兼容格式', '在电脑端播放']
    const callback = label => () => hits.push(label)
    const props = { visible: true, video: { id: 'menu', name: '长名称' }, playbackRate: 1, aspectMode: 'fit', playerBackgroundMode: 'black', selectedQuality: '原画', detailLine: 'detail', favorite: false,
      onClose() {}, onSpeedChange() {}, onAspectModeChange() {}, onPlayerBackgroundModeChange() {}, onQualitySelect() {},
      onSubtitleSelect() {}, onAudioTrackSelect() {}, onCopyName() {}, onRevealOnDesktop() {}, onClearTranscodeCache() {}, onFileInfo() {}, onHideFromPlaylist() {},
      onFavorite: callback('收藏'), onTags: callback('管理标签'), onAnalysis: callback('视频分析'), onCache: callback('缓存兼容格式'), onDesktopPlay: callback('在电脑端播放') }
    menuHarness.mount(() => PlayerMoreSheet(props))
    for (const label of commands) { const button = nodes(menuHarness.tree()).find(node => node.props?.accessibilityLabel === label); assert.ok(button, label); button.props.onPress() }
    assert.deepStrictEqual(hits, commands, 'compact/fullscreen commands remain available through the actual more-menu component')
    menuHarness.mount(() => PlayerMoreSheet({ ...props, networkResource: true }))
    assert.ok(!nodes(menuHarness.tree()).find(node => node.props?.accessibilityLabel === '视频分析'))
    assert.ok(!nodes(menuHarness.tree()).find(node => node.props?.accessibilityLabel === '缓存兼容格式'))
    assert.ok(nodes(menuHarness.tree()).find(node => node.props?.accessibilityLabel === '管理标签'))
    menuHarness.unmount()
  }
}
(async () => {
  const behavior = await sheetScreen(); await themeAndFrame()
  const folder = path.resolve(__dirname, '../.tmp/refactor-tests'); fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(path.join(folder, 'player-panel-behavior.json'), JSON.stringify({ date: new Date().toISOString(), behavior,
    conditions: 'Production PlayerScreen/hooks/frame; native player/windows/events and selected API/clipboard results controlled. Verifies ownership, draft and callback behavior; native layout and reader/device gates are separate.' }, null, 2) + '\n')
  console.log('mobile player panels passed: one owner outside video cells, back/draft/background/clipboard and stale mutation ownership, analysis failure/retry/dedup, shared frame and orientation wiring')
})().catch(error => { console.error(error); process.exitCode = 1 })
