const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const { execFile } = require('node:child_process')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
fs.mkdirSync(parent, { recursive: true })
const fixture = fs.mkdtempSync(path.join(parent, 'settings-feed-ui-'))
const fallback = path.join(root, '.tmp-wallpaper-player/settings.json')
const hash = file => fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null
const fallbackBefore = hash(fallback)
async function main() {
  fs.writeFileSync(path.join(fixture, 'index.html'), '<!doctype html><html><body>settings feed fixture<script type="module" src="./entry.js"></script></body></html>')
  fs.writeFileSync(path.join(fixture, 'entry.js'), `import { SettingsClient } from ${JSON.stringify(path.join(root, 'src/services/settings-client.js').replaceAll('\\', '/'))}
import * as media from ${JSON.stringify(path.join(root, 'src/api/media.ts').replaceAll('\\', '/'))}
window.feedMedia = media;
window.feedFrames = []; window.feedErrors = []; window.feedLegacy = [];
window.feedClient = new SettingsClient(window.electronAPI, view => { window.feedView = view }, error => window.feedErrors.push(error));
window.electronAPI.onSettingsPatched(event => { window.feedFrames.push(event); window.feedClient.receivePatch(event) });
window.feedClient.read().then(() => { window.stableTag = window.feedClient.confirmed.customTags['file-8']; window.feedReady = true }).catch(error => { window.feedErrors.push(error.message) });
`)
  const { build } = await import('vite')
  await build({ configFile: false, root: fixture, base: './', logLevel: 'silent',
    resolve: { alias: require('./shared-aliases.cjs') }, build: { outDir: 'web',
    rolldownOptions: { input: path.join(fixture, 'index.html') } } })
  const env = { ...process.env, WALLPAPER_SETTINGS_FEED_FIXTURE: fixture }; delete env.ELECTRON_RUN_AS_NODE
  const result = await new Promise((resolve, reject) => execFile(require('electron'), [path.join(__dirname, 'verify-settings-feed-electron.js'), ...process.argv.slice(2)],
    { cwd: root, env, windowsHide: true, timeout: 45000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error || !stdout.includes('settings feed Electron passed:')) reject(Object.assign(error || Error('Missing Electron completion'), { stdout, stderr }))
      else resolve(stdout)
    }))
  assert.equal(hash(fallback), fallbackBefore, 'test must not touch project fallback settings')
  console.log(result.split(/\r?\n/).filter(line => line.startsWith('settings feed Electron passed:')).join('\n'))
}
main().catch(error => { process.stdout.write(error.stdout || ''); process.stderr.write(error.stderr || ''); console.error(error); process.exitCode = 1 })
