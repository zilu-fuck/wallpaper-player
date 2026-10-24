const assert = require('assert'), fs = require('fs'), fsp = require('fs/promises'), path = require('path'), crypto = require('crypto')
const { spawnSync } = require('child_process')
const babel = require('@babel/core')
const sharedAliases = require('./shared-aliases.cjs')
const { removeTempRootWithRetry } = require('./verify-helpers')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
const names = new Set(['AppInner', 'Gallery', 'VideoCard', 'Sidebar', 'Settings', 'VideoPlayer', 'TagEditor'])
async function main() {
  fs.mkdirSync(parent, { recursive: true })
  const fixture = fs.mkdtempSync(path.join(parent, 'app-state-'))
  try {
    const sourceFiles = ['src/App.jsx', 'src/context/AppContext.js', 'src/components/AppProvider.jsx', 'src/hooks/useAppState.js',
      'src/services/controller-store.js', 'src/utils/share-json.js', ...['Gallery', 'VideoCard', 'Sidebar', 'Settings', 'VideoPlayer', 'TagEditor'].map(name => 'src/components/' + name + '.jsx')]
    const sourceDigest = crypto.createHash('sha256')
    for (const file of sourceFiles) sourceDigest.update(file).update(fs.readFileSync(path.join(root, file)))
    const { build } = await import('vite')
    const react = (await import('@vitejs/plugin-react')).default
    await fsp.writeFile(path.join(fixture, 'index.html'), '<div id="root"></div><script type="module" src="/scripts/fixtures/app-state-profile.jsx"></script>')
    await build({ configFile: false, root, base: './', logLevel: 'error',
      resolve: { alias: { ...sharedAliases, 'react-dom/client': require.resolve('react-dom/profiling') } },
      plugins: [{ name: 'state-profile-instrumentation', enforce: 'pre', transform(code, id) {
        if (!/[/\\]src[/\\](App\.jsx|components[/\\](Gallery|VideoCard|Sidebar|Settings|VideoPlayer|TagEditor)\.jsx|hooks[/\\]useAppController\.js)$/.test(id)) return null
        return babel.transformSync(code, { filename: id, babelrc: false, configFile: false, parserOpts: { plugins: ['jsx'] }, plugins: [({ types: t }) => ({
          visitor: {
            Program(program) { program.unshiftContainer('body', t.importDeclaration([
              t.importSpecifier(t.identifier('__AuditProfiler'), t.identifier('Profiler')),
              t.importSpecifier(t.identifier('__auditElement'), t.identifier('createElement'))
            ], t.stringLiteral('react'))) },
            FunctionDeclaration(fn) {
              const name = fn.node.id?.name
              if (names.has(name)) fn.get('body').unshiftContainer('body', t.expressionStatement(t.callExpression(t.memberExpression(t.identifier('globalThis'), t.identifier('__auditRender')), [t.stringLiteral(name), ...(name === 'VideoCard' ? [t.memberExpression(t.identifier('video'), t.identifier('fullPath'))] : [])])))
            },
            ReturnStatement(statement) {
              const owner = statement.getFunctionParent()?.node.id?.name
              if (!statement.node.argument) return
              if (owner === 'useAppController') statement.node.argument = t.assignmentExpression('=', t.memberExpression(t.identifier('globalThis'), t.identifier('__auditController')), statement.node.argument)
              if (names.has(owner)) statement.node.argument = t.callExpression(t.identifier('__auditElement'), [t.identifier('__AuditProfiler'), t.objectExpression([
                t.objectProperty(t.identifier('id'), t.stringLiteral(owner)),
                t.objectProperty(t.identifier('onRender'), t.memberExpression(t.identifier('globalThis'), t.identifier('__auditOnRender')))
              ]), statement.node.argument])
            }
          }
        })] })
      } }, react()],
      build: { outDir: path.join(fixture, 'bundle'), emptyOutDir: true,
        rolldownOptions: { input: path.join(fixture, 'index.html') } } })
    const html = path.join(fixture, 'bundle/index.html')
    const nested = path.join(fixture, 'bundle', path.relative(root, path.join(fixture, 'index.html')))
    if (!fs.existsSync(html)) { fs.copyFileSync(nested, html); fs.writeFileSync(html, fs.readFileSync(html, 'utf8').replace(/(?:\.\.\/)+(?=assets\/)/g, '')) }
    const env = { ...process.env, WALLPAPER_STATE_PROFILE_FIXTURE: fixture }; delete env.ELECTRON_RUN_AS_NODE
    const result = spawnSync(require('electron'), [path.join(__dirname, 'verify-app-state-electron.js'), ...process.argv.slice(2).filter(arg => arg.startsWith('--') && arg !== '--baseline')],
      { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 40000, maxBuffer: 4 * 1024 * 1024 })
    if (result.error || result.status !== 0 || !result.stdout?.includes('APP_STATE_PROFILE:')) {
      process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); throw result.error || Error('React state profile failed: ' + result.status)
    }
    const evidence = { ...JSON.parse(fs.readFileSync(path.join(fixture, 'evidence.json'))), sourceSha256: sourceDigest.digest('hex'), capturedAt: new Date().toISOString(), platform: process.platform,
      sourceFiles, electron: require('electron/package.json').version, react: require('react/package.json').version, flags: process.argv.slice(2).filter(arg => arg !== '--baseline') }
    const baseline = process.argv.includes('--baseline')
    await fsp.writeFile(path.join(parent, 'app-state-latest.json'), JSON.stringify(evidence, null, 2))
    if (!baseline) {
      for (const name of ['analysis', 'analysisWithSettings', 'settingsBroadcast', 'playback']) {
        const measured = evidence.measurements.find(item => item.name === name)
        assert.strictEqual(measured.bodies.Gallery || 0, 0, name + ' must not render the unrelated gallery')
        assert.strictEqual(measured.bodies.VideoCard || 0, 0, name + ' must not render unrelated video cards')
        assert.strictEqual(measured.bodies.Sidebar || 0, 0, name + ' must not render the unrelated sidebar')
      }
      assert.strictEqual(evidence.measurements.find(item => item.name === 'analysisWithSettings').bodies.Settings || 0, 0)
      const favorite = evidence.measurements.find(item => item.name === 'favorite')
      assert.ok(favorite.bodies.VideoCard > 0 && favorite.bodies.VideoCard <= 20, 'only the changed favorite card renders')
      assert.strictEqual(Object.keys(favorite.targets).length, 1)
    }
    const output = path.join(parent, baseline ? 'app-state-before.json' : 'app-state-after.json')
    await fsp.writeFile(output, JSON.stringify(evidence, null, 2))
    console.log('app state ' + (baseline ? 'baseline' : 'verification') + ' passed: ' + output)
    for (const item of evidence.measurements) console.log(item.name + ': ' + JSON.stringify({ bodies: item.bodies, durations: item.durations }))
  } finally {
    assert.strictEqual(path.dirname(path.resolve(fixture)), parent)
    await removeTempRootWithRetry(fixture)
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
