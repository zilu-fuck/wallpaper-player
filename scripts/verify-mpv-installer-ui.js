const assert = require('assert'), crypto = require('crypto')
const { phone } = require('./mobile-module-harness')
const { createHookHarness } = require('./verify-mobile-player-behavior')
function nodes(tree, predicate) {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(node => nodes(node, predicate))
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)]
}
async function main() {
  const client = phone(), harness = createHookHarness(client), requests = [], checks = [], cancelled = [], updates = [], listeners = new Set()
  const api = {
    downloadMpv: requestId => new Promise((resolve, reject) => requests.push({ requestId, resolve, reject })),
    cancelMediaWork: async requestId => { cancelled.push(requestId); return { success: true } },
    onMpvDownloadProgress: callback => { listeners.add(callback); return () => listeners.delete(callback) },
    checkMpv: () => new Promise(resolve => checks.push(resolve))
  }
  client.control.globals = { ...client.control.globals, crypto, window: { electronAPI: api } }
  const { useMpvInstaller } = client.load('src/hooks/useMpvInstaller.js')
  const update = value => updates.push(value)
  harness.mount(() => useMpvInstaller(update))
  const emit = (index, percent) => listeners.forEach(callback => callback({ requestId: requests[index].requestId, percent }))
  try {
    const first = harness.tree().download(); harness.tree().download(); await harness.settle()
    assert.strictEqual(requests.length, 1); assert.strictEqual(listeners.size, 1)
    listeners.forEach(callback => callback({ requestId: 'another-window', percent: 55 })); await harness.settle()
    assert.strictEqual(harness.tree().downloadProgress, null)
    emit(0, 25); await harness.settle(); assert.strictEqual(harness.tree().downloadProgress.percent, 25)
    harness.tree().cancel(); await harness.settle()
    assert.deepStrictEqual(cancelled, [requests[0].requestId]); assert.strictEqual(listeners.size, 0)
    const second = harness.tree().download(); await harness.settle()
    assert.notStrictEqual(requests[0].requestId, requests[1].requestId)
    requests[0].resolve({ success: true }); await first; await harness.settle()
    assert.strictEqual(checks.length, 0); assert.strictEqual(harness.tree().downloading, true)
    requests[1].resolve({ success: true }); await harness.until(() => checks.length === 1)
    harness.tree().cancel(); checks[0]({ available: true, path: 'late-install' }); await second; await harness.settle()
    assert.strictEqual(updates.length, 0, 'late status cannot replace a manual path or a new operation')
    assert.strictEqual(cancelled.length, 1, 'completed installations are not cancelled during a status refresh')

    const third = harness.tree().download(); await harness.settle()
    requests[2].resolve({ success: true }); await harness.until(() => checks.length === 2)
    checks[1]({ available: true, path: 'current-install' }); await third; await harness.settle()
    assert.strictEqual(updates[0].path, 'current-install'); assert.strictEqual(listeners.size, 0)
    const uncertain = harness.tree().download(); await harness.settle(); requests[3].reject(new Error('IPC disconnected'))
    await uncertain; await harness.settle(); assert.ok(cancelled.includes(requests[3].requestId)); assert.strictEqual(listeners.size, 0)
    assert.strictEqual(harness.tree().mpvDownloadError, 'IPC disconnected')

    const { MpvStatusSection } = client.load('src/components/settings/StatusSettingsSections.jsx')
    let clicked = false
    const section = MpvStatusSection({ downloading: true, downloadProgress: { stage: 'extract' }, onCancelDownloadMpv: () => { clicked = true } })
    const button = nodes(section, node => node.type === 'button' && node.props.children === '取消安装')[0]
    assert.ok(button); button.props.onClick(); assert.strictEqual(clicked, true)
    assert.ok(nodes(section, node => node.type === 'button' && node.props.children === '正在解压并验证...').length)

    const final = harness.tree().download(); await harness.settle(); harness.unmount()
    assert.ok(cancelled.includes(requests[4].requestId)); assert.strictEqual(listeners.size, 0)
    requests[4].resolve({ success: true }); await final
    assert.strictEqual(checks.length, 2); assert.strictEqual(updates.length, 1)
    console.log('mpv installer UI passed: production hook/controls, one local request, scoped progress, cancel/retry, stale completion/status isolation, uncertain IPC cancellation and unmount cleanup')
  } finally { harness.unmount() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
