const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { createHash } = require('crypto')
const root = path.resolve(__dirname, '..')
const mobile = path.join(root, 'mobile')
const cli = path.join(mobile, 'node_modules/expo/bin/cli')
const reactVersion = require(path.join(mobile, 'node_modules/react/package.json')).version
const results = []
const testRoot = path.join(root, '.tmp/refactor-tests')
const evidenceDirectory = process.env.WALLPAPER_BUNDLE_OUTPUT_DIR ? path.resolve(process.env.WALLPAPER_BUNDLE_OUTPUT_DIR) : testRoot
assert.ok(evidenceDirectory === testRoot || evidenceDirectory.startsWith(testRoot + path.sep), 'bundle evidence must remain inside refactor-tests')
const hash = value => createHash('sha256').update(value).digest('hex')
async function verifyPlatform(platform) {
  const output = path.join(evidenceDirectory, 'contracts-' + platform + '-bundle')
  assert.ok(output.startsWith(path.join(root, '.tmp/refactor-tests') + path.sep))
  if (!process.argv.includes('--inspect-only')) {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, 'export', '--platform', platform, '--output-dir', output,
        '--max-workers', '2', '--source-maps', 'external'], { cwd: mobile, env: { ...process.env, CI: '1' }, stdio: 'inherit', windowsHide: true })
      child.once('error', reject)
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(platform + ' Metro export exited ' + code)))
    })
  }
  const metadata = JSON.parse(fs.readFileSync(path.join(output, 'metadata.json'), 'utf8'))
  const bundle = path.join(output, metadata.fileMetadata[platform].bundle)
  const bytes = fs.readFileSync(bundle)
  assert.strictEqual(bytes.subarray(0, 8).toString('hex'), 'c61fbc03c103191f', 'export must produce Hermes bytecode')
  const map = JSON.parse(fs.readFileSync(bundle + '.map', 'utf8'))
  const buildOnlyAdvisories = ['braces', 'node-forge']
  for (const name of buildOnlyAdvisories) {
    assert.ok(!map.sources.some(source => ('/' + source.replace(/\\/g, '/')).includes('/node_modules/' + name + '/')),
      platform + ' must not ship the unresolved build-tool advisory package ' + name)
  }
  for (const file of ['contracts/dist/index.js', 'contracts/dist/schema.js', 'contracts/dist/settings-feed.js', 'domain/dist/index.js']) {
    const source = map.sources.findIndex(name => name.replace(/\\/g, '/').endsWith('/packages/' + file))
    assert.ok(source >= 0, platform + ' bundle must contain the shared contract runtime')
    assert.strictEqual(hash(map.sourcesContent[source]), hash(fs.readFileSync(path.join(root, 'packages', file), 'utf8')),
      platform + ' bundle must contain the current generated contract')
  }
  for (const file of ['App.tsx', 'src/AppNavigator.tsx', 'src/services/api.ts', 'src/services/library-repository.ts',
    'src/persistence/library-pages.ts', 'src/screens/LibraryScreen.tsx', 'src/screens/PlayerScreen.tsx',
    'src/services/task-observer.ts', 'src/services/navigation-store.ts', 'src/services/orientation.ts',
    'src/services/playback-adapter.ts', 'src/components/player/VideoAnalysisSheet.tsx',
    'src/hooks/useAdaptiveVideoGrid.ts', 'src/components/AccessibleModal.tsx', 'src/components/VideoCard.tsx',
    'src/components/PrimaryButton.tsx', 'src/theme.ts', 'src/screens/SearchScreen.tsx',
    'src/hooks/useAccessibilityPreferences.ts', 'src/components/DeviceCard.tsx', 'src/screens/DeviceListScreen.tsx',
    'src/screens/PairDeviceScreen.tsx', 'src/components/player/PlaybackProgress.tsx',
    'src/components/player/PlayerControls.tsx', 'src/components/player/VideoOverlay.tsx',
    'src/hooks/usePlayerSheet.ts', 'src/hooks/useTagEditorDraft.ts', 'src/components/player/PlayerSheetFrame.tsx',
    'src/components/player/PlayerMoreSheet.tsx', 'src/components/player/TagEditorSheet.tsx', 'src/components/player/VideoActionBar.tsx',
    'src/components/MobileUpdateCard.tsx', 'src/services/updates.ts', 'src/services/update-environment.ts',
    'src/services/update-manifest.ts', 'src/services/update-server-context.ts', 'src/services/active-device-context.ts', 'src/theme-context.tsx']) {
    const source = map.sources.findIndex(name => name.replace(/\\/g, '/').endsWith('/' + file))
    assert.ok(source >= 0, platform + ' bundle must contain the production mobile module: ' + file)
    assert.strictEqual(hash(map.sourcesContent[source]), hash(fs.readFileSync(path.join(mobile, file), 'utf8')),
      platform + ' bundle must contain the current mobile module: ' + file)
  }
  const reactSources = map.sources.map((name, index) => ({ name: name.replace(/\\/g, '/'), index }))
    .filter(item => item.name.endsWith('/react/cjs/react.production.js'))
  assert.strictEqual(reactSources.length, 1, 'mobile must bundle one React runtime')
  assert.ok(map.sourcesContent[reactSources[0].index].includes(reactVersion), 'mobile must use its pinned React version')
  results.push({ platform, bytes: bytes.length, modules: map.sources.length, reactVersion, sharedContracts: true, excludedBuildOnlyAdvisories: buildOnlyAdvisories })
}
(async () => {
  const selected = process.argv.find(arg => arg.startsWith('--platform='))?.split('=')[1]
  if (selected) assert.ok(['android', 'ios'].includes(selected))
  for (const platform of selected ? [selected] : ['android', 'ios']) await verifyPlatform(platform)
  fs.writeFileSync(path.join(evidenceDirectory, 'contracts-bundles-evidence.json'), JSON.stringify(results, null, 2))
  console.log('Mobile bundle verification passed: ' + JSON.stringify(results))
})().catch(error => { console.error(error); process.exitCode = 1 })
