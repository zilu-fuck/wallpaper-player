const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
fs.mkdirSync(parent, { recursive: true })
const fixture = fs.mkdtempSync(path.join(parent, 'vite-dev-中文 空格-'))
const source = label => `import { useState } from 'react';
import { playerActionSchema } from '@wallpaper/contracts';
import * as domain from '@wallpaper/domain';
export default function App() { const [count, setCount] = useState(0);
return <main><span id="label">${label}</span><button id="counter" onClick={() => setCount(count + 1)}>{count}</button>
<span id="contract">{playerActionSchema.parse({ action:'stop', sessionId:'hmr-fixture' }).action}</span>
<span id="domain">{Object.values(domain).some(value => typeof value === 'function') ? 'ready' : 'missing'}</span></main> }
`
fs.writeFileSync(path.join(fixture, 'index.html'), '<div id="root"></div><script type="module" src="./entry.jsx"></script>')
fs.writeFileSync(path.join(fixture, 'entry.jsx'), "import {createRoot} from 'react-dom/client';import App from './App';createRoot(document.getElementById('root')).render(<App/>);")
fs.writeFileSync(path.join(fixture, 'App.jsx'), source('before'))
let server, child, completion
;(async () => {
  const { createServer } = await import('vite')
  server = await createServer({ configFile: path.join(root, 'vite.config.js'), root: fixture,
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: true } })
  await server.listen()
  const env = { ...process.env, WALLPAPER_VITE_FIXTURE: fixture, WALLPAPER_VITE_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  completion = new Promise((resolve, reject) => {
    child = execFile(require('electron'), [...process.argv.slice(2), path.join(__dirname, 'verify-vite-dev-electron.js')], {
      cwd: root, env, windowsHide: true, timeout: 40000, maxBuffer: 2 * 1024 * 1024
    }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }))
  })
  completion.catch(() => {})
  const ready = path.join(fixture, 'hmr-ready'), end = Date.now() + 20000
  while (!fs.existsSync(ready)) {
    if (child.exitCode !== null) { await completion; throw Error('Native HMR probe exited without ready marker') }
    if (Date.now() > end) throw Error('Native HMR readiness timed out')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  fs.writeFileSync(path.join(fixture, 'App.jsx'), source('after'))
  await completion
  const native = JSON.parse(fs.readFileSync(path.join(fixture, 'result.json'), 'utf8'))
  assert.equal(native.success, true, JSON.stringify(native))
  fs.writeFileSync(path.join(parent, 'vite-dev-evidence.json'), JSON.stringify({ date: new Date().toISOString(), fixture,
    vite: JSON.parse(fs.readFileSync(path.join(root, 'node_modules/vite/package.json'), 'utf8')).version,
    reactPlugin: JSON.parse(fs.readFileSync(path.join(root, 'node_modules/@vitejs/plugin-react/package.json'), 'utf8')).version, native,
    scope: 'Real project Vite config, loopback dev server, CommonJS shared contract import and state-preserving React Fast Refresh in isolated Electron. Production IPC is verified separately.' }, null, 2))
  console.log('Vite dev passed: production config, shared CommonJS contracts, React render and Fast Refresh preserving local state')
})().catch(error => { console.error(error.stderr || error); process.exitCode = 1 }).finally(async () => {
  if (child && child.exitCode === null) child.kill()
  await completion?.catch(() => {})
  await server?.close()
})
