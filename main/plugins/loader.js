const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const crypto = require('crypto')
const os = require('os')
const { app } = require('electron')
const { isPathInside, pathKey } = require('../paths')
const { MANIFEST_FILE, normalizeManifest } = require('./manifest')
const { officialPluginIds, isOfficialPluginId, getOfficialPackageIntegrity } = require('./official')
const { execFileAsync } = require('../exec')
const { getUserDataDir } = require('../user-data')

const OFFICIAL_PACKAGE_MARKER = '.official-package.json'

function getExternalPluginsDir() {
  return path.join(getUserDataDir(), 'plugins')
}

async function ensureExternalPluginsDir() {
  const pluginsDir = getExternalPluginsDir()
  await fsp.mkdir(pluginsDir, { recursive: true })
  return pluginsDir
}

function getSourceOfficialPluginDir(pluginId) {
  return path.join(__dirname, pluginId)
}

function getDevOfficialPluginDirs() {
  if (app?.isPackaged) return []
  return officialPluginIds
    .map(pluginId => getSourceOfficialPluginDir(pluginId))
    .filter(pluginDir => fs.existsSync(path.join(pluginDir, MANIFEST_FILE)))
}

function getManifestPath(inputPath) {
  const resolved = path.resolve(inputPath)
  if (path.basename(resolved).toLowerCase() === MANIFEST_FILE) return resolved
  return path.join(resolved, MANIFEST_FILE)
}

async function readJsonFile(filePath) {
  const raw = await fsp.readFile(filePath, 'utf-8')
  return JSON.parse(raw.replace(/^\uFEFF/, ''))
}

function assertOfficialPackageIntegrity(manifest, options = {}) {
  const expected = getOfficialPackageIntegrity(manifest.id)
  const packageSha256 = String(options.officialPackageSha256 || '').trim().toLowerCase()
  const payloadSha256 = String(options.officialPayloadSha256 || '').trim().toLowerCase()
  const packageMatches = Boolean(packageSha256 && expected?.sha256 === packageSha256)
  const payloadMatches = Boolean(payloadSha256 && expected?.payloadSha256 === payloadSha256)
  if (!packageMatches && !payloadMatches) {
    throw new Error('官方插件包校验失败，请从项目 GitHub Releases 重新下载')
  }
  if (expected.version && manifest.version !== expected.version) {
    throw new Error('官方插件包版本与校验清单不一致')
  }
  return expected
}

function stampManifestSource(manifest, options = {}) {
  if (isOfficialPluginId(manifest.id) && manifest.publisher !== 'official') {
    throw new Error('第三方插件不能使用官方插件 ID')
  }
  const official = isOfficialPluginId(manifest.id) && manifest.publisher === 'official'
  if (official) assertOfficialPackageIntegrity(manifest, options)
  manifest.source = official ? 'official' : 'user'
  manifest.publisher = official ? 'official' : 'third-party'
  manifest.trusted = official
  manifest.executable = official
  return manifest
}

async function readManifestFromPath(inputPath, options = {}) {
  const manifestPath = getManifestPath(inputPath)
  const manifest = normalizeManifest(await readJsonFile(manifestPath), {
    ...options,
    location: path.dirname(manifestPath)
  })
  if (!options.publisher && !options.source) {
    let officialPackageSha256 = options.officialPackageSha256
    let officialPayloadSha256 = options.officialPayloadSha256
    let migratedOfficialPackage = false
    if (!officialPackageSha256 && isOfficialPluginId(manifest.id)) {
      const markerPath = path.join(path.dirname(manifestPath), OFFICIAL_PACKAGE_MARKER)
      const marker = await readJsonFile(markerPath).catch(() => null)
      officialPayloadSha256 = await hashDirectorySha256(path.dirname(manifestPath))
      migratedOfficialPackage = !marker
    }
    stampManifestSource(manifest, { officialPackageSha256, officialPayloadSha256 })
    if (migratedOfficialPackage && manifest.source === 'official') {
      await fsp.writeFile(path.join(path.dirname(manifestPath), OFFICIAL_PACKAGE_MARKER), JSON.stringify({
        id: manifest.id,
        version: manifest.version,
        payloadSha256: officialPayloadSha256
      }, null, 2), 'utf-8').catch(() => {})
    }
  }
  return {
    manifest,
    manifestPath
  }
}

