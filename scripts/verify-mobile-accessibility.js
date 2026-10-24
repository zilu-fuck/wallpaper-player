const assert = require('assert'), fs = require('fs'), path = require('path')
const { phone } = require('./mobile-module-harness')
const { createHookHarness } = require('./verify-mobile-player-behavior')
const delay = ms => new Promise(done => setTimeout(done, ms))
const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)]
const style = input => Array.isArray(input) ? Object.assign({}, ...input.map(style)) : input || {}

async function gridBehavior() {
  const client = phone()
  let grid, failures = 0, dimensions = { width: 400, height: 800, fontScale: 1 }, active = true, query = 'all'
  const positions = [], offsets = []
  const scroller = { scrollToIndex(value) { positions.push(value); if (failures-- > 0) grid.onScrollToIndexFailed({ averageItemLength: 200 }) },
    scrollToOffset(value) { offsets.push(value) } }
  const harness = createHookHarness(client, { commitRefs(tree) { tree.props.grid.listRef.current = scroller } })
  client.stubs['react-native'].useWindowDimensions = () => dimensions
  const { useAdaptiveVideoGrid, videoGridLayout } = client.load('mobile/src/hooks/useAdaptiveVideoGrid.ts')
  const items = Array.from({ length: 500 }, (_, index) => ({ id: 'v-' + index }))
  const render = () => { grid = useAdaptiveVideoGrid(items, query, active); return { type: 'Grid', props: { grid } } }
  const visible = index => grid.onViewableItemsChanged({ viewableItems: [{ item: items[index], key: items[index].id, index, isViewable: true }] })
  const matrix = []
  for (const width of [280, 320, 360, 400, 768, 1024]) for (const fontScale of [1, 1.3, 2, 2.5]) {
    const layout = videoGridLayout(width, fontScale)
    assert.ok(layout.columns >= 1 && layout.columns <= 4)
    assert.ok(layout.cardWidth * layout.columns + (layout.columns - 1) * 10 + 20 <= width)
    matrix.push({ width, fontScale, ...layout })
  }
  harness.mount(render); assert.strictEqual(grid.columns, 2)
  visible(240)
  grid.onViewableItemsChanged({ viewableItems: [{ item: items[0], key: items[0].id, index: undefined, isViewable: true }] })
  dimensions = { ...dimensions, fontScale: 2 }; harness.mount(render); await harness.settle()
  assert.strictEqual(grid.columns, 1); assert.strictEqual(positions.at(-1).index, 240)
  visible(0) // A newly mounted FlatList's first callback must not replace the saved video anchor.
  dimensions = { width: 720, height: 400, fontScale: 2 }; harness.mount(render); await harness.settle()
  assert.strictEqual(grid.columns, 2); assert.strictEqual(positions.at(-1).index, 120)
  grid.onLayout({ nativeEvent: { layout: { width: 640 } } }); await harness.settle()
  assert.strictEqual(grid.columns, 1); assert.strictEqual(positions.at(-1).index, 240)
  visible(240)
  active = false; const count = positions.length
  dimensions = { width: 1024, height: 500, fontScale: 1 }; harness.mount(render); await harness.settle()
  assert.strictEqual(positions.length, count, 'covered library does not scroll while the player owns the foreground')
  dimensions = { width: 400, height: 800, fontScale: 1 }; harness.mount(render)
  active = true; harness.mount(render); await harness.settle()
  assert.strictEqual(positions.at(-1).index, 120)
  visible(240); query = 'filtered'; harness.mount(render); await harness.settle()
  const beforeQuery = positions.length
  dimensions = { ...dimensions, fontScale: 2 }; harness.mount(render); await harness.settle()
  assert.strictEqual(positions.length, beforeQuery, 'a new query cannot reuse the previous query anchor')
  visible(10); failures = 1
  dimensions = { ...dimensions, fontScale: 1 }; harness.mount(render); await harness.settle()
  assert.strictEqual(offsets.at(-1).offset, 1000); assert.strictEqual(offsets.at(-1).animated, false)
  await delay(150); await harness.settle(); assert.strictEqual(positions.at(-1).index, 5)
  visible(10)
  failures = 100; dimensions = { ...dimensions, fontScale: 2 }; harness.mount(render)
  for (let attempt = 0; attempt < 10; attempt++) grid.onContentSizeChange()
  assert.strictEqual(harness.diagnostics().timers, 0, 'one layout generation has a finite retry budget')
  const exhausted = positions.length
  dimensions = { ...dimensions, fontScale: 1 }; harness.mount(render)
  assert.ok(positions.length > exhausted, 'a new layout receives a new retry budget for the saved video')
  failures = 0; visible(10)
  failures = 1; dimensions = { ...dimensions, fontScale: 2 }; harness.mount(render)
  assert.ok(harness.diagnostics().timers > 0)
  harness.unmount(); assert.strictEqual(harness.diagnostics().timers, 0)
  return matrix
}

