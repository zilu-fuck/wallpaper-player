const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const vm = require('node:vm'), Module = require('node:module'), ts = require('typescript'), { performance } = require('node:perf_hooks')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests'), baseline = process.argv.includes('--baseline')
const fallback = path.join(root, '.tmp-wallpaper-player/settings.json')
const hash = file => fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null
const fallbackBefore = hash(fallback)
fs.mkdirSync(parent, { recursive: true })
const fixture = fs.mkdtempSync(path.join(parent, 'settings-broadcast-cost-'))
const baselineFile = path.join(parent, 'settings-broadcast-cost-baseline.json')
const replay = baseline && fs.existsSync(baselineFile) ? JSON.parse(fs.readFileSync(baselineFile, 'utf8')) : null
const originals = ['main/settings.js', 'main/index.js', 'main/ipc/settings.js', 'preload.js']
const sources = new Map(), sourceDigests = {}
for (const file of originals) {
  const content = fs.readFileSync(replay ? path.join(root, replay.fixture, file.replaceAll('/', '_')) : path.join(root, file))
  const digest = crypto.createHash('sha256').update(content).digest('hex')
  if (replay) assert.equal(digest, replay.sourceDigests[file])
  sources.set(file, content.toString('utf8')); sourceDigests[file] = digest
  fs.writeFileSync(path.join(fixture, file.replaceAll('/', '_')), content)
}
process.chdir(fixture)
assert.equal(require('../main/user-data').getUserDataDir(), path.join(fixture, '.tmp-wallpaper-player'), 'settings cost fixture must own its user data')
let settings
if (replay) {
  const filename = path.join(root, 'main/settings.js'), loaded = new Module(filename, module)
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename)); loaded._compile(sources.get('main/settings.js'), filename)
  settings = loaded.exports
} else settings = require('../main/settings')
const source = ts.createSourceFile('index.js', sources.get('main/index.js'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'setupSettingsSync')
assert(declaration)
let lastPayload = null, lastChannel = '', eventCount = 0, fullParses = 0, counting = false
const parse = JSON.parse
JSON.parse = function (...args) { const value = parse(...args); if (counting && value?.customTags && value?.directories && value?.privacy) fullParses++; return value }
const win = { isDestroyed: () => false, webContents: { mainFrame: {}, isDestroyed: () => false,
  send(channel, payload) { lastPayload = structuredClone(payload); lastChannel = channel; eventCount++ } } }
let publisher
const context = { removeSettingsChangedListener: null, onSettingsChanged: settings.onSettingsChanged,
  getMainWindow: () => win, sanitizeSettingsForRenderer: settings.sanitizeSettingsForRenderer,
  EVENT: require('../main/ipc-channels').EVENT }
if (!declaration.getText(source).includes('onSettingsChanged(')) {
  publisher = require('../main/application/settings-broadcast').createSettingsBroadcast({ settings, getMainWindow: () => win,
    captureSender: () => ({ assertCurrent() {} }) })
  context.settingsBroadcast = publisher
}
vm.createContext(context); vm.runInContext('(' + declaration.getText(source) + ')()', context)
const results = []
async function measure(name, operation) {
  const rows = []
  for (let index = 0; index < 5; index++) {
    lastPayload = null; fullParses = 0; const startEvents = eventCount, started = performance.now(); let last = started, gap = 0
    const timer = setInterval(() => { const now = performance.now(); gap = Math.max(gap, now - last); last = now }, 1)
    counting = true
    try {
      await operation(index); await new Promise(resolve => setImmediate(resolve))
      gap = Math.max(gap, performance.now() - last)
      const milliseconds = performance.now() - started
      counting = false; clearInterval(timer)
      assert(lastPayload, name + ' must publish')
      const payloadJsonBytes = Buffer.byteLength(JSON.stringify(lastPayload))
      rows.push({ milliseconds, maxHeartbeatGapMs: gap, payloadJsonBytes, fullStateParses: fullParses,
        messages: eventCount - startEvents, channel: lastChannel })
      if (!baseline) { assert.equal(eventCount - startEvents, 1); assert.ok(payloadJsonBytes < 16384, name + ' must publish a narrow event') }
    } finally { counting = false; clearInterval(timer) }
  }
  results.push({ name, observations: rows })
}
;(async () => {
  const directory = path.join(fixture, 'library'); fs.mkdirSync(directory)
  const tags = Object.fromEntries(Array.from({ length: 10000 }, (_, i) => ['file:' + Buffer.from(path.join(directory, i + '.mp4')).toString('base64url'), ['中文tag', 'tag-' + i]]))
  await settings.saveSettingsAndFlush({ directories: [directory], customTags: tags })
  await settings.saveSettingsAndFlush({ theme: 'dark' })
  if (publisher) publisher.openFeed({ sender: win.webContents, senderFrame: win.webContents.mainFrame })
  await measure('theme broadcast', index => settings.saveSettingsAndFlush({ theme: index % 2 ? 'dark' : 'light' }))
  await measure('playback broadcast', index => settings.updateSettingsAndFlush(current => ({ patch: {
    playbackStates: { ...current.playbackStates, 'fixture-video': { position: index, updatedAt: index + 1, revision: index + 1 } }
  } }), { returnSettings: false }))
  const target = Object.keys(tags)[0]
  await measure('one video tag broadcast', index => settings.updateSettingsAndFlush(current => ({ patch: {
    customTags: { ...current.customTags, [target]: ['updated-' + index] }
  } }), { returnSettings: false }))
  const evidence = { date: new Date().toISOString(), fixture: path.relative(root, fixture), baseline, sourceDigests, tagEntries: 10000, results,
    conditions: 'Actual settings repository and AST-extracted production setupSettingsSync; sender uses Node structuredClone, not Electron transport. Payload JSON byte counting is outside timed operations. Five sequential observations per operation, not IPC wire bytes, renderer latency or P95.' }
  fs.writeFileSync(path.join(fixture, 'result.json'), JSON.stringify(evidence, null, 2))
  fs.writeFileSync(path.join(parent, 'settings-broadcast-cost-' + (baseline ? replay ? 'baseline-replay' : 'baseline' : 'after') + '.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence))
})().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  counting = false; JSON.parse = parse; context.removeSettingsChangedListener?.()
  await settings.flushSettingsWrites(); await settings.disposeSettingsSerialization?.(); process.chdir(root)
  assert.equal(hash(fallback), fallbackBefore, 'settings cost fixture must not change project fallback settings')
})
