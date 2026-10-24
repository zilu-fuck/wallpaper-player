const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { app, BrowserWindow, ipcMain, session } = require('electron')
app.on('window-all-closed', () => {})

const projectRoot = path.resolve(__dirname, '..')
const tempParent = path.join(projectRoot, '.tmp', 'vlm-ui-tests')
fs.mkdirSync(tempParent, { recursive: true })
const tempRoot = fs.mkdtempSync(path.join(tempParent, 'run-'))
assert.strictEqual(path.dirname(path.resolve(tempRoot)), tempParent)

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function parseRgb(color) {
  const match = String(color || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i)
  if (!match) return null
  return match.slice(1, 4).map(Number)
}

function assertReadableDarkText(label, color) {
  const rgb = parseRgb(color)
  assert.ok(rgb, `${label} should expose a computed rgb color, got ${color}`)
  const [red, green, blue] = rgb
  assert.ok(
    red < 150 && green < 160 && blue < 175,
    `${label} should be dark enough in light theme, got ${color}`
  )
}

function assertNoPaleSettingsText(items) {
  const offenders = items.filter((item) => {
    const rgb = parseRgb(item.color)
    if (!rgb) return false
    const [red, green, blue] = rgb
    return red > 180 && green > 180 && blue > 180
  })
  assert.deepStrictEqual(offenders, [], 'settings panel should not contain pale regular text in light theme')
}

async function waitFor(condition, timeoutMs = 5000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const value = await condition()
    if (value) return value
    await wait(100)
  }
  throw new Error('Timed out waiting for UI condition')
}

async function readUi(win) {
  return win.webContents.executeJavaScript(`(() => {
    const text = document.body.innerText;
    const startButton = document.querySelector('.analysis-vlm-start-button');
    const styleColor = (selector) => {
      const node = document.querySelector(selector);
      return node ? getComputedStyle(node).color : '';
    };
    const regularTextColors = [...document.querySelectorAll('.settings-panel :is(h2, h3, p, small, strong, label > span, .plugin-list-name)')]
      .filter((node) => {
        const text = node.textContent.trim();
        if (!text) return false;
        if (node.closest('button, .plugin-status, .theme-swatch, svg')) return false;
        const style = getComputedStyle(node);
        if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .map((node) => ({
        selector: node.className || node.tagName.toLowerCase(),
        text: node.textContent.trim().slice(0, 32),
        color: getComputedStyle(node).color
      }));
    return {
      text,
      appClasses: document.querySelector('.app')?.className || '',
      startButtonText: startButton?.textContent.trim() || '',
      startButtonDisabled: Boolean(startButton?.disabled),
      startButtonClasses: startButton?.className || '',
      primaryButtonBg: startButton ? getComputedStyle(startButton).backgroundImage || getComputedStyle(startButton).backgroundColor : '',
      settingTitleColor: styleColor('.settings-header h2'),
      pluginHintColor: styleColor('.plugin-info-box .hint'),
      pluginPathColor: styleColor('.plugin-info-box .plugin-path'),
      pluginEmptyHintColor: styleColor('.plugin-info-box:nth-child(4) .hint'),
      regularTextColors
    };
  })()`)
}

