const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), { execFile } = require('node:child_process')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
fs.mkdirSync(parent, { recursive: true }); const fixture = fs.mkdtempSync(path.join(parent, 'data-guard-'))
const protectedDir = path.join(fixture, 'protected'), sentinel = path.join(protectedDir, 'settings.json'), alias = path.join(fixture, 'alias'), hardlink = path.join(fixture, 'hardlink.json')
fs.mkdirSync(protectedDir); fs.writeFileSync(sentinel, 'original'); fs.symlinkSync(protectedDir, alias, process.platform === 'win32' ? 'junction' : 'dir'); fs.linkSync(sentinel, hardlink)
const preload = path.join(__dirname, 'test-data-guard.cjs').replaceAll('\\', '/')
const env = { ...process.env, WALLPAPER_VERIFY_PROTECTED_DIR: protectedDir, WALLPAPER_VERIFY_EXPECT_GUARD_FAILURES: '1', NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require "${preload}"` }
delete env.ELECTRON_RUN_AS_NODE
function run(executable, args, childEnv = env) { return new Promise((resolve, reject) => execFile(executable, args, { env: childEnv, windowsHide: true, timeout: 20000 }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve(stdout))) }
;(async () => {
  const source = `const fs=require('node:fs'),fsp=require('node:fs/promises'),assert=require('node:assert/strict'),{fileURLToPath,pathToFileURL}=require('node:url');
const file=${JSON.stringify(sentinel)},alias=${JSON.stringify(path.join(alias,'settings.json'))},hardlink=${JSON.stringify(hardlink)},parent=${JSON.stringify(fixture)};
const denied=e=>e.code==='verify_user_data_protected';let checks=0;
for(const action of[()=>fs.writeFileSync(file,'bad'),()=>fs.appendFileSync(Buffer.from(file),'bad'),()=>fs.openSync(file,'r+'),()=>fs.createWriteStream(file),()=>fs.renameSync(file,file+'.moved'),()=>fs.copyFileSync(__filename,file),()=>fs.rmSync(parent,{recursive:true,force:true}),()=>fs.writeFileSync(alias,'bad'),()=>fs.writeFileSync(hardlink,'bad'),()=>fs.writeFileSync(pathToFileURL(file),'bad')]){assert.throws(action,denied);checks++}
(async()=>{for(const action of[()=>fsp.writeFile(file,'bad'),()=>fsp.open(file,'a'),()=>fsp.rename(file,file+'.moved'),()=>fsp.rm(parent,{recursive:true,force:true}),()=>new Promise((resolve,reject)=>fs.writeFile(file,'bad',error=>error?reject(error):resolve()))]){await assert.rejects(action,denied);checks++}
const {Worker}=require('node:worker_threads');await new Promise((resolve,reject)=>{const worker=new Worker("const {parentPort}=require('node:worker_threads');try{require('node:fs').writeFileSync("+JSON.stringify(file)+",'bad');parentPort.postMessage(false)}catch(e){parentPort.postMessage(e.code==='verify_user_data_protected')}",{eval:true});worker.once('message',value=>{assert.equal(value,true);resolve()});worker.once('error',reject)});
assert.equal(fs.readFileSync(file,'utf8'),'original');console.log(JSON.stringify({checks,worker:true}));})().catch(error=>{console.error(error);process.exitCode=1});`
  const node = JSON.parse((await run(process.execPath, ['-e', source])).trim())
  assert.equal(node.checks, 15); assert.equal(node.worker, true)
  const electronEntry = path.join(fixture, 'electron.cjs')
  fs.writeFileSync(electronEntry, `const{app}=require('electron'),fs=require('node:fs');app.setPath('userData',${JSON.stringify(path.join(fixture,'electron-profile'))});app.whenReady().then(()=>{let denied=false;try{fs.writeFileSync(${JSON.stringify(sentinel)},'bad')}catch(error){denied=error.code==='verify_user_data_protected'}console.log('electron-guard:'+denied);app.exit(denied?0:1)})`)
  assert.ok((await run(require('electron'), [electronEntry])).includes('electron-guard:true'))
  const swallowed = path.join(fixture, 'swallowed.cjs')
  fs.writeFileSync(swallowed, `try { require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'bad') } catch {} process.exit(0)`)
  let intentionalReport
  await assert.rejects(run(process.execPath, [path.join(__dirname,'run-verify.cjs'),swallowed], { ...env, WALLPAPER_VERIFY_EXPECT_GUARD_FAILURES:'0' }), error => {
    assert.equal(error.code,1)
    intentionalReport=error.stderr.split(/\r?\n/).find(line=>line.startsWith('Verification attempted a protected project-data mutation: '))?.slice('Verification attempted a protected project-data mutation: '.length)
    return Boolean(intentionalReport)
  })
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'original')
  const evidence = { date:new Date().toISOString(), fixture:path.relative(root,fixture), passed:['sync/callback/promise filesystem mutation blocked before write','writable open and streams blocked','recursive ancestor mutation blocked','relative filesystem alias, hardlink and file URL blocked','worker preload inherits protection','actual Electron main preload inherits protection','runner fails even when the test catches the protection error and explicitly exits zero'], checks:node.checks, intentionalReport:path.relative(root,intentionalReport),
    conditions:'Synthetic protected directory only; no project fallback mutation attempted. Guard is for accidental verification writes, not a general security sandbox. Junction fixture retained.' }
  fs.writeFileSync(path.join(parent, 'test-data-guard-evidence.json'), JSON.stringify(evidence,null,2)); console.log(JSON.stringify(evidence))
})().catch(error => { console.error(error.stdout || '', error.stderr || '', error); process.exitCode=1 })
