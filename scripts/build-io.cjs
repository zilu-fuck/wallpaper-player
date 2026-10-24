const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFile } = require('node:child_process')

const fail = message => { throw new Error('Build filesystem: ' + message) }
const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
const inside = (parent, child) => { const relative = path.relative(key(parent), key(child)); return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
async function physicalPath(value) {
  let current = path.resolve(value), suffix = []
  for (;;) {
    try { return path.join(await fsp.realpath(current), ...suffix) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const parent = path.dirname(current); if (parent === current) throw error
      suffix.unshift(path.basename(current)); current = parent
    }
  }
}
async function noLinkedParents(value) {
  const absolute = path.resolve(value), parts = absolute.slice(path.parse(absolute).root.length).split(path.sep).filter(Boolean)
  let current = path.parse(absolute).root
  for (const part of parts) {
    current = path.join(current, part)
    try { if ((await fsp.lstat(current)).isSymbolicLink()) fail('linked path is not managed: ' + current) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return absolute
}
async function walkTree(directory, { excludeNames = [], excludePaths = [], excludeFileExtensions = [] } = {}) {
  await noLinkedParents(directory)
  const names = new Set(excludeNames.map(item => item.toLowerCase())), paths = new Set(excludePaths.map(item => key(path.resolve(directory, item))))
  const extensions = new Set(excludeFileExtensions.map(item => item.toLowerCase())), files = [], directories = [], excluded = []
  async function visit(current) {
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name)
      if (names.has(entry.name.toLowerCase()) || paths.has(key(file)) || entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) { excluded.push(file); continue }
      if (entry.isSymbolicLink()) fail('unexpected source link: ' + file)
      if (entry.isDirectory()) { directories.push(file); await visit(file) }
      else if (entry.isFile()) files.push(file)
      else fail('unsupported source file type: ' + file)
    }
  }
  if (!(await fsp.stat(directory)).isDirectory()) fail('expected source directory')
  await visit(directory)
  return { files, directories, excluded }
}
async function run(executable, args, { cwd, env = process.env, timeout = 30 * 60 * 1000, success = code => code === 0 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { cwd, env, windowsHide: true, timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? error.code : 0
      if (!success(code)) { reject(Object.assign(new Error('Build command failed: ' + executable + ' (exit ' + code + ')\n' + String(stderr || stdout).slice(-4000)), { code, cause: error })); return }
      resolve({ code, stdout, stderr })
    })
  })
}
async function copyItem(source, destination, options = {}) {
  source = path.resolve(source); destination = path.resolve(destination)
  await noLinkedParents(source); await noLinkedParents(destination)
  const from = await physicalPath(source), to = await physicalPath(destination)
  if (inside(from, to) || inside(to, from)) fail('copy source and destination overlap')
  const stat = await fsp.lstat(source)
  if (stat.isFile()) {
    await fsp.mkdir(path.dirname(destination), { recursive: true })
    await fsp.copyFile(source, destination, fs.constants.COPYFILE_EXCL)
    return { files: 1, method: 'copyFile' }
  }
  const tree = await walkTree(source, options)
  try { if ((await fsp.readdir(destination)).length) fail('copy destination must be empty: ' + destination) } catch (error) { if (error.code !== 'ENOENT') throw error }
  await fsp.mkdir(destination, { recursive: true })
  if (process.platform === 'win32') {
    const args = [source, destination, '/E', '/XJ', '/R:1', '/W:1', '/COPY:DAT', '/DCOPY:DAT', '/NFL', '/NDL', '/NJH', '/NJS', '/NP']
    if (tree.excluded.length) {
      const directories = [...(options.excludeNames || [])], files = [...(options.excludeNames || []), ...(options.excludeFileExtensions || []).map(item => '*' + item)]
      for (const relative of options.excludePaths || []) {
        const file = path.resolve(source, relative)
        if (!inside(source, file) || key(source) === key(file)) fail('invalid excluded path')
        // Both switches also cover an explicitly excluded link without following it.
        directories.push(file); files.push(file)
      }
      if (directories.length) args.push('/XD', ...directories)
      if (files.length) args.push('/XF', ...files)
    }
    await (options.run || run)('robocopy.exe', args, { success: code => Number.isInteger(code) && code >= 0 && code < 8 })
  } else {
    for (const directory of tree.directories) await fsp.mkdir(path.join(destination, path.relative(source, directory)), { recursive: true })
    for (const file of tree.files) await fsp.copyFile(file, path.join(destination, path.relative(source, file)), fs.constants.COPYFILE_EXCL)
  }
  const copied = await walkTree(destination)
  const expected = tree.files.map(file => path.relative(source, file)).sort()
  const actual = copied.files.map(file => path.relative(destination, file)).sort()
  if (JSON.stringify(expected) !== JSON.stringify(actual)) fail('copied file inventory differs from selected source')
  if (JSON.stringify(tree.directories.map(file => path.relative(source, file)).sort()) !== JSON.stringify(copied.directories.map(file => path.relative(destination, file)).sort())) fail('copied directory inventory differs from selected source')
  for (let i = 0; i < expected.length; i++) if ((await fsp.stat(path.join(source, expected[i]))).size !== (await fsp.stat(path.join(destination, actual[i]))).size) fail('copied file size differs')
  return { files: tree.files.length, excluded: tree.excluded.length, method: process.platform === 'win32' ? 'robocopy' : 'copyFile' }
}
async function atomicJson(file, value) {
  await noLinkedParents(file)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const temporary = path.join(path.dirname(file), '.build-write-' + crypto.randomUUID() + '.tmp')
  try { await fsp.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); await fsp.rename(temporary, file) }
  finally { try { await fsp.unlink(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error } }
}
async function createStage(base, projectRoot) {
  await noLinkedParents(base); await noLinkedParents(projectRoot)
  if (/[^\x20-\x7e]/.test(path.resolve(base))) fail('build base must be ASCII')
  const from = await physicalPath(projectRoot), to = await physicalPath(base)
  if (inside(from, to) || inside(to, from)) fail('build base must be outside the project tree')
  await fsp.mkdir(base, { recursive: true })
  const stage = await fsp.mkdtemp(path.join(path.resolve(base), 'run-'))
  const owner = { schemaVersion: 1, kind: 'wallpaper-build-stage', id: crypto.randomUUID(), projectRoot: key(from), base: key(to), directory: key(stage) }
  await atomicJson(path.join(stage, '.wallpaper-build-stage.json'), owner)
  return { stage, owner }
}
async function removeStage(stage, owner) {
  await noLinkedParents(stage)
  if (key(await physicalPath(stage)) !== owner.directory || key(path.dirname(stage)) !== owner.base || !/^run-[A-Za-z0-9_-]+$/.test(path.basename(stage))) fail('stage removal path is not owned')
  const marker = JSON.parse(await fsp.readFile(path.join(stage, '.wallpaper-build-stage.json'), 'utf8'))
  if (JSON.stringify(marker) !== JSON.stringify(owner)) fail('stage owner marker changed')
  await walkTree(stage)
  for (const relative of ['release/Data', 'release/win-unpacked/Data']) if (fs.existsSync(path.join(stage, relative))) fail('portable data exists in stage; retain it')
  // Only a freshly generated, physically checked run child with the exact owner is removed.
  await fsp.rm(stage, { recursive: true, force: false })
}
module.exports = { inside, key, physicalPath, noLinkedParents, walkTree, run, copyItem, atomicJson, createStage, removeStage }
