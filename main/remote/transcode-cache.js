const fsp = require('fs/promises'), path = require('path'), crypto = require('crypto')
const writes = new Map()
const MANIFEST_BYTES = 16 * 1024
const manifestPath = output => output + '.cache.json'
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const configurationKey = configuration => crypto.createHash('sha256').update(JSON.stringify(configuration)).digest('hex')

function signatureFromStat(canonical, stat) {
  if (!stat.isFile()) throw new Error('媒体文件无效')
  return { path: process.platform === 'win32' ? canonical.toLowerCase() : canonical,
    size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs),
    device: String(stat.dev), inode: String(stat.ino) }
}

async function fileSignature(filePath) {
  const canonical = await fsp.realpath(filePath)
  const file = await fsp.open(canonical, 'r')
  try {
    const stat = await file.stat({ bigint: true })
    return signatureFromStat(canonical, stat)
  } finally { await file.close() }
}

async function readFreshCache(source, output, configuration) {
  let handle
  try {
    handle = await fsp.open(manifestPath(output), 'r')
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > MANIFEST_BYTES) return null
    const bytes = Buffer.alloc(MANIFEST_BYTES + 1), read = await handle.read(bytes, 0, bytes.length, 0)
    if (read.bytesRead > MANIFEST_BYTES) return null
    const manifest = JSON.parse(bytes.subarray(0, read.bytesRead).toString('utf8'))
    if (manifest.version !== 1 || !['remux', 'reencode'].includes(manifest.operation) ||
        manifest.configuration !== configurationKey(configuration(manifest.operation))) return null
    const [currentSource, currentOutput] = await Promise.all([fileSignature(source), fileSignature(output)])
    return currentOutput.size !== '0' && same(manifest.source, currentSource) && same(manifest.output, currentOutput) ? manifest : null
  } catch { return null }
  finally { await handle?.close() }
}

function publishTranscode(task, configuration, check) {
  const previous = writes.get(task.outputPath) || Promise.resolve()
  const work = previous.catch(() => {}).then(async () => {
    const manifest = manifestPath(task.outputPath), suffix = '.' + task.taskId
    const outputBackup = task.outputPath + suffix + '.backup', manifestBackup = manifest + suffix + '.backup'
    const manifestTemporary = manifest + suffix + '.tmp'
    let outputBackedUp = false, manifestBackedUp = false, outputPublished = false, manifestPublished = false, committed = false
    try {
      await check()
      try { await fsp.rename(task.outputPath, outputBackup); outputBackedUp = true } catch (error) { if (error.code !== 'ENOENT') throw error }
      try { await fsp.rename(manifest, manifestBackup); manifestBackedUp = true } catch (error) { if (error.code !== 'ENOENT') throw error }
      await check(); await fsp.rename(task.tempPath, task.outputPath); outputPublished = true
      await check()
      const output = await fileSignature(task.outputPath)
      if (output.size === '0') throw new Error('转码输出为空')
      await fsp.writeFile(manifestTemporary, JSON.stringify({ version: 1, source: task.sourceSignature, output,
        operation: task.operation, configuration: configurationKey(configuration) }), { flag: 'wx' })
      await check(); await fsp.rename(manifestTemporary, manifest); manifestPublished = true
      await check(); committed = true
    } catch (error) {
      if (manifestPublished) await fsp.unlink(manifest).catch(() => {})
      if (outputPublished) await fsp.unlink(task.outputPath).catch(() => {})
      if (outputBackedUp) { await fsp.rename(outputBackup, task.outputPath); outputBackedUp = false }
      if (manifestBackedUp) { await fsp.rename(manifestBackup, manifest); manifestBackedUp = false }
      throw error
    } finally {
      await fsp.unlink(manifestTemporary).catch(() => {})
      if (committed) await Promise.all([outputBackedUp && fsp.unlink(outputBackup).catch(() => {}), manifestBackedUp && fsp.unlink(manifestBackup).catch(() => {})])
    }
  })
  writes.set(task.outputPath, work)
  return work.finally(() => { if (writes.get(task.outputPath) === work) writes.delete(task.outputPath) })
}
module.exports = { fileSignature, signatureFromStat, readFreshCache, publishTranscode, same, manifestPath }
