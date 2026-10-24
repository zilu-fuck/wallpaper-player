// IPC broadcasts clone JSON settings. Reuse unchanged branches before deriving library data.
export function shareJson(previous, next, depth = 0) {
  if (Object.is(previous, next)) return previous
  if (depth >= 64 || !previous || !next || typeof previous !== 'object' || typeof next !== 'object' ||
      Array.isArray(previous) !== Array.isArray(next)) return next
  const keys = Object.keys(next)
  const previousKeys = Object.keys(previous)
  let equal = keys.length === previousKeys.length, index = 0
  const result = Array.isArray(next) ? [...next] : { ...next }
  for (const key of keys) {
    result[key] = Object.hasOwn(previous, key) ? shareJson(previous[key], next[key], depth + 1) : next[key]
    if (previousKeys[index++] !== key || !Object.hasOwn(previous, key) || !Object.is(result[key], previous[key])) equal = false
  }
  return equal ? previous : result
}
