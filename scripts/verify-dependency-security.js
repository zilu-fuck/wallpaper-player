const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const mobile = process.argv.includes('--scope=mobile')
const base = mobile ? path.join(root, 'mobile') : root
const load = createRequire(path.join(base, 'package.json'))
const lock = JSON.parse(fs.readFileSync(path.join(base, 'package-lock.json'), 'utf8'))
const checks = []

function lockedModule(name, from = load) {
  const entry = from.resolve(name)
  let directory = path.dirname(entry)
  let pkg
  while (true) {
    const file = path.join(directory, 'package.json')
    pkg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
    if (pkg?.name === name) break
    const parent = path.dirname(directory)
    assert.notEqual(parent, directory, 'package manifest must exist: ' + name)
    directory = parent
  }
  const key = path.relative(base, directory).replaceAll('\\', '/')
  assert.ok(key.startsWith('node_modules/'), name + ' must resolve inside the selected dependency tree')
  assert.equal(typeof pkg.version, 'string')
  assert.equal(pkg.version, lock.packages[key]?.version, name + ' installed version must match its lockfile')
  return from(name)
}

function yamlLimits() {
  const yaml = lockedModule('js-yaml')
  const value = { title: '中文 & spaces', paths: ['C:\\视频 目录\\sample.mp4'], enabled: true }
  assert.deepEqual(yaml.load(yaml.dump(value)), value)
  assert.throws(() => yaml.load('empty: &empty {}\nmerged: { <<: [*empty, *empty, *empty] }', {
    maxTotalMergeKeys: 1
  }), /merge|limit|exceed/i)
  checks.push('actual locked YAML parser roundtrip and empty-merge work limit')
}

async function tarProbe(fixture) {
  const tar = lockedModule('tar')
  const output = path.join(fixture, 'pax-output')
  fs.mkdirSync(output)
  const content = Buffer.from('bounded numeric PAX fixture')
  const header = new tar.Header({ path: 'original.txt', type: 'File', mode: 0o600, size: content.length })
  header.encode()
  const archive = Buffer.concat([
    new tar.Pax({ path: '1234', size: -1 }).encode(), header.block,
    content, Buffer.alloc((512 - content.length % 512) % 512), Buffer.alloc(1024)
  ])
  assert.ok(archive.length < 4096, 'malformed-input probe stays bounded')
  await new Promise((resolve, reject) => {
    const unpack = tar.x({ cwd: output, strict: true })
    unpack.once('error', reject).once('close', resolve)
    unpack.end(archive)
  })
  assert.deepEqual(fs.readFileSync(path.join(output, '1234')), content)
  assert.deepEqual(fs.readdirSync(output), ['1234'])
}