function createInvalidPlugin(entryName, error, location) {
  const safeId = `invalid.${crypto
    .createHash('sha256')
    .update(entryName)
    .digest('hex')
    .slice(0, 12)}`
  return {
    id: safeId,
    name: entryName,
    version: '',
    description: '',
    source: 'user',
    publisher: 'third-party',
    external: true,
    trusted: false,
    executable: false,
    enabled: false,
    status: 'error',
    loadError: true,
    lastError: error?.message || String(error),
    location,
    installDirectoryName: entryName,
    permissions: [],
    settingsDefaults: {},
    settingsSchema: {},
    contributions: { remoteRoutes: [] }
  }
}

async function listExternalPluginManifests() {
  const pluginsDir = await ensureExternalPluginsDir()
  const entries = await fsp.readdir(pluginsDir, { withFileTypes: true }).catch(() => [])
  const manifests = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.')) continue
    const pluginDir = path.join(pluginsDir, entry.name)
    try {
      const { manifest } = await readManifestFromPath(pluginDir)
      manifest.installDirectoryName = entry.name
      manifests.push(manifest)
    } catch (error) {
      manifests.push(createInvalidPlugin(entry.name, error, pluginDir))
    }
  }

  for (const pluginDir of getDevOfficialPluginDirs()) {
    try {
      const { manifest } = await readManifestFromPath(pluginDir, {
        source: 'official',
        publisher: 'official',
        executable: true
      })
      if (!manifests.some(item => item.id === manifest.id)) {
        manifests.push(manifest)
      }
    } catch {}
  }

  return manifests
}

async function resolveRealPathIfExists(inputPath) {
  try {
    return await fsp.realpath(inputPath)
  } catch {
    return path.resolve(inputPath)
  }
}

async function assertSafeInstallSource(sourcePath, pluginsDir) {
  const source = path.resolve(sourcePath)
  const targetRoot = path.resolve(pluginsDir)
  const sourceRealPath = await resolveRealPathIfExists(source)
  const targetRootRealPath = await resolveRealPathIfExists(targetRoot)
  const insideByPath = pathKey(source) === pathKey(targetRoot) || isPathInside(targetRoot, source)
  const insideByRealPath = pathKey(sourceRealPath) === pathKey(targetRootRealPath) || isPathInside(targetRootRealPath, sourceRealPath)
  if (insideByPath || insideByRealPath) {
    throw new Error('Cannot install a plugin from the managed plugins directory')
  }
  return source
}

async function extractZipToTemp(sourceZip) {
  const extractDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wallpaper-player-plugin-'))
  await execFileAsync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    '& { param($sourceZip, $extractDir) Expand-Archive -LiteralPath $sourceZip -DestinationPath $extractDir -Force }',
    sourceZip,
    extractDir
  ], { windowsHide: true })
  return extractDir
}

async function pathExists(filePath) {
  try {
    await fsp.access(filePath)
    return true
  } catch {
    return false
  }
}

async function findPluginRoot(extractedDir) {
  if (await pathExists(path.join(extractedDir, MANIFEST_FILE))) {
    return extractedDir
  }
  const entries = await fsp.readdir(extractedDir, { withFileTypes: true }).catch(() => [])
  const candidates = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const candidate = path.join(extractedDir, entry.name)
    if (await pathExists(path.join(candidate, MANIFEST_FILE))) {
      candidates.push(candidate)
    }
  }
  if (candidates.length === 1) return candidates[0]
  throw new Error('插件包内未找到唯一的 plugin.json')
}

async function copyPluginDirectory(sourceDir, targetDir) {
  await fsp.rm(targetDir, { recursive: true, force: true })
  await fsp.mkdir(targetDir, { recursive: true })
  const entries = await fsp.readdir(sourceDir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === OFFICIAL_PACKAGE_MARKER) continue
    const source = path.join(sourceDir, entry.name)
    const target = path.join(targetDir, entry.name)
    if (entry.isDirectory()) {
      await copyPluginDirectory(source, target)
    } else if (entry.isFile()) {
      await fsp.copyFile(source, target)
    }
  }
}

async function readInstallManifest(source, options = {}) {
  return readManifestFromPath(source, {
    officialPackageSha256: options.officialPackageSha256,
    officialPayloadSha256: options.officialPayloadSha256
  })
}

async function createTempInstallDir(pluginsDir, pluginId, suffix) {
  const safeSuffix = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  return path.join(pluginsDir, `.${pluginId}.${suffix}-${safeSuffix}`)
}

