const assert = require('assert'), fs = require('fs'), fsp = require('fs/promises'), path = require('path')
async function verifyScanIndexConsistency({ directory, scanner, query }) {
  const { pathKey } = require('../main/paths')
  await scanner.waitForBackgroundScanRefreshes()
  scanner.invalidateScanCache(pathKey(directory))
  const prefix = await scanner.scanWithCache(directory, false, { initialLimit: 100 })
  assert.ok(prefix.videos.length >= 100 && prefix.videos.length < 245)
  assert.ok(prefix.indexed && prefix.refreshing)
  const remote = await query({ limit: 200 })
  assert.strictEqual(remote.data.count, 245, 'a desktop prefix must never become the full remote snapshot')
  assert.strictEqual(remote.data.matchedCount, 245)
  await scanner.waitForBackgroundScanRefreshes()

  const indexPath = scanner.getScanIndexPath(directory)
  const before = fs.readFileSync(indexPath, 'utf8'), rename = fsp.rename
  let injected = false
  fsp.rename = async (from, to) => {
    if (to === indexPath) { injected = true; throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) }
    return rename(from, to)
  }
  try { await scanner.scanWithCache(directory, true) } finally { fsp.rename = rename }
  assert.ok(injected)
  assert.strictEqual(fs.readFileSync(indexPath, 'utf8'), before, 'failed replacement must preserve the valid previous index')
  assert.ok(!fs.readdirSync(path.dirname(indexPath)).some(file => file.startsWith(path.basename(indexPath) + '.') && file.endsWith('.tmp')))
  const forged = JSON.parse(before); forged.root = path.dirname(directory)
  fs.writeFileSync(indexPath, JSON.stringify(forged))
  scanner.invalidateScanCache(pathKey(directory))
  assert.strictEqual((await scanner.loadScanIndex(directory)).entries && Object.keys((await scanner.loadScanIndex(directory)).entries).length, 0)
  assert.strictEqual((await scanner.scanWithCache(directory)).videos.length, 245)
  await scanner.waitForBackgroundScanRefreshes()

  const stat = fsp.stat
  let release, enter
  const blocked = new Promise(resolve => { release = resolve }), entered = new Promise(resolve => { enter = resolve })
  let held = false
  fsp.stat = async (file, ...args) => {
    if (!held && String(file).endsWith('.mp4')) { held = true; enter(); await blocked }
    return stat(file, ...args)
  }
  const scanning = scanner.scanWithCache(directory, true)
  await entered
  const added = path.join(directory, 'New-during-scan.mp4')
  fs.writeFileSync(added, 'fixture'); scanner.invalidateScanCache(pathKey(directory))
  release()
  try { assert.strictEqual((await scanning).videos.length, 246, 'invalidated old scans must retry rather than republish obsolete records') }
  finally { fsp.stat = stat; fs.unlinkSync(added) }
  scanner.invalidateScanCache(pathKey(directory))
  await scanner.scanWithCache(directory, true)
  console.log('scan index consistency passed: desktop prefix isolated from remote counts, atomic failure preserves index, root validation and change-during-scan retry')
}
module.exports = { verifyScanIndexConsistency }
