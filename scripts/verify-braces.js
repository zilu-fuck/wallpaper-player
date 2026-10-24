const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const defaultLoad = createRequire(path.join(root, 'mobile/package.json'))
const depthError = error => error && /(?:Input|AST) depth \(\d+\), exceeds max depth \(\d+\)/.test(error.message)
const pattern = (kind, depth) => {
  const opening = kind === 'braces' ? '{' : kind === 'parens' ? '(' : '{('
  const closing = kind === 'braces' ? '}' : kind === 'parens' ? ')' : ')}'
  return opening.repeat(depth) + 'x' + closing.repeat(depth)
}

function astChain(depth) {
  const ast = { type: 'root', nodes: [] }
  let cursor = ast
  for (let i = 0; i < depth; i++) {
    const next = { type: 'paren', nodes: [], parent: cursor }
    cursor.nodes.push(next); cursor = next
  }
  cursor.nodes.push({ type: 'text', value: 'x' })
  return ast
}

function runProbe(entry, name) {
  const braces = require(entry)
  const [kind, method, option] = name.split(':')
  const options = option === 'clamp' ? { maxDepth: 5000, maxLength: Infinity } : {}
  let input
  if (['braces', 'parens', 'mixed', 'unclosed'].includes(kind)) {
    input = kind === 'unclosed' ? '{'.repeat(4000) + 'x' : pattern(kind, kind === 'mixed' ? 2000 : 4000)
  } else if (kind === 'ast') input = astChain(12000)
  else if (kind === 'child-cycle') { input = { type: 'root', nodes: [] }; input.nodes.push(input) }
  else {
    input = { type: 'root', nodes: [] }
    const paren = { type: 'paren', nodes: [{ type: 'text', value: 'x' }] }
    input.nodes.push(paren)
    if (kind === 'parent-cycle') paren.parent = paren
    if (kind === 'foreign-queue') {
      let queue = 'foreign'
      for (let i = 0; i < 12000; i++) queue = [queue]
      const owner = { type: 'root', queue: [queue] }
      paren.parent = owner
    }
    if (kind === 'parent-getter') Object.defineProperty(paren, 'parent', { get() { throw Error('foreign parent metadata was read') } })
  }
  try {
    let output
    if (kind === 'micromatch') output = braces[method](pattern('braces', 4000), options)
    else if (method === 'default') output = braces(input, options)
    else if (method === 'default-expand') output = braces(input, { ...options, expand: true })
    else output = braces[method](input, options)
    const safeForeignMetadata = ['parent-cycle', 'foreign-queue', 'parent-getter'].includes(kind)
    if (safeForeignMetadata) assert.deepEqual(output, ['x'], 'expansion must derive queues from child traversal, ignoring foreign parent metadata')
    console.log(JSON.stringify({ name, returned: true, safeForeignMetadata }))
  } catch (error) {
    console.log(JSON.stringify({ name, returned: false, error: error.name, message: error.message, depthGuard: depthError(error) }))
  }
}

