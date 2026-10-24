const assert = require('assert')
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const Module = require('module')
const { execFileSync } = require('child_process')
const { EventEmitter } = require('events')
const {
  claimDevice,
  createFixtureVideo,
  removeTempRootWithRetry,
  requestJson,
  requestRaw
} = require('./verify-helpers')

const projectRoot = path.resolve(__dirname, '..')
const fixtureParent = path.join(projectRoot, '.tmp', 'refactor-tests')
fs.mkdirSync(fixtureParent, { recursive: true })
const tempRoot = fs.mkdtempSync(path.join(fixtureParent, 'media-access-'))
const libraryDir = path.join(tempRoot, 'library')
const privateDir = path.join(libraryDir, 'private')
const privateChild = path.join(privateDir, 'child')
const publicPath = path.join(libraryDir, 'public.mp4')
const privatePath = path.join(privateChild, 'secret.mp4')
const previewPath = path.join(privateDir, 'preview.png')

process.chdir(tempRoot)
const settings = require(path.join(projectRoot, 'main/settings'))
const scanner = require(path.join(projectRoot, 'main/scanner'))
const { pathKey, isPathInside } = require(path.join(projectRoot, 'main/paths'))
const { createMediaAccessPolicy } = require(path.join(projectRoot, 'main/security/media-access'))
const { createRemoteServer } = require(path.join(projectRoot, 'main/remote/server'))
const { createPairingCode, approvePairingRequest } = require(path.join(projectRoot, 'main/remote/identity'))
const { rememberVideos, getVideoId } = require(path.join(projectRoot, 'main/remote/video-index'))
const { clearLibrarySnapshotCache } = require(path.join(projectRoot, 'main/remote/handlers/library'))
const { getExistingPreviewPath } = require(path.join(projectRoot, 'main/thumbnail'))
const transcodes = require(path.join(projectRoot, 'main/remote/transcode'))
const { setMainWindow } = require(path.join(projectRoot, 'main/window'))

const ipcHandlers = new Map()
const sender = Object.assign(new EventEmitter(), {
  id: 17,
  send() {},
  isDestroyed: () => false
})
let stoppedPrivatePlayback = 0
const originalLoad = Module._load
const loadWithPrivacyStubs = function (request, parent, ...args) {
  const parentName = parent?.filename?.replace(/\\/g, '/')
  if (parentName?.endsWith('/main/ipc/privacy.js')) {
    if (request === 'electron') return { ipcMain: { handle: (name, handler) => ipcHandlers.set(name, handler) } }
    if (request === '../mpv-integration') return {
      mpvManager: {
        getState: () => ({ filePath: privatePath }),
        stop: async () => { stoppedPrivatePlayback += 1 }
      }
    }
  }
  return originalLoad.call(this, request, parent, ...args)
}
Module._load = loadWithPrivacyStubs
try {
  require(path.join(projectRoot, 'main/ipc/privacy')).registerPrivacyIpc({ handle: (name, handler) => ipcHandlers.set(name, handler) })
} finally {
  Module._load = originalLoad
}
setMainWindow({ webContents: sender })

