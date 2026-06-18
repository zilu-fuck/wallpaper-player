const fs = require('fs')
const fsp = require('fs/promises')
const https = require('https')
const path = require('path')
const { execFileSync } = require('child_process')

const vendorDir = path.join(__dirname, '..', 'vendor')
const downloadsDir = path.join(vendorDir, '_downloads')

const packages = [
  {
    name: 'mpv',
    url: 'https://github.com/mpv-player/mpv/releases/download/v0.41.0/mpv-v0.41.0-x86_64-pc-windows-msvc.zip',
    archive: 'mpv.zip',
    marker: path.join(vendorDir, 'mpv', 'mpv.exe'),
    targetDir: path.join(vendorDir, 'mpv'),
    exeName: 'mpv.exe'
  },
  {
    name: 'ffmpeg',
    url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
    archive: 'ffmpeg.zip',
    marker: path.join(vendorDir, 'ffmpeg', 'bin', 'ffmpeg.exe'),
    targetDir: path.join(vendorDir, 'ffmpeg'),
    exeName: 'ffmpeg.exe',
    keepBinLayout: true
  }
]

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true })
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (currentUrl, redirects) => {
      if (redirects > 8) {
        reject(new Error(`Too many redirects for ${url}`))
        return
      }

      const request = https.get(currentUrl, { headers: { 'User-Agent': 'wallpaper-player-build' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const nextUrl = new URL(res.headers.location, currentUrl).toString()
          res.resume()
          follow(nextUrl, redirects + 1)
          return
        }

        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error(`Download failed (${res.statusCode}) for ${currentUrl}`))
          return
        }

        const file = fs.createWriteStream(dest)
        res.pipe(file)
        file.on('finish', () => file.close(resolve))
        file.on('error', reject)
      })

      request.on('error', reject)
    }

    follow(url, 0)
  })
}

async function downloadWithPowerShell(url, dest) {
  execFileSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `$ProgressPreference = 'SilentlyContinue'; Invoke-WebRequest -Uri '${url.replace(/'/g, "''")}' -OutFile '${dest.replace(/'/g, "''")}' -UseBasicParsing`
  ], { stdio: 'inherit' })
}

async function extractZip(archivePath, targetDir) {
  await ensureDir(targetDir)
  execFileSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${targetDir.replace(/'/g, "''")}' -Force`
  ], { stdio: 'inherit' })
}

async function findFile(dir, fileName, depth = 0) {
  if (depth > 5) return null

  const entries = await fsp.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
      return fullPath
    }
    if (entry.isDirectory()) {
      const found = await findFile(fullPath, fileName, depth + 1)
      if (found) return found
    }
  }

  return null
}

async function copyDirectory(src, dest) {
  await fsp.rm(dest, { recursive: true, force: true })
  await fsp.mkdir(dest, { recursive: true })
  await fsp.cp(src, dest, { recursive: true })
}

async function preparePackage(pkg) {
  if (fs.existsSync(pkg.marker)) {
    console.log(`[vendor] ${pkg.name} already exists`)
    return
  }

  await ensureDir(downloadsDir)
  const archivePath = path.join(downloadsDir, pkg.archive)
  const extractDir = path.join(downloadsDir, `${pkg.name}-extract`)

  if (!fs.existsSync(archivePath)) {
    console.log(`[vendor] downloading ${pkg.name}`)
    try {
      await downloadWithPowerShell(pkg.url, archivePath)
    } catch {
      await downloadFile(pkg.url, archivePath)
    }
  }

  console.log(`[vendor] extracting ${pkg.name}`)
  await fsp.rm(extractDir, { recursive: true, force: true })
  await extractZip(archivePath, extractDir)

  const exePath = await findFile(extractDir, pkg.exeName)
  if (!exePath) {
    throw new Error(`Could not find ${pkg.exeName} in ${pkg.archive}`)
  }

  const sourceRoot = pkg.keepBinLayout
    ? path.dirname(path.dirname(exePath))
    : path.dirname(exePath)

  await copyDirectory(sourceRoot, pkg.targetDir)
  await fsp.rm(extractDir, { recursive: true, force: true })
  console.log(`[vendor] ready: ${pkg.name}`)
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('Bundled mpv/FFmpeg preparation is configured for Windows builds only.')
  }

  for (const pkg of packages) {
    await preparePackage(pkg)
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
