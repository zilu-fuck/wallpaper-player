const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const fsp = fs.promises, CURRENT_SCHEMA_VERSION = 1
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const object = value => value && typeof value === 'object' && !Array.isArray(value)

function parseDocument(bytes) {
  let value
  try { value = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')) } catch { throw Object.assign(Error('设置 JSON 损坏'), { code: 'settings_corrupt' }) }
  if (!object(value)) throw Object.assign(Error('设置必须是 JSON 对象'), { code: 'settings_corrupt' })
  const version = Object.hasOwn(value, 'schemaVersion') ? value.schemaVersion : 0
  if (Number.isSafeInteger(version) && version > CURRENT_SCHEMA_VERSION) throw Object.assign(Error('设置来自较新版本，请使用支持该版本的应用'), { code: 'settings_unsupported_version', schemaVersion: version })
  if (!Number.isSafeInteger(version) || version < 0) throw Object.assign(Error('设置格式版本无效'), { code: 'settings_corrupt' })
  return { value, version }
}

function createSettingsFile(filename, { onWarning = error => console.error('[settings storage]', error.message) } = {}) {
  const backup = path.join(path.dirname(filename), 'settings.v1.backup.json'), migration = path.join(path.dirname(filename), 'settings-migration.json')
  let lastGood = null, version = null, loaded = false, pending = null, counter = 0, pendingMigration = null, fileMode = 0o600, generation = 0, writes = 0
  const error = (code, message, extra = {}) => Object.assign(Error(message), { code, settingsPath: filename, backupPath: backup, ...extra })
  const readBytes = file => { try { return fs.readFileSync(file) } catch (cause) { if (cause.code === 'ENOENT') return null; throw error('settings_unreadable', '设置文件无法读取；原文件未覆盖', { ioCode: cause.code }) } }
  function read() {
    generation++
    loaded = false; pending = null
    const bytes = readBytes(filename)
    if (bytes) {
      try {
        const parsed = parseDocument(bytes)
        fileMode = fs.statSync(filename).mode & 0o777
        lastGood = Buffer.from(bytes); version = parsed.version; loaded = true; pending = null
        return parsed.value
      } catch (cause) { if (cause.code !== 'settings_corrupt') throw error(cause.code, cause.message, { schemaVersion: cause.schemaVersion }) }
    }
    const backupBytes = readBytes(backup)
    if (!bytes && !backupBytes) { lastGood = null; version = null; loaded = true; pending = null; return {} }
    if (backupBytes) {
      try {
        parseDocument(backupBytes)
        pending = { id: crypto.randomUUID(), primary: bytes, backup: backupBytes, mode: fs.statSync(bytes ? filename : backup).mode & 0o777 }
        throw error('settings_backup_available', bytes ? '主设置损坏，找到可用备份' : '主设置缺失，找到可用备份', {
          recoveryId: pending.id, backupModifiedAt: fs.statSync(backup).mtime.toISOString()
        })
      } catch (cause) {
        if (cause.code === 'settings_backup_available') throw cause
        throw error('settings_recovery_unavailable', '主设置无法读取，备份也不可用；原文件均已保留', { backupErrorCode: cause.code })
      }
    }
    throw error('settings_recovery_unavailable', '设置损坏且没有可用备份；原文件已保留')
  }
  async function readAsync(decode = bytes => parseDocument(bytes)) {
    if (writes) throw error('settings_busy', '设置正在保存，请稍后重试')
    const owner = ++generation
    loaded = false; pending = null
    const check = () => { if (owner !== generation) throw error('settings_read_changed', '设置读取已被更新的操作替代') }
    const bytesFrom = async file => {
      try { return await fsp.readFile(file) } catch (cause) { if (cause.code === 'ENOENT') return null; throw error('settings_unreadable', '设置文件无法读取；原文件未覆盖', { ioCode: cause.code }) }
    }
    const stat = async file => { try { return await fsp.stat(file) } catch (cause) { throw error('settings_unreadable', '设置文件状态无法读取；原文件未覆盖', { ioCode: cause.code }) } }
    const same = (left, right) => left === null ? right === null : right !== null && left.equals(right)
    const bytes = await bytesFrom(filename); check()
    if (bytes) {
      try {
        const parsed = await decode(bytes); check()
        const info = await stat(filename), current = await bytesFrom(filename); check()
        if (!same(bytes, current)) throw error('settings_read_changed', '设置在读取期间已被修改，请重新读取')
        fileMode = info.mode & 0o777; lastGood = Buffer.from(bytes); version = parsed.version; loaded = true; pending = null
        return parsed.value
      } catch (cause) { check(); if (cause.code !== 'settings_corrupt') throw error(cause.code || 'settings_read_failed', cause.message, { schemaVersion: cause.schemaVersion }) }
    }
    const backupBytes = await bytesFrom(backup); check()
    if (!bytes && !backupBytes) {
      const parsed = await decode(Buffer.from('{}')); check()
      const [primaryNow, backupNow] = await Promise.all([bytesFrom(filename), bytesFrom(backup)]); check()
      if (primaryNow !== null || backupNow !== null) throw error('settings_read_changed', '设置在读取期间已出现，请重新读取')
      lastGood = null; version = null; loaded = true; pending = null; return parsed.value
    }
    if (backupBytes) {
      try {
        await decode(backupBytes); check()
        const [info, backupInfo, primaryNow, backupNow] = await Promise.all([stat(bytes ? filename : backup), stat(backup), bytesFrom(filename), bytesFrom(backup)]); check()
        if (!same(bytes, primaryNow) || !same(backupBytes, backupNow)) throw error('settings_read_changed', '设置或备份在读取期间已变化，请重新读取')
        pending = { id: crypto.randomUUID(), primary: bytes, backup: backupBytes, mode: info.mode & 0o777 }
        throw error('settings_backup_available', bytes ? '主设置损坏，找到可用备份' : '主设置缺失，找到可用备份', { recoveryId: pending.id, backupModifiedAt: backupInfo.mtime.toISOString() })
      } catch (cause) {
        check()
        if (['settings_backup_available', 'settings_read_changed', 'settings_unreadable'].includes(cause.code)) throw cause
        throw error('settings_recovery_unavailable', '主设置无法读取，备份也不可用；原文件均已保留', { backupErrorCode: cause.code })
      }
    }
    throw error('settings_recovery_unavailable', '设置损坏且没有可用备份；原文件已保留')
  }
  function temporary(file) { return `${file}.${process.pid}.${++counter}.${crypto.randomUUID()}.tmp` }
  async function atomic(file, bytes) {
    const temp = temporary(file)
    try { await fsp.writeFile(temp, bytes, { flag: 'wx', mode: fileMode }); await fsp.rename(temp, file) }
    finally { await fsp.rm(temp, { force: true }).catch(() => {}) }
  }
  function atomicSync(file, bytes) {
    const temp = temporary(file)
    try { fs.writeFileSync(temp, bytes, { flag: 'wx', mode: fileMode }); fs.renameSync(temp, file) }
    finally { try { fs.rmSync(temp, { force: true }) } catch {} }
  }
  function migrationRecord(previous, next) {
    return { schemaVersion: CURRENT_SCHEMA_VERSION, from: 0, to: CURRENT_SCHEMA_VERSION,
      sourceSha256: digest(previous), targetSha256: digest(next), committedAt: new Date().toISOString(), backup: path.basename(backup) }
  }
  async function write(bytes) {
    if (!loaded) read()
    const owned = Buffer.from(bytes), previous = lastGood, priorVersion = version
    generation++; writes++
    try {
    await fsp.mkdir(path.dirname(filename), { recursive: true })
    if (previous) await atomic(backup, previous)
    await atomic(filename, owned)
    lastGood = owned; version = CURRENT_SCHEMA_VERSION; pending = null
    if (!previous) {
      try { await atomic(backup, owned) }
      catch { try { onWarning(error('settings_backup_failed', '设置已保存，但首次备份失败；后续提交将重试备份')) } catch {} }
    }
    if (previous && priorVersion === 0) pendingMigration = migrationRecord(previous, owned)
    if (pendingMigration) {
      try { await atomic(migration, JSON.stringify(pendingMigration, null, 2)); pendingMigration = null }
      catch { try { onWarning(error('settings_migration_log_failed', '设置已保存，但迁移记录写入失败；下次提交将重试')) } catch {} }
    }
    } finally { writes-- }
  }
  function writeSync(bytes) {
    if (!loaded) read()
    generation++
    const owned = Buffer.from(bytes), previous = lastGood, priorVersion = version
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    if (previous) atomicSync(backup, previous)
    atomicSync(filename, owned); lastGood = owned; version = CURRENT_SCHEMA_VERSION; pending = null
    if (!previous) {
      try { atomicSync(backup, owned) }
      catch { try { onWarning(error('settings_backup_failed', '设置已保存，但首次备份失败；后续提交将重试备份')) } catch {} }
    }
    if (previous && priorVersion === 0) pendingMigration = migrationRecord(previous, owned)
    if (pendingMigration) {
      try { atomicSync(migration, JSON.stringify(pendingMigration, null, 2)); pendingMigration = null }
      catch { try { onWarning(error('settings_migration_log_failed', '设置已保存，但迁移记录写入失败；下次提交将重试')) } catch {} }
    }
  }
  async function currentBytes(file) {
    try { return await fsp.readFile(file) } catch (cause) { if (cause.code === 'ENOENT') return null; throw error('settings_unreadable', '恢复前无法复核设置文件', { ioCode: cause.code }) }
  }
  const equal = (left, right) => left === null ? right === null : right !== null && left.equals(right)
  async function recover(id, { decode = bytes => parseDocument(bytes), check = () => {} } = {}) {
    const candidate = pending
    if (!candidate || candidate.id !== id) throw error('settings_recovery_changed', '恢复候选已变化，请重新读取')
    const verify = async () => {
      check()
      if (pending !== candidate) throw error('settings_recovery_changed', '恢复候选已变化，请重新读取')
      const [primaryNow, backupNow] = await Promise.all([currentBytes(filename), currentBytes(backup)])
      check()
      if (!equal(candidate.primary, primaryNow) || !equal(candidate.backup, backupNow)) throw error('settings_recovery_changed', '设置或备份已被修改，本次未恢复')
    }
    let preserved = null
    try {
      await verify(); await decode(candidate.backup); check()
      if (candidate.primary !== null) {
        preserved = path.join(path.dirname(filename), 'settings.corrupt-' + Date.now() + '-' + crypto.randomUUID() + '.json')
        await fsp.writeFile(preserved, candidate.primary, { flag: 'wx', mode: candidate.mode })
      }
      await verify(); fileMode = candidate.mode; await atomic(filename, candidate.backup)
      loaded = false; pending = null; generation++
      return { preservedPath: preserved, restoredFrom: backup }
    } catch (cause) {
      if (cause.code === 'app_quitting') throw cause
      if (String(cause.code || '').startsWith('settings_')) throw cause.settingsPath ? cause : error(cause.code, cause.message, { preservedPath: preserved })
      throw error('settings_recovery_failed', '恢复未完成，原设置和备份未使用默认内容覆盖，请检查目录权限后重启', { ioCode: cause.code, preservedPath: preserved })
    }
  }
  return { read, readAsync, write, writeSync, recover, paths: () => ({ filename, backup, migration }) }
}
module.exports = { CURRENT_SCHEMA_VERSION, createSettingsFile, parseDocument }
