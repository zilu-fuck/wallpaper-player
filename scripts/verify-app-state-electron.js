const { app, BrowserWindow } = require('electron')
const assert = require('assert'), path = require('path'), fs = require('fs')
const fixture = process.env.WALLPAPER_STATE_PROFILE_FIXTURE
app.setPath('userData', path.join(fixture, 'profile'))
app.on('window-all-closed', () => {})
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let window, deadline
app.whenReady().then(async () => {
  window = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }))
  const run = source => window.webContents.executeJavaScript(source)
  const until = async source => { const end = Date.now() + 10000
    while (!await run(source)) { if (Date.now() > end) throw Error('State profile condition timed out: ' + source + '\n' + JSON.stringify(await run('({ text: document.body.innerText.slice(0, 500), errors: window.__audit?.errors, cards: document.querySelectorAll(".video-card").length, tasks: window.__auditController?.analysisTasks?.length })'))); await delay(10) } }
  await window.loadFile(path.join(fixture, 'bundle/index.html'))
  await until("document.querySelectorAll('.video-card').length === 100 && window.__auditController?.analysisTasks?.length > 0")
  await delay(500)
  const measure = async (name, action) => {
    await run('window.__audit.reset()')
    for (let index = 1; index <= 20; index++) { await run('(' + action + ')(' + index + ')'); await delay(10) }
    await delay(50)
    return { name, ...await run(`(() => {
      const result = { bodies: {}, durations: {}, targets: {} };
      for (const entry of window.__audit.renders) {
        result.bodies[entry.name] = (result.bodies[entry.name] || 0) + 1;
        if (entry.target) result.targets[entry.target] = (result.targets[entry.target] || 0) + 1;
      }
      for (const entry of window.__audit.profiles) {
        const record = result.durations[entry.id] ||= { commits: 0, totalMs: 0, maximumMs: 0 };
        record.commits++; record.totalMs += entry.actualDuration; record.maximumMs = Math.max(record.maximumMs, entry.actualDuration);
      }
      return result;
    })()` ) }
  }
  const evidence = { library: 10000, visibleCards: 100, samples: 20, measurements: [] }
  evidence.measurements.push(await measure('analysis', 'index => window.__audit.analysis(index)'))
  await run('window.__auditController.setShowSettings(true)')
  await until("Boolean(document.querySelector('.settings-panel'))")
  await delay(100)
  evidence.measurements.push(await measure('analysisWithSettings', 'index => window.__audit.analysis(index + 20)'))
  evidence.measurements.push(await measure('settingsBroadcast', "index => window.__audit.settings({ videoAnalysis: { enabled: true, fixtureRevision: index } })"))
  await run('window.__auditController.setShowSettings(false); window.__auditController.handlePlay(window.__audit.videos[0], { queueVideos: window.__audit.videos })')
  await until("Boolean(document.querySelector('.video-player-overlay')) || Boolean(document.querySelector('.player-overlay'))")
  await delay(100)
  evidence.measurements.push(await measure('playback', 'index => window.__audit.playback(index)'))
  await run('window.__auditController.handleClosePlayer()')
  await delay(75)
  evidence.measurements.push(await measure('favorite', "index => window.__audit.settings({ favorites: index % 2 ? [window.__audit.videos[0].favoriteKey] : [] })"))
  const favoriteButton = "document.querySelector('.video-card .card-favorite-btn')"
  await run(favoriteButton + '.click()')
  await until(favoriteButton + ".classList.contains('active')")
  await run(favoriteButton + '.click()')
  await until('window.__audit.actions.length === 2 && !' + favoriteButton + ".classList.contains('active')")
  assert.deepStrictEqual(await run('window.__audit.actions.map(item => item.favorite)'), [true, false], 'a stable card action uses the latest confirmed favorite state')
  await run('window.__auditController.handleSelectOnlyVideo(window.__audit.videos[0])')
  await until("Boolean(document.querySelector('[aria-label=\"选择 视频 00001\"]'))")
  await run("document.querySelector('[aria-label=\"选择 视频 00001\"]').click()")
  await until('window.__auditController.selectedVideoKeys.length === 2')
  assert.strictEqual(await run("document.querySelectorAll('.video-card.selected').length"), 2)
  await run("window.__auditController.setSearchQuery('00099')")
  await until("document.querySelectorAll('.video-card').length === 1 && document.querySelector('.video-card').innerText.includes('视频 00099')")
  await run(favoriteButton + '.click()')
  await until('window.__audit.actions.length === 3')
  assert.strictEqual(await run('window.__audit.actions[2].key'), await run('window.__audit.videos[99].favoriteKey'))
  await run("window.__auditController.setSearchQuery(''); window.__auditController.handleClearVideoSelection()")
  await until("document.querySelectorAll('.video-card').length === 100 && document.querySelectorAll('.video-card.selected').length === 0")
  await run('window.__audit.suspendSettings()')
  await until('window.__auditController.favoriteKeys.has(window.__audit.videos[0].favoriteKey)')
  assert.strictEqual(await run(favoriteButton + ".classList.contains('active')"), false, 'a suspended render must not publish new context state')
  await run(favoriteButton + '.click()')
  await until('window.__audit.actions.length === 4')
  assert.strictEqual(await run('window.__audit.actions[3].favorite'), true, 'visible actions must not use an uncommitted render')
  await run('window.__audit.block(false)')
  await until(favoriteButton + ".classList.contains('active')")
  await run("window.__auditController.setActiveCategory('favorites')")
  await until("document.querySelectorAll('.video-card').length === 1")
  await run(favoriteButton + '.click()')
  await until("document.querySelectorAll('.video-card').length === 0")
  await run("window.__auditController.setActiveCategory('all'); window.__audit.settings({ customTags: { [window.__audit.videos[0].favoriteKey]: ['新增标签'] } })")
  await until("window.__auditController.availableTags.includes('新增标签')")
  await run("window.__auditController.setActiveCategory('custom:新增标签')")
  await until("document.querySelectorAll('.video-card').length === 1 && document.querySelector('.video-card').innerText.includes('视频 00000')")
  await run("window.__audit.settings({ customTags: {} })")
  await until("!window.__auditController.availableTags.includes('新增标签')")
  evidence.behavior = { latestFavoriteAction: true, selectedCards: 2, searchAndTarget: true, reset: true,
    suspendedStateAndActions: true, favoritesFilterInvalidation: true, customTagAdditionAndRemoval: true }
  evidence.errors = await run('window.__audit.errors')
  evidence.listeners = await run('window.__audit.listeners()')
  await run('window.__audit.unmount()')
  await delay(50)
  evidence.listenersAfterUnmount = await run('window.__audit.listeners()')
  assert.ok(Object.values(evidence.listenersAfterUnmount).every(count => count === 0), 'actual production subscriptions must be removed on unmount')
  evidence.profilingEnabled = evidence.measurements.some(item => Object.keys(item.durations).length > 0)
  assert.deepStrictEqual(evidence.errors, [])
  assert.ok(evidence.profilingEnabled, 'the real React profiling renderer must report timings')
  fs.writeFileSync(path.join(fixture, 'evidence.json'), JSON.stringify(evidence, null, 2))
  console.log('APP_STATE_PROFILE:' + JSON.stringify(evidence))
}).then(() => app.exit(0), error => { console.error(error); app.exit(1) })
deadline = setTimeout(() => { console.error('App state profile timed out'); app.exit(1) }, 30000)
deadline.unref()
