const { spawnSync } = require('child_process')
const path = require('path')
const fs = require('fs'), assert = require('assert')
const { removeTempRootWithRetry } = require('./verify-helpers')
const root = path.resolve(__dirname, '..')
async function main() {
  for (const script of ['verify-player-service', 'verify-mpv-session-lifecycle', 'verify-desktop-player-behavior', 'verify-desktop-player-resources', 'verify-mpv-host-geometry', 'verify-desktop-player-visibility', 'verify-player-frame-electron']) {
    const taskEnv = { ...process.env }; delete taskEnv.ELECTRON_RUN_AS_NODE
    const electron = script.endsWith('electron'), executable = electron ? require('electron') : process.execPath
    const parent = path.join(root, '.tmp', 'refactor-tests')
    let fixture
    if (electron) { fs.mkdirSync(parent, { recursive: true }); fixture = fs.mkdtempSync(path.join(parent, 'player-frame-')); taskEnv.WALLPAPER_PLAYER_FRAME_FIXTURE = fixture }
    try {
      const result = spawnSync(executable, [path.join(root, 'scripts', script + '.js'), ...(electron ? process.argv.slice(2) : [])], {
        cwd: root, env: taskEnv, windowsHide: true, encoding: 'utf8', timeout: 30000
      })
      process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '')
      if (result.error) console.error(result.error)
      if (result.error || result.status !== 0 || (electron && !result.stdout?.includes('player frame passed:'))) { process.exitCode = result.status || 1; break }
    } finally {
      if (fixture) { assert.strictEqual(path.dirname(path.resolve(fixture)), parent); await removeTempRootWithRetry(fixture) }
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
