const path = require('node:path'), fs = require('node:fs'), crypto = require('node:crypto'), { spawnSync } = require('node:child_process')
const args = process.argv.slice(2), electron = args[0] === '--electron'
if (electron) args.shift()
if (!args.length) throw new Error('A verification script is required')
const preload = path.join(__dirname, 'test-data-guard.cjs').replaceAll('\\', '/')
const reports = path.join(__dirname, '..', '.tmp/refactor-tests'); fs.mkdirSync(reports, { recursive: true })
const report = path.join(reports, 'verification-guard-' + crypto.randomUUID() + '.jsonl')
const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require "${preload}"`.trim(), WALLPAPER_VERIFY_GUARD_REPORT: report }
if (electron) delete env.ELECTRON_RUN_AS_NODE
const result = spawnSync(electron ? require('electron') : process.execPath, args, { cwd: process.cwd(), env, windowsHide: true, stdio: 'inherit' })
if (result.error) console.error(result.error)
const blocked = fs.existsSync(report) && fs.statSync(report).size > 0
if (blocked) console.error('Verification attempted a protected project-data mutation: ' + report)
process.exitCode = blocked ? 1 : result.status ?? 1
