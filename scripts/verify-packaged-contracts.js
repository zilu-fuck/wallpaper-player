const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')
const { promisify } = require('util')
const asar = require('@electron/asar')
const { minimatch } = require('minimatch')
const { removeTempRootWithRetry } = require('./verify-helpers')
const root = path.resolve(__dirname, '..')
const parent = path.join(root, '.tmp/refactor-tests')
fs.mkdirSync(parent, { recursive: true })
const fixture = fs.mkdtempSync(path.join(parent, 'packaged-contracts-'))
async function main() {
  const files = require('../package.json').build.files
  function included(file) {
    return files.filter(pattern => !pattern.startsWith('!')).some(pattern => minimatch(file, pattern)) &&
      !files.filter(pattern => pattern.startsWith('!')).some(pattern => minimatch(file, pattern.slice(1)))
  }
  const stage = path.join(fixture, 'stage')
  fs.mkdirSync(stage)
  const artifacts = ['packages/contracts/package.json', 'packages/contracts/dist/index.js',
    'packages/contracts/dist/schema.js', 'packages/contracts/dist/settings-feed.js', 'main/remote/http-utils.js', 'packages/domain/package.json', 'packages/domain/dist/index.js',
    'main/application/mpv-installer.js', 'main/application/extract-mpv.ps1', 'main/application/resource-scheduler.js',
    'main/application/download-service.js', 'main/application/download-tasks.js', 'main/application/mpv-version-cache.js',
    'main/exec.js', 'main/process-lifecycle.js', 'main/media-pressure.js',
    'main/window.js', 'main/ipc-channels.js', 'main/security/ipc.js', 'main/security/ipc-sender.js', 'main/security/privacy-password.js', 'main/remote/json-responses.js',
    'main/application/media-mutation-paths.js', 'main/settings.js', 'main/paths.js', 'main/path-identity.js', 'main/constants.js',
    'main/user-data.js', 'main/repositories/tag-state.js', 'main/repositories/tag-normalizers.js', 'main/repositories/user-media.js', 'main/repositories/settings-file.js',
    'main/repositories/settings-normalize.js', 'main/repositories/settings-renderer.js', 'main/repositories/identity-document.js', 'main/repositories/device-activity.js', 'main/security/media-access.js',
    'main/application/media-mutations.js', 'main/ipc/media-data.js', 'main/ipc/window-shell.js', 'main/ipc/app-dialogs.js', 'main/application/confirm.js', 'main/remote/media-mutations.js', 'main/remote/identity.js',
    'main/application/settings-json.js', 'main/application/settings-json-worker.js', 'main/application/settings-reader.js', 'main/application/settings-read-worker.js', 'main/application/settings-broadcast.js', 'main/application/settings-startup.js']
  for (const artifact of artifacts) {
    assert.ok(included(artifact), 'electron-builder must include ' + artifact)
    const target = path.join(stage, artifact)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(root, artifact), target)
  }
  const archive = path.join(fixture, 'app.asar')
  await asar.createPackage(stage, archive)
  const probe = path.join(fixture, 'probe.js')
  fs.writeFileSync(probe, `const { app } = require('electron')
const assert = require('assert')
const path = require('path')
const archive = process.env.WALLPAPER_PACKAGED_FIXTURE_ARCHIVE
assert.strictEqual(path.dirname(path.resolve(archive)), ${JSON.stringify(fixture)})
const profile = path.join(path.dirname(archive), 'profile')
require('fs').mkdirSync(profile, { recursive: true }); app.setPath('userData', profile)
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  try {
    const passwords = require(path.join(archive, 'main/security/privacy-password'))
    const privacy = await passwords.createPrivacyPassword('packaged-fixture')
    assert.strictEqual(await passwords.verifyPrivacyPassword('packaged-fixture', privacy), true)
    assert.strictEqual(await passwords.verifyPrivacyPassword('incorrect', privacy), false)
    const contract = require(path.join(archive, 'packages/contracts'))
    const domain = require(path.join(archive, 'packages/domain'))
    const { sendJson } = require(path.join(archive, 'main/remote/http-utils'))
    assert.strictEqual(contract.PROTOCOL_VERSION, 2)
    let body
    const { EventEmitter } = require('events')
    const request = Object.assign(new EventEmitter(), { method: 'GET', url: '/v1/info', headers: { 'accept-encoding': 'gzip,identity;q=0' } })
    const response = Object.assign(new EventEmitter(), { writeHead(_status, headers) { this.headersSent = true; this.headers = headers }, end(value) { body = JSON.parse(require('zlib').gunzipSync(value).toString()); this.writableEnded = this.writableFinished = true; this.emit('finish') } })
    await sendJson(request, response, 200,
      { deviceId: 'packaged-pc', deviceName: '中文数据路径', capabilities: {} })
    assert.strictEqual(body.protocolVersion, 1)
    assert.strictEqual(response.headers['Content-Encoding'], 'gzip')
    assert.strictEqual(body.capabilities.favoriteState, false)
    assert.throws(() => contract.playbackSchema.parse({ position: -1 }))
    const index = new domain.LibraryQueryIndex([{ id: '1', name: '中文视频 2', size: 10 }])
    assert.strictEqual(index.page(contract.libraryQuerySchema.parse({ query: '视频' }), 0, 200).matchedCount, 1)
    const fs = require('fs/promises')
    const settings = require(path.join(archive, 'main/settings'))
    const { prepareMediaMutationPaths } = require(path.join(archive, 'main/application/media-mutation-paths'))
    const mediaPath = path.join(profile, 'packaged-media.mp4')
    await fs.writeFile(mediaPath, 'packaged-path-fixture')
    await settings.saveSettingsAndFlush({ directories: [profile], customTags: { [mediaPath]: ['legacy'] } })
    const mediaTarget = { kind: 'file', path: mediaPath, rawPath: mediaPath, favoriteKey: 'file:packaged', accessOptions: { audience: 'remote', senderId: 0 } }
    const committedMedia = await settings.updateSettingsAndFlush((current, prepared) => {
      prepared.assertCurrent(current); prepared.assertTarget(mediaTarget)
      assert.deepStrictEqual(prepared.collectLegacyEntries(current.customTags, mediaTarget), [[mediaPath, ['legacy']]])
      return { patch: { favorites: [mediaTarget.favoriteKey] } }
    }, { prepare: current => prepareMediaMutationPaths(current, [mediaTarget], { tags: true }) })
    assert.deepStrictEqual(committedMedia.settings.favorites, ['file:packaged'])
    const { updateUserMedia } = require(path.join(archive, 'main/repositories/user-media'))
    const scoped = await updateUserMedia('favorite', current => {
      assert.deepStrictEqual(Object.keys(current), ['favorites'])
      return { patch: { favorites: [...current.favorites, 'file:scoped'] } }
    })
    assert.deepStrictEqual(scoped.settings.favorites, ['file:packaged', 'file:scoped'])
    assert.strictEqual(JSON.parse(await fs.readFile(path.join(profile, 'settings.json'), 'utf8')).schemaVersion, 1)
    assert.strictEqual(JSON.parse(await fs.readFile(path.join(profile, 'settings.v1.backup.json'), 'utf8')).schemaVersion, 1)
    const { createSettingsFile } = require(path.join(archive, 'main/repositories/settings-file'))
    const recoveryDir = path.join(profile, '中文 recovery'); await fs.mkdir(recoveryDir)
    const recoveryPath = path.join(recoveryDir, 'settings.json'), storage = createSettingsFile(recoveryPath)
    await fs.writeFile(recoveryPath, 'broken-primary')
    await fs.writeFile(storage.paths().backup, JSON.stringify({schemaVersion:1,theme:'packaged-recovered'}))
    let recoveryError; try { storage.read() } catch (error) { recoveryError = error }
    assert.strictEqual(recoveryError.code, 'settings_backup_available')
    const { prepareSettingsForStartup } = require(path.join(archive, 'main/application/settings-startup'))
    let recovered
    assert.strictEqual(await prepareSettingsForStartup({
      settings: { loadSettings: () => storage.read(), recoverSettingsBackup: async id => { recovered = await storage.recover(id); return recovered } },
      dialog: { showMessageBox: async options => { assert.strictEqual(options.defaultId, 0); return {response:1} } }
    }), true)
    assert.strictEqual(await fs.readFile(recovered.preservedPath, 'utf8'), 'broken-primary')
    assert.strictEqual(storage.read().theme, 'packaged-recovered')
    await settings.flushSettingsWrites()
    await settings.disposeSettingsSerialization()
    const identity = require(path.join(archive, 'main/remote/identity'))
    await identity.refreshIdentity()
    const pairing = identity.createPairingCode().payload
    const pairingInput = { pairingId: pairing.pairingId, oneTimeSecret: pairing.oneTimeSecret, clientId: 'packaged-phone' }
    const pendingPairing = await identity.claimPairing(pairingInput)
    identity.approvePairingRequest(pendingPairing.pairingRequestId)
    const paired = await identity.claimPairing(pairingInput)
    const signedThumbnail = identity.createBoundScopedToken('thumbnail', 'packaged-video', paired.token, 60000)
    assert.strictEqual(identity.verifyBoundScopedToken('thumbnail', 'packaged-video', signedThumbnail), true)
    assert.strictEqual(await identity.revokePairedDevice('packaged-phone'), true)
    assert.strictEqual(identity.verifyBoundScopedToken('thumbnail', 'packaged-video', signedThumbnail), false)
    await identity.flushIdentityWrites()
    assert.strictEqual(JSON.parse(await fs.readFile(path.join(profile, 'remote-identity.json'), 'utf8')).pairedDevices.length, 0)
    const { BrowserWindow } = require('electron')
    const { pathToFileURL } = require('url')
    const appWindow = require(path.join(archive, 'main/window'))
    const { bindAppWindow } = require(path.join(archive, 'main/security/ipc-sender'))
    const { ipcMain } = require(path.join(archive, 'main/security/ipc'))
    const entry = path.join(path.dirname(archive), 'entry.html'), other = path.join(path.dirname(archive), 'other.html')
    const preload = path.join(path.dirname(archive), 'preload.js')
    await fs.writeFile(entry, '<title>trusted packaged fixture</title>'); await fs.writeFile(other, '<title>untrusted fixture</title>')
    await fs.writeFile(preload, "require('electron').contextBridge.exposeInMainWorld('probe', { invoke: () => require('electron').ipcRenderer.invoke('packaged-source-probe') })")
    const win = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: false } })
    appWindow.setMainWindow(win); bindAppWindow(win, pathToFileURL(entry).href)
    ipcMain.handle('packaged-source-probe', () => 'trusted')
    await win.loadFile(entry)
    assert.strictEqual(await win.webContents.executeJavaScript('window.probe.invoke()'), 'trusted')
    await win.loadFile(other)
    await assert.rejects(win.webContents.executeJavaScript('window.probe.invoke()'), /ipc_sender_denied/)
    ipcMain.removeHandler('packaged-source-probe'); win.destroy()
    const { MpvInstaller } = require(path.join(archive, 'main/application/mpv-installer'))
    const { mediaScheduler } = require(path.join(archive, 'main/application/resource-scheduler'))
    let extractionScript = ''
    const installer = new MpvInstaller({ directory: path.join(path.dirname(archive), 'mpv-install'),
      download: async (_url, target) => fs.writeFile(target, 'controlled-archive'),
      execute: async (file, args, options) => {
        if (file.endsWith('powershell.exe')) {
          extractionScript = args.at(-1)
          assert.ok(!extractionScript.includes('.asar'))
          assert.deepStrictEqual(await fs.readFile(extractionScript), await fs.readFile(path.join(archive, 'main/application/extract-mpv.ps1')))
          await fs.writeFile(path.join(options.env.WALLPAPER_MPV_EXTRACT, 'mpv.exe'), 'controlled-executable')
          return { stdout: '' }
        }
        return { stdout: 'mpv 0.41.0 fixture' }
      } })
    const installed = await installer.install()
    assert.ok(extractionScript)
    assert.strictEqual(await installer.resolveInstalled(), installed)
    const selectedVersion = await installer.retainExecutable(installed)
    for (let i = 0; i < 3; i++) await installer.install()
    assert.strictEqual(await fs.readFile(installed, 'utf8'), 'controlled-executable')
    assert.ok((await fs.readdir(path.join(path.dirname(installed), '..'))).length <= 3)
    selectedVersion.release()
    await installer.install()
    await assert.rejects(fs.stat(installed), error => error.code === 'ENOENT')
    await installer.dispose()
    const { DownloadTasks, digest } = require(path.join(archive, 'main/application/download-tasks'))
    const tasksPath = path.join(path.dirname(archive), 'tasks.json')
    const ledger = new DownloadTasks({ filename: tasksPath, rpc: async () => {}, stopEngine: async () => {} })
    await ledger.engineStarted()
    const operation = { operationId: 'packaged-intent', fingerprint: digest('packaged-source'), kind: 'url' }
    const accepted = await ledger.submit(operation, async gid => gid); await ledger.dispose()
    const restoredLedger = new DownloadTasks({ filename: tasksPath, rpc: async () => {}, stopEngine: async () => {} })
    await restoredLedger.engineStarted()
    assert.strictEqual((await restoredLedger.submit(operation, async () => { throw Error('duplicate side effect') })).gid, accepted.gid)
    await restoredLedger.dispose(); await mediaScheduler.dispose()
    process.stdout.write('packaged contract runtime passed\\n')
    app.exit(0)
  } catch (error) { process.stderr.write(String(error.stack)); app.exit(1) }
})
`)
  const env = { ...process.env, WALLPAPER_PACKAGED_FIXTURE_ARCHIVE: archive }
  delete env.ELECTRON_RUN_AS_NODE
  const result = await promisify(execFile)(require('electron'), [probe, ...process.argv.slice(2)], { cwd: fixture, env, timeout: 30000, windowsHide: true })
  assert.ok(result.stdout.includes('packaged contract runtime passed'), result.stderr)
  console.log('Windows ASAR verification passed: builder inclusion, actual Electron settings worker/stop, schema/backup/recovery and scoped media repository, async identity/pairing/revocation, privacy/contracts/HTTP serializer, IPC source gate, installer assets/reclamation and durable download ledger restore/deduplication')
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  assert.strictEqual(path.dirname(path.resolve(fixture)), parent)
  assert.ok(path.basename(fixture).startsWith('packaged-contracts-'))
  await removeTempRootWithRetry(fixture)
})
