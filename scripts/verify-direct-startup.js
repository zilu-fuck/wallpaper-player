const assert = require('assert')
const fs = require('fs')
const path = require('path')

const projectRoot = path.resolve(__dirname, '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'))
const launcher = fs.readFileSync(path.join(projectRoot, 'scripts', 'start-electron-direct.js'), 'utf-8')
const mainEntry = fs.readFileSync(path.join(projectRoot, 'main', 'index.js'), 'utf-8')
const packageWinSource = fs.readFileSync(path.join(projectRoot, 'scripts', 'package-win.js'), 'utf-8')
const releaseWorkflow = fs.readFileSync(path.join(projectRoot, '.github', 'workflows', 'release.yml'), 'utf-8')
const updaterSource = fs.readFileSync(path.join(projectRoot, 'main', 'updater.js'), 'utf-8')
const appSource = fs.readFileSync(path.join(projectRoot, 'src', 'App.jsx'), 'utf-8')
const settingsSource = fs.readFileSync(path.join(projectRoot, 'src', 'components', 'Settings.jsx'), 'utf-8')
const scanSource = fs.readFileSync(path.join(projectRoot, 'src', 'hooks', 'useScan.js'), 'utf-8')
const appStateSource = fs.readFileSync(path.join(projectRoot, 'src', 'hooks', 'useAppState.js'), 'utf-8')
const { configurePortableUserData, getPortableDataFallback } = require(path.join(projectRoot, 'main', 'portable-user-data'))
const { resolveAsciiBuildRoot } = require(path.join(projectRoot, 'scripts', 'package-win'))

assert.match(packageJson.scripts.start, /node scripts\/start-electron-direct\.js/)
assert.match(packageJson.scripts.rebuild, /node scripts\/start-electron-direct\.js/)
assert.strictEqual(packageJson.scripts['start:direct'], 'node scripts/start-electron-direct.js')
assert.match(launcher, /require\('electron'\)/)
assert.match(launcher, /detached:\s*true/)
assert.match(launcher, /child\.unref\(\)/)
assert.match(mainEntry, /requestSingleInstanceLock\(\)/)
assert.match(mainEntry, /app\.on\('second-instance'/)
assert.doesNotMatch(mainEntry, /\['Ctrl\+/)
assert.match(mainEntry, /MediaPlayPause/)
assert.match(appSource, /event\.ctrlKey \|\| event\.metaKey/)
assert.match(appSource, /arrowup:\s*\['volume-up', 5\]/)
assert.match(appSource, /scanErrorDir[\s\S]*onRetryScan/)
assert.match(settingsSource, /activeElement\.blur\(\)/)
assert.match(scanSource, /setScanErrorDir\(dirPath\)/)
assert.match(appStateSource, /setSettings\(previous\)/)
assert.match(appStateSource, /setSettingsSaveError/)
assert.match(releaseWorkflow, /release\/plugins/)
assert.match(updaterSource, /releases\/latest/)

const mainBuildBody = packageWinSource.slice(packageWinSource.indexOf('async function main()'))
assert.ok(mainBuildBody.indexOf('packagePlugins()') < mainBuildBody.indexOf('electronBuilderCli'))
assert.ok(mainBuildBody.indexOf('electronBuilderCli') < mainBuildBody.indexOf('copyReleaseBack()'))
assert.match(packageWinSource, /fsp\.cp\(pluginArtifactsDir/)
assert.throws(
  () => resolveAsciiBuildRoot(
    { WALLPAPER_PLAYER_BUILD_ROOT: 'C:\\构建目录' },
    { platform: 'win32', execPath: 'C:\\Program Files\\nodejs\\node.exe' }
  ),
  /ASCII/
)
assert.doesNotMatch(
  resolveAsciiBuildRoot({}, { platform: 'win32', execPath: 'C:\\Program Files\\nodejs\\node.exe' }),
  /[^\x20-\x7e]/
)

const tempRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'wallpaper-player-portable-user-data-'))
try {
  const writableEnv = { PORTABLE_EXECUTABLE_DIR: path.join(tempRoot, 'portable') }
  const writableApp = createFakeApp(path.join(tempRoot, 'system-user-data'))
  const writable = configurePortableUserData(writableApp, writableEnv)
  assert.strictEqual(writable.fallback, false)
  assert.strictEqual(writableApp.userDataPath, path.join(writableEnv.PORTABLE_EXECUTABLE_DIR, 'Data'))

  const fallbackEnv = { PORTABLE_EXECUTABLE_DIR: path.join(tempRoot, 'read-only') }
  const fallbackApp = createFakeApp(path.join(tempRoot, 'system-user-data'))
  const deniedFs = {
    mkdirSync() {
      throw Object.assign(new Error('access denied'), { code: 'EACCES' })
    }
  }
  const fallback = configurePortableUserData(fallbackApp, fallbackEnv, deniedFs)
  assert.strictEqual(fallback.fallback, true)
  assert.strictEqual(fallbackApp.userDataPath, path.join(tempRoot, 'system-user-data'))
  assert.strictEqual(getPortableDataFallback(fallbackEnv).requestedPath, path.join(fallbackEnv.PORTABLE_EXECUTABLE_DIR, 'Data'))
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}

console.log('direct startup verification passed')

function createFakeApp(defaultUserDataPath) {
  return {
    userDataPath: defaultUserDataPath,
    getPath(name) {
      assert.strictEqual(name, 'userData')
      return this.userDataPath
    },
    setPath(name, value) {
      assert.strictEqual(name, 'userData')
      this.userDataPath = value
    }
  }
}
