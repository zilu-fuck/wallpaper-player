const fs = require('fs')
const fsp = require('fs/promises')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const rootDir = path.join(__dirname, '..')
const tempRoot = path.join(os.tmpdir(), 'wallpaper-player-build')
const mirror = 'https://npmmirror.com/mirrors/electron-builder-binaries/'

const copyItems = [
  '.npmrc',
  'build',
  'dist',
  'index.html',
  'LICENSE',
  'licenses',
  'main',
  'main.js',
  'mpv.js',
  'node_modules',
  'package-lock.json',
  'package.json',
  'preload.js',
  'scripts',
  'sources',
  'THIRD_PARTY_NOTICES.md',
  'vendor',
  'vite.config.js'
]

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

async function assertVideoComprehensionProject(projectDir) {
  const missing = requiredVideoComprehensionFiles
    .map(item => path.join(projectDir, item))
    .filter(itemPath => !fs.existsSync(itemPath))

  if (missing.length) {
    throw new Error(`video comprehension project is incomplete:\n${missing.map(item => `- ${item}`).join('\n')}`)
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

async function copyProject() {
  await fsp.rm(tempRoot, { recursive: true, force: true })
  await fsp.mkdir(tempRoot, { recursive: true })

  for (const item of copyItems) {
    const src = path.join(rootDir, item)
    if (!fs.existsSync(src)) continue
    await fsp.cp(src, path.join(tempRoot, item), { recursive: true })
  }

  const sourceProject = path.join(rootDir, 'video comprehension', 'video comprehension')
  await assertVideoComprehensionProject(sourceProject)
  const bundledProject = path.join(tempRoot, 'main', 'video-comprehension-runtime')
  await fsp.rm(bundledProject, { recursive: true, force: true })
  await fsp.mkdir(bundledProject, { recursive: true })
  for (const item of videoComprehensionItems) {
    const src = path.join(sourceProject, item)
    if (!fs.existsSync(src)) continue
    await fsp.cp(src, path.join(bundledProject, item), { recursive: true })
  }
  await assertVideoComprehensionProject(bundledProject)
  await patchVideoComprehensionRuntime(bundledProject)
  await assertVideoComprehensionProject(bundledProject)

  if (fs.existsSync(sourceProject)) {
    const targetProject = path.join(tempRoot, 'video comprehension', 'video comprehension')
    await fsp.mkdir(targetProject, { recursive: true })
    for (const item of videoComprehensionItems) {
      const src = path.join(sourceProject, item)
      if (!fs.existsSync(src)) continue
      await fsp.cp(src, path.join(targetProject, item), { recursive: true })
    }
    await assertVideoComprehensionProject(targetProject)
    await patchVideoComprehensionRuntime(targetProject)
    await assertVideoComprehensionProject(targetProject)
  }
}

async function copyReleaseBack() {
  const sourceRelease = path.join(tempRoot, 'release')
  const targetRelease = path.join(rootDir, 'release')

  if (!fs.existsSync(sourceRelease)) {
    throw new Error('electron-builder did not create a release directory')
  }

  await fsp.rm(targetRelease, { recursive: true, force: true })
  await fsp.cp(sourceRelease, targetRelease, { recursive: true })
}

async function main() {
  await copyProject()

  const electronBuilderCli = path.join(tempRoot, 'node_modules', 'electron-builder', 'cli.js')
  const publishMode = process.env.ELECTRON_PUBLISH || 'never'

  execFileSync(process.execPath, [electronBuilderCli, '--win', '--publish', publishMode], {
    cwd: tempRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_BUILDER_BINARIES_MIRROR: process.env.ELECTRON_BUILDER_BINARIES_MIRROR || mirror
    }
  })

  await assertVideoComprehensionProject(path.join(tempRoot, 'release', 'win-unpacked', 'resources', 'video comprehension', 'video comprehension'))

  await copyReleaseBack()
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