async function componentBehavior() {
  const client = phone(), harness = createHookHarness(client)
  client.stubs.react.memo = component => component
  client.stubs['lucide-react-native'] = new Proxy({}, { get: (_, key) => key })
  Object.assign(client.stubs['react-native'], { Text: 'Text', Image: 'Image', Pressable: 'Pressable', ActivityIndicator: 'ActivityIndicator', Modal: 'Modal' })
  client.stubs['react-native-safe-area-context'].SafeAreaView = 'SafeAreaView'
  const { themeColors } = client.load('mobile/src/theme.ts')
  const luminance = hex => {
    const channels = hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722
  }
  const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05)
  for (const colors of Object.values(themeColors)) {
    for (const foreground of [colors.text, colors.muted, colors.subtle]) for (const background of [colors.background, colors.surface, colors.surfaceElevated]) {
      assert.ok(contrast(foreground, background) >= 4.5, 'ordinary semantic text must remain legible on opaque theme surfaces')
    }
    assert.ok(contrast(colors.onAccent, colors.accentStrong) >= 4.5)
  }
  let mode = 'dark'
  client.override('mobile/src/theme-context.tsx', { useTheme: () => ({ colors: themeColors[mode], themeMode: mode }) })
  const { VideoCard } = client.load('mobile/src/components/VideoCard.tsx')
  const { PrimaryButton } = client.load('mobile/src/components/PrimaryButton.tsx')
  const { AccessibleModal } = client.load('mobile/src/components/AccessibleModal.tsx')
  const video = { id: 'video-1', name: '完整的视频名称与目录信息', extension: '.mp4', size: 1024, thumbnailUrl: '/thumb', tags: [], favorite: false }
  let plays = 0, favorites = 0, selects = 0, selected = false
  for (mode of ['dark', 'light']) {
    harness.mount(() => VideoCard({ device: { endpoint: 'http://127.0.0.1:42000', token: 'fixture' }, video,
      onPress: () => plays++, onToggleFavorite: selected ? undefined : () => favorites++, onLongPress: () => selects++,
      selectionMode: selected, selected, width: 300 }))
    const buttons = nodes(harness.tree()).filter(node => node.type === 'Pressable')
    assert.strictEqual(buttons.length, 2)
    assert.strictEqual(nodes(buttons[0].props.children).some(node => node.type === 'Pressable'), false, 'favorite is a sibling accessibility target, not grouped inside the playback button')
    assert.ok(buttons[0].props.accessibilityLabel.includes(video.name))
    assert.strictEqual(style(buttons[1].props.style).width, 48); assert.strictEqual(style(buttons[1].props.style).height, 48)
    buttons[0].props.onPress(); buttons[1].props.onPress()
    buttons[0].props.onAccessibilityAction({ nativeEvent: { actionName: 'longpress' } })
    const primary = PrimaryButton({ label: '完整的操作名称', loading: true, onPress() {} })
    assert.strictEqual(primary.props.accessibilityState.busy, true); assert.strictEqual(primary.props.disabled, true)
    assert.ok(style(primary.props.style({ pressed: false })).minHeight >= 48)
  }
  assert.strictEqual(plays, 2); assert.strictEqual(favorites, 2); assert.strictEqual(selects, 2)
  selected = true; harness.mount(() => VideoCard({ device: { endpoint: 'http://127.0.0.1:42000', token: 'fixture' }, video, selectionMode: true, selected, onPress() {} }))
  const checkbox = nodes(harness.tree()).find(node => node.type === 'Pressable')
  assert.strictEqual(checkbox.props.accessibilityRole, 'checkbox'); assert.strictEqual(checkbox.props.accessibilityState.checked, true)
  let closed = 0
  const modal = AccessibleModal({ label: '导航', onClose() { closed++ }, children: 'content' })
  assert.strictEqual(modal.type, 'Modal'); assert.strictEqual(modal.props.animationType, 'none')
  modal.props.onRequestClose()
  nodes(modal).find(node => node.props?.accessibilityViewIsModal).props.onAccessibilityEscape()
  assert.strictEqual(closed, 2)
  assert.strictEqual(modal.props.children.type, 'SafeAreaView')
  assert.strictEqual(modal.props.children.props.children.type, 'View', 'absolute overlays are inside the padded safe-area content, not against its outer edges')
  harness.unmount()
}

async function main() {
  const matrix = await gridBehavior(); await componentBehavior()
  const parent = path.resolve(__dirname, '../.tmp/refactor-tests'); fs.mkdirSync(parent, { recursive: true })
  fs.writeFileSync(path.join(parent, 'mobile-accessibility-evidence.json'), JSON.stringify({ date: new Date().toISOString(), matrix,
    conditions: 'Production React hooks/components with native views/list scrolling controlled by the harness. Validates layout arithmetic, anchor ownership, row-index conversion, retries and teardown, button semantics and Modal wiring; not native Yoga/VoiceOver/TalkBack/device rendering evidence.' }, null, 2) + '\n')
  console.log('mobile accessibility passed: 24 width/font layouts, stable video anchor through columns/safe area/background, bounded scroll recovery, sibling favorite targets, selection/readout and native modal/back/safe-area wiring')
}
const deadline = setTimeout(() => { console.error('mobile accessibility verification timed out'); process.exit(1) }, 15000)
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => clearTimeout(deadline))
