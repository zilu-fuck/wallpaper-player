const fs = require('fs')
const fsp = require('fs/promises')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const rootDir = path.join(__dirname, '..')
const releasePluginsDir = path.join(rootDir, 'release', 'plugins')
const officialPluginIds = ['video-analysis', 'ai-search', 'agent-bridge']

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
  await fsp.rm(targetProject, { recursive: true, force: true })
  await fsp.mkdir(targetProject, { recursive: true })
  for (const item of videoComprehensionItems) {
    const src = path.join(sourceProject, item)
    if (!fs.existsSync(src)) continue
    await fsp.cp(src, path.join(targetProject, item), { recursive: true })
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
  await fsp.rm(targetDir, { recursive: true, force: true })
  await fsp.mkdir(targetDir, { recursive: true })
  await fsp.cp(sourceDir, targetDir, {
    recursive: true,
    filter(source) {
      const name = path.basename(source)
      return name !== 'resources'
    }
  })
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
      await fsp.cp(src, path.join(resourcesDir, 'vendor', item), {
        recursive: true,
        filter(source) {
          const name = path.basename(source).toLowerCase()
          return name !== '_downloads' && !name.endsWith('.pdb')
        }
      })
    }
  }
}

function zipDirectory(sourceDir, outputZip) {
  execFileSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    '& { param($sourceDir, $outputZip) Compress-Archive -LiteralPath $sourceDir -DestinationPath $outputZip -Force }',
    sourceDir,
    outputZip
  ], { stdio: 'inherit' })
}

async function packagePlugin(pluginId) {
  const stageParent = await fsp.mkdtemp(path.join(os.tmpdir(), `wallpaper-player-${pluginId}-`))
  const pluginDir = path.join(stageParent, pluginId)
  try {
    await copyPluginSource(pluginId, pluginDir)
    if (pluginId === 'video-analysis') {
      await copyVideoAnalysisResources(pluginDir)
    }
    await fsp.mkdir(releasePluginsDir, { recursive: true })
    const manifest = JSON.parse(await fsp.readFile(path.join(pluginDir, 'plugin.json'), 'utf-8'))
    const outputZip = path.join(releasePluginsDir, `Wallpaper-Player-Plugin-${pluginId}-${manifest.version || '0.0.0'}.zip`)
    zipDirectory(pluginDir, outputZip)
    return outputZip
  } finally {
    await fsp.rm(stageParent, { recursive: true, force: true }).catch(() => {})
  }
}

async function main() {
  await fsp.rm(releasePluginsDir, { recursive: true, force: true })
  await fsp.mkdir(releasePluginsDir, { recursive: true })
  const outputs = []
  for (const pluginId of officialPluginIds) {
    outputs.push(await packagePlugin(pluginId))
  }
  console.log(`packaged plugins:\n${outputs.map(item => `- ${item}`).join('\n')}`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
