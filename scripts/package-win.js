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
  'main',
  'main.js',
  'mpv.js',
  'node_modules',
  'package-lock.json',
  'package.json',
  'preload.js',
  'scripts',
  'vendor',
  'vite.config.js'
]

async function copyProject() {
  await fsp.rm(tempRoot, { recursive: true, force: true })
  await fsp.mkdir(tempRoot, { recursive: true })

  for (const item of copyItems) {
    const src = path.join(rootDir, item)
    if (!fs.existsSync(src)) continue
    await fsp.cp(src, path.join(tempRoot, item), { recursive: true })
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

  await copyReleaseBack()
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