async function restoreBackupDirectory(targetDir, backupDir, installedReplacement) {
  if (!backupDir || !(await pathExists(backupDir))) {
    if (installedReplacement) {
      await fsp.rm(targetDir, { recursive: true, force: true }).catch(() => {})
    }
    return
  }
  if (installedReplacement) {
    await fsp.rm(targetDir, { recursive: true, force: true }).catch(() => {})
  }
  if (!(await pathExists(targetDir))) {
    await fsp.rename(backupDir, targetDir).catch(() => {})
  }
}

async function installPreparedPlugin(source, options = {}) {
  const pluginsDir = await ensureExternalPluginsDir()
  const { manifest, manifestPath } = await readInstallManifest(source, options)
  const sourceDir = path.dirname(manifestPath)
  const targetDir = path.resolve(pluginsDir, manifest.id)
  if (!isPathInside(pluginsDir, targetDir)) {
    throw new Error('Invalid plugin id')
  }

  const stageDir = await createTempInstallDir(pluginsDir, manifest.id, 'install')
  let backupDir = ''
  let targetMoved = false
  let installedReplacement = false
  let finalized = false

  try {
    await copyPluginDirectory(sourceDir, stageDir)
    const { manifest: stagedManifest } = await readInstallManifest(stageDir, options)
    if (stagedManifest.id !== manifest.id) {
      throw new Error('Installed plugin manifest id changed during copy')
    }
    if (stagedManifest.source === 'official') {
      await fsp.writeFile(path.join(stageDir, OFFICIAL_PACKAGE_MARKER), JSON.stringify({
        id: stagedManifest.id,
        version: stagedManifest.version,
        sha256: options.officialPackageSha256,
        payloadSha256: getOfficialPackageIntegrity(stagedManifest.id)?.payloadSha256 || ''
      }, null, 2), 'utf-8')
    }

    if (await pathExists(targetDir)) {
      backupDir = await createTempInstallDir(pluginsDir, manifest.id, 'backup')
      await fsp.rename(targetDir, backupDir)
      targetMoved = true
    }

    await fsp.rename(stageDir, targetDir)
    installedReplacement = true

    const { manifest: installedManifest } = await readInstallManifest(targetDir)
    installedManifest.installDirectoryName = manifest.id
    return {
      manifest: installedManifest,
      async commit() {
        if (finalized) return
        if (backupDir) {
          await fsp.rm(backupDir, { recursive: true, force: true })
        }
        finalized = true
      },
      async rollback() {
        if (finalized) return
        await restoreBackupDirectory(targetDir, backupDir, installedReplacement)
        finalized = true
      }
    }
  } catch (error) {
    if (targetMoved) {
      await restoreBackupDirectory(targetDir, backupDir, installedReplacement)
    }
    await fsp.rm(stageDir, { recursive: true, force: true }).catch(() => {})
    if (backupDir && !targetMoved) {
      await fsp.rm(backupDir, { recursive: true, force: true }).catch(() => {})
    }
    throw error
  }
}

async function installExternalPlugin(sourcePath) {
  const pluginsDir = await ensureExternalPluginsDir()
  const source = await assertSafeInstallSource(sourcePath, pluginsDir)
  let extractedDir = ''
  try {
    const stats = await fsp.stat(source)
    if (stats.isFile() && path.extname(source).toLowerCase() === '.zip') {
      const packageSha256 = await hashFileSha256(source)
      extractedDir = await extractZipToTemp(source)
      return await installPreparedPlugin(await findPluginRoot(extractedDir), {
        officialPackageSha256: packageSha256
      })
    }
    return await installPreparedPlugin(source)
  } finally {
    if (extractedDir) {
      await fsp.rm(extractedDir, { recursive: true, force: true }).catch(() => {})
    }
  }
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
      if (entry.name === OFFICIAL_PACKAGE_MARKER) continue
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

async function uninstallExternalPlugin(pluginId, options = {}) {
  const pluginsDir = await ensureExternalPluginsDir()
  const id = String(options.directoryName || pluginId || '').trim().toLowerCase()
  const targetDir = path.resolve(pluginsDir, id)
  if (!isPathInside(pluginsDir, targetDir)) {
    throw new Error('Invalid plugin id')
  }
  if (!fs.existsSync(targetDir)) {
    return false
  }
  await fsp.rm(targetDir, { recursive: true, force: true })
  return true
}

module.exports = {
  getExternalPluginsDir,
  ensureExternalPluginsDir,
  readManifestFromPath,
  listExternalPluginManifests,
  installExternalPlugin,
  uninstallExternalPlugin
}
