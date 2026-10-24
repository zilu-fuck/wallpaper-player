// Test-only preload. Production entry points never import this file.
const fs = require('node:fs'), path = require('node:path'), { fileURLToPath } = require('node:url')
const marker = Symbol.for('wallpaper.verify.dataGuard')
if (!globalThis[marker]) {
  const root = path.resolve(process.env.WALLPAPER_VERIFY_PROTECTED_DIR || path.join(__dirname, '..', '.tmp-wallpaper-player'))
  const canonical = value => {
    const resolved = path.resolve(value)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  const inside = (parent, child) => { const relative = path.relative(parent, child); return !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) }
  const realpath = fs.realpathSync.native
  const appendReport = fs.appendFileSync
  function resolvedTarget(value) {
    let current = path.resolve(value), suffix = []
    for (;;) {
      try { return path.join(realpath(current), ...suffix) } catch {}
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(value)
      suffix.unshift(path.basename(current)); current = parent
    }
  }
  const lexicalRoot = canonical(root), realRoot = canonical(resolvedTarget(root))
  const stat = fs.statSync
  function protectedHardlink(text) {
    let candidate
    try { candidate = stat(text); if (!candidate.isFile() || candidate.nlink < 2) return false } catch { return false }
    const entries = [root]
    while (entries.length) {
      const entry = entries.pop()
      let info
      try { info = fs.lstatSync(entry) } catch { continue }
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) { for (const child of fs.readdirSync(entry)) entries.push(path.join(entry, child)) }
      else if (info.dev === candidate.dev && info.ino === candidate.ino) return true
    }
    return false
  }
  function check(value, ancestor = false) {
    if (typeof value === 'number' || value == null) return
    const text = Buffer.isBuffer(value) ? value.toString() : value instanceof URL ? fileURLToPath(value) : String(value)
    const names = [canonical(text), canonical(resolvedTarget(text))]
    if (names.some(name => [lexicalRoot, realRoot].some(base => inside(base, name) || (ancestor && inside(name, base)))) || protectedHardlink(text)) {
      if (process.env.WALLPAPER_VERIFY_EXPECT_GUARD_FAILURES !== '1') {
        process.exitCode = 1
        const report = process.env.WALLPAPER_VERIFY_GUARD_REPORT
        if (report && ![canonical(report), canonical(resolvedTarget(report))].some(name => inside(lexicalRoot, name) || inside(realRoot, name))) {
          try { appendReport(report, JSON.stringify({ pid: process.pid, time: new Date().toISOString(), code: 'verify_user_data_protected' }) + '\n') } catch {}
        }
      }
      throw Object.assign(new Error('Verification blocked a mutation of protected project fallback data: ' + root), { code: 'verify_user_data_protected' })
    }
  }
  const specs = {
    writeFile: [0], appendFile: [0], truncate: [0], unlink: [0], rm: [0], rmdir: [0],
    mkdir: [0], mkdtemp: [0], chmod: [0], chown: [0], utimes: [0], lutimes: [0], lchown: [0], lchmod: [0],
    rename: [0, 1], copyFile: [1], cp: [1], link: [0, 1], symlink: [0, 1]
  }
  const ancestors = new Set(['rename', 'rm', 'rmdir', 'chmod', 'chown'])
  for (const [name, indexes] of Object.entries(specs)) {
    const inspect = args => indexes.forEach(index => check(args[index], ancestors.has(name)))
    if (typeof fs[name + 'Sync'] === 'function') {
      const original = fs[name + 'Sync']
      fs[name + 'Sync'] = function (...args) { inspect(args); return original.apply(this, args) }
    }
    if (typeof fs[name] === 'function') {
      const original = fs[name]
      fs[name] = function (...args) {
        try { inspect(args) } catch (error) {
          const callback = args.at(-1)
          if (typeof callback !== 'function') throw error
          queueMicrotask(() => callback(error)); return
        }
        return original.apply(this, args)
      }
    }
    if (typeof fs.promises[name] === 'function') {
      const original = fs.promises[name]
      fs.promises[name] = async function (...args) { inspect(args); return original.apply(this, args) }
    }
  }
  const writable = flags => typeof flags === 'number'
    ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_TRUNC))
    : /[wa+]/.test(flags || 'r')
  for (const [owner, name] of [[fs, 'openSync'], [fs, 'open'], [fs.promises, 'open']]) {
    const original = owner[name]
    owner[name] = function (...args) {
      try { if (writable(args[1])) check(args[0]) } catch (error) {
        if (name === 'openSync') throw error
        if (owner === fs.promises) return Promise.reject(error)
        const callback = args.at(-1); if (typeof callback !== 'function') throw error
        queueMicrotask(() => callback(error)); return
      }
      return original.apply(this, args)
    }
  }
  const createWriteStream = fs.createWriteStream
  fs.createWriteStream = function (...args) { check(args[0]); return createWriteStream.apply(this, args) }
  globalThis[marker] = Object.freeze({ protectedRoot: root })
}
