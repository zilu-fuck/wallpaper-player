const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const fixture = process.env.WALLPAPER_VITE_FIXTURE, url = process.env.WALLPAPER_VITE_URL
assert.ok(fixture && path.dirname(path.resolve(fixture)) === path.resolve(__dirname, '../.tmp/refactor-tests'))
assert.ok(/^http:\/\/127\.0\.0\.1:\d+\/$/.test(url))
assert.ok(globalThis[Symbol.for('wallpaper.verify.dataGuard')])
app.setPath('userData', path.join(fixture, 'profile')); app.setPath('sessionData', path.join(fixture, 'session'))
const result = { success: false, electron: process.versions.electron, errors: [] }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let window
const deadline = setTimeout(() => { result.error = 'Native dev probe deadline'; app.exit(1) }, 30000)
app.on('will-quit', () => { clearTimeout(deadline); fs.writeFileSync(path.join(fixture, 'result.json'), JSON.stringify(result, null, 2)) })
app.whenReady().then(async () => {
  window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } })
  window.webContents.on('console-message', details => { if (details.level === 'error') result.errors.push(details.message) })
  await window.loadURL(url)
  const run = code => window.webContents.executeJavaScript(code)
  const until = async (code, milliseconds) => { const end = Date.now() + milliseconds
    while (!await run(code)) { if (Date.now() > end) throw Error('Dev condition timed out: ' + code + ' ' + JSON.stringify(result.errors)); await delay(25) } }
  await until('document.querySelector("#contract")?.textContent === "stop" && document.querySelector("#domain")?.textContent === "ready"', 10000)
  await run('document.querySelector("#counter").click(); true')
  await until('document.querySelector("#counter")?.textContent === "1"', 3000)
  fs.writeFileSync(path.join(fixture, 'hmr-ready'), '')
  await until('document.querySelector("#label")?.textContent === "after"', 10000)
  result.counterAfterRefresh = await run('document.querySelector("#counter").textContent')
  assert.equal(result.counterAfterRefresh, '1')
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors))
  result.success = true
  app.quit()
}).catch(error => { result.error = error.stack; app.quit() })
