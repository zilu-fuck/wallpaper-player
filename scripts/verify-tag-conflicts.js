const assert = require('assert')
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const Module = require('module')
const { execFile } = require('child_process')
const { promisify } = require('util')
const { phone } = require('./mobile-module-harness')
const { createHookHarness, find, activePage } = require('./verify-mobile-player-behavior')
const { claimDevice, requestJson, removeTempRootWithRetry } = require('./verify-helpers')
const projectRoot = path.resolve(__dirname, '..')
const parent = path.join(projectRoot, '.tmp/refactor-tests')
fs.mkdirSync(parent, { recursive: true })
const fixture = fs.mkdtempSync(path.join(parent, 'tag-conflicts-'))
process.chdir(fixture)
const settings = require(path.join(projectRoot, 'main/settings'))
const scanner = require(path.join(projectRoot, 'main/scanner'))
const { createMediaMutationService } = require(path.join(projectRoot, 'main/application/media-mutations'))
const { getVideoId } = require(path.join(projectRoot, 'main/remote/video-index'))
const { createRemoteServer } = require(path.join(projectRoot, 'main/remote/server'))
const identity = require(path.join(projectRoot, 'main/remote/identity'))
const { listRemoteNetworkItems } = require(path.join(projectRoot, 'main/remote/handlers/network-resources'))
const ipc = new Map()
const originalLoad = Module._load
Module._load = function(name, owner, ...args) {
  if (name === 'electron' && /[\\/]main[\\/]ipc[\\/]media-data\.js$/.test(owner?.filename || '')) {
    return { ipcMain: { handle: (channel, handler) => ipc.set(channel, handler) } }
  }
  return originalLoad.call(this, name, owner, ...args)
}
try { require(path.join(projectRoot, 'main/ipc/media-data')).registerMediaDataIpc({ handle: (channel, handler) => ipc.set(channel, handler) }) } finally { Module._load = originalLoad }
let server
const plain = value => JSON.parse(JSON.stringify(value))

