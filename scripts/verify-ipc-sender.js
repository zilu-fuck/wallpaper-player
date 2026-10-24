const assert = require('assert'), fs = require('fs'), path = require('path')
const { spawnSync } = require('child_process')
const { pathToFileURL } = require('url')
const { createAppEntryMatcher } = require('../main/security/ipc-sender')
const { removeTempRootWithRetry } = require('./verify-helpers')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')

async function main() {
  const matches = createAppEntryMatcher('http://localhost:5173/')
  assert.ok(matches('http://localhost:5173/#library'))
  for (const url of ['http://localhost:51730/', 'http://localhost:5173@remote.invalid/', 'http://127.0.0.1:5173/',
    'http://localhost:5173/other', 'http://localhost:5173/?bridge=1', 'https://localhost:5173/', 'about:blank', 'invalid']) {
    assert.strictEqual(matches(url), false, url)
  }
  const file = pathToFileURL(path.join(root, 'dist/index.html')).href, fileMatches = createAppEntryMatcher(file)
  assert.ok(fileMatches(file + '#player'))
  for (const url of [pathToFileURL(path.join(root, 'README.md')).href, file + '?bridge=1', 'data:text/html,hello']) assert.ok(!fileMatches(url))
  assert.throws(() => createAppEntryMatcher('https://remote.invalid/'))

  fs.mkdirSync(parent, { recursive: true })
  const fixture = fs.mkdtempSync(path.join(parent, 'ipc-sender-'))
  try {
    const env = { ...process.env, WALLPAPER_IPC_SENDER_FIXTURE: fixture }; delete env.ELECTRON_RUN_AS_NODE
    const result = spawnSync(require('electron'), [...process.argv.slice(2), path.join(__dirname, 'verify-ipc-sender-electron.js')], {
      cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 45000, maxBuffer: 4 * 1024 * 1024
    })
    if (result.error || result.status !== 0 || !result.stdout?.includes('IPC sender passed:')) {
      process.stderr.write(result.stderr || ''); process.stdout.write(result.stdout || '')
      throw result.error || Error('Electron IPC source verification failed: ' + result.status)
    }
    process.stdout.write(result.stdout.split(/\r?\n/).filter(line => line.startsWith('IPC sender passed:')).join('\n') + '\n')
  } finally {
    assert.strictEqual(path.dirname(path.resolve(fixture)), parent)
    await removeTempRootWithRetry(fixture)
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
