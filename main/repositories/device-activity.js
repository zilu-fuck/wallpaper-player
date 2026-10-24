const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')

// Activity is optional metadata. It must never replace the credential document.
function createDeviceActivity(filename) {
  let loaded = false, unavailable = false, document = null, sequence = 0
  const failure = () => Object.assign(new Error('设备访问记录暂时不可用，原文件已保留'), { code: 'device_activity_unavailable' })
  const owner = identity => crypto.createHash('sha256').update(JSON.stringify([identity.deviceId, identity.machineSecret])).digest('hex')
  function accept(text) {
    const value = JSON.parse(text)
    if (!value || value.schemaVersion !== 1 || typeof value.owner !== 'string' || !/^[a-f0-9]{64}$/.test(value.owner) ||
      !Array.isArray(value.devices) || value.devices.length > 100 || value.devices.some(device => !device ||
        typeof device.id !== 'string' || !device.id || device.id.length > 80 || typeof device.tokenHash !== 'string' || !device.tokenHash || device.tokenHash.length > 128 ||
        !Number.isFinite(device.lastSeenAt) || device.lastSeenAt < 0 || typeof device.lastAddress !== 'string' || device.lastAddress.length > 80)) throw failure()
    document = value; loaded = true; unavailable = false
  }
  function readFailure(error) {
    document = null; loaded = true; unavailable = error.code !== 'ENOENT'
  }
  function merge(identity) {
    if (!document || document.owner !== owner(identity)) return identity
    const devices = new Map(document.devices.map(device => [device.id, device]))
    return { ...identity, pairedDevices: identity.pairedDevices.map(device => {
      const activity = devices.get(device.id)
      if (device.revokedAt || !activity || activity.tokenHash !== device.tokenHash || activity.lastSeenAt < device.lastSeenAt) return device
      return { ...device, lastSeenAt: activity.lastSeenAt, lastAddress: activity.lastAddress }
    }) }
  }
  async function read(identity) {
    if (!loaded || unavailable) {
      try { accept(await fs.promises.readFile(filename, 'utf8')) } catch (error) { readFailure(error) }
    }
    return merge(identity)
  }
  function readSync(identity) {
    if (!loaded || unavailable) {
      try { accept(fs.readFileSync(filename, 'utf8')) } catch (error) { readFailure(error) }
    }
    return merge(identity)
  }
  async function save(identity) {
    if (unavailable) throw failure()
    const next = { schemaVersion: 1, owner: owner(identity), devices: identity.pairedDevices.filter(device => !device.revokedAt).map(device => ({
      id: device.id, tokenHash: device.tokenHash, lastSeenAt: device.lastSeenAt, lastAddress: device.lastAddress
    })) }
    const temporary = `${filename}.${process.pid}.${++sequence}.tmp`
    try {
      await fs.promises.mkdir(path.dirname(filename), { recursive: true })
      await fs.promises.writeFile(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 })
      await fs.promises.rename(temporary, filename)
      document = next; loaded = true
    } catch { throw failure() }
    finally { await fs.promises.rm(temporary, { force: true }).catch(() => {}) }
  }
  return { read, readSync, save }
}

module.exports = { createDeviceActivity }
