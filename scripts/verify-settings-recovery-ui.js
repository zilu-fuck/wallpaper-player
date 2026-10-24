const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{execFile}=require('node:child_process')
const root=path.resolve(__dirname,'..'),parent=path.join(root,'.tmp/refactor-tests');fs.mkdirSync(parent,{recursive:true})
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),fallback=path.join(root,'.tmp-wallpaper-player/settings.json'),before=fs.existsSync(fallback)?hash(fallback):null
const results=[]
;(async()=>{
 for(const mode of['corrupt','future','cancel','restore','changed']){
  const fixture=fs.mkdtempSync(path.join(parent,'settings-recovery-native-中文 空格-'))
  fs.writeFileSync(path.join(fixture,'settings.json'),mode==='future'?JSON.stringify({schemaVersion:2,theme:'future'}):'{broken-primary')
  if(mode!=='corrupt')fs.writeFileSync(path.join(fixture,'settings.v1.backup.json'),JSON.stringify({schemaVersion:1,theme:'backup',directories:[],remoteAccess:{enabled:true}}))
  const env={...process.env,WALLPAPER_SETTINGS_RECOVERY_FIXTURE:fixture,WALLPAPER_SETTINGS_RECOVERY_MODE:mode};delete env.ELECTRON_RUN_AS_NODE
  const output=await new Promise((resolve,reject)=>execFile(require('electron'),[path.join(__dirname,'verify-settings-recovery-electron.js'),...process.argv.slice(2)],{cwd:root,env,windowsHide:true,timeout:20000,maxBuffer:1024*1024},(error,stdout,stderr)=>{
   if(error)reject(Object.assign(error,{stdout,stderr}));else resolve(stdout)
  }))
  const line=output.split(/\r?\n/).find(line=>line.startsWith('settings recovery startup passed:'));assert.ok(line,mode+' must complete startup verification')
  results.push({fixture:path.relative(root,fixture),...JSON.parse(line.slice('settings recovery startup passed:'.length))})
 }
 assert.equal(fs.existsSync(fallback)?hash(fallback):null,before)
 const evidence={date:new Date().toISOString(),results,conditions:'Actual Electron production main/index startup in separate Unicode/space profiles. Native dialog answers controlled; actual identity initialization held after recovery to avoid external service/plugin/player startup. Before-choice and failure cases create no normal window or identity store. Not manual native dialog layout, signed installer or power-loss acceptance.'}
 fs.writeFileSync(path.join(parent,'settings-recovery-electron.json'),JSON.stringify(evidence,null,2));console.log('settings recovery Electron passed: 5 actual startup cases, Unicode/space paths, no defaults overwrite, cancel/restore/stale confirmation and no pre-recovery services')
})().catch(error=>{process.stdout.write(error.stdout||'');process.stderr.write(error.stderr||'');console.error(error);process.exitCode=1})
