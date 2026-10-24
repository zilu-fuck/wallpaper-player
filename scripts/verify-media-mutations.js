const assert = require('assert')
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const Module = require('module')
const {
  claimDevice,
  removeTempRootWithRetry,
  requestJson
} = require('./verify-helpers')

const projectRoot = path.resolve(__dirname, '..')
const fixtureParent = path.join(projectRoot, '.tmp/refactor-tests')
fs.mkdirSync(fixtureParent, { recursive: true })
const tempRoot = fs.mkdtempSync(path.join(fixtureParent, 'media-mutations-'))
const libraryDir = path.join(tempRoot, 'library')
fs.mkdirSync(libraryDir)
const paths = ['a', 'b', 'c'].map(name => path.join(libraryDir, name + '.mp4'))
for (const file of paths) fs.writeFileSync(file, 'media-mutation-fixture')
process.chdir(tempRoot)
const settings = require(path.join(projectRoot, 'main/settings'))
const scanner = require(path.join(projectRoot, 'main/scanner'))
const {
  createFileTarget, createMediaMutationService, savePlaybackRecord
} = require(path.join(projectRoot, 'main/application/media-mutations'))
const { getVideoId } = require(path.join(projectRoot, 'main/remote/video-index'))
const { createRemoteServer } = require(path.join(projectRoot, 'main/remote/server'))
const identity = require(path.join(projectRoot, 'main/remote/identity'))
const settingsPath = path.join(tempRoot, '.tmp-wallpaper-player/settings.json')

const ipc = new Map()
const originalLoad = Module._load
Module._load = function (request, parent, ...args) {
  if (request === 'electron' && /[\\/]main[\\/]ipc[\\/](media-data|settings)\.js$/.test(parent?.filename || '')) {
    return { ipcMain: { handle: (name, handler) => ipc.set(name, handler) }, app: { getVersion: () => 'fixture' } }
  }
  return originalLoad.call(this, request, parent, ...args)
}
try {
  const testIpc = { handle: (name, handler) => ipc.set(name, handler) }
  require(path.join(projectRoot, 'main/ipc/media-data')).registerMediaDataIpc(testIpc)
  require(path.join(projectRoot, 'main/ipc/settings')).registerSettingsIpc(testIpc)
} finally {
  Module._load = originalLoad
}

function readPersisted() {
  return JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
}