async function main() {
  fs.mkdirSync(privateChild, { recursive: true })
  await createFixtureVideo({
    ffmpeg: path.join(projectRoot, 'vendor/ffmpeg/bin/ffmpeg.exe'),
    destPath: publicPath,
    duration: 1
  })
  fs.copyFileSync(publicPath, privatePath)
  fs.writeFileSync(previewPath, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
    'base64'
  ))
  fs.writeFileSync(path.join(libraryDir, 'project.json'), JSON.stringify({
    title: 'public', preview: 'private/preview.png'
  }))
  settings.saveSettings({
    directories: [libraryDir, privateDir, privateChild],
    privateDirectories: [],
    privacy: await settings.createPrivacyPassword('fixture-password'),
    remoteAccess: { enabled: true }
  })
  const server = createRemoteServer({ port: 0 })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  let originalStat
  let releaseStat
  try {
    const baseUrl = 'http://127.0.0.1:' + server.address().port
    const phone = await claimDevice({
      baseUrl, clientId: 'privacy-phone', approvePairingRequest, createPairingCode
    })
    const headers = { Authorization: 'Bearer ' + phone.token }
    const before = await requestJson(baseUrl + '/v1/library', { headers })
    assert.strictEqual(before.status, 200)
    const privateItem = before.data.items.find(item => item.id === getVideoId(privatePath))
    assert.ok(privateItem, 'fixture must obtain an ID and signed thumbnail before privacy is enabled')
    await transcodes.startMobileTranscode(privateItem.id, privatePath)
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = transcodes.getMobileTranscodeStatus(privateItem.id)
      if (state?.status === 'ready' || state?.status === 'error') break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.strictEqual(transcodes.getMobileTranscodeStatus(privateItem.id)?.status, 'ready')

    settings.saveSettings({ privateDirectories: [privateDir] })
    const policy = createMediaAccessPolicy()
    assert.strictEqual(policy.canReadPath(privatePath), false)
    assert.strictEqual(policy.canReadPath(previewPath), false)
    assert.deepStrictEqual(settings.getPublicVideoDirectories(), [libraryDir])
    assert.strictEqual((await scanner.scanWithCache(libraryDir)).videos.some(video => video.fullPath === privatePath), false)
    await assert.rejects(scanner.scanWithCache(privateDir), /解锁/)
    await assert.rejects(scanner.assertAllowedVideoPath(privatePath), /解锁/)
    assert.strictEqual(await getExistingPreviewPath(publicPath, { audience: 'remote' }), null,
      'a public video must not use a preview image from a private descendant')

    const unlock = ipcHandlers.get('privacy-unlock')
    assert.strictEqual((await unlock({ sender }, 'wrong-password')).success, false)
    assert.strictEqual(createMediaAccessPolicy().canReadPath(privatePath), false)
    assert.strictEqual((await unlock({ sender }, 'fixture-password', { verifyOnly: true })).success, true)
    assert.strictEqual(createMediaAccessPolicy().canReadPath(privatePath), false,
      'password verification for restoring tags must not unlock directories')
    assert.strictEqual((await unlock({ sender }, 'fixture-password')).success, true)
    assert.strictEqual(await scanner.assertAllowedVideoPath(privatePath), privatePath)
    assert.strictEqual((await scanner.scanWithCache(privateDir)).videos.length, 1)
    assert.strictEqual((await scanner.scanWithCache(libraryDir)).videos.some(video => video.fullPath === privatePath), false,
      'public parent view must stay public even while the desktop is unlocked')
    assert.strictEqual(createMediaAccessPolicy({ audience: 'remote' }).canReadPath(privatePath), false)

    const privateBase = baseUrl + '/v1/videos/' + encodeURIComponent(privateItem.id)
    const protectedRequests = [
      [privateBase + '/stream', 'GET'],
      [privateBase + '/metadata', 'GET'],
      [privateBase + '/transcoded-stream', 'GET'],
      [privateBase + '/transcode', 'GET'],
      [privateBase + '/transcode', 'POST'],
      [privateBase + '/transcode', 'DELETE'],
      [privateBase + '/favorite', 'PUT'],
      [privateBase + '/tags', 'PUT'],
      [privateBase + '/tags', 'GET'],
      [privateBase + '/play-on-desktop', 'POST'],
      [privateBase + '/reveal-on-desktop', 'POST'],
      [baseUrl + '/v1/playback/' + encodeURIComponent(privateItem.id), 'GET'],
      [baseUrl + '/v1/playback/' + encodeURIComponent(privateItem.id), 'PUT']
    ]
    // 此时还未刷新远程索引，确保实际校验旧 ID，而非仅因索引移除而拒绝。
    for (const [url, method] of protectedRequests) {
      const response = await requestRaw(url, { method, headers })
      assert.strictEqual(response.status, 404, method + ' ' + url + ' must reject private media')
    }
    const oldThumbnail = await requestRaw(baseUrl + privateItem.thumbnailUrl +
      '?thumbnailToken=' + encodeURIComponent(privateItem.thumbnailToken))
    assert.strictEqual(oldThumbnail.status, 404, 'previous signed thumbnail must not bypass current privacy')
    assert.deepStrictEqual((await requestJson(baseUrl + '/v1/transcodes', { headers })).data.tasks, [],
      'transcode list must not disclose private task IDs or state')
    const after = await requestJson(baseUrl + '/v1/library', { headers })
    assert.strictEqual(after.data.items.some(item => item.id === privateItem.id), false)
    assert.strictEqual(after.data.directories.length, 1)
    assert.strictEqual((await requestRaw(baseUrl + after.data.items[0].streamUrl, { headers })).status, 200)

    const alias = path.join(libraryDir, 'alias')
    fs.symlinkSync(privateDir, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const aliasPath = path.join(alias, 'child/secret.mp4')
    assert.strictEqual(createMediaAccessPolicy({ audience: 'remote' }).canReadPath(aliasPath), false)
    await assert.rejects(scanner.assertAllowedVideoPath(aliasPath, { audience: 'remote' }))
    if (process.platform === 'win32') {
      assert.strictEqual(createMediaAccessPolicy({ audience: 'remote' }).canReadPath(privatePath.toUpperCase()), false)
      const subst = path.join(process.env.SystemRoot, 'System32/subst.exe')
      const drive = 'ZYXWVUTSRQP'.split('').find(letter => !fs.existsSync(letter + ':\\'))
      assert.ok(drive, 'privacy regression requires a free temporary drive letter')
      const driveName = drive + ':'
      const mappedRoot = driveName + '\\'
      execFileSync(subst, [driveName, privateDir], { windowsHide: true })
      try {
        assert.strictEqual(pathKey(fs.realpathSync.native(mappedRoot)), pathKey(privateDir))
        settings.sessionAllowedDirectories.add(mappedRoot)
        const mappedPath = path.join(mappedRoot, 'child/secret.mp4')
        assert.strictEqual(createMediaAccessPolicy({ audience: 'remote' }).isPrivatePath(mappedPath), true)
        await assert.rejects(scanner.assertAllowedVideoPath(mappedPath, { audience: 'remote' }))
      } finally {
        settings.sessionAllowedDirectories.delete(mappedRoot)
        // 只撤销本测试刚创建且仍指向测试私有目录的映射。
        assert.strictEqual(pathKey(fs.realpathSync.native(mappedRoot)), pathKey(privateDir))
        execFileSync(subst, [driveName, '/D'], { windowsHide: true })
      }
    }
    assert.strictEqual(isPathInside(libraryDir, path.join(libraryDir, '..safe/video.mp4')), true)
    assert.strictEqual(isPathInside(libraryDir, path.join(libraryDir, '../outside.mp4')), false)

    rememberVideos([{ fullPath: privatePath }])
    await assert.rejects(require(path.join(projectRoot, 'main/plugins/capabilities'))
      .resolveVideoPathById(privateItem.id), /无权访问/)

    sender.emit('did-start-navigation', {}, 'file://reload', false, true)
    assert.strictEqual(createMediaAccessPolicy().canReadPath(privatePath), false, 'reload must reset desktop authorization')
    await unlock({ sender }, 'fixture-password')
    Module._load = loadWithPrivacyStubs
    try {
      await ipcHandlers.get('privacy-lock')({ sender })
    } finally {
      Module._load = originalLoad
    }
    assert.strictEqual(stoppedPrivatePlayback, 1)
    await assert.rejects(scanner.scanWithCache(privateDir), /解锁/, 'cached private scan must be inaccessible after locking')

    settings.saveSettings({ privateDirectories: [] })
    await scanner.scanWithCache(libraryDir, true)
    clearLibrarySnapshotCache()
    const blocked = new Promise(resolve => {
      scanner.invalidateScanCache(pathKey(libraryDir))
      originalStat = fsp.stat
      fsp.stat = async function (input, ...args) {
        if (path.resolve(input) === libraryDir && !releaseStat) {
          await new Promise(release => { releaseStat = release; resolve() })
        }
        return originalStat.call(this, input, ...args)
      }
    })
    const pendingLibrary = requestJson(baseUrl + '/v1/library', { headers })
    await blocked
    settings.saveSettings({ privateDirectories: [privateDir] })
    releaseStat()
    const raced = await pendingLibrary
    assert.strictEqual(raced.status, 200)
    assert.strictEqual(raced.data.items.some(item => item.id === privateItem.id), false,
      'privacy change during snapshot building must not publish or cache the old view')
    const repeated = await requestJson(baseUrl + '/v1/library', { headers })
    assert.strictEqual(repeated.data.items.some(item => item.id === privateItem.id), false)
    console.log('media access verification passed: desktop session, nested roots, stale index/signatures, preview, junction/subst/case, tasks, snapshot race')
  } finally {
    if (originalStat) fsp.stat = originalStat
    releaseStat?.()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await scanner.waitForBackgroundScanRefreshes()
    scanner.unwatchAllDirectories()
    await settings.flushSettingsWrites()
    setMainWindow(null)
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
}).finally(async () => {
  process.chdir(projectRoot)
  const resolved = path.resolve(tempRoot)
  assert.strictEqual(path.dirname(resolved), fixtureParent)
  assert.ok(path.basename(resolved).startsWith('media-access-'))
  await removeTempRootWithRetry(resolved)
})
