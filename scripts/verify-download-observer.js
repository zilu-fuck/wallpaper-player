const assert = require('assert'), crypto = require('crypto')
const { phone } = require('./mobile-module-harness')
const { createHookHarness } = require('./verify-mobile-player-behavior')
const next = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
function nodes(tree, predicate) {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(node => nodes(node, predicate))
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)]
}
async function main() {
  const client = phone(), requests = [], cancelled = [], states = [], errors = [], timers = new Map()
  let sequence = 0, active = 0, maximum = 0
  client.control.globals = { crypto, setTimeout: (callback, ms) => { const id = ++sequence; timers.set(id, { callback, ms }); return id }, clearTimeout: id => timers.delete(id) }
  const api = {
    downloadGetState: options => { active++; maximum = Math.max(maximum, active); return new Promise(resolve => requests.push({ options, resolve: value => { active--; resolve(value) } })) },
    cancelMediaWork: async id => { cancelled.push(id); return { success: true } }
  }
  const fire = async () => { assert.strictEqual(timers.size, 1); const [id, timer] = timers.entries().next().value; timers.delete(id); timer.callback(); await next() }
  const ok = name => ({ success: true, engine: { running: true }, tasks: [{ gid: name }] })
  const { DownloadStateObserver } = client.load('src/services/download-state-observer.js')
  const observer = new DownloadStateObserver(api, { onState: value => states.push(value), onError: value => errors.push(value) })
  try {
    observer.setActive(true); await next()
    assert.strictEqual(requests[0].options.start, false, 'observing does not start the download daemon')
    for (let i = 0; i < 20; i++) observer.refresh({ refresh: true })
    assert.strictEqual(requests.length, 1); assert.strictEqual(timers.size, 0)
    requests[0].resolve(ok('first')); await next(); await fire()
    assert.strictEqual(requests.length, 2); assert.strictEqual(requests[1].options.refresh, true, 'one queued explicit refresh retains the force flag')
    observer.setActive(false); observer.setActive(true)
    assert.ok(cancelled.includes(requests[1].options.requestId)); assert.strictEqual(requests.length, 2, 'resume waits for the old query settlement')
    requests[1].resolve(ok('late-hidden')); await next(); assert.strictEqual(states.length, 1)
    await fire(); assert.strictEqual(requests.length, 3)
    observer.publishMutation({ engine: {}, tasks: [{ gid: 'new-action' }] })
    assert.ok(cancelled.includes(requests[2].options.requestId))
    requests[2].resolve(ok('old-query')); await next()
    assert.strictEqual(states.at(-1).tasks[0].gid, 'new-action', 'old observations cannot overwrite a control result')
    await fire(); requests[3].resolve({ success: false, error: 'probe failure' }); await next()
    assert.deepStrictEqual(errors, ['probe failure']); assert.strictEqual(states.at(-1).tasks[0].gid, 'new-action')
    await fire(); observer.dispose(); requests[4].resolve(ok('after-dispose')); await next()
    assert.strictEqual(states.at(-1).tasks[0].gid, 'new-action'); assert.strictEqual(timers.size, 0); assert.strictEqual(maximum, 1)
  } finally { observer.dispose() }

  const hookClient = phone(), harness = createHookHarness(hookClient), visibility = new Set(), hookRequests = [], hookCancelled = []
  const document = { visibilityState: 'visible', addEventListener: (_name, callback) => visibility.add(callback), removeEventListener: (_name, callback) => visibility.delete(callback) }
  hookClient.control.globals = { ...hookClient.control.globals, crypto, document, window: { electronAPI: {
    downloadGetState: options => new Promise(resolve => hookRequests.push({ options, resolve })),
    cancelMediaWork: async id => hookCancelled.push(id)
  } } }
  const { useDownloadStateObserver } = hookClient.load('src/hooks/useDownloadStateObserver.js'), onError = () => {}
  harness.mount(() => useDownloadStateObserver(onError)); await harness.until(() => hookRequests.length === 1)
  document.visibilityState = 'hidden'; visibility.forEach(callback => callback()); await harness.settle()
  assert.ok(hookCancelled.includes(hookRequests[0].options.requestId))
  document.visibilityState = 'visible'; visibility.forEach(callback => callback()); harness.unmount()
  hookRequests[0].resolve(ok('late-hook')); await next(); assert.strictEqual(visibility.size, 0)
  assert.strictEqual(hookRequests.length, 1)

  const ui = phone(), uiHarness = createHookHarness(ui), removed = [], changes = []
  const externalTasks = [{ gid: 'xunlei-requested', engine: 'xunlei', status: 'external', name: 'requested' },
    { gid: 'xunlei-failed', engine: 'xunlei', status: 'error', errorMessage: 'client failed', name: 'failed' }]
  ui.override('src/hooks/useDownloadStateObserver.js', { useDownloadStateObserver: () => ({ state: { engine: {}, tasks: externalTasks }, setState: value => changes.push(value), refreshState: async () => {} }) })
  ui.stubs['react-dom'] = { createPortal: tree => tree }
  ui.control.globals = { ...ui.control.globals, window: { addEventListener() {}, removeEventListener() {}, electronAPI: {
    downloadRemove: async gid => { removed.push(gid); return { success: true, engine: {}, tasks: [] } }
  } }, document: { querySelector: () => null, body: { classList: { add() {}, remove() {} } } } }
  const DownloadCenter = ui.load('src/components/DownloadCenter.jsx').default
  uiHarness.mount(() => DownloadCenter({ libraryDirectories: [] })); await uiHarness.settle()
  const removal = nodes(uiHarness.tree(), node => node.type === 'button' && node.props['aria-label'] === '移除接管记录')
  assert.strictEqual(removal.length, 2); assert.ok(removal[0].props.title.includes('不会停止迅雷下载'))
  assert.strictEqual(nodes(uiHarness.tree(), node => node.type === 'button' && ['暂停', '继续'].includes(node.props['aria-label'])).length, 0)
  assert.ok(nodes(uiHarness.tree(), node => node.type === 'em' && node.props.children === '下载失败').length)
  await removal[0].props.onClick(); assert.deepStrictEqual(removed, ['xunlei-requested']); assert.strictEqual(changes.length, 1)
  uiHarness.unmount()
  console.log('download observer passed: production observer/hook/center, completion-paced single flight, one forced refresh, visibility/cancel/disposal, stale action-result protection and explicit external record-only controls')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