async function main() {
  await settings.saveSettingsAndFlush({ directories: [libraryDir], defaultDirectory: libraryDir })
  const scan = await scanner.scanWithCache(libraryDir, true)
  const videos = paths.map(fullPath => scan.videos.find(video => video.fullPath === fullPath))
  const keys = videos.map(video => video.favoriteKey)
  const service = createMediaMutationService()

  let release
  let entered
  const enteredResolver = new Promise(resolve => { entered = resolve })
  const delayed = createMediaMutationService({
    async resolveTarget(input) {
      if (input === 'a') {
        entered()
        await new Promise(resolve => { release = resolve })
      }
      const index = input === 'a' ? 0 : 1
      return createFileTarget(paths[index], { favoriteKey: keys[index] })
    }
  })
  const bulk = delayed.appendTagsBulk(['a'], ['bulk'])
  await enteredResolver
  await service.setVideoTags(videos[1], ['other-phone'])
  release()
  await bulk
  assert.deepStrictEqual(settings.loadSettings().customTags[keys[0]], ['bulk'])
  assert.deepStrictEqual(settings.loadSettings().customTags[keys[1]], ['other-phone'],
    'bulk resolver must not overwrite a change committed while it was waiting')

  await Promise.all([
    service.appendTagsBulk([videos[0]], ['one']),
    service.appendTagsBulk([videos[0]], ['two']),
    service.setFavorite(videos[0], true),
    service.setFavorite(videos[1], true),
    savePlaybackRecord(paths[0], { position: 180, volume: 0 }),
    savePlaybackRecord(paths[1], { position: 30 })
  ])
  let saved = readPersisted()
  assert.ok(saved.customTags[keys[0]].includes('one'))
  assert.ok(saved.customTags[keys[0]].includes('two'))
  assert.ok(saved.favorites.includes(keys[0]) && saved.favorites.includes(keys[1]))
  assert.strictEqual(settings.getPlaybackState(saved.playbackStates, paths[0]).volume, 0)
  assert.strictEqual(settings.getPlaybackState(saved.playbackStates, paths[1]).position, 30)

  const mixed = await service.appendTagsBulk([videos[0], { fullPath: path.join(libraryDir, 'missing.mp4') }], ['partial'])
  assert.strictEqual(mixed.value.updatedCount, 1)
  assert.deepStrictEqual(mixed.value.updated.map(item => item.index), [0])
  assert.deepStrictEqual(mixed.value.failed.map(item => item.index), [1])
  await service.setVideoTags(videos[2], ['first'])
  await service.setVideoTags(videos[2], ['second'])
  assert.deepStrictEqual(settings.loadSettings().customTags[keys[2]], ['second'],
    'unversioned replacement requests follow commit order')
  await service.setVideoTags(videos[2], [])
  assert.strictEqual(settings.loadSettings().customTags[keys[2]], undefined)

  const legacy = process.platform === 'win32' ? paths[2].toUpperCase() : paths[2]
  await settings.saveSettingsAndFlush({ customTags: { ...settings.loadSettings().customTags, [legacy]: ['legacy'] } })
  await service.appendTagsBulk([videos[2]], ['new'])
  assert.deepStrictEqual(settings.loadSettings().customTags[keys[2]], ['legacy', 'new'])
  assert.strictEqual(settings.loadSettings().customTags[legacy], undefined)
  const standalone = { fullPath: paths[2], favoriteKey: paths[2] }
  await service.setFavorite(standalone, true)
  assert.ok(settings.loadSettings().favorites.includes(paths[2]), 'standalone path favorite semantics must remain compatible')
  const workshopDir = path.join(libraryDir, 'workshop')
  fs.mkdirSync(workshopDir)
  fs.writeFileSync(path.join(workshopDir, 'project.json'), JSON.stringify({ workshopid: 'fixture-workshop', title: 'Workshop' }))
  fs.copyFileSync(paths[0], path.join(workshopDir, 'one.mp4'))
  fs.copyFileSync(paths[0], path.join(workshopDir, 'two.mp4'))
  const workshopVideos = (await scanner.scanWithCache(libraryDir, true)).videos.filter(video => video.workshopId === 'fixture-workshop')
  assert.strictEqual(workshopVideos.length, 2)
  await service.setFavorite(workshopVideos[0], true)
  await service.setFavorite(workshopVideos[1], true)
  assert.strictEqual(settings.loadSettings().favorites.filter(key => key === 'workshop:fixture-workshop').length, 1)
  await service.appendTagsBulk(workshopVideos, ['shared-workshop-tag'])
  assert.deepStrictEqual(settings.loadSettings().customTags['workshop:fixture-workshop'], ['shared-workshop-tag'])

  await assert.rejects(ipc.get('save-settings')({}, { favorites: [] }), /媒体操作/,
    'generic renderer snapshots must not bypass the mutation queue')
  const desktop = await ipc.get('media-set-favorite')({}, videos[0], true)
  assert.strictEqual(desktop.success, true)

  let notifications = 0
  const off = settings.onSettingsChanged(() => { notifications += 1 })
  const beforeFailure = settings.loadSettings()
  const originalRename = fsp.rename
  fsp.rename = async function (from, to) {
    if (path.resolve(to) === settingsPath) {
      throw Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' })
    }
    return originalRename.call(this, from, to)
  }
  try {
    await assert.rejects(service.setVideoTags(videos[1], ['must-not-publish']), { code: 'ENOSPC' })
    assert.deepStrictEqual(settings.loadSettings(), beforeFailure)
    assert.strictEqual(notifications, 0)
    assert.deepStrictEqual(readPersisted(), beforeFailure)
    const failedIpc = await ipc.get('media-set-tags')({}, videos[1], ['must-not-publish'])
    assert.strictEqual(failedIpc.success, false)
    assert.strictEqual(notifications, 0)
  } finally {
    fsp.rename = originalRename
    off()
  }
  await service.setVideoTags(videos[1], ['recovered'])
  assert.deepStrictEqual(readPersisted().customTags[keys[1]], ['recovered'], 'queue must recover after a failed commit')

  const originalWrite = fsp.writeFile
  let writeEntered
  let releaseWrite
  const writing = new Promise(resolve => { writeEntered = resolve })
  fsp.writeFile = async function (file, ...args) {
    if (String(file).startsWith(settingsPath + '.') && !releaseWrite) {
      writeEntered()
      await new Promise(resolve => { releaseWrite = resolve })
    }
    return originalWrite.call(this, file, ...args)
  }
  try {
    const mutation = service.setFavorite(videos[1], false)
    await writing
    settings.saveSettings({ theme: 'light' })
    releaseWrite()
    await mutation
    await settings.flushSettingsWrites()
    saved = readPersisted()
    assert.strictEqual(saved.theme, 'light')
    assert.strictEqual(saved.favorites.includes(keys[1]), false,
      'a concurrent internal config write must not restore an older media snapshot')
  } finally {
    fsp.writeFile = originalWrite
    releaseWrite?.()
  }

  const server = createRemoteServer({ port: 0 })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const baseUrl = 'http://127.0.0.1:' + server.address().port
    const phoneA = await claimDevice({ baseUrl, clientId: 'mutations-a', ...identity })
    const phoneB = await claimDevice({ baseUrl, clientId: 'mutations-b', ...identity })
    const aHeaders = { Authorization: 'Bearer ' + phoneA.token }
    const bHeaders = { Authorization: 'Bearer ' + phoneB.token }
    const info = await requestJson(baseUrl + '/v1/info')
    assert.strictEqual(info.data.capabilities.favoriteState, true)
    await requestJson(baseUrl + '/v1/library', { headers: aHeaders })
    const idA = getVideoId(paths[0])
    const idB = getVideoId(paths[1])
    const favoriteUrl = baseUrl + '/v1/videos/' + idA + '/favorite'
    const first = await requestJson(favoriteUrl, { headers: aHeaders, method: 'PUT', body: JSON.stringify({ favorite: true }) })
    const repeated = await requestJson(favoriteUrl, { headers: aHeaders, method: 'PUT', body: JSON.stringify({ favorite: true }) })
    assert.strictEqual(first.data.favorite, true)
    assert.strictEqual(repeated.data.favorite, true)
    const legacyToggle = await requestJson(favoriteUrl, { headers: aHeaders, method: 'PUT' })
    assert.strictEqual(legacyToggle.data.favorite, false)
    const badFavorite = await requestJson(favoriteUrl, { headers: aHeaders, method: 'PUT', body: JSON.stringify({ favorite: 'true' }) })
    assert.strictEqual(badFavorite.status, 400)
    const requests = await Promise.all([
      requestJson(baseUrl + '/v1/videos/tags/bulk', { headers: aHeaders, method: 'PUT', body: JSON.stringify({ videoIds: [idA, 'video_missing'], tags: ['http-a'] }) }),
      requestJson(baseUrl + '/v1/videos/' + idB + '/tags', { headers: bHeaders, method: 'PUT', body: JSON.stringify({ tags: ['http-b'] }) }),
      ipc.get('media-append-tags')({}, [videos[2]], ['desktop'])
    ])
    assert.strictEqual(requests[0].status, 200)
    assert.strictEqual(requests[0].data.updatedCount, 1)
    assert.strictEqual(requests[0].data.failed[0].id, 'video_missing')
    assert.ok(!JSON.stringify(requests[0].data).includes('file:'), 'remote mutation results must not expose encoded desktop paths')
    assert.strictEqual(requests[1].status, 200)
    assert.strictEqual(requests[2].success, true)
    saved = readPersisted()
    assert.ok(saved.customTags[keys[0]].includes('http-a'))
    assert.deepStrictEqual(saved.customTags[keys[1]], ['http-b'])
    assert.ok(saved.customTags[keys[2]].includes('desktop'))
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
  console.log('media mutation verification passed: concurrent desktop/two phones, partial results, desired favorites, legacy keys, failed disk commit, recovery and config rebasing')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
}).finally(async () => {
  await scanner.waitForBackgroundScanRefreshes()
  scanner.unwatchAllDirectories()
  await settings.flushSettingsWrites()
  process.chdir(projectRoot)
  assert.strictEqual(path.dirname(path.resolve(tempRoot)), fixtureParent)
  assert.ok(path.basename(tempRoot).startsWith('media-mutations-'))
  await removeTempRootWithRetry(tempRoot)
})
