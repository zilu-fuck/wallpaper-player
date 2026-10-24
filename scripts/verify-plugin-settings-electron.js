const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), Module = require('node:module')
const { app, BrowserWindow } = require('electron')
require('./test-data-guard.cjs')
app.disableHardwareAcceleration()
const root = path.resolve(__dirname, '..'), fixture = process.env.WALLPAPER_PLUGIN_SETTINGS_FIXTURE
const mode = process.env.WALLPAPER_PLUGIN_SETTINGS_MODE
assert.ok(fixture && path.dirname(path.resolve(fixture)).startsWith(path.join(root, '.tmp/refactor-tests/plugin-settings-')))
assert.ok(['current', 'guard-control'].includes(mode))
app.setPath('userData', fixture); app.setPath('sessionData', path.join(fixture, 'session'))
fs.writeFileSync(path.join(fixture, 'settings.json'), JSON.stringify({ schemaVersion: 1, theme: 'dark', directories: [],
  customTags: Object.fromEntries(Array.from({ length: 10000 }, (_, i) => ['file-' + i, ['tag-' + i]])),
  remoteAccess: { enabled: false, keepRunningInTray: false }, windowClose: { mode: 'exit' } }))
const result = { passed: false, mode, electron: process.versions.electron, profile: fixture, windows: [], postSetupIpcEntries: 0 }
app.on('browser-window-created', (_event, window) => { result.windows.push({ alwaysOnTop: window.isAlwaysOnTop() }); window.hide() })
let release, flushEntered = false
const gate = new Promise(resolve => { release = resolve })
const settings = require('../main/settings'), flush = settings.flushSettingsWrites
settings.flushSettingsWrites = async (...args) => { await flush(...args); flushEntered = true; await gate }
const plugins = require('../main/plugins'), setup = plugins.setupPlugins
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const failure = error => { result.error = error.stack || String(error); release() }
plugins.setupPlugins = async (...args) => {
  const value = await setup(...args)
  result.preparedPlugins = plugins.pluginRegistry.listPlugins().map(plugin => ({ id: plugin.id, status: plugin.status }))
  app.quit()
  const end = Date.now() + 4000
  while (!flushEntered) { if (Date.now() > end) throw Error('Quit did not reach settings drain'); await delay(5) }
  setTimeout(() => {
    try {
      assert.ok(result.preparedPlugins.some(plugin => plugin.id === 'video-analysis' && plugin.status !== 'error'))
      assert.equal(result.postSetupIpcEntries, mode === 'guard-control' ? 1 : 0)
      assert.equal(BrowserWindow.getAllWindows().length, 0)
      assert.equal(plugins.pluginRegistry.listPlugins().length, 0)
      result.passed = true
    } catch (error) { failure(error) }
    finally { release() }
  }, 40)
  return value
}
// The positive control stops at the first service boundary, before any window,
// shortcut or player may be recreated by the deliberately removed quit guard.
require('../main/ipc').setupIPC = () => {
  result.postSetupIpcEntries++
  throw Error('controlled post-quit service boundary')
}
const deadline = setTimeout(() => {
  failure(Error('Native plugin startup/quit check timed out'))
  fs.writeFileSync(path.join(fixture, 'result.json'), JSON.stringify(result, null, 2)); app.exit(1)
}, 15000)
app.once('will-quit', () => {
  clearTimeout(deadline)
  result.closedSettingsDrain = flushEntered
  result.sourceDigests = Object.fromEntries(['main/index.js', 'main/settings.js', 'main/plugins/registry.js',
    'main/plugins/index.js', 'scripts/verify-plugin-settings-electron.js']
    .map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]))
  fs.writeFileSync(path.join(fixture, 'result.json'), JSON.stringify(result, null, 2))
})
if (mode === 'guard-control') {
  const filename = path.join(root, 'main/index.js'), source = fs.readFileSync(filename, 'utf8').replaceAll('\r\n', '\n')
  const guarded = '  await setupPlugins()\n  if (isAppQuitting) return'
  assert.ok(source.includes(guarded))
  const control = source.replace(guarded, '  await setupPlugins()')
  result.controlSourceSha256 = crypto.createHash('sha256').update(control).digest('hex')
  const entry = new Module(filename, module)
  entry.filename = filename; entry.paths = Module._nodeModulePaths(path.dirname(filename)); entry._compile(control, filename)
} else require('../main/index')
