const { execFile } = require('child_process')
const path = require('path')
const stops = new WeakMap()

function workerSpawnSpec(file, args, options = {}) {
  if (process.platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(file)) return { file, args, options: { ...options, shell: false } }
  const values = [file, ...args].map(String)
  if (values.some(value => /[\0\r\n"]/.test(value))) throw new Error('脚本参数包含不支持的字符')
  // Values stay in the child environment: CMD performs one expansion inside quotes.
  const env = { ...(options.env || process.env) }, variables = []
  values.forEach((value, index) => {
    if (value === '') { variables.push('""'); return }
    const name = 'WALLPAPER_MEDIA_ARG_' + index; env[name] = value; variables.push('"%' + name + '%"')
  })
  return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/v:off', '/s', '/c', '"' + variables.join(' ') + '"'],
    options: { ...options, env, shell: false, windowsVerbatimArguments: true } }
}

/** Only receives ChildProcess instances created by this application's worker owners. */
function stopProcessTree(child, { processGroup = false } = {}) {
  if (!child) return Promise.resolve()
  if (stops.has(child)) return stops.get(child)
  const operation = (async () => {
    const pid = child.pid
    if (!Number.isInteger(pid) || pid <= 0 || child.exitCode != null || child.signalCode != null) { try { child.kill() } catch {} return }
    if (pid === process.pid) throw new Error('不能停止当前应用进程')
    if (process.platform === 'win32') {
      await new Promise(resolve => {
        const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
        execFile(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 4000 }, error => {
          if (error && child.exitCode == null) { try { child.kill() } catch {} }
          resolve()
        })
      })
    } else if (processGroup) {
      try { process.kill(-pid, 'SIGTERM') } catch { try { child.kill() } catch {} }
    } else { try { child.kill() } catch {} }
  })()
  stops.set(child, operation)
  return operation
}
module.exports = { stopProcessTree, workerSpawnSpec }
