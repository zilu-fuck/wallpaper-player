// The queue survives panel remounts. Already issued native work holds its slot until it settles.
export function createSettingsQueue(limit = 16) {
  let tail = Promise.resolve(), pending = 0
  return action => {
    if (pending >= limit) return Promise.reject(new Error('设置操作过多，请稍后重试'))
    pending++
    const work = tail.then(action).finally(() => pending--)
    tail = work.catch(() => {})
    return work
  }
}

export function snapshotVersion(value, key) {
  const version = value?.[key]
  return version && typeof version.epoch === 'string' && version.epoch && version.epoch.length <= 128 && Number.isSafeInteger(version.revision) && version.revision >= 0 ? version : null
}

export function acceptsSnapshot(previous, next, key) {
  const before = snapshotVersion(previous, key), after = snapshotVersion(next, key)
  return !before || Boolean(after && before.epoch === after.epoch && after.revision > before.revision)
}
