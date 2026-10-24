const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')
const { app } = require('electron')
require('./test-data-guard.cjs')
app.disableHardwareAcceleration()
const fixture = process.env.WALLPAPER_RUNTIME_FIXTURE
assert.ok(fixture && path.dirname(path.resolve(fixture)) === path.resolve(__dirname, '../.tmp/refactor-tests'))
assert.ok(globalThis[Symbol.for('wallpaper.verify.dataGuard')], 'native test must inherit data protection')
app.setPath('userData', fixture)
app.setPath('sessionData', path.join(fixture, 'session'))
const library = path.join(fixture, 'library'), settingsFile = path.join(fixture, 'settings.json')
fs.mkdirSync(library)
fs.writeFileSync(settingsFile, JSON.stringify({ schemaVersion: 1, theme: 'dark',
  directories: [library], customTags: Object.fromEntries(Array.from({ length: 10000 }, (_, i) => ['file-' + i, ['tag-' + i]])),
  privacy: { salt: 'a'.repeat(32), passwordHash: 'b'.repeat(64) },
  remoteAccess: { enabled: false, keepRunningInTray: false }, windowClose: { mode: 'exit' } }))
const result = { success: false, electron: process.versions.electron, chrome: process.versions.chrome,
  node: process.versions.node, v8: process.versions.v8, arch: process.arch, profile: fixture }
