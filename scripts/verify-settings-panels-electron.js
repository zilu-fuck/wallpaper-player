const assert = require('assert'), fs = require('fs'), fsp = require('fs/promises'), path = require('path')
const { pathToFileURL } = require('url')
const { app, BrowserWindow } = require('electron')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests'), fixture = process.env.WALLPAPER_SETTINGS_PANEL_FIXTURE
assert.strictEqual(path.dirname(path.resolve(fixture)), parent)
app.setPath('userData', fixture); app.on('window-all-closed', () => {})
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const delay = ms => new Promise(done => setTimeout(done, ms))
let phase = 'startup', window, remove, registry, remoteService
const rename = fsp.rename, gates = []
const deadline = setTimeout(() => { console.error('settings panel UI timeout: ' + phase); app.exit(1) }, 30000)
app.whenReady().then(async () => {
  const settings = require('../main/settings'), { ipcMain } = require('../main/security/ipc'), { IPC, EVENT } = require('../main/ipc-channels')
  registry = require('../main/plugins').pluginRegistry; remoteService = require('../main/remote')
  await settings.saveSettingsAndFlush({ theme: 'dark', remoteAccess: { enabled: false, port: 42001, keepRunningInTray: false, allowLegacyToken: false } })
  for (const id of ['panel-a', 'panel-b']) await registry.register({ id, name: id, enabled: false, setup() {}, secretKeys: ['secret'],
    settingsDefaults: { title: id, note: 'original note', secret: 'fixture-secret' },
    settingsSchema: { title: { type: 'string', title: '标题' }, note: { type: 'string', title: '备注' }, secret: { type: 'string', title: '密钥' } } })
  const ai = require('../main/plugins/ai-search')
  await registry.register({ id: ai.id, name: ai.name, enabled: false, setup() {}, settingsDefaults: ai.settingsDefaults, settingsSchema: ai.settingsSchema })
  await settings.flushSettingsWrites()
  let configCalls = 0, configInputs = [], configHeld, listCalls = 0, oldListHeld, portCalls = 0, remoteInputs = [], portHeld, ordinarySaves = 0
  const configGate = deferred(), listGate = deferred(), portGate = deferred(); gates.push(configGate, listGate, portGate)
  require('../main/ipc/settings').registerSettingsIpc({ handle(channel, action) { ipcMain.handle(channel, async (...args) => {
    if (channel === IPC.SAVE_SETTINGS) ordinarySaves++
    return action(...args)
  }) } })
  require('../main/ipc/plugins').registerPluginIpc({ handle(channel, action) { ipcMain.handle(channel, async (...args) => {
    if (channel === IPC.PLUGINS_LIST) listCalls++
    if (channel === IPC.PLUGINS_SAVE_CONFIG) { configCalls++; configInputs.push(args[2]) }
    const result = await action(...args)
    if (channel === IPC.PLUGINS_LIST && listCalls === 2) { oldListHeld = true; await listGate.promise }
    if (channel === IPC.PLUGINS_SAVE_CONFIG && configCalls === 1) { configHeld = true; await configGate.promise }
    return result
  }) } })
  require('../main/ipc/remote').registerRemoteIpc({ handle(channel, action) { ipcMain.handle(channel, async (...args) => {
    if (channel === IPC.REMOTE_SAVE_SETTINGS) { remoteInputs.push(args[1]); if (Object.hasOwn(args[1], 'port')) portCalls++ }
    const result = await action(...args)
    if (channel === IPC.REMOTE_SAVE_SETTINGS && Object.hasOwn(args[1], 'port') && portCalls === 1) { portHeld = true; await portGate.promise }
    return result
  }) } })
  for (const [channel, response] of [[IPC.CHECK_FFMPEG, { available: false }], [IPC.CHECK_MPV, { available: false }], [IPC.UPDATER_GET_STATUS, { status: 'disabled' }]]) ipcMain.handle(channel, async () => response)
  window = new BrowserWindow({ show: false, width: 1200, height: 820, webPreferences: { preload: path.join(root, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  require('../main/window').setMainWindow(window)
  const entry = path.join(root, 'dist/index.html'); require('../main/security/ipc-sender').bindAppWindow(window, pathToFileURL(entry).href)
  remove = settings.onSettingsChanged(snapshot => { if (!window.isDestroyed()) window.webContents.send(EVENT.SETTINGS_CHANGED, settings.sanitizeSettingsForRenderer(snapshot)) })
  const run = source => window.webContents.executeJavaScript(source).catch(error => { throw Error(phase + ': ' + source.slice(0, 200) + ': ' + error.message) })
  const until = async check => { const end = Date.now() + 8000; while (!await check()) { if (Date.now() > end) throw Error('UI condition timed out: ' + phase); await delay(5) } }
  const click = (selector, text) => run(`(() => { const items = [...document.querySelectorAll(${JSON.stringify(selector)})]; const button = ${text === undefined ? 'items[0]' : 'items.find(item => item.textContent.trim() === ' + JSON.stringify(text) + ')'}; if (!button) throw Error('button missing'); button.click(); })()`)
  const tab = text => run(`(() => { const button = [...document.querySelectorAll('[aria-label="设置分页"] button')].find(item => item.textContent.includes(${JSON.stringify(text)})); button.click(); })()`)
  const edit = async (selector, value) => run(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element || element.disabled) throw Error('field disabled or missing');
    Object.getOwnPropertyDescriptor(element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(element, ${JSON.stringify(value)}); element.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  const fieldValue = selector => run('document.querySelector(' + JSON.stringify(selector) + ').value')
  await window.loadFile(entry); await window.webContents.insertCSS('*, *::before, *::after { animation: none !important; transition: none !important; }')
  await until(() => run("Boolean(document.querySelector('.sidebar-settings-btn'))"))
  await run("window.__panelErrors = []; window.addEventListener('unhandledrejection', event => window.__panelErrors.push(String(event.reason)))")
  await click('.sidebar-settings-btn'); await until(() => run("Boolean(document.querySelector('.settings-panel'))"))
  await tab('插件管理'); await until(() => Boolean(oldListHeld))
  phase = 'plugin edits across save and selection'
  const title = '.plugin-config-grid .plugin-config-field:first-child input'
  await edit(title, 'submitted a'); await click('.plugin-config-heading button')
  await until(() => Boolean(configHeld))
  assert.deepStrictEqual(Object.keys(configInputs[0]), ['title'])
  await edit(title, 'a typed during save')
  await run("[...document.querySelectorAll('.plugin-list-item')].find(item => item.textContent.includes('panel-b')).click()")
  await edit(title, 'unsaved b')
  await run("[...document.querySelectorAll('.plugin-list-item')].find(item => item.textContent.includes('panel-a')).click()")
  assert.strictEqual(await fieldValue(title), 'a typed during save')
  await settings.saveSettingsAndFlush({ plugins: { 'panel-a': { config: { note: 'background note' } } } })
  configGate.resolve(); await until(() => run("document.querySelector('.plugin-message')?.textContent.includes('新更改尚未保存')"))
  listGate.resolve(); await delay(50)
  assert.strictEqual(await fieldValue(title), 'a typed during save')
  assert.strictEqual(await fieldValue('.plugin-config-grid .plugin-config-field:nth-child(2) input'), 'background note')
  await run("[...document.querySelectorAll('.plugin-list-item')].find(item => item.textContent.includes('panel-b')).click()")
  assert.strictEqual(await fieldValue(title), 'unsaved b')
  await run("[...document.querySelectorAll('.plugin-list-item')].find(item => item.textContent.includes('panel-a')).click()")
  await click('.plugin-config-heading button')
  await until(() => settings.loadSettings().plugins['panel-a'].config.title === 'a typed during save')
  assert.strictEqual(settings.loadSettings().plugins['panel-a'].config.secret, 'fixture-secret')

  phase = 'AI form drafts across plugins and tabs'
  await until(() => run("!document.querySelector('.plugin-config-heading button').disabled || document.querySelector('.plugin-message')?.textContent === '插件配置已保存'"))
  await run("[...document.querySelectorAll('.plugin-list-item')].find(item => item.textContent.includes('AI 搜索')).click()")
  await until(() => run("Boolean(document.querySelector('.ai-search-settings'))"))
  const trustedSite = '.ai-search-trusted-editor textarea'
  const tagDraft = '.ai-search-settings textarea[placeholder="手动补充标签"]'
  const localModel = '.ai-search-settings input[placeholder="qwen2.5"]'
  await edit(trustedSite, 'unfinished.example'); await edit(tagDraft, 'unfinished tag'); await edit(localModel, 'local draft')
  await run("[...document.querySelectorAll('.plugin-list-item')].find(item => item.textContent.includes('panel-b')).click()")
  await run("[...document.querySelectorAll('.plugin-list-item')].find(item => item.textContent.includes('AI 搜索')).click()")
  assert.strictEqual(await fieldValue(trustedSite), 'unfinished.example'); assert.strictEqual(await fieldValue(tagDraft), 'unfinished tag')
  await tab('基础设置'); await tab('插件管理')
  await until(() => run("Boolean(document.querySelector('.ai-search-settings'))"))
  assert.strictEqual(await fieldValue(localModel), 'local draft'); assert.strictEqual(await fieldValue(trustedSite), 'unfinished.example')

  phase = 'remote dirty port and partial toggles'
  await tab('手机访问'); await until(() => run("Boolean(document.querySelector('.remote-port-field input:not(:disabled)'))"))
  await edit('.remote-port-field input', '42011')
  await remoteService.applyRemoteSettings({ port: 42012 })
  await delay(50); assert.strictEqual(await fieldValue('.remote-port-field input'), '42011')
  await run("document.querySelectorAll('.remote-settings-grid input[type=checkbox]')[2].click()")
  await until(() => settings.loadSettings().remoteAccess.allowLegacyToken === true)
  assert.strictEqual(settings.loadSettings().remoteAccess.port, 42012)
  assert.deepStrictEqual(Object.keys(remoteInputs[0]), ['allowLegacyToken'])
  await until(() => run("!document.querySelector('.remote-port-field button').disabled"))
  await click('.remote-port-field button'); await until(() => Boolean(portHeld))
  await edit('.remote-port-field input', '42013'); portGate.resolve()
  await until(() => run("!document.querySelector('.remote-port-field button').disabled"))
  assert.strictEqual(await fieldValue('.remote-port-field input'), '42013')
  assert.strictEqual(settings.loadSettings().remoteAccess.port, 42011)
  await click('.remote-port-field button'); await until(() => settings.loadSettings().remoteAccess.port === 42013)
  await edit('.remote-port-field input', '99999'); const before = remoteInputs.length
  await click('.remote-port-field button'); await delay(30)
  assert.strictEqual(remoteInputs.length, before)
  assert.ok(await run("document.querySelector('.settings-section [role=alert]').textContent.includes('65535')"))
  phase = 'remote disk failure and visual feedback'
  let failNext = true
  fsp.rename = async function (from, to) {
    if (failNext && to === path.join(fixture, 'settings.json')) { failNext = false; throw Error('fixture remote disk failure') }
    return rename.call(this, from, to)
  }
  await edit('.remote-port-field input', '42014'); await click('.remote-port-field button')
  await until(() => run("document.querySelector('.settings-section [role=alert]')?.textContent.includes('fixture remote disk failure')"))
  assert.strictEqual(settings.loadSettings().remoteAccess.port, 42013)
  assert.strictEqual(await fieldValue('.remote-port-field input'), '42014')
  await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await delay(150)
  await fsp.writeFile(path.join(parent, 'remote-settings-draft-error.png'), (await window.webContents.capturePage()).toPNG())
  window.setSize(900, 820)
  await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await delay(250)
  assert.ok(await run(`(() => { const box = document.querySelector('.remote-port-field'); return box.scrollWidth <= box.clientWidth + 1 && [...box.children].every(item => item.getBoundingClientRect().right <= box.getBoundingClientRect().right + 1) })()`), 'port draft and save control fit the narrow settings panel')
  await fsp.writeFile(path.join(parent, 'remote-settings-narrow.png'), (await window.webContents.capturePage()).toPNG())
  fsp.rename = rename; await click('.remote-port-field button'); await until(() => settings.loadSettings().remoteAccess.port === 42014)
  assert.strictEqual(ordinarySaves, 0, 'remote settings do not re-save their result through the global settings channel')
  assert.deepStrictEqual(await run('window.__panelErrors'), [])
  console.log('settings panel UI passed: actual App/components/preload/guarded plugin and remote IPC, old list/read isolation, per-plugin and AI form drafts, editable in-flight save, partial fields/secrets, explicit port saves, runtime broadcasts, real disk failure/retry and 900px port layout')
}).then(() => finish(0), error => { console.error('settings panel phase: ' + phase, error); finish(1) })
async function finish(code) {
  gates.forEach(gate => gate.resolve()); fsp.rename = rename; remove?.(); clearTimeout(deadline)
  await registry?.dispose().catch(() => {}); await remoteService?.disposeRemoteAccess().catch(() => {})
  if (window && !window.isDestroyed()) window.destroy()
  app.exit(code)
}
