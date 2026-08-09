// 按 key（IP / webContents id）统计失败次数并在达到阈值后锁定的通用限流器。
// IPC 隐私解锁与远程 HTTP 隐私解锁共用，避免两套实现行为分叉。

function createFailureLimiter({ limit = 5, lockMs = 30 * 1000 } = {}) {
  const failures = new Map()

  function getWaitMs(key) {
    const current = failures.get(key)
    if (!current || !current.lockUntil) return 0
    const waitMs = current.lockUntil - Date.now()
    if (waitMs <= 0) {
      failures.delete(key)
      return 0
    }
    return waitMs
  }

  // 记录一次失败；返回锁定毫秒数（>0 表示本次触发锁定）
  function recordFailure(key) {
    const current = failures.get(key) || { count: 0, lockUntil: 0 }
    const nextCount = current.count + 1
    const next = {
      count: nextCount,
      lockUntil: nextCount >= limit ? Date.now() + lockMs : 0
    }
    failures.set(key, next)
    return next.lockUntil ? lockMs : 0
  }

  function reset(key) {
    failures.delete(key)
  }

  function clear() {
    failures.clear()
  }

  return { getWaitMs, recordFailure, reset, clear }
}

module.exports = { createFailureLimiter }
