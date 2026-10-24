const assert = require('assert'), fs = require('fs'), path = require('path'), { spawnSync } = require('child_process')
const { removeTempRootWithRetry } = require('./verify-helpers')
async function main() {
  const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests'); fs.mkdirSync(parent, { recursive: true })
  const fixture = fs.mkdtempSync(path.join(parent, 'initialization-ui-'))
  try {
    const env = { ...process.env, WALLPAPER_INITIALIZATION_FIXTURE: fixture }; delete env.ELECTRON_RUN_AS_NODE
    const result = spawnSync(require('electron'), [path.join(__dirname, 'verify-app-initialization-electron.js'), ...process.argv.slice(2)], { env, cwd: root, windowsHide: true, encoding: 'utf8', timeout: 40000 })
    if (result.error || result.status !== 0 || !result.stdout?.includes('initialization UI passed:')) {
      process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); throw result.error || Error('Initialization UI failed: ' + result.status)
    }
    process.stdout.write(result.stdout.split(/\r?\n/).filter(line => line.startsWith('initialization UI passed:')).join('\n') + '\n')
  } finally { assert.strictEqual(path.dirname(path.resolve(fixture)), parent); await removeTempRootWithRetry(fixture) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
