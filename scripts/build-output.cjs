const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const io = require('./build-io.cjs')

const markerName = '.wallpaper-build-output.json'
const fail = message => { throw new Error('Build output: ' + message) }
const pointerPath = (root, kind) => path.join(root, '.release', 'packaging', kind + '.json')
function validateKind(kind) { if (!['windows', 'plugins'].includes(kind)) fail('unknown output kind') }
async function identity(root) { await io.noLinkedParents(root); return io.key(await fs.realpath(root)) }
function validateRecord(record, rootId, kind) {
  if (record.schemaVersion !== 1 || record.kind !== kind || record.projectRoot !== rootId || !/^[a-f0-9-]{36}$/.test(record.id) || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(record.version)) fail('unknown output owner')
  if (!['directory', 'distribution', 'plugins'].includes(record.mode) || record.mode === 'plugins' !== (kind === 'plugins')) fail('invalid output mode')
  if (record.output !== 'release/' + kind + '-' + record.version + '-' + record.id || record.integrity !== 'official-package-integrity.json') fail('invalid output location')
  if (record.sourceCommit !== null && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(record.sourceCommit)) fail('invalid source commit')
  return record
}
async function readPointer(root, kind, { optional = false } = {}) {
  validateKind(kind)
  const file = pointerPath(root, kind)
  await io.noLinkedParents(file)
  let record
  try { record = JSON.parse(await fs.readFile(file, 'utf8')) } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error }
  return validateRecord(record, await identity(root), kind)
}
async function resolveOutput(root, kind, expected = {}) {
  const record = await readPointer(root, kind)
  for (const field of ['version', 'mode', 'sourceCommit']) if (expected[field] !== undefined && record[field] !== expected[field]) fail(field + ' differs from requested build')
  const directory = path.join(root, record.output)
  await io.noLinkedParents(directory)
  const marker = JSON.parse(await fs.readFile(path.join(directory, markerName), 'utf8'))
  if (JSON.stringify(marker) !== JSON.stringify(record)) fail('output marker differs from pointer')
  await io.walkTree(directory)
  return { record, directory, integrityPath: path.join(directory, record.integrity) }
}
async function publishOutput({ rootDir, kind, version, mode, sourceCommit = null, populate, validate, beforePointer }) {
  validateKind(kind)
  const rootId = await identity(rootDir)
  await readPointer(rootDir, kind, { optional: true })
  const id = crypto.randomUUID()
  const record = validateRecord({ schemaVersion: 1, kind, id, projectRoot: rootId, version, mode, sourceCommit,
    output: 'release/' + kind + '-' + version + '-' + id, integrity: 'official-package-integrity.json' }, rootId, kind)
  const release = path.join(rootDir, 'release')
  await io.noLinkedParents(release)
  await fs.mkdir(release, { recursive: true })
  const candidate = await fs.mkdtemp(path.join(release, '.candidate-' + kind + '-'))
  // A failed candidate is deliberately retained. Existing releases and portable Data are never removed.
  await io.atomicJson(path.join(candidate, markerName), record)
  await populate(candidate)
  await io.walkTree(candidate)
  await validate(candidate)
  if (JSON.stringify(JSON.parse(await fs.readFile(path.join(candidate, markerName), 'utf8'))) !== JSON.stringify(record)) fail('output owner marker changed during build')
  const directory = path.join(rootDir, record.output)
  try { await fs.lstat(directory); fail('output already exists') } catch (error) { if (error.code !== 'ENOENT') throw error }
  await io.noLinkedParents(directory)
  await fs.rename(candidate, directory)
  if (beforePointer) await beforePointer({ directory, record })
  // Validate ownership again; concurrent successful builds can each replace this one atomic file.
  await readPointer(rootDir, kind, { optional: true })
  await io.atomicJson(pointerPath(rootDir, kind), record)
  return { record, directory, integrityPath: path.join(directory, record.integrity) }
}
module.exports = { markerName, pointerPath, readPointer, resolveOutput, publishOutput }
