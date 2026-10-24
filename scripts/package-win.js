const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const io = require('./build-io.cjs')
const { publishOutput, readPointer } = require('./build-output.cjs')
const { buildPluginSet, validatePluginOutput } = require('./package-plugins.js')

const copyItems = ['.npmrc', 'build', 'dist', 'index.html', 'LICENSE', 'licenses', 'main', 'main.js', 'node_modules',
  'package-lock.json', 'package.json', 'packages', 'preload.js', 'scripts', 'sources', 'THIRD_PARTY_NOTICES.md', 'vendor', 'vite.config.js']
const copyOptions = {
  node_modules: { excludeNames: ['wallpaper-player'] },
  main: { excludePaths: ['plugins/video-analysis', 'plugins/ai-search', 'plugins/agent-bridge', 'video-comprehension-runtime'] },
  vendor: { excludePaths: ['_downloads', 'llama.cpp', 'llama.cpp-cuda'], excludeFileExtensions: ['.pdb'] }
}
function resolveAsciiBuildRoot(env = process.env, options = {}) {
  const platform = options.platform || process.platform, execPath = options.execPath || process.execPath
  const defaultBase = platform === 'win32' ? path.join(path.parse(execPath).root, 'wp-build') : path.join(path.parse(execPath).root, 'tmp', 'wp-build')
  const buildRoot = path.resolve(String(env.WALLPAPER_PLAYER_BUILD_ROOT || '').trim() || defaultBase, 'wallpaper-player-build')
  if (/[^\x20-\x7e]/.test(buildRoot)) throw new Error('Windows build directory must be ASCII; set WALLPAPER_PLAYER_BUILD_ROOT to a writable ASCII directory')
  return buildRoot
}
async function validateWindowsOutput(directory, { version, mode, sourceCommit, inspectVersion } = {}) {
  const integrity = await validatePluginOutput(directory)
  const asar = require('@electron/asar')
  const archive = path.join(directory, 'win-unpacked', 'resources', 'app.asar')
  const embedded = JSON.parse(asar.extractFile(archive, path.join('main', 'plugins', 'official-package-integrity.json')).toString('utf8'))
  if (JSON.stringify(embedded) !== JSON.stringify(integrity)) throw new Error('packaged app integrity differs from companion plugins')
  const manifest = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'))
  if (manifest.version !== version) throw new Error('packaged app version differs from build version')
  const entries = asar.listPackage(archive).map(item => item.replace(/\\/g, '/'))
  if (entries.some(item => /^\/main\/(?:plugins\/(?:video-analysis|ai-search|agent-bridge)(?:\/|$)|video-comprehension-runtime(?:\/|$))/.test(item))) throw new Error('official plugin payload leaked into core app')
  if (mode === 'distribution') await require('./release-gate.cjs').collectWindows({ directory, version, sourceCommit, integrity, ...(inspectVersion ? { inspectVersion } : {}) })
  return integrity
}
async function packageWindows({ rootDir = path.resolve(__dirname, '..'), buildBase = resolveAsciiBuildRoot(), mode = 'distribution',
  runCommand = io.run, buildPlugins = buildPluginSet, validate = validateWindowsOutput, beforePointer } = {}) {
  if (!['directory', 'distribution'].includes(mode)) throw new Error('invalid Windows build mode')
  if (process.env.ELECTRON_PUBLISH && process.env.ELECTRON_PUBLISH !== 'never') throw new Error('local packaging cannot publish; use the release workflow')
  const manifest = JSON.parse(await fsp.readFile(path.join(rootDir, 'package.json'), 'utf8'))
  if (manifest.build?.directories?.output !== 'release') throw new Error('Windows build output must be the isolated release directory')
  await readPointer(rootDir, 'windows', { optional: true })
  await io.noLinkedParents(path.join(rootDir, 'release'))
  const { stage, owner } = await io.createStage(buildBase, rootDir)
  console.log('Windows build stage: ' + stage)
  try {
    for (const item of copyItems) if (fs.existsSync(path.join(rootDir, item))) await io.copyItem(path.join(rootDir, item), path.join(stage, item), copyOptions[item])
    const plugins = path.join(stage, 'plugin-artifacts'), integrityPath = path.join(stage, 'main/plugins/official-package-integrity.json')
    await buildPlugins({ rootDir, stageRoot: path.join(stage, 'plugin-stage'), outputDir: plugins, integrityPath })
    await runCommand(process.execPath, [path.join(stage, 'node_modules/electron-builder/cli.js'), mode === 'directory' ? '--dir' : '--win', '--x64', '--publish', 'never'], {
      cwd: stage, env: { ...process.env, ELECTRON_BUILDER_BINARIES_MIRROR: process.env.ELECTRON_BUILDER_BINARIES_MIRROR || 'https://npmmirror.com/mirrors/electron-builder-binaries/' }
    })
    const sourceCommit = process.env.GITHUB_SHA || null
    const result = await publishOutput({ rootDir, kind: 'windows', version: manifest.version, mode, sourceCommit, beforePointer,
      populate: async directory => {
        for (const child of await fsp.readdir(path.join(stage, 'release'))) await io.copyItem(path.join(stage, 'release', child), path.join(directory, child))
        await io.copyItem(plugins, path.join(directory, 'plugins'))
        await io.copyItem(integrityPath, path.join(directory, 'official-package-integrity.json'))
      },
      validate: directory => validate(directory, { version: manifest.version, mode, sourceCommit }) })
    console.log('Windows build output: ' + result.directory)
    await io.removeStage(stage, owner).catch(error => console.warn('Retained successful build stage: ' + stage + '\n' + error.message))
    return result
  } catch (error) { error.message += '\nBuild stage retained: ' + stage; throw error }
}
if (require.main === module) packageWindows({ mode: process.argv.includes('--dir') ? 'directory' : 'distribution' }).catch(error => { console.error(error); process.exitCode = 1 })
module.exports = { resolveAsciiBuildRoot, packageWindows, validateWindowsOutput }
