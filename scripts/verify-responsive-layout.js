const assert = require('assert'), fs = require('fs'), path = require('path')
const root = path.resolve(__dirname, '..'), testRoot = path.join(root, '.tmp/refactor-tests')
const parent = process.env.WALLPAPER_LAYOUT_OUTPUT_DIR ? path.resolve(process.env.WALLPAPER_LAYOUT_OUTPUT_DIR) : testRoot
assert.ok(parent === testRoot || parent.startsWith(testRoot + path.sep), 'layout evidence must remain inside refactor-tests')
const observe = process.argv.includes('--observe') || process.env.WALLPAPER_LAYOUT_OBSERVE === '1'
async function desktop() {
  const { app, BrowserWindow } = require('electron'), { pathToFileURL } = require('url')
  const fixture = process.env.WALLPAPER_LAYOUT_FIXTURE
  assert.strictEqual(path.dirname(path.resolve(fixture)), parent)
  assert.ok(path.basename(fixture).startsWith('responsive-layout-'))
  app.setPath('userData', fixture); app.on('window-all-closed', () => {})
  await app.whenReady()
  const settings = require('../main/settings'), scanner = require('../main/scanner')
  const metadata = require('../main/video-metadata'), { ipcMain } = require('../main/security/ipc')
  const { IPC, EVENT } = require('../main/ipc-channels')
  const directory = path.join(fixture, '很长的目录名称-桌面与手机视频库')
  fs.mkdirSync(directory); for (let i = 0; i < 32; i++) fs.writeFileSync(path.join(directory, 'Video-' + i + '.mp4'), Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex'))
  await settings.saveSettingsAndFlush({ directories: [directory], defaultDirectory: directory, theme: 'dark', sidebarCollapsed: false })
  metadata.setVideoMetadataWarmPaused(true)
  require('../main/ipc').setupIPC()
  for (const [channel, result] of [[IPC.CHECK_FFMPEG, { available: false }], [IPC.CHECK_MPV, { available: false }]]) {
    require('electron').ipcMain.removeHandler(channel); ipcMain.handle(channel, async () => result)
  }
  const window = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: {
    preload: path.join(root, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  require('../main/window').setMainWindow(window)
  const entry = path.join(root, 'dist/index.html')
  require('../main/security/ipc-sender').bindAppWindow(window, pathToFileURL(entry).href)
  const remove = settings.onSettingsChanged(snapshot => window.webContents.send(EVENT.SETTINGS_CHANGED, settings.sanitizeSettingsForRenderer(snapshot)))
  const run = source => window.webContents.executeJavaScript(source)
  const delay = ms => new Promise(done => setTimeout(done, ms))
  const until = async check => { const end = Date.now() + 10000; while (!await check()) {
    if (Date.now() > end) throw Error('responsive UI condition timed out: ' + JSON.stringify(await run(`({ width: innerWidth, compact: matchMedia('(max-width: 900px)').matches, reactCompact: document.querySelector('.sidebar')?.dataset.compact, sidebar: document.querySelector('.sidebar')?.className, role: document.querySelector('.sidebar')?.getAttribute('role'), active: document.activeElement?.className, errors: window.__layoutErrors })`)))
    await delay(10)
  } }
  const settle = async () => {
    await run('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))'); await delay(250)
    if (!observe) await until(() => run("document.querySelector('.sidebar')?.dataset.compact === String(matchMedia('(max-width: 900px)').matches) && document.querySelector('.right-dock-wrapper')?.dataset.compact === String(matchMedia('(max-width: 1080px)').matches)"))
  }
  const results = [], failures = [], behavior = {}, label = observe ? 'before' : 'after'
  try {
    await window.loadFile(entry); await until(() => run("document.querySelectorAll('.video-card').length > 0"))
    await run("window.__layoutErrors = []; window.addEventListener('error', event => window.__layoutErrors.push(String(event.error || event.message)))")
    const forcedMotion = await window.webContents.insertCSS('*, *::before, *::after { animation: none !important; transition: none !important; }')
    for (const theme of ['dark', 'light']) {
      await settings.saveSettingsAndFlush({ theme })
      for (const width of [1024, 1280, 1920]) for (const zoom of [1, 1.25, 1.5, 2]) {
        window.setContentSize(width, 900); window.webContents.setZoomFactor(zoom); await settle()
        const metric = await run(`(() => {
          const visible = el => Boolean(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).opacity !== '0' && !el.closest('[inert]'));
          const inside = el => { if (!visible(el)) return false; const b = el.getBoundingClientRect(); return b.left >= -1 && b.right <= innerWidth + 1 && b.top >= -1 && b.bottom <= innerHeight + 1; };
          const search = document.querySelector('.search-input'), main = document.querySelector('.main-content');
          return { cssWidth: innerWidth, cssHeight: innerHeight, searchVisible: inside(search), navigationVisible: [...document.querySelectorAll('.sidebar-toggle-btn')].some(inside),
            mainOverflow: main.scrollWidth > main.clientWidth + 1, headerOverflow: document.querySelector('.header').scrollWidth > innerWidth + 1,
            cards: document.querySelectorAll('.video-card').length };
        })()`)
        results.push({ theme, width, zoom, ...metric })
        for (const key of ['searchVisible', 'navigationVisible']) if (!metric[key]) failures.push({ theme, width, zoom, key })
        for (const key of ['mainOverflow', 'headerOverflow']) if (metric[key]) failures.push({ theme, width, zoom, key })
        if (width === 1024 && zoom === 2) fs.writeFileSync(path.join(parent, 'desktop-' + label + '-' + theme + '-1024-200.png'), (await window.webContents.capturePage()).toPNG())
      }
    }
    if (!observe) {
      const click = selector => run(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw Error('missing control: ' + ${JSON.stringify(selector)}); el.focus(); el.click(); })()`)
      const escape = () => run("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))")
      await settings.saveSettingsAndFlush({ theme: 'dark' })
      window.setContentSize(1280, 900); window.webContents.setZoomFactor(1); await settle()
      const beforeToggle = await run("document.querySelector('.sidebar').classList.contains('collapsed')")
      await click('.sidebar-pane.active .sidebar-toggle-btn'); await settle()
      const preference = await run("document.querySelector('.sidebar').classList.contains('collapsed')")
      assert.strictEqual(preference, !beforeToggle)
      window.setContentSize(1024, 900); window.webContents.setZoomFactor(2); await settle()
      await until(() => run("document.querySelector('.sidebar').dataset.compact === 'true'"))
      await click('.sidebar-pane.active .sidebar-toggle-btn')
      await until(() => run("Boolean(document.querySelector('.sidebar.compact-open[aria-modal=true]'))"))
      assert.strictEqual(await run("document.querySelector('.header').inert"), true)
      assert.strictEqual(await run(`(() => {
        const root = document.querySelector('.sidebar.compact-open');
        const items = [...root.querySelectorAll('button, [tabindex]')].filter(el => el.tabIndex >= 0 && !el.closest('[inert]') && el.getClientRects().length && !el.disabled);
        items.at(-1).focus(); items.at(-1).dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
        return document.activeElement === items[0];
      })()`), true, 'Tab wraps inside the navigation overlay')
      await run("document.querySelector('.search-input').focus()")
      assert.strictEqual(await run("document.querySelector('.sidebar.compact-open').contains(document.activeElement)"), true, 'inert background cannot receive focus')
      assert.strictEqual(await run("(() => { const el = document.querySelector('.sidebar.compact-open .sidebar-dir-remove'); el.focus(); return getComputedStyle(el).opacity === '1'; })()"), true, 'keyboard focus reveals the directory action')
      await run("document.querySelector('.sidebar.compact-open .sidebar-toggle-btn').focus()")
      await settle()
      assert.strictEqual(await run("(() => { const b = document.querySelector('.sidebar.compact-open').getBoundingClientRect(); return b.width > 200 && b.right <= innerWidth && b.bottom <= innerHeight + 1; })()"), true)
      assert.strictEqual(await run("(() => { const el = document.querySelector('.sidebar.compact-open .sidebar-dir-item'), b = el.getBoundingClientRect(); return b.height > 20 && el.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)); })()"), true, 'the first directory remains visible and hit-testable in a short viewport')
      fs.writeFileSync(path.join(parent, 'desktop-after-navigation-1024-200.png'), (await window.webContents.capturePage()).toPNG())
      await escape(); await until(() => run("!document.querySelector('.sidebar.compact-open')")); await settle()
      assert.strictEqual(await run("document.activeElement.matches('.sidebar-toggle-btn')"), true, 'closing returns focus to the opener')
      assert.strictEqual(await run("document.querySelector('.header').inert"), false)
      behavior.navigation = { focusWrap: true, backgroundInert: true, escapeAndFocusReturn: true, directoryHitTest: true }
      window.setContentSize(1280, 900); window.webContents.setZoomFactor(1); await settle()
      assert.strictEqual(await run("document.querySelector('.sidebar').classList.contains('collapsed')"), preference, 'automatic collapse preserves the wide-window preference')
      behavior.preferencePreserved = true
      window.setContentSize(1024, 900); window.webContents.setZoomFactor(2); await settle()
      await click('.sidebar-pane.active .sidebar-settings-btn')
      await until(() => run("Boolean(document.querySelector('.settings-panel'))"))
      behavior.settings = []
      for (const page of ['基础设置', '手机访问', '插件管理', '系统状态']) {
        await run(`(() => { const button = [...document.querySelectorAll('[aria-label="设置分页"] button')].find(el => el.textContent.includes(${JSON.stringify(page)})); button.click(); })()`)
        await settle()
        const metric = await run(`(() => { const panel = document.querySelector('.settings-panel'), b = panel.getBoundingClientRect(); return { withinViewport: b.left >= -1 && b.right <= innerWidth + 1 && b.top >= -1 && b.bottom <= innerHeight + 1, overflow: panel.scrollWidth > panel.clientWidth + 1 }; })()`)
        behavior.settings.push({ page, ...metric }); assert.strictEqual(metric.withinViewport, true); assert.strictEqual(metric.overflow, false)
      }
      await escape(); await until(() => run("!document.querySelector('.settings-panel')"))
      await click('.right-dock-activity-item[aria-label="下载中心"]')
      await until(() => run("Boolean(document.querySelector('.right-dock-wrapper[aria-modal=true] .right-dock-close-btn'))")); await settle()
      const dock = await run(`(() => { const el = document.querySelector('.right-dock-panel.open'), b = el.getBoundingClientRect(); return { width: b.width, withinViewport: b.left >= -1 && b.right <= innerWidth + 1 && b.top >= -1 && b.bottom <= innerHeight + 1, overflow: el.scrollWidth > el.clientWidth + 1, backgroundInert: document.querySelector('.header').inert }; })()`)
      assert.strictEqual(dock.withinViewport, true); assert.strictEqual(dock.overflow, false); assert.strictEqual(dock.backgroundInert, true)
      behavior.dock = dock
      fs.writeFileSync(path.join(parent, 'desktop-after-dock-1024-200.png'), (await window.webContents.capturePage()).toPNG())
      await escape(); await until(() => run("!document.querySelector('.right-dock-wrapper.open')")); await settle()
      assert.strictEqual(await run("document.activeElement.matches('.right-dock-activity-item')"), true)
      await window.webContents.removeInsertedCSS(forcedMotion)
      window.webContents.debugger.attach('1.3')
      await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
      await settle()
      const motion = await run(`({ matches: matchMedia('(prefers-reduced-motion: reduce)').matches, transition: getComputedStyle(document.querySelector('.sidebar')).transitionDuration, animation: getComputedStyle(document.querySelector('.gallery')).animationDuration })`)
      assert.strictEqual(motion.matches, true)
      assert.ok(motion.transition.split(',').every(value => parseFloat(value) <= .001)); assert.ok(parseFloat(motion.animation) <= .001)
      behavior.reducedMotion = motion; window.webContents.debugger.detach()

      // Exercise the real native-player DOM separately from the HTML5/library layout.
      // Only decoding is substituted; native host geometry uses the production module.
      const rawIpc = require('electron').ipcMain, host = require('../main/mpv-host')
      let nativeState = { filePath: null, sessionId: '', engineSessionId: 1, timePos: 1, duration: 20,
        paused: true, ready: true, volume: 100, muted: true, speed: 1, eofReached: false, trackList: [] }
      host.setMpvHostMainWindow(window)
      for (const channel of [IPC.CHECK_MPV, IPC.MPV_GET_STATE, IPC.PLAYER_ACTION]) rawIpc.removeHandler(channel)
      ipcMain.handle(IPC.CHECK_MPV, async () => ({ available: true, path: 'layout-fixture' }))
      ipcMain.handle(IPC.MPV_GET_STATE, async () => nativeState)
      ipcMain.handle(IPC.PLAYER_ACTION, async (_event, request) => {
        if (request.action === 'load') nativeState = { ...nativeState, filePath: request.target, sessionId: request.sessionId }
        if (request.action === 'bounds') host.setMpvHostBounds(request.bounds)
        if (request.action === 'stop') host.hideMpvHostWindow(true)
        return { success: true, sessionId: request.sessionId, state: nativeState }
      })
      try {
        await new Promise(resolve => { window.webContents.once('did-finish-load', resolve); window.reload() })
        await until(() => run("document.querySelectorAll('.video-card').length > 0"))
        await run("document.querySelector('.video-card .play-circle').click()")
        await until(() => run("Boolean(document.querySelector('.mpv-shell .player-mpv-host-surface'))"))
        behavior.nativePlayer = []
        for (const [width, height, zoom] of [[1366, 626, 1], [900, 600, 1], [1024, 600, 1.25], [1024, 600, 1.5], [1024, 600, 2], [1366, 768, 2]]) {
          window.setContentSize(width, height); window.webContents.setZoomFactor(zoom); await settle()
          const metric = await run(`(() => {
            const rect = selector => { const b = document.querySelector(selector).getBoundingClientRect(); return {x:b.x,y:b.y,right:b.right,bottom:b.bottom}; };
            const shell=rect('.player-shell'),header=rect('.player-topbar'),video=rect('.player-mpv-host-surface'),toolbar=rect('.player-toolbar');
            const controls=[...document.querySelectorAll('.player-topbar button,.player-toolbar button,.player-toolbar input')].every(el=>{const b=el.getBoundingClientRect();return b.left>=shell.x-1&&b.right<=shell.right+1&&b.top>=shell.y-1&&b.bottom<=shell.bottom+1});
            return {shell,header,video,toolbar,controls,withinViewport:shell.x>=-1&&shell.y>=-1&&shell.right<=innerWidth+1&&shell.bottom<=innerHeight+1};
          })()`)
          assert.ok(metric.withinViewport && metric.controls, 'native-player chrome must stay within the viewport and card')
          assert.ok(metric.header.bottom <= metric.video.y + 1 && metric.video.bottom <= metric.toolbar.y + 1, 'native video must not overlap title or transport controls')
          behavior.nativePlayer.push({ width, height, zoom, ...metric })
        }
        await run("document.querySelector('.player-close').click()")
      } finally { host.destroyMpvHostWindow() }
    }
    fs.writeFileSync(path.join(parent, 'desktop-layout-' + label + '.json'), JSON.stringify({ date: new Date().toISOString(), results, failures, behavior }, null, 2) + '\n')
    if (!observe) assert.deepStrictEqual(failures, [], 'desktop responsive layout failures')
    console.log('responsive layout ' + (observe ? 'observed' : 'passed') + ': ' + results.length + ' actual Electron viewport/theme/zoom cases; ' + failures.length + ' failures; ' + (behavior.nativePlayer?.length || 0) + ' native-player layout cases with substituted decoding')
  } finally {
    remove(); await scanner.waitForBackgroundScanRefreshes(); scanner.unwatchAllDirectories()
    require('../main/application/media-work-service').mediaWorkService.dispose()
    await Promise.all([metadata.disposeVideoMetadata(), require('../main/application/resource-scheduler').mediaScheduler.dispose(),
      require('../main/download-manager').disposeDownloadManager()])
    await settings.flushSettingsWrites()
    require('../main/window').setMainWindow(null); window.destroy()
  }
  app.exit(0)
}
async function driver() {
  fs.mkdirSync(parent, { recursive: true }); const fixture = fs.mkdtempSync(path.join(parent, 'responsive-layout-'))
  try {
    const env = { ...process.env, WALLPAPER_LAYOUT_FIXTURE: fixture, WALLPAPER_LAYOUT_OBSERVE: observe ? '1' : '0' }
    delete env.ELECTRON_RUN_AS_NODE
    const result = require('child_process').spawnSync(require('electron'), [__filename, ...process.argv.slice(2).filter(arg => arg !== '--observe')],
      { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 120000, maxBuffer: 2 * 1024 * 1024 })
    if (result.error || result.status || !result.stdout.includes('responsive layout ')) {
      process.stderr.write(result.stderr || ''); process.stdout.write(result.stdout || ''); throw result.error || Error('responsive layout failed: ' + result.status)
    }
    console.log(result.stdout.split(/\r?\n/).filter(line => line.startsWith('responsive layout ')).join('\n'))
  } finally { assert.strictEqual(path.dirname(path.resolve(fixture)), parent); await require('./verify-helpers').removeTempRootWithRetry(fixture) }
}
if (process.versions.electron) {
  const timeout = setTimeout(() => { console.error('responsive UI deadline exceeded'); require('electron').app.exit(1) }, 110000)
  desktop().catch(error => { console.error(error); require('electron').app.exit(1) }).finally(() => clearTimeout(timeout))
} else driver().catch(error => { console.error(error); process.exitCode = 1 })
