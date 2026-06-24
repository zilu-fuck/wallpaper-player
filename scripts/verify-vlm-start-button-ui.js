const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { app, BrowserWindow, ipcMain, session } = require('electron')

const projectRoot = path.resolve(__dirname, '..')
const tempParent = path.join(projectRoot, '.tmp', 'vlm-ui-tests')
fs.rmSync(tempParent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
fs.mkdirSync(tempParent, { recursive: true })
const tempRoot = fs.mkdtempSync(path.join(tempParent, 'run-'))

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
    const startButton = [...document.querySelectorAll('button')]
      .find(button => button.textContent.includes('启动模型') || button.textContent.includes('启动中'));
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

  ipcMain.removeHandler('video-analysis-vlm-start')
  ipcMain.handle('video-analysis-vlm-start', async () => {
    await wait(350)
    return {
      success: false,
      error: '测试启动失败',
      state: { connected: false, running: false, modelExists: true }
    }
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
  await win.loadFile(path.join(projectRoot, 'dist', 'index.html'))
  await waitFor(async () => (await readUi(win)).text.includes('设置'))
  await clickButton(win, '设置')
  await waitFor(async () => (await readUi(win)).text.includes('插件管理'))
  await clickButton(win, '插件管理')
  await waitFor(async () => (await readUi(win)).text.includes('视频理解设置'))

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

  const screenshotPath = path.join(tempParent, 'plugin-light-theme.png')
  await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  await win.webContents.capturePage().then(image => fs.writeFileSync(screenshotPath, image.toPNG()))

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

  await win.close()
  await disposePlugins()
  console.log(`vlm start button UI verification passed; screenshot: ${screenshotPath}`)
}

app.whenReady()
  .then(main)
  .finally(() => {
    app.quit()
  })
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
    app.quit()
  })
