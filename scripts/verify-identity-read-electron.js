const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
require('./test-data-guard.cjs'); app.disableHardwareAcceleration()
const root = path.resolve(__dirname, '..'), fixture = process.env.WALLPAPER_IDENTITY_READ_FIXTURE, port = Number(process.env.WALLPAPER_IDENTITY_READ_PORT)
assert.ok(fixture && path.dirname(path.resolve(fixture)).startsWith(path.join(root, '.tmp/refactor-tests/identity-read-safety-')))
assert.ok(Number.isInteger(port) && port > 0)
app.setPath('userData', fixture); app.setPath('sessionData', path.join(fixture, 'session'))
const filename = path.join(fixture, 'remote-identity.json'), damaged = 'RAW_SECRET_NATIVE_IDENTITY_FRAGMENT'
fs.writeFileSync(filename, damaged)
fs.writeFileSync(path.join(fixture, 'settings.json'), JSON.stringify({ schemaVersion: 1, theme: 'dark',
  directories: [], remoteAccess: { enabled: true, port, keepRunningInTray: true, allowLegacyToken: false }, windowClose: { mode: 'exit' } }))
const result = { passed: false, electron: process.versions.electron, profile: fixture, windows: [], steps: [] }
let phase = 'startup'
app.on('browser-window-created', (_event, window) => { result.windows.push({ alwaysOnTop: window.isAlwaysOnTop() }); window.hide() })
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async check => { const end = Date.now() + 10000; while (!await check()) { if (Date.now() > end) throw Error('Native identity UI condition timed out'); await delay(10) } }
let finishing = false
function finish(error) {
  if (finishing) return; finishing = true
  if (error) { result.phase = phase; result.error = error.stack || String(error) }
  else result.passed = true
  app.quit()
}
const deadline = setTimeout(() => finish(Error('Native identity read safety timed out')), 25000)
app.once('will-quit', () => {
  clearTimeout(deadline)
  result.sourceDigests = Object.fromEntries(['main/remote/identity.js', 'main/repositories/identity-document.js', 'main/remote/index.js', 'main/ipc/remote.js',
    'src/components/settings/RemoteAccessSection.jsx', 'scripts/verify-identity-read-electron.js', 'dist/index.html']
    .map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]))
  fs.writeFileSync(path.join(fixture, 'result.json'), JSON.stringify(result, null, 2))
})
app.whenReady().then(async () => {
  let window
  await until(async () => {
    window = require('../main/window').getMainWindow()
    if (!window || window.webContents.isLoadingMainFrame()) return false
    try { return await window.webContents.executeJavaScript('Boolean(window.electronAPI && document.querySelector(".sidebar-settings-btn") && !document.getElementById("app-splash"))') } catch { return false }
  })
  const run = source => window.webContents.executeJavaScript(source).catch(error => { throw Error(phase + ': ' + source.slice(0, 180) + ': ' + error.message) })
  phase = 'unavailable IPC'
  assert.equal(fs.readFileSync(filename, 'utf8'), damaged)
  const unavailable = await run('window.electronAPI.remoteGetState()')
  assert.equal(unavailable.running, false); assert.equal(unavailable.accessToken, ''); assert.equal(unavailable.endpoint, ''); assert.equal(unavailable.pairedDevices.length, 0)
  assert.ok(!JSON.stringify(unavailable).includes('RAW_SECRET'))
  assert.equal(require('../main/remote').shouldKeepRunningInTray(), false)
  phase = 'open settings'
  window.setBounds({ width: 1100, height: 760 }); window.setIgnoreMouseEvents(true); window.show(); window.focus()
  await until(() => run('!document.hidden'))
  await run('document.querySelector(".sidebar-settings-btn").click();true')
  await until(() => run(`Boolean(document.querySelector('[aria-label="设置分页"]'))`))
  phase = 'open remote page'
  await run(`Array.from(document.querySelectorAll('[aria-label="设置分页"] button')).find(b=>b.textContent.includes('手机访问')).click();true`)
  await until(() => run('Boolean(document.querySelector(".settings-warning[role=alert]"))'))
  phase = 'disabled actions'
  const blocked = await run('(()=>{const buttons=[...document.querySelectorAll(".settings-section button")];return {warning:document.querySelector(".settings-warning").textContent,port:document.querySelector(".remote-port-field input").disabled,rotate:buttons.find(b=>b.textContent.trim()==="重新生成 Token").disabled,refresh:buttons.find(b=>b.textContent.trim()==="刷新状态").disabled}})()')
  assert.equal(blocked.port, true); assert.equal(blocked.rotate, true); assert.equal(blocked.refresh, false)
  assert.ok(blocked.warning.includes('原文件已保留') && !blocked.warning.includes('已自动生成'))
  assert.equal(await run('document.querySelector(".remote-device-list-header").textContent.includes("暂不可用")'), true)
  result.blocked = blocked; result.steps.push('actual complete main/preload/workbench survives corrupt identity, retains original bytes and presents redacted retry state with disabled credential actions')
  await delay(200)
  assert.equal(window.isAlwaysOnTop(), false)
  fs.writeFileSync(path.join(fixture, 'identity-unavailable.png'), (await window.webContents.capturePage()).toPNG())
  const repaired = { schemaVersion: 1, deviceId: 'pc_native_read_fixture', deviceName: 'Native read fixture', machineSecret: 'native-fixture-machine-secret',
    accessToken: 'native-fixture-legacy-token', pairedDevices: [], createdAt: 1, preservedExtension: { keep: true } }
  fs.writeFileSync(filename, JSON.stringify(repaired))
  phase = 'repair refresh'
  await run('Array.from(document.querySelectorAll(".settings-section button")).find(b=>b.textContent.trim()==="刷新状态").click();true')
  await until(() => run('window.electronAPI.remoteGetState().then(s=>s.running && !s.error)'))
  await until(() => run('!document.querySelector(".settings-warning[role=alert]") && !document.querySelector(".remote-port-field input").disabled'))
  const identity = require('../main/remote/identity').loadIdentity(); assert.equal(identity.machineSecret, repaired.machineSecret); assert.equal(identity.preservedExtension.keep, true)
  phase = 'new QR after repair'
  await run('Array.from(document.querySelectorAll(".settings-section button")).find(b=>b.textContent.trim()==="生成扫码绑定二维码").click();true')
  await until(() => run('Boolean(document.querySelector(".remote-qr-wrap img")?.complete && document.querySelector(".remote-qr-wrap img")?.naturalWidth)'))
  result.steps.push('repair and actual refresh restart the previously enabled service with the same identity, clear the warning and allow a real QR code without an automatic identity reset')
  assert.ok(result.windows.every(item => !item.alwaysOnTop)); assert.equal(BrowserWindow.getAllWindows().length, 1)
  finish()
}).catch(finish)
require('../main/index')
