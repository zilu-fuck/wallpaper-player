const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const projectRoot = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wallpaper-player-settings-verify-'))

process.chdir(tempRoot)

const {
  normalizeRemoteSettings
} = require(path.join(projectRoot, 'main', 'remote', 'index'))

try {
  assert.deepStrictEqual(
    normalizeRemoteSettings({ enabled: true, port: 38127, keepRunningInTray: false }),
    { enabled: true, port: 38127, keepRunningInTray: false, allowLegacyToken: false }
  )
  assert.strictEqual(normalizeRemoteSettings({ allowLegacyToken: true }).allowLegacyToken, true)
  assert.strictEqual(normalizeRemoteSettings({ port: 70000 }).port, 38127)
  assert.strictEqual(normalizeRemoteSettings({ remoteAccess: { port: 40001 } }).port, 40001)

  const source = fs.readFileSync(path.join(projectRoot, 'main', 'remote', 'index.js'), 'utf8')
  assert.ok(/async function startRemoteAccess\(options = \{\}\)/.test(source), 'startRemoteAccess should accept restart options')
  assert.ok(/!options\.forceRestart/.test(source), 'startRemoteAccess should keep idempotent fast path unless restart is forced')
  assert.ok(/currentRemoteAccess\.port !== remoteAccess\.port/.test(source), 'remote settings save should detect port changes')
  assert.ok(/forceRestart: serverState\.running/.test(source), 'remote settings save should force restart when running and port changed')

  console.log('remote settings verification passed')
} finally {
  process.chdir(projectRoot)
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
