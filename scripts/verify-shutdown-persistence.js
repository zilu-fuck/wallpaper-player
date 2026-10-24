const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { EventEmitter } = require('events')
const { removeTempRootWithRetry } = require('./verify-helpers')

const projectRoot = path.resolve(__dirname, '..')
const fixtureParent = path.join(projectRoot, '.tmp/refactor-tests')
fs.mkdirSync(fixtureParent, { recursive: true })
const tempRoot = fs.mkdtempSync(path.join(fixtureParent, 'shutdown-'))
process.chdir(tempRoot)
const settings = require(path.join(projectRoot, 'main/settings'))
const { savePlaybackRecord } = require(path.join(projectRoot, 'main/application/media-mutations'))
const source = fs.readFileSync(path.join(projectRoot, 'main/index.js'), 'utf8')
const mediaPath = path.join(tempRoot, 'playing.mp4')
const deadline = setTimeout(() => { console.error('shutdown verification timed out'); process.exit(1) }, 30000)

async function runScenario({ holdRemote = false, position }) {
  const app = new EventEmitter()
  let terminalResolve
  const terminal = new Promise(resolve => { terminalResolve = resolve })
  let windowResolve
  const windowReady = new Promise(resolve => { windowResolve = resolve })
  let releaseRemote
  const remoteHeld = new Promise(resolve => { releaseRemote = resolve })
  let cleanupCount = 0
  let transcodeCleanupCount = 0
  let mediaWorkCleanupCount = 0, metadataCleanupCount = 0, schedulerCleanupCount = 0
  let forcedCount = 0
  let requestedDeadline
  let identityReady = false
  const log = { info() {}, warn() {}, error() {} }
  app.requestSingleInstanceLock = () => true
  app.whenReady = () => Promise.resolve()
  app.quit = () => {
    let prevented = false
    app.emit('before-quit', { preventDefault() { prevented = true } })
    if (!prevented) terminalResolve()
  }
  const win = { webContents: { send() {} }, isDestroyed: () => false }
  const dependencies = {
    electron: { app, dialog: {}, globalShortcut: { register() {}, unregisterAll() {} } },
    'electron-log': log,
    './ipc-channels': require(path.join(projectRoot, 'main/ipc-channels')),
    './window': {
      setupCSP() {}, createWindow() { assert.strictEqual(identityReady, true); windowResolve(); return win },
      getMainWindow: () => win, setWindowCloseHandler() {}
    },
    './ipc': { setupIPC() {} },
    './application/settings-broadcast': { settingsBroadcast: { start() { return settings.onSettingsCommitted(() => {}) } } },
    './application/settings-startup': require(path.join(projectRoot, 'main/application/settings-startup')),
    './updater': { setupAutoUpdater() {}, disposeUpdater() {} },
    './mpv-integration': {
      initMpv: async () => {},
      async destroyMpv() {
        cleanupCount += 1
        await new Promise(resolve => setTimeout(resolve, 20))
        await savePlaybackRecord(mediaPath, { position, volume: 0 })
      },
      mpvManager: { destroy() { forcedCount += 1 } }
    },
    './download-manager': { disposeDownloadManager() {} },
    './scanner': { unwatchAllDirectories() {} },
    './settings': settings,
    './remote/identity': { async refreshIdentity() { await require(path.join(projectRoot, 'main/remote/identity')).refreshIdentity(); identityReady = true } },
    './plugins': { setupPlugins: async () => {}, disposePlugins: async () => {} },
    './remote/transcode': { disposeTranscodes: async () => { transcodeCleanupCount++ } },
    './application/media-work-service': { mediaWorkService: { dispose() { mediaWorkCleanupCount++ } } },
    './video-metadata': { disposeVideoMetadata: async () => { metadataCleanupCount++ } },
    './application/resource-scheduler': { mediaScheduler: { dispose: async () => { schedulerCleanupCount++ } } },
    './portable-user-data': { getPortableDataFallback: () => null },
    './remote': {
      initRemoteAccess: async () => {}, disposeRemoteAccess: () => holdRemote ? remoteHeld : Promise.resolve(),
      shouldKeepRunningInTray: () => false, markQuitting() {}
    }
  }
  vm.runInNewContext(source, {
    require(name) {
      if (!Object.hasOwn(dependencies, name)) throw new Error('Unexpected dependency: ' + name)
      return dependencies[name]
    },
    module: { exports: {} }, process, console,
    setTimeout(callback, delay) {
      requestedDeadline = delay
      return setTimeout(callback, delay)
    },
    clearTimeout
  }, { filename: path.join(projectRoot, 'main/index.js') })
  await windowReady
  app.quit()
  app.quit()
  await terminal
  assert.strictEqual(cleanupCount, 1, 'repeated quit must run teardown exactly once')
  assert.strictEqual(transcodeCleanupCount, 1, 'repeated quit must dispose background transcodes once')
  assert.strictEqual(mediaWorkCleanupCount, 1); assert.strictEqual(metadataCleanupCount, 1); assert.strictEqual(schedulerCleanupCount, 1)
  assert.strictEqual(requestedDeadline, 5000)
  const persisted = JSON.parse(fs.readFileSync(path.join(tempRoot, '.tmp-wallpaper-player/settings.json'), 'utf8'))
  assert.strictEqual(settings.getPlaybackState(persisted.playbackStates, mediaPath).position, position,
    'final playback state must be durable before a normal shutdown completes')
  assert.strictEqual(settings.getPlaybackState(persisted.playbackStates, mediaPath).volume, 0)
  assert.strictEqual(forcedCount, holdRemote ? 1 : 0)
  releaseRemote()
  await settings.flushSettingsWrites()
}

(async () => {
  await settings.saveSettingsAndFlush({ theme: 'dark' })
  await runScenario({ position: 47 })
  await runScenario({ holdRemote: true, position: 83 })
  console.log('shutdown persistence verification passed: durable final progress, repeated quit and bounded stuck cleanup')
})().catch(error => {
  console.error(error)
  process.exitCode = 1
}).finally(async () => {
  clearTimeout(deadline)
  await settings.flushSettingsWrites()
  process.chdir(projectRoot)
  assert.strictEqual(path.dirname(path.resolve(tempRoot)), fixtureParent)
  assert.ok(path.basename(tempRoot).startsWith('shutdown-'))
  await removeTempRootWithRetry(tempRoot)
})
