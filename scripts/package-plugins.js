const fs = require('fs')
const fsp = require('fs/promises')
const crypto = require('crypto')
const path = require('path')
const io = require('./build-io.cjs')
const { publishOutput, readPointer } = require('./build-output.cjs')

const officialPluginIds = ['video-analysis', 'ai-search', 'agent-bridge']
const pluginDependencies = {
  'ai-search': ['playwright-core']
}

const videoComprehensionItems = [
  '.env.example',
  'docs',
  'pyproject.toml',
  'README.md',
  'uv.lock',
  'video_comprehension'
]

const requiredVideoComprehensionFiles = [
  'pyproject.toml',
  path.join('video_comprehension', 'cli.py'),
  path.join('video_comprehension', 'config.py'),
  path.join('video_comprehension', 'pipeline.py')
]

async function buildPluginSet({ rootDir, stageRoot: pluginStageRoot, outputDir: releasePluginsDir, integrityPath: integrityOutputPath, runCommand = io.run }) {
  if (io.key(await io.physicalPath(integrityOutputPath)) === io.key(await io.physicalPath(path.join(rootDir, 'main/plugins/official-package-integrity.json')))) throw new Error('plugin packaging cannot rewrite source integrity')
  for (const directory of [pluginStageRoot, releasePluginsDir]) {
    await io.noLinkedParents(directory)
    try { if ((await fsp.readdir(directory)).length) throw new Error('plugin build directory must be empty: ' + directory) } catch (error) { if (error.code !== 'ENOENT') throw error }
    await fsp.mkdir(directory, { recursive: true })
  }

  function getMissingVideoComprehensionFiles(projectDir) {
    return requiredVideoComprehensionFiles
      .map(item => path.join(projectDir, item))
      .filter(itemPath => !fs.existsSync(itemPath))
  }

  function hasCompleteVideoComprehensionProject(projectDir) {
    return getMissingVideoComprehensionFiles(projectDir).length === 0
  }

  function resolveVideoComprehensionSourceProject() {
    const candidates = [
      path.join(rootDir, 'video comprehension', 'video comprehension'),
      path.join(rootDir, 'main', 'video-comprehension-runtime')
    ]
    const sourceProject = candidates.find(hasCompleteVideoComprehensionProject)
    if (sourceProject) return sourceProject

    const missing = candidates.flatMap(candidate => getMissingVideoComprehensionFiles(candidate))
    throw new Error(`video comprehension project is incomplete:\n${missing.map(item => `- ${item}`).join('\n')}`)
  }

  async function copyVideoComprehensionProject(sourceProject, targetProject) {
    await fsp.mkdir(targetProject, { recursive: true })
    for (const item of videoComprehensionItems) {
      const src = path.join(sourceProject, item)
      if (!fs.existsSync(src)) continue
      await io.copyItem(src, path.join(targetProject, item))
    }
  }

  async function patchVideoComprehensionRuntime(projectDir) {
    const cliPath = path.join(projectDir, 'video_comprehension', 'cli.py')
    let cliText = await fsp.readFile(cliPath, 'utf-8')
    if (!cliText.includes('VIDEO_COMPREHENSION_ENV')) {
      cliText = cliText.replace('import argparse\nfrom pathlib import Path', 'import argparse\nimport os\nfrom pathlib import Path')
      cliText = cliText.replace(
        '    result = run_pipeline(load_request_from_env(Path(args.video_path)))',
        [
          '    env_path = Path(os.environ.get("VIDEO_COMPREHENSION_ENV") or ".env")',
          '    result = run_pipeline(load_request_from_env(Path(args.video_path), env_path=env_path))'
        ].join('\n')
      )
      await fsp.writeFile(cliPath, cliText, 'utf-8')
    }

    const configPath = path.join(projectDir, 'video_comprehension', 'config.py')
    let configText = await fsp.readFile(configPath, 'utf-8')
    if (!configText.includes('VIDEO_COMPREHENSION_OUTPUT_DIR')) {
      configText = configText.replace('from __future__ import annotations\n\nfrom dataclasses', 'from __future__ import annotations\n\nimport os\nfrom dataclasses')
      configText = configText.replace(
        '    yolo_model = resolve_model_path(model_storage_dir, DEFAULT_YOLO_MODEL)',
        [
          '    output_dir = resolve_config_path(os.environ.get("VIDEO_COMPREHENSION_OUTPUT_DIR") or str(DEFAULT_OUTPUT_DIR), env_path.parent)',
          '    yolo_model = resolve_model_path(model_storage_dir, DEFAULT_YOLO_MODEL)'
        ].join('\n')
      )
      configText = configText.replace('        output_dir=DEFAULT_OUTPUT_DIR,', '        output_dir=output_dir,')
      await fsp.writeFile(configPath, configText, 'utf-8')
    }
  }

  async function copyPluginSource(pluginId, targetDir) {
    const sourceDir = path.join(rootDir, 'main', 'plugins', pluginId)
    if (!fs.existsSync(path.join(sourceDir, 'plugin.json'))) {
      throw new Error(`missing plugin manifest: ${pluginId}`)
    }
    await io.copyItem(sourceDir, targetDir, { excludeNames: ['resources'] })
    for (const dependency of pluginDependencies[pluginId] || []) {
      const dependencyDir = path.join(rootDir, 'node_modules', dependency)
      if (!fs.existsSync(path.join(dependencyDir, 'package.json'))) {
        throw new Error(`missing plugin dependency: ${dependency}`)
      }
      await io.copyItem(dependencyDir, path.join(targetDir, 'node_modules', dependency))
    }
  }

  async function copyVideoAnalysisResources(pluginDir) {
    const resourcesDir = path.join(pluginDir, 'resources')
    const sourceProject = resolveVideoComprehensionSourceProject()
    const runtimeProject = path.join(resourcesDir, 'video-comprehension-runtime')
    const resourceProject = path.join(resourcesDir, 'video comprehension', 'video comprehension')
    await copyVideoComprehensionProject(sourceProject, runtimeProject)
    await patchVideoComprehensionRuntime(runtimeProject)
    await copyVideoComprehensionProject(sourceProject, resourceProject)
    await patchVideoComprehensionRuntime(resourceProject)

    for (const item of ['llama.cpp', 'llama.cpp-cuda']) {
      const src = path.join(rootDir, 'vendor', item)
      if (fs.existsSync(src)) {
        await io.copyItem(src, path.join(resourcesDir, 'vendor', item), { excludeNames: ['_downloads'], excludeFileExtensions: ['.pdb'] })
      }
    }
  }

  async function zipDirectory(sourceDir, outputZip) {
    await runCommand('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:WP_ZIP_SOURCE, $env:WP_ZIP_OUTPUT, [IO.Compression.CompressionLevel]::Optimal, $true)"],
    { env: { ...process.env, WP_ZIP_SOURCE: sourceDir, WP_ZIP_OUTPUT: outputZip } })
  }

  async function packagePlugin(pluginId) {
    await fsp.mkdir(pluginStageRoot, { recursive: true })
    const stageParent = await fsp.mkdtemp(path.join(pluginStageRoot, `wallpaper-player-${pluginId}-`))
    const pluginDir = path.join(stageParent, pluginId)
    await copyPluginSource(pluginId, pluginDir)
    if (pluginId === 'video-analysis') {
      await copyVideoAnalysisResources(pluginDir)
    }
    const payloadSha256 = await hashDirectorySha256(pluginDir)
    await fsp.mkdir(releasePluginsDir, { recursive: true })
    const manifest = JSON.parse(await fsp.readFile(path.join(pluginDir, 'plugin.json'), 'utf-8'))
    if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('invalid plugin version: ' + pluginId)
    const outputZip = path.join(releasePluginsDir, `Wallpaper-Player-Plugin-${pluginId}-${manifest.version || '0.0.0'}.zip`)
    await zipDirectory(pluginDir, outputZip)
    return {
      id: pluginId,
      version: manifest.version || '0.0.0',
      outputZip,
      sha256: await hashFileSha256(outputZip),
      payloadSha256
    }
  }

  const outputs = []
  for (const pluginId of officialPluginIds) outputs.push(await packagePlugin(pluginId))
  const integrity = { version: 1, packages: Object.fromEntries(outputs.map(item => [item.id, {
    version: item.version, sha256: item.sha256, payloadSha256: item.payloadSha256
  }])) }
  await io.atomicJson(integrityOutputPath, integrity)
  return { outputs, integrity }
}

function hashFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function hashDirectorySha256(directory) {
  const hash = crypto.createHash('sha256')

  async function visit(currentDir, relativeDir = '') {
    const entries = await fsp.readdir(currentDir, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      const relativePath = path.posix.join(relativeDir.replace(/\\/g, '/'), entry.name)
      const fullPath = path.join(currentDir, entry.name)
      if (entry.isDirectory()) {
        await visit(fullPath, relativePath)
      } else if (entry.isFile()) {
        hash.update(`file:${relativePath}\0`)
        await new Promise((resolve, reject) => {
          const stream = fs.createReadStream(fullPath)
          stream.on('error', reject)
          stream.on('data', chunk => hash.update(chunk))
          stream.on('end', resolve)
        })
        hash.update('\0')
      }
    }
  }

  await visit(directory)
  return hash.digest('hex')
}

async function packagePlugins({ rootDir = path.join(__dirname, '..'), buildBase = require('./package-win').resolveAsciiBuildRoot() } = {}) {
  await readPointer(rootDir, 'plugins', { optional: true })
  await io.noLinkedParents(path.join(rootDir, 'release'))
  const { stage, owner } = await io.createStage(buildBase, rootDir)
  try {
    const plugins = path.join(stage, 'plugins'), integrityPath = path.join(stage, 'official-package-integrity.json')
    await buildPluginSet({ rootDir, stageRoot: path.join(stage, 'payloads'), outputDir: plugins, integrityPath })
    const result = await publishOutput({ rootDir, kind: 'plugins', mode: 'plugins', version: JSON.parse(await fsp.readFile(path.join(rootDir, 'package.json'), 'utf8')).version,
      sourceCommit: process.env.GITHUB_SHA || null,
      populate: async directory => { await io.copyItem(plugins, path.join(directory, 'plugins')); await io.copyItem(integrityPath, path.join(directory, 'official-package-integrity.json')) },
      validate: validatePluginOutput })
    console.log('packaged plugins: ' + result.directory)
    await io.removeStage(stage, owner).catch(error => console.warn('Retained successful build stage: ' + stage + '\n' + error.message))
    return result
  } catch (error) { error.message += '\nBuild stage retained: ' + stage; throw error }
}

async function validatePluginOutput(directory) {
  const integrity = JSON.parse(await fsp.readFile(path.join(directory, 'official-package-integrity.json'), 'utf8'))
  if (integrity.version !== 1 || JSON.stringify(Object.keys(integrity.packages).sort()) !== JSON.stringify([...officialPluginIds].sort())) throw new Error('invalid plugin integrity inventory')
  for (const id of officialPluginIds) {
    const item = integrity.packages[id]
    if (!/^\d+\.\d+\.\d+$/.test(item.version) || !/^[a-f0-9]{64}$/.test(item.payloadSha256) || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('invalid plugin integrity entry: ' + id)
    const file = path.join(directory, 'plugins', `Wallpaper-Player-Plugin-${id}-${item.version}.zip`)
    if (await hashFileSha256(file) !== item.sha256) throw new Error('plugin archive differs from build integrity: ' + id)
  }
  return integrity
}

if (require.main === module) packagePlugins().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
module.exports = { buildPluginSet, packagePlugins, hashDirectorySha256, hashFileSha256, validatePluginOutput }