const settings = require('../main/settings'), initialize = settings.initializeSettings
let startupComplete = false
async function traceSettingsPreparation(operation) {
  const parse = JSON.parse, stringify = JSON.stringify, read = fs.readFileSync, realpath = fs.realpathSync, native = realpath.native
  const counters = { fullParses: 0, fullStringifies: 0, syncSettingsReads: 0, syncLibraryRealpaths: 0 }
  const full = value => value && typeof value === 'object' && ['customTags', 'directories', 'privacy'].every(key => Object.hasOwn(value, key))
  JSON.parse = function (...values) {
    const value = parse.apply(this, values)
    if (full(value)) counters.fullParses++
    return value
  }
  JSON.stringify = function (value, ...values) { if (full(value)) counters.fullStringifies++; return stringify.call(this, value, ...values) }
  fs.readFileSync = function (file, ...values) {
    if (typeof file === 'string' && path.resolve(file) === settingsFile) counters.syncSettingsReads++
    return read.call(this, file, ...values)
  }
  const wrapRealpath = fn => function (file, ...values) {
    if (typeof file === 'string' && path.resolve(file) === library) counters.syncLibraryRealpaths++
    return fn.call(this, file, ...values)
  }
  fs.realpathSync = wrapRealpath(realpath); fs.realpathSync.native = wrapRealpath(native)
  try { return { value: await operation(), counters } }
  finally {
    JSON.parse = parse; JSON.stringify = stringify; fs.readFileSync = read; fs.realpathSync = realpath
  }
}
settings.initializeSettings = async function (...args) {
  if (startupComplete) return initialize.apply(this, args)
  const { value, counters } = await traceSettingsPreparation(() => initialize.apply(this, args))
  startupComplete = true; result.initialSettingsPreparation = counters
  return value
}
const registerSection = settings.registerSettingsSectionAsync
result.sectionPreparations = []
settings.registerSettingsSectionAsync = async function (...args) {
  const { value, counters } = await traceSettingsPreparation(() => registerSection.apply(this, args))
  result.sectionPreparations.push({ key: args[0], counters })
  return value
}
result.windows = []
app.on('browser-window-created', (_event, window) => {
  result.windows.push({ startupComplete, alwaysOnTop: window.isAlwaysOnTop() })
  window.hide()
})
const log = require('electron-log'), messages = []
for (const method of ['debug', 'info', 'warn', 'error']) {
  const original = log[method]
  log[method] = (...args) => {
    if (typeof args[0] === 'string' && args[0].includes('runtime44-probe-')) messages.push({ method, text: args[0] })
    return original.apply(log, args)
  }
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let finishing = false
const finish = error => {
  if (finishing) return
  finishing = true
  if (error) result.error = error.stack || String(error)
  else result.success = true
  app.quit()
}
const deadline = setTimeout(() => finish(Error('Full application startup timed out')), 30000)
app.once('will-quit', () => {
  clearTimeout(deadline)
  if (result.success) {
    try {
      const primary = JSON.parse(fs.readFileSync(path.join(fixture, 'settings.json'), 'utf8'))
      const backup = JSON.parse(fs.readFileSync(path.join(fixture, 'settings.v1.backup.json'), 'utf8'))
      assert.equal(primary.theme, 'light'); assert.equal(primary.schemaVersion, 1); assert.equal(backup.schemaVersion, 1)
      assert.equal(Object.keys(primary.customTags).length, 10000)
      result.persistedAfterShutdown = true
    } catch (error) { result.success = false; result.error = error.stack }
  }
  fs.writeFileSync(path.join(fixture, 'runtime-result.json'), JSON.stringify(result, null, 2))
})
app.whenReady().then(async () => {
  assert.equal(process.versions.electron, require('../package.json').devDependencies.electron)
  const end = Date.now() + 20000
  let window
  while (!finishing) {
    window = require('../main/window').getMainWindow()
    if (window && !window.webContents.isLoadingMainFrame()) {
      try {
        if (await window.webContents.executeJavaScript('Boolean(document.querySelector(".sidebar") && window.electronAPI)')) break
      } catch {}
    }
    if (Date.now() > end) throw Error('Frontend/preload did not become ready')
    await delay(25)
  }
  assert.ok(!finishing)
  const zeroPreparation = { fullParses: 0, fullStringifies: 0, syncSettingsReads: 0, syncLibraryRealpaths: 0 }
  assert.deepEqual(result.initialSettingsPreparation, zeroPreparation)
  assert.ok(result.sectionPreparations.some(item => item.key === 'videoAnalysis'), 'actual official video-analysis section uses asynchronous preparation')
  for (const item of result.sectionPreparations) assert.deepEqual(item.counters, zeroPreparation, item.key)
  result.plugins = require('../main/plugins').pluginRegistry.listPlugins().map(plugin => ({ id: plugin.id, status: plugin.status }))
  assert.ok(result.plugins.some(plugin => plugin.id === 'video-analysis' && plugin.status !== 'error'))
  assert.ok(result.windows.length > 0 && result.windows.every(window => window.startupComplete && !window.alwaysOnTop))
  const run = code => window.webContents.executeJavaScript(code)
  result.security = window.webContents.getLastWebPreferences()
  assert.equal(result.security.contextIsolation, true); assert.equal(result.security.nodeIntegration, false)
  assert.equal(result.security.webSecurity, true)
  const publicSettings = await run('window.electronAPI.getSettings()')
  assert.equal(publicSettings.schemaVersion, 1)
  assert.equal(Object.keys(publicSettings.customTags).length, 10000)
  assert.equal(publicSettings.privacy.salt, undefined); assert.equal(publicSettings.privacy.passwordHash, undefined)
  await run('window.electronAPI.saveSettings({ theme: "light" })')
  assert.equal((await run('window.electronAPI.getSettings()')).theme, 'light')
  const assets = path.resolve(__dirname, '../dist/assets'), names = fs.readdirSync(assets)
  result.lazyModules = []
  for (const prefix of ['Settings', 'VideoAnalysisSidebar', 'AISearchPanel', 'DownloadCenter', 'NetworkResourceLibrary', 'useDownloadStateObserver']) {
    const file = names.find(name => name.startsWith(prefix + '-') && name.endsWith('.js'))
    assert.ok(file, 'production lazy module: ' + prefix)
    const keys = await run(`import(${JSON.stringify(pathToFileURL(path.join(assets, file)).href)}).then(value => Object.keys(value))`)
    assert.ok(keys.length > 0, 'lazy module exports: ' + prefix)
    result.lazyModules.push({ prefix, file, exports: keys })
  }
  await run('console.debug("runtime44-probe-debug"); console.info("runtime44-probe-info"); console.warn("runtime44-probe-warning"); console.error("runtime44-probe-error"); true')
  for (const [level, method] of [['debug', 'debug'], ['info', 'info'], ['warning', 'warn'], ['error', 'error']]) {
    assert.ok(messages.some(message => message.method === method && message.text.includes('[renderer:' + level + '] runtime44-probe-' + level)))
  }
  result.consoleDetails = messages
  result.frontend = await run('({ title: document.title, bridge: typeof window.electronAPI.remoteCopyEndpoint, userAgent: navigator.userAgent, theme: document.documentElement.getAttribute("data-theme") })')
  assert.equal(result.frontend.bridge, 'function')
  const splashEnd = Date.now() + 8000
  while (!await run('!document.getElementById("app-splash") && !document.getElementById("root").inert')) {
    if (Date.now() > splashEnd) throw Error('Splash did not release the real workbench')
    await delay(50)
  }
  result.splashReleasedWorkbench = true
  result.sourceDigests = Object.fromEntries(['main/index.js', 'main/settings.js', 'main/application/settings-startup.js',
    'main/application/settings-json.js', 'main/application/settings-json-worker.js', 'main/repositories/settings-file.js',
    'main/repositories/settings-normalize.js', 'main/plugins/registry.js', 'main/plugins/index.js', 'main/plugins/core-api.js',
    'main/plugins/capabilities.js', 'scripts/verify-electron-runtime-electron.js', 'dist/index.html']
    .map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.resolve(__dirname, '..', file))).digest('hex')]))
  // A hidden native window may not have a Viz surface; render without taking focus.
  window.showInactive()
  assert.equal(window.isAlwaysOnTop(), false)
  await delay(250)
  result.screenshot = path.join(fixture, 'runtime-window.png')
  try { fs.writeFileSync(result.screenshot, (await window.webContents.capturePage()).toPNG()) }
  finally { window.hide() }
  finish()
}).catch(finish)
require('../main/index')
