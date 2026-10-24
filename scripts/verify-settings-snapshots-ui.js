const assert = require('assert'), fs = require('fs'), path = require('path')
const { spawnSync } = require('child_process')
const { removeTempRootWithRetry } = require('./verify-helpers')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
async function main() {
  fs.mkdirSync(parent, { recursive: true }); const fixture = fs.mkdtempSync(path.join(parent, 'settings-snapshot-ui-'))
  try {
    const env = { ...process.env, WALLPAPER_SETTINGS_SNAPSHOT_FIXTURE: fixture }; delete env.ELECTRON_RUN_AS_NODE
    const result = spawnSync(require('electron'), [path.join(__dirname, 'verify-settings-snapshots-electron.js'), ...process.argv.slice(2)],
      { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 40000, maxBuffer: 4 * 1024 * 1024 })
    if (result.error || result.status !== 0 || !result.stdout?.includes('settings snapshot UI passed:')) {
      process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); throw result.error || Error('Settings snapshot UI failed: ' + result.status)
    }
    process.stdout.write(result.stdout.split(/\r?\n/).filter(line => line.startsWith('settings snapshot UI passed:')).join('\n') + '\n')
  } finally { assert.strictEqual(path.dirname(path.resolve(fixture)), parent); await removeTempRootWithRetry(fixture) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
