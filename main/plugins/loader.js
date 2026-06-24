const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const crypto = require('crypto')
const os = require('os')
const { execFile } = require('child_process')
const { app } = require('electron')
const { isPathInside, pathKey } = require('../paths')
const { MANIFEST_FILE, normalizeManifest } = require('./manifest')
const { officialPluginIds, isOfficialPluginId } = require('./official')

const fallbackUserDataDir = path.join(process.cwd(), '.tmp-wallpaper-player')

function getUserDataDir() {
  return app?.getPath ? app.getPath('userData') : fallbackUserDataDir
}

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

function stampManifestSource(manifest) {
  if (isOfficialPluginId(manifest.id) && manifest.publisher !== 'official') {
    throw new Error('第三方插件不能使用官方插件 ID')
  }
  const official = isOfficialPluginId(manifest.id) && manifest.publisher === 'official'
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
    stampManifestSource(manifest)
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

function execFileAsync(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
        return
      }
      resolve({ stdout, stderr })
    })
  })
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
    const source = path.join(sourceDir, entry.name)
    const target = path.join(targetDir, entry.name)
    if (entry.isDirectory()) {
      await copyPluginDirectory(source, target)
    } else if (entry.isFile()) {
      await fsp.copyFile(source, target)
    }
  }
}

async function readInstallManifest(source) {
  const { manifest, manifestPath } = await readManifestFromPath(source)
  return {
    manifest: stampManifestSource(manifest),
    manifestPath
  }
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

async function installPreparedPlugin(source) {
  const pluginsDir = await ensureExternalPluginsDir()
  const { manifest, manifestPath } = await readInstallManifest(source)
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
    const { manifest: stagedManifest } = await readInstallManifest(stageDir)
    if (stagedManifest.id !== manifest.id) {
      throw new Error('Installed plugin manifest id changed during copy')
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
      extractedDir = await extractZipToTemp(source)
      return await installPreparedPlugin(await findPluginRoot(extractedDir))
    }
    return await installPreparedPlugin(source)
  } finally {
    if (extractedDir) {
      await fsp.rm(extractedDir, { recursive: true, force: true }).catch(() => {})
    }
  }
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