async function desktopChecks() {
  const tar = lockedModule('tar')
  // Check the actual packaging/native-build consumers resolve the module under test.
  for (const consumer of ['app-builder-lib', 'node-gyp']) {
    const from = createRequire(load.resolve(consumer + '/package.json'))
    assert.equal(lockedModule('tar', from), tar)
  }
  const parent = path.join(root, '.tmp/refactor-tests')
  fs.mkdirSync(parent, { recursive: true })
  const fixture = fs.mkdtempSync(path.join(parent, 'dependency-security-'))
  const source = path.join(fixture, 'source'), output = path.join(fixture, 'output')
  fs.mkdirSync(source); fs.mkdirSync(output)
  const content = Buffer.from('打包链 tar / 中文目录 / bounded payload\n')
  fs.mkdirSync(path.join(source, '中文 目录'))
  fs.writeFileSync(path.join(source, '中文 目录', 'config.json'), content)
  const archive = path.join(fixture, 'fixture.tgz')
  await tar.c({ cwd: source, file: archive, gzip: true }, ['中文 目录'])
  await tar.x({ cwd: output, file: archive, strict: true })
  assert.deepEqual(fs.readFileSync(path.join(output, '中文 目录', 'config.json')), content)
  checks.push('packaging and node-gyp tar consumer resolution and gzip Unicode roundtrip')
  // A vulnerable parser can stall; keep this small regression in a time-limited child.
  const result = spawnSync(process.execPath, [__filename, '--tar-probe', fixture], {
    cwd: root, env: process.env, encoding: 'utf8', windowsHide: true, timeout: 5000,
    maxBuffer: 64 * 1024
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  checks.push('bounded numeric PAX path and negative size extraction in a timed child')
  yamlLimits()
}

function mobileChecks() {
  const { applyDependencyPatches } = require('../mobile/scripts/apply-dependency-patches.cjs')
  const backports = applyDependencyPatches({ checkOnly: true })
  assert.ok(backports.every(result => result.state === 'already-applied'))
  checks.push('installed dependency backports match reviewed source, package version and lock integrity')
  checks.push({ backportInstaller: require('./verify-dependency-patches').verifyDependencyPatches() })
  const forge = require('./verify-node-forge').verifyNodeForge({ load })
  checks.push({ forgeStrictDigestInfo: forge })
  checks.push({ bracesDepth: require('./verify-braces').verifyBraces({ load }) })
  const quote = lockedModule('shell-quote')
  const consumer = createRequire(path.join(base, 'node_modules/react-devtools-core/package.json'))
  assert.equal(lockedModule('shell-quote', consumer), quote)
  const tokens = ['node', 'C:\\视频 目录\\sample.js', 'https://example.invalid/#frag', 'a;echo text', '']
  assert.deepEqual(quote.parse(quote.quote(tokens)), tokens)
  for (const end of ['\n', '\r', '\u2028', '\u2029']) {
    assert.throws(() => quote.quote(['echo', 'ok', { comment: 'fixture' }, 'a' + end + 'payload;#']), TypeError)
  }
  checks.push('React Native devtools shell quoting roundtrip and four post-comment line terminators rejected')
  for (const name of ['@expo/plist', 'plist']) {
    const module = lockedModule(name), plist = module.default || module
    const value = { CFBundleName: '中文 & spaces', enabled: true, identifiers: ['one', 'two'] }
    const parsed = plist.parse(plist.build(value))
    assert.deepEqual(Object.keys(parsed).sort(), Object.keys(value).sort())
    for (const key of Object.keys(value)) assert.deepEqual(parsed[key], value[key])
  }
  checks.push('Expo and nested plist XML consumers preserve Unicode, entities and values')
  const xcode = lockedModule('xcode')
  const expo = createRequire(load.resolve('@expo/config-plugins'))
  assert.equal(lockedModule('xcode', expo), xcode, 'Expo must use the Xcode consumer under test')
  const xcodePackage = JSON.parse(fs.readFileSync(load.resolve('xcode/package.json'), 'utf8'))
  assert.equal(xcodePackage.dependencies?.uuid, undefined, 'supported Xcode tooling must no longer depend on the retired UUID package')
  const project = xcode.project('dependency-security-unused.pbxproj')
  project.hash = { project: { objects: { PBXFileReference: {} } } }
  const ids = new Set()
  for (let i = 0; i < 128; i++) {
    const id = project.generateUuid()
    assert.match(id, /^[A-F0-9]{24}$/)
    assert.ok(!ids.has(id), 'generated Xcode references must be unique')
    ids.add(id); project.hash.project.objects.PBXFileReference[id] = { isa: 'PBXFileReference' }
  }
  checks.push('actual Expo/Xcode consumer generates valid unique native references without the retired UUID dependency')
  yamlLimits()
}

;(async () => {
  const probe = process.argv.indexOf('--tar-probe')
  if (probe >= 0) return tarProbe(process.argv[probe + 1])
  if (mobile) mobileChecks()
  else await desktopChecks()
  console.log(JSON.stringify({ scope: mobile ? 'mobile' : 'desktop', checks }))
})().catch(error => { console.error(error); process.exitCode = 1 })
