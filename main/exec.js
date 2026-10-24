const { execFile, spawn } = require('child_process')
const { workerSpawnSpec, stopProcessTree } = require('./process-lifecycle')

// execFile 的 Promise 封装，统一超时/错误语义。
// 失败时 error 对象上附加 stdout/stderr，方便调用方做诊断。
function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    let callback, closed = false, child
    const finish = () => {
      if (!callback || !closed) return
      const { err, stdout, stderr } = callback
      if (err) {
        err.stdout = stdout
        err.stderr = stderr
        reject(err)
      } else {
        resolve({ stdout, stderr })
      }
    }
    child = execFile(file, args, { windowsHide: true, ...options }, (err, stdout, stderr) => {
      callback = { err, stdout, stderr }; finish()
    })
    // Node may call back with AbortError before close; never release a worker's slot early.
    if (child?.once) child.once('close', () => { closed = true; finish() })
    else { closed = true; finish() }
  })
}

function execFileTreeAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    let child, failure, timer, stopping, stdoutBytes = 0, stderrBytes = 0
    const stdout = [], stderr = [], signal = options.signal, maxBuffer = options.maxBuffer || 1024 * 1024
    const stop = error => {
      failure ||= error
      if (child) stopping ||= stopProcessTree(child, { processGroup: process.platform !== 'win32' }).catch(() => {})
    }
    const abort = () => stop(signal.reason || Object.assign(new Error('操作已取消'), { code: 'ABORT_ERR' }))
    if (signal?.aborted) { reject(signal.reason); return }
    try {
      const spec = workerSpawnSpec(file, args, { cwd: options.cwd, env: options.env, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
      child = spawn(spec.file, spec.args, spec.options)
    } catch (error) { reject(error); return }
    const capture = (chunks, channel) => chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (channel === 'stdout') stdoutBytes += bytes.length; else stderrBytes += bytes.length
      if (Math.max(stdoutBytes, stderrBytes) > maxBuffer) {
        stop(Object.assign(new Error('工作进程输出超过大小上限'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })); return
      }
      if (!failure) chunks.push(bytes)
    }
    const onStdout = capture(stdout, 'stdout'), onStderr = capture(stderr, 'stderr')
    child.stdout.on('data', onStdout); child.stderr.on('data', onStderr)
    child.once('error', stop)
    child.once('close', async (code, exitSignal) => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort)
      child.stdout.off('data', onStdout); child.stderr.off('data', onStderr); child.off('error', stop)
      await stopping
      const encoding = options.encoding || 'utf8', out = Buffer.concat(stdout).toString(encoding), err = Buffer.concat(stderr).toString(encoding)
      if (!failure && code !== 0) failure = Object.assign(new Error('工作进程退出：' + (code ?? exitSignal)), { code: code ?? 'PROCESS_EXIT' })
      if (failure) {
        // A shared abort reason belongs to its controller; process output stays on this invocation's error.
        reject(Object.assign(new Error(failure.message || '工作进程失败'), { name: failure.name || 'Error', code: failure.code,
          status: failure.status, retryable: failure.retryable, stdout: out, stderr: err }))
      } else resolve({ stdout: out, stderr: err })
    })
    if (options.timeout) {
      timer = setTimeout(() => stop(Object.assign(new Error('工作进程超过最长等待时间'), { code: 'ETIMEDOUT' })), options.timeout)
      timer.unref?.()
    }
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
  })
}

module.exports = { execFileAsync, execFileTreeAsync }