async function clickButton(win, label) {
  await win.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find(item => item.textContent.includes(${JSON.stringify(label)}));
    if (!button) throw new Error('Button not found: ${label}');
    button.click();
  })()`)
}

async function main() {
  app.setPath('userData', tempRoot)
  app.commandLine.appendSwitch('disable-gpu')

  const { saveSettings } = require(path.join(projectRoot, 'main', 'settings'))
  const { setupPlugins, disposePlugins } = require(path.join(projectRoot, 'main', 'plugins'))
  const { setupIPC } = require(path.join(projectRoot, 'main', 'ipc'))
  const { setupRemoteIPC } = require(path.join(projectRoot, 'main', 'remote'))

  saveSettings({
    theme: 'light',
    directories: [],
    defaultDirectory: '',
    remoteAccess: { enabled: false },
    plugins: {
      'video-analysis': {
        enabled: true,
        updatedAt: new Date().toISOString()
      }
    },
    videoAnalysis: {
      enabled: true
    }
  })

  await setupPlugins()
  setupIPC()
  setupRemoteIPC()

  const guardedIpc = require('../main/security/ipc').ipcMain
  const runtimeService = require('../main/plugins/video-analysis/service')
  let releaseRuntime, releaseSave, saveCount = 0
  guardedIpc.removeHandler('video-analysis-get-runtime-config')
  guardedIpc.handle('video-analysis-get-runtime-config', async () => {
    const config = await runtimeService.getVideoAnalysisRuntimeConfig()
    await new Promise(resolve => { releaseRuntime = resolve })
    return { success: true, config }
  })
  guardedIpc.removeHandler('video-analysis-save-runtime-config')
  guardedIpc.handle('video-analysis-save-runtime-config', async (_event, input) => {
    if (++saveCount === 2) return { success: false, error: '测试保存失败' }
    const config = await runtimeService.saveVideoAnalysisRuntimeConfig(input)
    if (saveCount === 1) await new Promise(resolve => { releaseSave = resolve })
    return { success: true, config }
  })

  ipcMain.removeHandler('video-analysis-vlm-start')
  ipcMain.handle('video-analysis-vlm-start', async () => {
    await wait(350)
    return {
      success: false,
      error: '测试启动失败',
      state: { connected: false, running: false, modelExists: true }
    }
  })
  let downloading = false, resolveDownload, cancelCalls = 0, downloadCalls = 0
  for (const channel of ['video-analysis-vlm-state', 'video-analysis-vlm-download', 'video-analysis-vlm-download-cancel']) ipcMain.removeHandler(channel)
  ipcMain.handle('video-analysis-vlm-state', () => ({ success: true, state: { connected: false, running: false, modelExists: true, downloading } }))
  ipcMain.handle('video-analysis-vlm-download', event => {
    downloading = true; downloadCalls++
    event.sender.send('video-analysis-vlm-event', { type: 'download-started' })
    return new Promise(resolve => { resolveDownload = resolve })
  })
  ipcMain.handle('video-analysis-vlm-download-cancel', event => {
    cancelCalls++; downloading = false
    event.sender.send('video-analysis-vlm-event', { type: 'download-error', error: '模型下载已取消' })
    resolveDownload({ success: false, error: '模型下载已取消', state: { downloading: false } })
    return { success: true, cancelled: true }
  })

  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    show: false,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: path.join(projectRoot, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      offscreen: true,
      backgroundThrottling: false
    }
  })

  await session.defaultSession.clearCache()
  require('../main/window').setMainWindow(win)
  require('../main/security/ipc-sender').bindAppWindow(win, require('url').pathToFileURL(path.join(projectRoot, 'dist', 'index.html')).href)
  await win.loadFile(path.join(projectRoot, 'dist', 'index.html'))
  await waitFor(async () => (await readUi(win)).text.includes('设置'))
  await clickButton(win, '设置')
  await waitFor(async () => (await readUi(win)).text.includes('插件管理'))
  await clickButton(win, '插件管理')
  await waitFor(async () => (await readUi(win)).text.includes('视频理解设置'))

  const inputValue = async value => win.webContents.executeJavaScript(`(() => {
    const input = [...document.querySelectorAll('.analysis-runtime-field input')].find(node => node.closest('label').querySelector('span')?.textContent.includes('文本模型名称'));
    if (!input) throw Error('text model input missing');
    ${value == null ? '' : `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true }));`}
    return input.value;
  })()`)
  await waitFor(() => releaseRuntime)
  assert.strictEqual((await readUi(win)).startButtonDisabled, true)
  await inputValue('读取期间的草稿')
  releaseRuntime()
  await waitFor(async () => (await readUi(win)).startButtonText === '启动模型')
  assert.strictEqual(await inputValue(), '读取期间的草稿')
  const { sanitizeSettingsForRenderer } = require('../main/settings')
  win.webContents.send('settings-changed', sanitizeSettingsForRenderer(saveSettings({ videoAnalysis: { llmProfiles: { local: { llmName: '较旧的广播' } } } })))
  await wait(50); assert.strictEqual(await inputValue(), '读取期间的草稿', 'settings broadcasts preserve the local draft')
  await clickButton(win, '保存分析参数'); await waitFor(() => releaseSave)
  await inputValue('保存期间的新草稿'); releaseSave()
  await waitFor(async () => (await readUi(win)).text.includes('分析参数已保存'))
  assert.strictEqual(await inputValue(), '保存期间的新草稿')
  assert.ok((await readUi(win)).text.includes('分析参数有未保存的更改'))
  await clickButton(win, '保存分析参数')
  await waitFor(async () => (await readUi(win)).text.includes('测试保存失败'))
  assert.strictEqual(await inputValue(), '保存期间的新草稿')
  await clickButton(win, '保存分析参数')
  await waitFor(async () => (await readUi(win)).text.includes('分析参数已保存'))
  assert.strictEqual(saveCount, 3)
  assert.strictEqual((await readUi(win)).text.includes('分析参数有未保存的更改'), false)
  await inputValue('尚未保存的界面草稿')

  const before = await readUi(win)
  assert.ok(before.appClasses.includes('theme-light'), 'test should run in light theme')
  assertReadableDarkText('settings title', before.settingTitleColor)
  assertReadableDarkText('plugin source hint', before.pluginHintColor)
  assertReadableDarkText('plugin path', before.pluginPathColor)
  assertReadableDarkText('plugin remote route hint', before.pluginEmptyHintColor)
  assertNoPaleSettingsText(before.regularTextColors)
  assert.strictEqual(before.startButtonText, '启动模型')
  assert.strictEqual(before.startButtonDisabled, false)
  assert.ok(before.startButtonClasses.includes('btn-primary'))
  assert.ok(/gradient|rgb\(59, 105, 255\)|rgb\(74, 125, 255\)/i.test(before.primaryButtonBg), 'start button should keep primary styling')

  const screenshotPath = path.join(tempRoot, 'plugin-light-theme.png')
  await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  await win.webContents.capturePage().then(image => fs.writeFileSync(screenshotPath, image.toPNG()))
  const draftScreenshot = path.join(tempRoot, 'analysis-drafts-light-theme.png')
  await win.webContents.executeJavaScript(`(() => {
    const input = [...document.querySelectorAll('.analysis-runtime-field input')].find(node => node.closest('label').querySelector('span')?.textContent.includes('文本模型名称'));
    input.scrollIntoView({ block: 'center' });
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`)
  await win.webContents.capturePage().then(image => fs.writeFileSync(draftScreenshot, image.toPNG()))

  await clickButton(win, '启动模型')
  const starting = await waitFor(async () => {
    const ui = await readUi(win)
    return ui.startButtonText.includes('启动中') ? ui : null
  })
  assert.strictEqual(starting.startButtonDisabled, true)
  assert.ok(starting.text.includes('正在启动 VLM 服务') || starting.text.includes('正在等待 VLM 服务就绪'))

  const failed = await waitFor(async () => {
    const ui = await readUi(win)
    return ui.text.includes('测试启动失败') ? ui : null
  })
  assert.strictEqual(failed.startButtonText, '启动模型')
  assert.strictEqual(failed.startButtonDisabled, false)

  await clickButton(win, '下载并配置')
  await waitFor(async () => (await readUi(win)).text.includes('取消下载'))
  await clickButton(win, '取消下载')
  await waitFor(async () => !(await readUi(win)).text.includes('取消下载'))
  assert.strictEqual(downloadCalls, 1); assert.strictEqual(cancelCalls, 1)

  await win.close()
  await disposePlugins()
  console.log(`vlm start and download cancellation UI verification passed; config read/save/broadcast drafts and failed-save recovery passed; screenshot: ${screenshotPath}`)
}

app.whenReady()
  .then(main)
  .then(() => app.exit(0), error => {
    console.error(error)
    app.exit(1)
  })