function verifyBraces({ load = defaultLoad, diagnostic = false, includeConsumers = true } = {}) {
  const entry = load.resolve('braces'), braces = load('braces')
  const results = { diagnostic, normalExpansionCases: 0, compiledMatches: 0, literalCases: 0, shallowNestingCases: 0, loweredLimitCases: 0, probes: [] }
  const expansions = [
    ['src/{App,index}.{ts,tsx}', ['src/App.ts', 'src/App.tsx', 'src/index.ts', 'src/index.tsx']],
    ['video-{1..3}.mp4', ['video-1.mp4', 'video-2.mp4', 'video-3.mp4']],
    ['video-{3..1}.mp4', ['video-3.mp4', 'video-2.mp4', 'video-1.mp4']],
    ['{1..7..2}', ['1', '3', '5', '7']],
    ['{01..03}', ['01', '02', '03']],
    ['{a..c}', ['a', 'b', 'c']],
    ['media/{中文,{red,blue}}.mp4', ['media/中文.mp4', 'media/red.mp4', 'media/blue.mp4']],
    ['{a,b}{c,d}', ['ac', 'ad', 'bc', 'bd']],
    ['{,a,a}', ['', 'a', 'a']],
    ['pre-{one,two}-post', ['pre-one-post', 'pre-two-post']]
  ]
  for (const [input, expected] of expansions) {
    assert.deepEqual(braces.expand(input), expected)
    assert.deepEqual(braces(input, { expand: true }), expected)
    const regex = new RegExp('^(?:' + braces.compile(input) + ')$')
    for (const value of expected) { assert.ok(regex.test(value)); results.compiledMatches++ }
    results.normalExpansionCases++
  }
  assert.deepEqual(braces.expand('{,a,a}', { noempty: true, nodupes: true }), ['a'])
  for (const input of ['literal', 'file/\\{a,b\\}.txt', '"{a,b}"', '[{a,b}]']) {
    assert.equal(braces.expand(input).length, 1)
    results.literalCases++
  }
  for (const kind of ['braces', 'parens', 'mixed']) {
    for (const depth of [1, 16, kind === 'mixed' ? 50 : 100]) {
      const input = pattern(kind, depth)
      for (const method of ['parse', 'compile', 'expand', 'stringify']) assert.doesNotThrow(() => braces[method](input))
      results.shallowNestingCases++
    }
  }
  if (!diagnostic) {
    for (const method of ['parse', 'compile', 'expand', 'stringify']) {
      assert.throws(() => braces[method](pattern('braces', 6), { maxDepth: 5 }), depthError)
      results.loweredLimitCases++
    }
    assert.throws(() => braces.compile('x'.repeat(10001)), /exceeds max characters/)
    assert.throws(() => braces.expand('{1..1001}'), /exceeds range limit/)
    for (const method of ['parse', 'compile', 'expand', 'stringify']) {
      assert.throws(() => braces[method](pattern('braces', 101)), depthError)
      if (method !== 'parse') {
        assert.doesNotThrow(() => braces[method](astChain(100)))
        assert.throws(() => braces[method](astChain(101)), depthError)
      }
    }
  }
  const probes = []
  for (const kind of ['braces', 'parens', 'mixed', 'unclosed']) {
    for (const method of ['parse', 'compile', 'expand', 'stringify', 'default', 'create', 'default-expand']) probes.push(kind + ':' + method)
  }
  for (const kind of ['ast', 'child-cycle']) for (const method of ['compile', 'expand', 'stringify']) probes.push(kind + ':' + method)
  for (const method of ['parse', 'compile', 'expand', 'stringify']) probes.push('braces:' + method + ':clamp')
  for (const kind of ['parent-cycle', 'foreign-queue', 'parent-getter']) probes.push(kind + ':expand')
  const cases = probes.map(name => ({ name, entry }))
  if (includeConsumers) {
    const micromatchEntry = load.resolve('micromatch'), micromatchLoad = createRequire(micromatchEntry)
    assert.equal(micromatchLoad.resolve('braces'), entry)
    const micromatch = load('micromatch')
    assert.deepEqual(micromatch.braces('src/{a,b}.ts'), ['src/(a|b).ts'])
    assert.deepEqual(micromatch.braceExpand('src/{a,b}.ts'), ['src/a.ts', 'src/b.ts'])
    assert.ok(Array.isArray(micromatch.parse('src/{a,b}.ts')))
    let metro = path.dirname(load.resolve('metro-file-map'))
    while (!fs.existsSync(path.join(metro, 'package.json'))) {
      const parent = path.dirname(metro); assert.notEqual(parent, metro); metro = parent
    }
    assert.equal(createRequire(path.join(metro, 'package.json')).resolve('micromatch'), micromatchEntry)
    const watcher = load(path.join(metro, 'src/watchers/common.js'))
    const originalCreate = braces.create; let braceCalls = 0
    braces.create = (...args) => { braceCalls++; return originalCreate(...args) }
    try {
      assert.equal(watcher.includedByGlob('f', ['**/*.{js,ts}'], false, 'src/App.ts'), true)
      assert.equal(watcher.includedByGlob('f', ['**/*.{js,ts}'], false, 'assets/icon.png'), false)
      assert.equal(watcher.includedByGlob('f', ['**/*.js'], false, 'src/.hidden.js'), false)
      assert.equal(watcher.includedByGlob('f', ['**/*.js'], true, 'src/.hidden.js'), true)
      assert.equal(braceCalls, 0, 'tested Metro watcher matching uses picomatch; do not claim its fixed glob path invokes the affected braces walker')
    } finally { braces.create = originalCreate }
    results.consumers = { actualMetroWatcherCases: 4, testedWatcherBraceCalls: braceCalls, micromatchBraceApis: 3, sameResolvedDependency: true }
    for (const method of ['parse', 'braces', 'braceExpand']) cases.push({ name: 'micromatch:' + method, entry: micromatchEntry })
  }
  for (const { name, entry: selectedEntry } of cases) {
    const result = spawnSync(process.execPath, ['--stack-size=512', __filename, '--probe', selectedEntry, name], {
      cwd: root, env: process.env, encoding: 'utf8', windowsHide: true, timeout: 2500, maxBuffer: 64 * 1024
    })
    const lines = (result.stdout || '').trim().split(/\r?\n/)
    let value
    try { value = JSON.parse(lines.at(-1)) } catch { value = { name, timedOut: result.error?.code === 'ETIMEDOUT', status: result.status, stderr: result.stderr?.slice(-300) } }
    results.probes.push(value)
    if (!diagnostic) {
      assert.ifError(result.error)
      assert.equal(result.status, 0, name + ': child must finish normally')
      if (/^(parent-cycle|foreign-queue|parent-getter):/.test(name)) {
        assert.equal(value.returned, true, name + ': external parent data must not be traversed')
        assert.equal(value.safeForeignMetadata, true)
      } else assert.equal(value.depthGuard, true, name + ': must reject with a deliberate depth guard, not stack exhaustion')
    }
  }
  return results
}

if (require.main === module) {
  try {
    const probe = process.argv.indexOf('--probe')
    if (probe >= 0) runProbe(process.argv[probe + 1], process.argv[probe + 2])
    else {
      const moduleRoot = process.argv.find(arg => arg.startsWith('--module-root='))?.slice('--module-root='.length)
      const load = moduleRoot ? createRequire(path.resolve(moduleRoot, 'package.json')) : defaultLoad
      console.log(JSON.stringify(verifyBraces({ load, diagnostic: process.argv.includes('--diagnostic'), includeConsumers: !moduleRoot })))
    }
  } catch (error) { console.error(error); process.exitCode = 1 }
}
module.exports = { verifyBraces }
