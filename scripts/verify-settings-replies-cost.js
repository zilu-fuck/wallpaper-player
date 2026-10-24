const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const Module = require('node:module'), { performance } = require('node:perf_hooks')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests'), before = process.argv.includes('--before')
const fixture = fs.mkdtempSync(path.join(parent, 'settings-replies-cost-'))
const hash = file => fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null
const fallback = path.join(root, '.tmp-wallpaper-player/settings.json'), fallbackHash = hash(fallback)
const manifest = JSON.parse(fs.readFileSync(path.join(parent, 'settings-replies-before.json'), 'utf8'))
process.chdir(fixture)
assert.equal(require('../main/user-data').getUserDataDir(), path.join(fixture, '.tmp-wallpaper-player'))
const files = ['main/settings.js', 'main/application/media-mutations.js', 'main/ipc/settings.js', 'main/ipc/media-data.js']
const sourceDigests = {}
for (const file of files) {
  const sourceFile = before ? path.join(root, manifest.fixture, file.replaceAll('/', '_')) : path.join(root, file)
  sourceDigests[file] = hash(sourceFile)
  if (before) {
    assert.equal(sourceDigests[file], manifest.sourceDigests[file])
    const filename = path.join(root, file), loaded = new Module(filename, module)
    loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename)); require.cache[filename] = loaded
    loaded._compile(fs.readFileSync(sourceFile, 'utf8'), filename)
  }
}
const settings = require('../main/settings'), handlers = new Map()
const ipc = { handle(channel, action) { handlers.set(channel, action) } }
require('../main/ipc/settings').registerSettingsIpc(ipc); require('../main/ipc/media-data').registerMediaDataIpc(ipc)
const contents = { mainFrame: {}, send() {} }, sender = { sender: contents, senderFrame: contents.mainFrame }
const publisher = require('../main/application/settings-broadcast').createSettingsBroadcast({ settings,
  getMainWindow: () => ({ isDestroyed: () => false, webContents: contents }), captureSender: () => ({ assertCurrent() {} }) })
const stop = publisher.start(), results = [], parse = JSON.parse
let fullParses = 0, counting = false
JSON.parse = (...args) => { const value = parse(...args); if (counting && value?.customTags && value?.directories && value?.privacy) fullParses++; return value }
const call = (channel, ...args) => handlers.get(channel)(sender, ...args)
const narrow = { settingsReply: 'version-v1' }
async function measure(name, action) {
  const rows = []
  for (let i = 0; i < 5; i++) {
    fullParses = 0; let last = performance.now(), gap = 0
    const started = last, timer = setInterval(() => { const now = performance.now(); gap = Math.max(gap, now - last); last = now }, 1)
    counting = true
    try {
      const result = structuredClone(await action(i)); await new Promise(resolve => setImmediate(resolve))
      const ended = performance.now(); gap = Math.max(gap, ended - last); counting = false
      assert.equal(result.success, true)
      if (!before) { assert.ok(result.settingsVersion); assert.equal(Object.hasOwn(result, 'settings'), false) }
      rows.push({ milliseconds: ended-started, maxHeartbeatGapMs: gap, responseJsonBytes: Buffer.byteLength(JSON.stringify(result)), fullStateParses: fullParses })
    } finally { counting = false; clearInterval(timer) }
  }
  results.push({ name, observations: rows })
}
;(async () => {
  const directory = path.join(fixture, 'library'); fs.mkdirSync(directory)
  const fullPath = path.join(directory, 'target.mp4'); fs.writeFileSync(fullPath, 'fixture; never decoded')
  const target = { fullPath }, customTags = Object.fromEntries(Array.from({length:10000}, (_,i) => ['https://fixture.invalid/video/'+i, ['tag-'+i]]))
  await settings.saveSettingsAndFlush({ directories:[directory], customTags, theme:'dark' })
  publisher.openFeed(sender)
  await call('media-get-tags', target, narrow)
  await measure('theme IPC reply', i => call('save-settings', {theme:i%2?'dark':'light'}, narrow))
  await measure('favorite IPC reply', i => call('media-set-favorite', target, i%2===0, narrow))
  await measure('tag read IPC reply', () => call('media-get-tags', target, narrow))
  await measure('tag write IPC reply', i => call('media-set-tags', target, ['updated-'+i], undefined, narrow))
  const evidence = { date:new Date().toISOString(), fixture:path.relative(root,fixture), before, sourceDigests, tagEntries:10000, results,
    conditions:'Controlled IPC registration with actual settings/media service, worker, atomic writes, generated network tag keys and one real file header. Negotiated publisher uses a no-op send; replies use Node structuredClone. Five observations per operation. Captured-before modules replayed in this isolated process require cache, compatible dependencies current. Not Electron transport, decoder, cold start or P95.' }
  fs.writeFileSync(path.join(fixture,'result.json'),JSON.stringify(evidence,null,2))
  fs.writeFileSync(path.join(parent,'settings-replies-cost-'+(before?'before':'after')+'.json'),JSON.stringify(evidence,null,2))
  console.log(JSON.stringify(evidence))
})().catch(error => { console.error(error); process.exitCode=1 }).finally(async () => {
  counting=false; JSON.parse=parse; stop(); await settings.flushSettingsWrites(); await settings.disposeSettingsSerialization(); process.chdir(root)
  assert.equal(hash(fallback), fallbackHash, 'cost test must not change the project fallback settings')
})
