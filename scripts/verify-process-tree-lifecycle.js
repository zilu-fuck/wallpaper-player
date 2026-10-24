const assert = require('assert'), fs = require('fs'), path = require('path'), { spawn } = require('child_process')
const { stopProcessTree, workerSpawnSpec } = require('../main/process-lifecycle')
const { removeTempRootWithRetry } = require('./verify-helpers')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
fs.mkdirSync(parent, { recursive: true })
const fixture = fs.mkdtempSync(path.join(parent, 'process-tree-'))
const until = async condition => { const deadline = Date.now() + 5000
  while (!condition()) { if (Date.now() > deadline) throw new Error('process tree condition timed out'); await new Promise(done => setTimeout(done, 5)) } }
const alive = pid => { try { process.kill(pid, 0)
  if (process.platform !== 'win32' && fs.existsSync('/proc/' + pid + '/stat')) return !/\) Z /.test(fs.readFileSync('/proc/' + pid + '/stat', 'utf8'))
  return true } catch { return false } }
async function main() {
  const pidFile = path.join(fixture, 'pids.json'), childCode = path.join(fixture, 'child.js'), parentCode = path.join(fixture, 'parent.js')
  fs.writeFileSync(childCode, 'setInterval(() => {}, 1000)')
  fs.writeFileSync(parentCode, 'const fs = require("fs"), { spawn } = require("child_process"); const child = spawn(process.execPath, [process.argv[2]], { stdio: "ignore", windowsHide: true }); fs.writeFileSync(process.argv[3], JSON.stringify({ parent: process.pid, child: child.pid })); setInterval(() => {}, 1000)')
  const worker = spawn(process.execPath, [parentCode, childCode, pidFile], { windowsHide: true, detached: process.platform !== 'win32', stdio: 'ignore' })
  const closed = new Promise((resolve, reject) => { worker.once('close', resolve); worker.once('error', reject) })
  try {
    await until(() => fs.existsSync(pidFile))
    const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'))
    assert.ok(alive(pids.parent) && alive(pids.child))
    const first = stopProcessTree(worker, { processGroup: process.platform !== 'win32' })
    assert.strictEqual(stopProcessTree(worker, { processGroup: process.platform !== 'win32' }), first)
    await first; await closed; await until(() => !alive(pids.parent) && !alive(pids.child))
    if (process.platform === 'win32') {
      const script = path.join(fixture, 'capture.cmd'), capture = path.join(fixture, 'capture.js'), output = path.join(fixture, 'arguments.json')
      fs.writeFileSync(capture, 'require("fs").writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)))')
      fs.writeFileSync(script, '@echo off\r\n"' + process.execPath + '" "%~dp0capture.js" %*\r\n')
      const expected = ['', '汉字 space', 'x&y^z%PATH%!literal!', 'scale=x\\,y', '-flag', '']
      const spec = workerSpawnSpec(script, [output, ...expected], { windowsHide: true, stdio: 'pipe' })
      const command = spawn(spec.file, spec.args, spec.options)
      let stderr = ''; command.stderr.on('data', value => { stderr += value })
      await new Promise((resolve, reject) => { command.once('error', reject); command.once('close', code => code === 0 ? resolve() : reject(new Error(stderr))) })
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(output, 'utf8')), expected, 'script parameters remain data rather than CMD expansions/operators')
      assert.throws(() => workerSpawnSpec(script, ['unsafe"argument']))
    }
    console.log('process tree lifecycle passed: real owned parent/child cleanup, repeated-stop ownership, native close and literal Windows script arguments')
  } finally { await stopProcessTree(worker, { processGroup: process.platform !== 'win32' }); await closed }
}
const deadline = setTimeout(() => { console.error('process tree verification timed out'); process.exit(1) }, 15000)
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  clearTimeout(deadline); assert.strictEqual(path.dirname(path.resolve(fixture)), parent); await removeTempRootWithRetry(fixture)
})
