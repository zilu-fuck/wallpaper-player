const assert = require('assert'), fsp = require('fs/promises'), path = require('path'), { performance } = require('perf_hooks')
const { removeTempRootWithRetry } = require('./verify-helpers')
async function main() {
  const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests'); await fsp.mkdir(parent, { recursive: true })
  const fixture = await fsp.mkdtemp(path.join(parent, 'policy-settings-')); process.chdir(fixture)
  const settings = require('../main/settings'), access = require('../main/security/media-access'), stringify = JSON.stringify
  try {
    const directory = path.join(fixture, 'library'), privateDirectory = path.join(directory, 'private'); await fsp.mkdir(privateDirectory, { recursive: true })
    const customTags = Object.fromEntries(Array.from({ length: 2000 }, (_, index) => [path.join(directory, index + '.mp4'), ['fixture-' + index]]))
    await settings.saveSettingsAndFlush({ directories: [directory, privateDirectory], privateDirectories: [privateDirectory], customTags })
    const snapshot = settings.getMediaAccessSettings(); snapshot.directories.push('must not enter the repository'); snapshot.privateDirectories.length = 0
    assert.deepStrictEqual(settings.getMediaAccessSettings().directories, [directory, privateDirectory]); assert.deepStrictEqual(settings.getMediaAccessSettings().privateDirectories, [privateDirectory])
    assert.strictEqual(access.createMediaAccessPolicy({ audience: 'remote', resolvedRoots: { allowed: [directory] } }).canReadPath(path.join(privateDirectory, 'secret.mp4')), false)
    let fullCopies = 0
    JSON.stringify = function (value, ...args) {
      if (value?.customTags && value?.privacy && value?.directories) fullCopies++
      return stringify(value, ...args)
    }
    for (let index = 0; index < 20; index++) {
      const policy = access.createMediaAccessPolicy({ audience: 'remote' })
      assert.strictEqual(policy.canReadPath(path.join(privateDirectory, 'secret.mp4')), false)
      assert.strictEqual(policy.canReadPath(path.join(directory, 'public.mp4')), true)
      const asyncPolicy = await access.createMediaAccessPolicyAsync({ audience: 'remote' })
      assert.strictEqual(asyncPolicy.canReadPath(path.join(privateDirectory, 'secret.mp4')), false)
      settings.getAllowedVideoDirectories(); settings.getAllowedDownloadDirectories(); settings.getPublicVideoDirectories()
    }
    assert.strictEqual(fullCopies, 0, 'permission checks must not serialize unrelated tags, plugin config, playback or credentials')
    JSON.stringify = stringify
    const started = performance.now(); for (let index = 0; index < 200; index++) settings.loadSettings()
    const fullSnapshotMs = performance.now() - started, minimalStart = performance.now()
    for (let index = 0; index < 200; index++) settings.getMediaAccessSettings()
    const minimalSnapshotMs = performance.now() - minimalStart
    await settings.saveSettingsAndFlush({ privateDirectories: [directory] })
    assert.strictEqual((await access.createMediaAccessPolicyAsync({ audience: 'remote' })).canReadPath(path.join(directory, 'public.mp4')), false, 'later policy reads still observe current permission changes')
    await fsp.writeFile(path.join(parent, 'media-policy-settings-timing.json'), stringify({ operations: 200, tagEntries: 2000, fullSnapshotMs, minimalSnapshotMs,
      interpretation: 'Settings capture only; actual filesystem and policy work is excluded. No cached permission decision.' }, null, 2) + '\n')
    console.log('media policy settings passed: detached minimal snapshots, no unrelated settings serialization, current private roots, sync/async permission consumers; ' + stringify({ fullSnapshotMs, minimalSnapshotMs }))
  } finally { JSON.stringify = stringify; await settings.flushSettingsWrites(); process.chdir(root); assert.strictEqual(path.dirname(path.resolve(fixture)), parent); await removeTempRootWithRetry(fixture) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
