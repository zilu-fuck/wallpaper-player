const { spawnSync } = require('child_process')
const path = require('path')
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const result = spawnSync(require('electron'), [...process.argv.slice(2), path.join(__dirname, 'verify-vlm-start-button-ui.js')], {
  cwd: path.resolve(__dirname, '..'), env, windowsHide: true, encoding: 'utf8', timeout: 40000, maxBuffer: 4 * 1024 * 1024
})
process.stdout.write(result.stdout || '')
if (result.error || result.status !== 0 || !result.stdout?.includes('vlm start and download cancellation UI verification passed')) {
  process.stderr.write(result.stderr || ''); if (result.error) console.error(result.error)
  process.exitCode = result.status || 1
}
