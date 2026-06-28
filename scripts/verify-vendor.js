const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const rootDir = path.join(__dirname, '..')

const requiredFiles = [
  'THIRD_PARTY_NOTICES.md',
  path.join('licenses', 'mpv-GPL-2.0-or-later.txt'),
  path.join('licenses', 'aria2-GPL-2.0-or-later.txt'),
  path.join('licenses', 'yt-dlp-Unlicense.txt'),
  path.join('licenses', 'ffmpeg-GPL-3.0.txt'),
  path.join('licenses', 'dependency-notices.txt'),
  path.join('sources', 'mpv-source-information.txt'),
  path.join('sources', 'aria2-source-information.txt'),
  path.join('sources', 'yt-dlp-source-information.txt'),
  path.join('sources', 'ffmpeg-source-information.txt'),
  path.join('vendor', 'mpv', 'mpv.exe'),
  path.join('vendor', 'aria2', 'aria2c.exe'),
  path.join('vendor', 'yt-dlp', 'yt-dlp.exe'),
  path.join('vendor', 'ffmpeg', 'bin', 'ffmpeg.exe')
]

function resolveRoot(...segments) {
  return path.join(rootDir, ...segments)
}

function assertFilesExist() {
  const missing = requiredFiles.filter(file => !fs.existsSync(resolveRoot(file)))
  if (missing.length > 0) {
    throw new Error(`Vendor verification is missing required files:\n${missing.map(file => `- ${file}`).join('\n')}`)
  }
}

function runVersionCommand(exePath, args) {
  const result = spawnSync(exePath, args, {
    cwd: rootDir,
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true
  })

  if (result.error) {
    throw result.error
  }

  return `${result.stdout || ''}\n${result.stderr || ''}`
}

function assertOutputIncludes(name, output, expectedParts) {
  const missing = expectedParts.filter(part => !output.includes(part))
  if (missing.length > 0) {
    throw new Error(`${name} version output did not match bundled license metadata:\n${missing.map(part => `- ${part}`).join('\n')}`)
  }
}

function validateMpv() {
  const output = runVersionCommand(resolveRoot('vendor', 'mpv', 'mpv.exe'), ['--version'])
  assertOutputIncludes('mpv', output, [
    'mpv v0.41.0',
    '41f6a6450'
  ])
}

function validateFfmpeg() {
  const output = runVersionCommand(resolveRoot('vendor', 'ffmpeg', 'bin', 'ffmpeg.exe'), ['-version'])
  assertOutputIncludes('FFmpeg', output, [
    'ffmpeg version 8.1.1-essentials_build-www.gyan.dev',
    '--enable-gpl',
    '--enable-version3',
    '--enable-static',
    '--enable-libx264',
    '--enable-libx265'
  ])
}

function validateAria2() {
  const output = runVersionCommand(resolveRoot('vendor', 'aria2', 'aria2c.exe'), ['--version'])
  assertOutputIncludes('aria2', output, [
    'aria2 version 1.37.0',
    'GNU General Public License',
    'either version 2 of the License'
  ])
}

function validateYtDlp() {
  const output = runVersionCommand(resolveRoot('vendor', 'yt-dlp', 'yt-dlp.exe'), ['--version'])
  assertOutputIncludes('yt-dlp', output, [
    '2026.06.09'
  ])
}

function verifyVendor() {
  assertFilesExist()
  validateMpv()
  validateAria2()
  validateYtDlp()
  validateFfmpeg()
}

if (require.main === module) {
  try {
    verifyVendor()
    console.log('Vendor verification passed')
  } catch (err) {
    console.error(err)
    process.exitCode = 1
  }
}

module.exports = {
  verifyVendor
}
