const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { applyDependencyPatches } = require('../mobile/scripts/apply-dependency-patches.cjs')

function verifyDependencyPatches() {
  const root = path.resolve(__dirname, '..'), mobile = path.join(root, 'mobile')
  const scripts = JSON.parse(fs.readFileSync(path.join(mobile, 'package.json'))).scripts
  assert.equal(scripts.postinstall, 'node scripts/apply-dependency-patches.cjs')
  assert.equal(scripts['patch:dependencies'], scripts.postinstall)
  assert.equal(scripts.prestart, scripts.postinstall + ' --check')
  assert.equal(scripts.preandroid, scripts.prestart)
  const allManifest = JSON.parse(fs.readFileSync(path.join(mobile, 'patches/dependency-patches.json')))
  const patch = allManifest.patches.find(item => item.id === 'node-forge-CVE-2026-85393')
  const manifest = { ...allManifest, patches: [patch] }
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
  const current = fs.readFileSync(path.join(mobile, patch.packagePath, patch.file), 'utf8')
  assert.equal(hash(current), patch.afterSha256)
  const pristine = current.replace(patch.after.join('\n'), () => patch.before.join('\n'))
  assert.equal(hash(pristine), patch.beforeSha256)
  const parent = fs.mkdtempSync(path.join(root, '.tmp/refactor-tests/dependency-patches-'))
  const checks = []
  const fixture = (name, { module = true } = {}) => {
    const directory = path.join(parent, name)
    fs.mkdirSync(path.join(directory, 'patches'), { recursive: true })
    fs.mkdirSync(path.join(directory, 'node_modules'))
    fs.writeFileSync(path.join(directory, 'patches/dependency-patches.json'), JSON.stringify(manifest))
    fs.writeFileSync(path.join(directory, 'package-lock.json'), JSON.stringify({ packages: {
      [patch.packagePath]: { version: patch.version, integrity: patch.integrity }
    } }))
    if (module) {
      fs.mkdirSync(path.join(directory, patch.packagePath, 'lib'), { recursive: true })
      fs.writeFileSync(path.join(directory, patch.packagePath, 'package.json'), JSON.stringify({ name: patch.package, version: patch.version }))
      fs.writeFileSync(path.join(directory, patch.packagePath, patch.file), pristine)
    }
    return directory
  }
  const target = directory => path.join(directory, patch.packagePath, patch.file)
  const normal = fixture('normal')
  assert.throws(() => applyDependencyPatches({ mobileRoot: normal, checkOnly: true }), /backport missing/)
  assert.equal(hash(fs.readFileSync(target(normal))), patch.beforeSha256)
  assert.equal(applyDependencyPatches({ mobileRoot: normal })[0].state, 'applied')
  assert.equal(applyDependencyPatches({ mobileRoot: normal })[0].state, 'already-applied')
  assert.equal(applyDependencyPatches({ mobileRoot: normal, checkOnly: true })[0].state, 'already-applied')
  checks.push('missing patch fails check; application, check-only and repeated installation are idempotent')
  const changed = fixture('changed-source')
  fs.appendFileSync(target(changed), '\n// unknown local dependency edit\n')
  const changedHash = hash(fs.readFileSync(target(changed)))
  assert.throws(() => applyDependencyPatches({ mobileRoot: changed }), /unexpected source digest/)
  assert.equal(hash(fs.readFileSync(target(changed))), changedHash)
  checks.push('unexpected dependency bytes are rejected without overwrite')
  const version = fixture('changed-version')
  fs.writeFileSync(path.join(version, patch.packagePath, 'package.json'), JSON.stringify({ name: patch.package, version: '1.4.99' }))
  assert.throws(() => applyDependencyPatches({ mobileRoot: version }), /version\/integrity changed/)
  assert.equal(hash(fs.readFileSync(target(version))), patch.beforeSha256)
  const integrity = fixture('changed-integrity')
  const lockFile = path.join(integrity, 'package-lock.json'), locked = JSON.parse(fs.readFileSync(lockFile))
  locked.packages[patch.packagePath].integrity = 'sha512-unreviewed'
  fs.writeFileSync(lockFile, JSON.stringify(locked))
  assert.throws(() => applyDependencyPatches({ mobileRoot: integrity }), /version\/integrity changed/)
  assert.equal(hash(fs.readFileSync(target(integrity))), patch.beforeSha256)
  checks.push('new package versions and unreviewed npm integrity require explicit patch review')
  for (const [index, file] of ['../outside.js', '.. /outside.js', 'lib/rsa.js:alternate-stream'].entries()) {
    const traversal = fixture('traversal-' + index)
    const unsafe = JSON.parse(JSON.stringify(manifest)); unsafe.patches[0].file = file
    fs.writeFileSync(path.join(traversal, 'patches/dependency-patches.json'), JSON.stringify(unsafe))
    assert.throws(() => applyDependencyPatches({ mobileRoot: traversal }), /invalid managed dependency path/)
    assert.equal(hash(fs.readFileSync(target(traversal))), patch.beforeSha256)
  }
  checks.push('path traversal, Windows trailing-space alias and alternate data stream cannot redirect the patch')
  const nested = fixture('new-nested-copy')
  const nestedLock = path.join(nested, 'package-lock.json'), copies = JSON.parse(fs.readFileSync(nestedLock))
  copies.packages['node_modules/new-consumer/node_modules/node-forge'] = { version: patch.version, integrity: patch.integrity }
  fs.writeFileSync(nestedLock, JSON.stringify(copies))
  assert.throws(() => applyDependencyPatches({ mobileRoot: nested }), /new node-forge installation paths/)
  checks.push('additional nested Forge copies fail closed instead of remaining silently unpatched')
  const linkedTarget = fixture('linked-target'), linked = fixture('linked-consumer', { module: false })
  fs.symlinkSync(path.join(linkedTarget, patch.packagePath), path.join(linked, patch.packagePath), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => applyDependencyPatches({ mobileRoot: linked }), /refusing linked dependency path/)
  assert.equal(hash(fs.readFileSync(target(linkedTarget))), patch.beforeSha256)
  checks.push('linked/junction dependency directories are rejected before mutation')
  const hardlinked = fixture('hardlinked-source'), shadow = path.join(parent, 'hardlink-shadow.js')
  fs.linkSync(target(hardlinked), shadow)
  applyDependencyPatches({ mobileRoot: hardlinked })
  assert.equal(hash(fs.readFileSync(target(hardlinked))), patch.afterSha256)
  assert.equal(hash(fs.readFileSync(shadow)), patch.beforeSha256)
  assert.ok(!fs.readdirSync(path.dirname(target(hardlinked))).some(name => name.startsWith('.wallpaper-backport-')))
  checks.push('atomic file replacement leaves shared hardlink bytes untouched and no temporary file')
  const allPristine = new Map(allManifest.patches.map(item => {
    const source = fs.readFileSync(path.join(mobile, item.packagePath, item.file), 'utf8')
    assert.equal(hash(source), item.afterSha256)
    const before = source.replace(item.after.join('\n'), () => item.before.join('\n'))
    assert.equal(hash(before), item.beforeSha256)
    return [item.id, before]
  }))
  const completeFixture = name => {
    const directory = path.join(parent, name), packages = {}
    fs.mkdirSync(path.join(directory, 'patches'), { recursive: true })
    fs.writeFileSync(path.join(directory, 'patches/dependency-patches.json'), JSON.stringify(allManifest))
    for (const item of allManifest.patches) {
      packages[item.packagePath] = { version: item.version, integrity: item.integrity }
      const file = path.join(directory, item.packagePath, item.file)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(path.join(directory, item.packagePath, 'package.json'), JSON.stringify({ name: item.package, version: item.version }))
      fs.writeFileSync(file, allPristine.get(item.id))
    }
    fs.writeFileSync(path.join(directory, 'package-lock.json'), JSON.stringify({ packages }))
    return directory
  }
  const complete = completeFixture('all-patch-files')
  assert.throws(() => applyDependencyPatches({ mobileRoot: complete, checkOnly: true }), /backport missing/)
  const applied = applyDependencyPatches({ mobileRoot: complete })
  assert.equal(applied.length, allManifest.patches.length); assert.ok(applied.every(item => item.state === 'applied'))
  assert.ok(applyDependencyPatches({ mobileRoot: complete, checkOnly: true }).every(item => item.state === 'already-applied'))
  assert.ok(applyDependencyPatches({ mobileRoot: complete }).every(item => item.state === 'already-applied'))
  for (const item of allManifest.patches) assert.equal(hash(fs.readFileSync(path.join(complete, item.packagePath, item.file))), item.afterSha256)
  checks.push('all package/file patches apply together, verify individually and remain idempotent')
  const last = allManifest.patches.at(-1), late = completeFixture('late-unexpected-source')
  fs.appendFileSync(path.join(late, last.packagePath, last.file), '\n// unreviewed last file\n')
  const beforeFailure = allManifest.patches.map(item => hash(fs.readFileSync(path.join(late, item.packagePath, item.file))))
  assert.throws(() => applyDependencyPatches({ mobileRoot: late }), /unexpected source digest/)
  assert.deepEqual(allManifest.patches.map(item => hash(fs.readFileSync(path.join(late, item.packagePath, item.file)))), beforeFailure)
  checks.push('multi-file preflight rejects a later unknown source before modifying any earlier target')
  const extra = completeFixture('new-braces-copy'), extraFile = path.join(extra, 'package-lock.json')
  const extraLock = JSON.parse(fs.readFileSync(extraFile)), braces = allManifest.patches.find(item => item.package === 'braces')
  assert.ok(braces)
  extraLock.packages['node_modules/new-consumer/node_modules/braces'] = { version: braces.version, integrity: braces.integrity }
  fs.writeFileSync(extraFile, JSON.stringify(extraLock))
  assert.throws(() => applyDependencyPatches({ mobileRoot: extra }), /new braces installation paths/)
  for (const item of allManifest.patches) assert.equal(hash(fs.readFileSync(path.join(extra, item.packagePath, item.file))), item.beforeSha256)
  checks.push('new nested braces copies fail closed before any managed package changes')
  const literal = fixture('literal-replacement'), literalManifest = JSON.parse(JSON.stringify(manifest))
  literalManifest.patches[0].after.push("// Literal replacement tokens: $& $' $` $$")
  const expectedLiteral = pristine.replace(patch.before.join('\n'), () => literalManifest.patches[0].after.join('\n'))
  literalManifest.patches[0].afterSha256 = hash(expectedLiteral)
  fs.writeFileSync(path.join(literal, 'patches/dependency-patches.json'), JSON.stringify(literalManifest))
  applyDependencyPatches({ mobileRoot: literal })
  assert.equal(fs.readFileSync(target(literal), 'utf8'), expectedLiteral)
  checks.push('replacement text preserves literal JavaScript dollar substitution tokens')
  // Retain fixtures. The linked-consumer directory intentionally contains a junction.
  return { checks, fixture: parent, retainReason: 'Includes an intentional owned junction; do not recursively remove this fixture tree' }
}

if (require.main === module) {
  try { console.log(JSON.stringify(verifyDependencyPatches())) }
  catch (error) { console.error(error); process.exitCode = 1 }
}
module.exports = { verifyDependencyPatches }
