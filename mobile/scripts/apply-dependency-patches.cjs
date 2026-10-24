const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const fail = message => { throw new Error('Dependency backport: ' + message) }
function safeParts(value) {
  if (typeof value !== 'string' || path.isAbsolute(value)) fail('expected a relative managed dependency path')
  const parts = value.split(/[\\/]/)
  if (parts.some(part => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part))) {
    fail('invalid managed dependency path')
  }
  return parts
}
function ownedFile(root, relative) {
  let current = root
  const parts = safeParts(relative)
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i])
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) fail('refusing linked dependency path: ' + relative)
    if (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) fail('unexpected file type: ' + relative)
  }
  return current
}

function applyDependencyPatches({ mobileRoot = path.resolve(__dirname, '..'), checkOnly = false } = {}) {
  const root = path.resolve(mobileRoot)
  if (fs.lstatSync(root).isSymbolicLink()) fail('refusing a linked project root')
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'patches/dependency-patches.json'), 'utf8'))
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.patches) || !manifest.patches.length) fail('unsupported patch manifest')
  const results = []
  for (const name of new Set(manifest.patches.map(patch => patch.package))) {
    const known = [...new Set(manifest.patches.filter(patch => patch.package === name).map(patch => patch.packagePath))].sort()
    const installed = Object.keys(lock.packages || {}).filter(key => key.endsWith('/' + name)).sort()
    if (JSON.stringify(known) !== JSON.stringify(installed)) fail('new ' + name + ' installation paths require patch review')
  }
  const prepared = [], targets = new Set()
  for (const patch of manifest.patches) {
    const packageParts = safeParts(patch.packagePath)
    if (packageParts[0] !== 'node_modules' || packageParts.at(-1) !== patch.package) fail('patch target is not its managed package')
    const packageFile = ownedFile(root, patch.packagePath + '/package.json')
    const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8')), locked = lock.packages?.[patch.packagePath]
    if (pkg.name !== patch.package || pkg.version !== patch.version || locked?.version !== patch.version || locked?.integrity !== patch.integrity) {
      fail(patch.id + ': package version/integrity changed; review the upstream fix before updating the backport')
    }
    const target = ownedFile(root, patch.packagePath + '/' + safeParts(patch.file).join('/'))
    if (targets.has(target)) fail('duplicate managed patch target')
    targets.add(target)
    const bytes = fs.readFileSync(target), current = digest(bytes)
    if (current === patch.afterSha256) { prepared.push({ patch, target, updated: null }); continue }
    if (current !== patch.beforeSha256) fail(patch.id + ': unexpected source digest; no file changed')
    if (checkOnly) fail(patch.id + ': backport missing; run npm run patch:dependencies in mobile')
    const before = patch.before.join('\n'), after = patch.after.join('\n'), source = bytes.toString('utf8')
    if (source.split(before).length !== 2) fail(patch.id + ': patch must match exactly once')
    const updated = Buffer.from(source.replace(before, () => after))
    if (digest(updated) !== patch.afterSha256) fail(patch.id + ': patched source does not match reviewed digest')
    prepared.push({ patch, target, updated })
  }
  // Validate every source/version/path before replacing any file in a multi-file patch.
  // Each replacement is atomic; interrupted installation still fails the startup check.
  for (const { patch, target, updated } of prepared) {
    if (!updated) { results.push({ id: patch.id, state: 'already-applied', sha256: patch.afterSha256 }); continue }
    const temporary = path.join(path.dirname(target), '.wallpaper-backport-' + process.pid + '-' + crypto.randomUUID() + '.tmp')
    try {
      fs.writeFileSync(temporary, updated, { flag: 'wx', mode: fs.statSync(target).mode })
      const latest = digest(fs.readFileSync(target))
      if (latest !== patch.beforeSha256 && latest !== patch.afterSha256) fail(patch.id + ': source changed during application')
      fs.renameSync(temporary, target)
      if (digest(fs.readFileSync(target)) !== patch.afterSha256) fail(patch.id + ': applied source verification failed')
    } finally {
      try { fs.unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    results.push({ id: patch.id, state: 'applied', sha256: patch.afterSha256 })
  }
  return results
}

if (require.main === module) {
  try { console.log(JSON.stringify({ dependencyBackports: applyDependencyPatches({ checkOnly: process.argv.includes('--check') }) })) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
module.exports = { applyDependencyPatches }