async function main() {
  const directory = path.join(fixture, 'library')
  fs.mkdirSync(directory)
  const aPath = path.join(directory, 'a.mp4'), bPath = path.join(directory, 'b.mp4')
  fs.writeFileSync(aPath, 'tag-fixture'); fs.writeFileSync(bPath, 'tag-fixture')
  const group = path.join(directory, 'group')
  fs.mkdirSync(group)
  fs.writeFileSync(path.join(group, 'project.json'), JSON.stringify({ workshopid: 'tag-group', title: 'Group' }))
  fs.writeFileSync(path.join(group, 'one.mp4'), 'group-fixture'); fs.writeFileSync(path.join(group, 'two.mp4'), 'group-fixture')
  await settings.saveSettingsAndFlush({ directories: [directory], defaultDirectory: directory })
  const scanned = (await scanner.scanWithCache(directory, true)).videos
  const a = scanned.find(item => item.fullPath === aPath), b = scanned.find(item => item.fullPath === bPath)
  const grouped = scanned.filter(item => item.workshopId === 'tag-group')
  const service = createMediaMutationService()
  const first = await service.getVideoTags(a)
  assert.strictEqual(first.value.customTagsRevision, 0)
  const race = await Promise.allSettled([
    service.setVideoTags(a, ['one'], { expectedRevision: 0, operationId: 'race-one' }),
    service.setVideoTags(a, ['two'], { expectedRevision: 0, operationId: 'race-two' })
  ])
  assert.strictEqual(race.filter(item => item.status === 'fulfilled').length, 1)
  const rejected = race.find(item => item.status === 'rejected').reason
  assert.strictEqual(rejected.code, 'tags_conflict')
  assert.strictEqual(rejected.currentRevision, 1)
  const winner = race.find(item => item.status === 'fulfilled').value
  const winnerId = winner.value.customTags[0] === 'one' ? 'race-one' : 'race-two'
  const duplicate = await service.setVideoTags(a, winner.value.customTags, { expectedRevision: 0, operationId: winnerId })
  assert.strictEqual(duplicate.value.replayed, true)
  assert.strictEqual(duplicate.value.customTagsRevision, 1)
  await assert.rejects(service.setVideoTags(a, ['reused'], { expectedRevision: 1, operationId: winnerId }), error => error.code === 'operation_id_reused')
  await service.setVideoTags(b, ['unrelated'], { expectedRevision: 0, operationId: 'unrelated' })
  assert.strictEqual((await service.getVideoTags(a)).value.customTagsRevision, 1)
  await service.appendTagsBulk([a], ['append'])
  await assert.rejects(service.setVideoTags(a, ['old-editor'], { expectedRevision: 1, operationId: 'stale-after-append' }), error => error.code === 'tags_conflict')
  const alias = { fullPath: aPath, favoriteKey: aPath }
  const aliasState = await service.getVideoTags(alias)
  assert.strictEqual(aliasState.value.customTagsRevision, 2, 'standalone aliases must share the canonical version')
  await service.setVideoTags(alias, ['alias'], { expectedRevision: 2, operationId: 'alias' })
  assert.strictEqual((await service.getVideoTags(a)).value.customTagsRevision, 3)
  await service.setVideoTags(grouped[0], ['group'], { expectedRevision: 0, operationId: 'group-one' })
  assert.strictEqual((await service.getVideoTags(grouped[1])).value.customTagsRevision, 1)
  await assert.rejects(service.setVideoTags(grouped[1], ['stale-group'], { expectedRevision: 0, operationId: 'group-two' }), error => error.code === 'tags_conflict')
  const beforeFailure = settings.loadSettings()
  const rename = fsp.rename
  fsp.rename = async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) }
  try { await assert.rejects(service.setVideoTags(a, ['failed'], { expectedRevision: 3, operationId: 'disk-failed' }), /disk full/) }
  finally { fsp.rename = rename }
  assert.deepStrictEqual(settings.loadSettings().customTagRevisions, beforeFailure.customTagRevisions)
  assert.deepStrictEqual(settings.loadSettings().tagMutationReceipts, beforeFailure.tagMutationReceipts)
  await service.setVideoTags(a, ['recovered'], { expectedRevision: 3, operationId: 'disk-failed' })

  server = createRemoteServer({ port: 0 })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  const pairA = await claimDevice({ baseUrl: endpoint, clientId: 'tag-phone-a', ...identity })
  const pairB = await claimDevice({ baseUrl: endpoint, clientId: 'tag-phone-b', ...identity })
  const pa = phone(), pb = phone()
  const apiA = pa.load('mobile/src/services/api.ts'), apiB = pb.load('mobile/src/services/api.ts')
  let loseMobileResponse = false
  pa.override('mobile/src/services/api.ts', { ...apiA, async updateVideoTags(...args) {
    const result = await apiA.updateVideoTags(...args)
    if (loseMobileResponse) { loseMobileResponse = false; throw new apiA.ApiError('response lost', 0, 'network_error') }
    return result
  } })
  const info = await apiA.getInfo(endpoint)
  assert.strictEqual(info.capabilities.tagRevisions, true)
  const da = { id: info.deviceId, name: info.deviceName, endpoint, token: pairA.token, capabilities: info.capabilities }
  const db = { ...da, token: pairB.token }
  const id = getVideoId(aPath)
  const editingA = pa.load('mobile/src/services/tag-editing.ts'), editingB = pb.load('mobile/src/services/tag-editing.ts')
  const mobileVideo = (await apiA.getLibrary(da)).items.find(item => item.id === id)
  assert.strictEqual(mobileVideo.customTagsRevision, 4)
  const sa = await editingA.openTagEdit(da, mobileVideo), sb = await editingB.openTagEdit(db, mobileVideo)
  await editingA.saveTagEdit(sa, ['phone-a'])
  await assert.rejects(editingB.saveTagEdit(sb, ['phone-b']), error => error.code === 'tags_conflict' && error.currentRevision === 5)
  assert.strictEqual(sb.expectedRevision, 4, 'an editor must not automatically rebase after a conflict')
  const reopened = await editingB.openTagEdit(db, mobileVideo)
  assert.deepStrictEqual(plain(reopened.video.customTags), ['phone-a'])
  await editingB.saveTagEdit(reopened, [])
  assert.strictEqual((await apiA.getVideoTagsState(da, id)).customTags.length, 0)
  const sharedNonce = 'shared-across-authenticated-actors'
  const state = await apiA.getVideoTagsState(da, id)
  await apiA.updateVideoTags(da, id, ['actor-a'], { expectedRevision: state.customTagsRevision, operationId: sharedNonce })
  await apiB.updateVideoTags(db, id, ['actor-b'], { expectedRevision: state.customTagsRevision + 1, operationId: sharedNonce })
  const headers = { Authorization: 'Bearer ' + pairA.token }
  const legacy = await requestJson(endpoint + '/v1/videos/' + id + '/tags', { method: 'PUT', headers, body: JSON.stringify({ tags: ['legacy-phone'] }) })
  assert.strictEqual(legacy.status, 200)
  assert.strictEqual(legacy.data.customTagsRevision, state.customTagsRevision + 3)
  const lostSession = await editingA.openTagEdit(da, mobileVideo)
  loseMobileResponse = true
  await assert.rejects(editingA.saveTagEdit(lostSession, ['lost']), /response lost/)
  const afterLost = await apiB.getVideoTagsState(db, id)
  await apiB.updateVideoTags(db, id, ['newer'], { expectedRevision: afterLost.customTagsRevision, operationId: 'newer-after-lost' })
  const replay = await editingA.saveTagEdit(lostSession, ['lost'])
  assert.strictEqual(replay.replayed, true)
  assert.deepStrictEqual(plain(replay.customTags), ['newer'])
  assert.strictEqual(replay.operationRevision + 1, replay.customTagsRevision)
  assert.ok(!JSON.stringify(replay).includes('file:'), 'HTTP must not expose desktop tag identities or receipts')
  assert.ok(!('tagMutationReceipts' in settings.sanitizeSettingsForRenderer(settings.loadSettings())))

  let publicSettings = settings.sanitizeSettingsForRenderer(settings.loadSettings())
  const desktop = phone()
  const calls = []
  let loseDesktopResponse = false
  desktop.control.globals = { window: { electronAPI: {
    getVideoCustomTags: target => ipc.get('media-get-tags')({}, target),
    setVideoCustomTags: async (...args) => {
      calls.push(args)
      const result = await ipc.get('media-set-tags')({}, ...args)
      if (loseDesktopResponse && result.success) { loseDesktopResponse = false; throw new Error('response lost') }
      return result
    },
    appendVideoCustomTags: (...args) => ipc.get('media-append-tags')({}, ...args)
  } } }
  const desktopHarness = createHookHarness(desktop)
  const { useTagEditor } = desktop.load('src/hooks/useTagEditor.js')
  desktopHarness.mount(() => useTagEditor({ settings: publicSettings }))
  await desktopHarness.tree().handleOpenTagEditor(a)
  await desktopHarness.settle()
  desktopHarness.tree().setTagEditorValue('desktop-draft')
  await desktopHarness.settle()
  const openedRevision = (await service.getVideoTags(a)).value.customTagsRevision
  await apiB.updateVideoTags(db, id, ['concurrent-phone'], { expectedRevision: openedRevision, operationId: 'while-desktop-open' })
  publicSettings = settings.sanitizeSettingsForRenderer(settings.loadSettings())
  desktopHarness.mount(() => useTagEditor({ settings: publicSettings }))
  await assert.rejects(desktopHarness.tree().handleSaveTagEditor(), error => error.code === 'tags_conflict')
  await desktopHarness.settle()
  assert.strictEqual(desktopHarness.tree().tagEditorValue, 'desktop-draft')
  assert.strictEqual(calls[calls.length - 1][2].expectedRevision, openedRevision)
  await desktopHarness.tree().handleReloadTagEditor()
  await desktopHarness.settle()
  assert.strictEqual(desktopHarness.tree().tagEditorValue, 'concurrent-phone')
  desktopHarness.tree().setTagEditorValue('desktop-lost')
  await desktopHarness.settle()
  loseDesktopResponse = true
  await assert.rejects(desktopHarness.tree().handleSaveTagEditor(), error => error.code === 'ipc_unavailable')
  await desktopHarness.settle()
  const firstAttempt = calls[calls.length - 1][2]
  fsp.rename = async () => { throw new Error('replayed operations must not write disk') }
  try { await desktopHarness.tree().handleSaveTagEditor() } finally { fsp.rename = rename }
  await desktopHarness.settle()
  assert.deepStrictEqual(calls[calls.length - 1][2], firstAttempt)
  assert.strictEqual(desktopHarness.tree().tagEditorVideo, null)
  const expected = (await service.getVideoTags(a)).value
  const replayBody = calls[calls.length - 1]
  const childCode = `const s=require(${JSON.stringify(path.join(projectRoot, 'main/application/media-mutations'))});
s.createMediaMutationService().setVideoTags(JSON.parse(process.argv[1]),JSON.parse(process.argv[2]),JSON.parse(process.argv[3]))
.then(r=>{if(!r.value.replayed)throw Error('missing durable receipt');process.stdout.write('durable receipt passed')}).catch(e=>{console.error(e);process.exitCode=1})`
  const restarted = await promisify(execFile)(process.execPath, ['-e', childCode, JSON.stringify(a), JSON.stringify(replayBody[1]), JSON.stringify(replayBody[2])], { cwd: fixture, windowsHide: true })
  assert.ok(restarted.stdout.includes('durable receipt passed'))
  assert.strictEqual((await service.getVideoTags(a)).value.customTagsRevision, expected.customTagsRevision)
  desktopHarness.unmount()

  const screenPhone = phone()
  const screenApi = screenPhone.load('mobile/src/services/api.ts')
  const screenDevice = await screenPhone.load('mobile/src/persistence/devices.ts').saveDevice(da)
  const screenVideos = (await screenApi.getLibrary(screenDevice)).items
  const screenVideo = screenVideos.find(item => item.id === id)
  const screenB = screenVideos.find(item => item.id === getVideoId(bPath))
  const screenHarness = createHookHarness(screenPhone)
  const { PlayerScreen } = screenPhone.load('mobile/src/screens/PlayerScreen.tsx')
  let screenProps = { device: screenDevice, video: screenVideo, videos: [screenVideo, screenB],
    navigation: { canGoBack: false, navigate() {}, back() {} } }
  screenHarness.mount(() => PlayerScreen(screenProps))
  await find(activePage(screenHarness, screenVideo), 'VideoOverlay').props.onTags()
  await screenHarness.settle()
  const openedSheet = find(screenHarness.tree(), 'TagEditorSheet').props
  const frozenTags = plain(openedSheet.video.customTags)
  const current = await screenApi.getVideoTagsState(screenDevice, id)
  await apiB.updateVideoTags(db, id, ['changed-during-sheet'], { expectedRevision: current.customTagsRevision, operationId: 'screen-concurrent' })
  const changedVideo = { ...screenVideo, customTags: ['changed-during-sheet'], customTagsRevision: current.customTagsRevision + 1 }
  screenProps = { ...screenProps, video: changedVideo, videos: [changedVideo, screenB] }
  screenHarness.mount(() => PlayerScreen(screenProps))
  await screenHarness.settle()
  const unchangedSheet = find(screenHarness.tree(), 'TagEditorSheet').props
  assert.deepStrictEqual(plain(unchangedSheet.video.customTags), frozenTags, 'live metadata must not replace the mobile editor draft source')
  assert.strictEqual(unchangedSheet.editKey, openedSheet.editKey)
  await unchangedSheet.onSave(['mobile-draft'])
  await screenHarness.settle()
  const conflictedSheet = find(screenHarness.tree(), 'TagEditorSheet').props
  assert.strictEqual(conflictedSheet.visible, true)
  assert.ok(conflictedSheet.error.includes('其他设备'), 'mobile conflict must remain visible in the sheet: ' + conflictedSheet.error)
  await conflictedSheet.onReload()
  await screenHarness.settle()
  const reloadedSheet = find(screenHarness.tree(), 'TagEditorSheet').props
  assert.deepStrictEqual(plain(reloadedSheet.video.customTags), ['changed-during-sheet'])
  assert.strictEqual(reloadedSheet.error, '')
  await reloadedSheet.onSave([])
  await screenHarness.settle()
  assert.strictEqual((await screenApi.getVideoTagsState(screenDevice, id)).customTags.length, 0)

  let releaseRead, enterRead
  const readEntered = new Promise(resolve => { enterRead = resolve })
  const readRelease = new Promise(resolve => { releaseRead = resolve })
  screenPhone.control.hold = async (url, options) => {
    if (String(url).endsWith('/tags') && options.method === 'GET') { enterRead(); await readRelease }
  }
  const cancelledOpen = find(activePage(screenHarness, changedVideo), 'VideoOverlay').props.onTags()
  await readEntered
  await screenHarness.settle()
  find(screenHarness.tree(), 'TagEditorSheet').props.onClose()
  releaseRead()
  await cancelledOpen
  await screenHarness.settle()
  assert.ok(!find(screenHarness.tree(), 'TagEditorSheet'),
    'a late snapshot read must not reopen a closed sheet')
  screenPhone.control.hold = null

  await find(activePage(screenHarness, changedVideo), 'VideoOverlay').props.onTags()
  await screenHarness.settle()
  let releaseSave, enterSave
  const saveEntered = new Promise(resolve => { enterSave = resolve })
  const saveRelease = new Promise(resolve => { releaseSave = resolve })
  screenPhone.control.hold = async (url, options) => {
    if (String(url).endsWith('/tags') && options.method === 'PUT') { enterSave(); await saveRelease }
  }
  const pendingSave = find(screenHarness.tree(), 'TagEditorSheet').props.onSave(['pending-old-video'])
  await saveEntered
  find(screenHarness.tree(), 'TagEditorSheet').props.onClose()
  screenProps = { ...screenProps, video: screenB }
  screenHarness.mount(() => PlayerScreen(screenProps))
  await screenHarness.settle()
  const activeB = find(screenHarness.tree(), 'FlatList').props.renderItem({ item: screenB, index: 1 })
  await find(activeB, 'VideoOverlay').props.onTags()
  await screenHarness.settle()
  releaseSave()
  await pendingSave
  await screenHarness.settle()
  const stillB = find(screenHarness.tree(), 'TagEditorSheet').props
  assert.strictEqual(stillB.visible, true, 'an old save must not close a newer editor')
  assert.strictEqual(stillB.video.id, screenB.id)
  assert.strictEqual(stillB.error, '')
  screenPhone.control.hold = null
  screenHarness.unmount()
  await screenHarness.settle()

  await settings.saveSettingsAndFlush({ networkResources: [
    { id: 'net-upper', title: 'Upper', url: 'http://example.com/Video.mp4', kind: 'direct' },
    { id: 'net-lower', title: 'Lower', url: 'http://example.com/video.mp4', kind: 'direct' }
  ] })
  const network = listRemoteNetworkItems()
  const upper = network.find(item => item.url.endsWith('/Video.mp4')), lower = network.find(item => item.url.endsWith('/video.mp4'))
  const upperTarget = { sourceType: 'network', id: upper.id, url: upper.url }
  const lowerTarget = { sourceType: 'network', id: lower.id, url: lower.url }
  await service.setVideoTags(upperTarget, ['Upper'], { expectedRevision: 0, operationId: 'network-upper' })
  await service.setVideoTags(lowerTarget, ['Lower'], { expectedRevision: 0, operationId: 'network-lower' })
  assert.deepStrictEqual((await service.getVideoTags(upperTarget)).value.customTags, ['Upper'])
  assert.deepStrictEqual((await service.getVideoTags(lowerTarget)).value.customTags, ['Lower'])
  assert.strictEqual((await service.getVideoTags(upperTarget)).value.customTagsRevision, 1)
  assert.strictEqual((await service.getVideoTags(lowerTarget)).value.customTagsRevision, 1)
  console.log('tag conflict verification passed: per-target CAS, canonical aliases/Workshop/network scope, append invalidation, disk rollback, two authenticated phones, legacy requests, lost ACK/replay after restart; actual desktop/mobile editors preserve baseline/draft, explicit reload, cancelled reads and old save ownership')
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  await scanner.waitForBackgroundScanRefreshes()
  scanner.unwatchAllDirectories()
  await settings.flushSettingsWrites()
  process.chdir(projectRoot)
  assert.strictEqual(path.dirname(path.resolve(fixture)), parent)
  assert.ok(path.basename(fixture).startsWith('tag-conflicts-'))
  await removeTempRootWithRetry(fixture)
})
