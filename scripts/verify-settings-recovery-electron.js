const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{app,BrowserWindow,dialog}=require('electron')
require('./test-data-guard.cjs')
app.disableHardwareAcceleration()
const root=path.resolve(__dirname,'..'),fixture=process.env.WALLPAPER_SETTINGS_RECOVERY_FIXTURE,mode=process.env.WALLPAPER_SETTINGS_RECOVERY_MODE
assert.ok(fixture&&path.dirname(path.resolve(fixture))===path.join(root,'.tmp/refactor-tests'))
app.setPath('userData',fixture);app.on('window-all-closed',()=>{})
const filename=path.join(fixture,'settings.json'),backup=path.join(fixture,'settings.v1.backup.json'),original=fs.readFileSync(filename),backupOriginal=fs.existsSync(backup)?fs.readFileSync(backup):null
const dialogs=[],realExit=app.exit.bind(app);let exitSeen=null,identityEntered=0
app.exit=code=>{exitSeen=code}
dialog.showMessageBox=async options=>{
 dialogs.push({type:options.type,title:options.title,buttons:options.buttons,defaultId:options.defaultId,cancelId:options.cancelId})
 if(mode==='changed'&&options.type==='warning')fs.writeFileSync(filename,JSON.stringify({schemaVersion:1,theme:'external-repair'}))
 return{response:['restore','changed'].includes(mode)&&options.type==='warning'?1:0}
}
const timeout=setTimeout(()=>{console.error('settings native startup timeout: '+mode);realExit(1)},15000)
app.whenReady().then(async()=>{
 assert.equal(require('../main/user-data').getUserDataDir(),fixture)
 require('../main/remote/identity').refreshIdentity=async()=>{identityEntered++;await new Promise(()=>{})}
 require('../main/index')
 const end=Date.now()+10000
 while(exitSeen===null&&identityEntered===0){if(Date.now()>end)throw Error('No startup boundary reached');await new Promise(resolve=>setTimeout(resolve,5))}
 assert.equal(BrowserWindow.getAllWindows().length,0,'no normal window/services may start before recovery is resolved')
 assert.equal(fs.existsSync(path.join(fixture,'remote-identity.json')),false)
 if(mode==='restore'){
  assert.equal(identityEntered,1);assert.equal(exitSeen,null);assert.deepEqual(fs.readFileSync(filename),backupOriginal)
  const preserved=fs.readdirSync(fixture).filter(name=>name.startsWith('settings.corrupt-'));assert.equal(preserved.length,1);assert.deepEqual(fs.readFileSync(path.join(fixture,preserved[0])),original)
 }else{
  assert.equal(identityEntered,0);assert.equal(exitSeen,1)
  if(mode==='changed'){assert.equal(JSON.parse(fs.readFileSync(filename)).theme,'external-repair');assert.equal(dialogs.length,2)}else assert.deepEqual(fs.readFileSync(filename),original)
 }
 if(backupOriginal)assert.deepEqual(fs.readFileSync(backup),backupOriginal)
 assert.equal(dialogs[0].defaultId,0);assert.equal(dialogs[0].cancelId,0)
 const files=['main/index.js','main/settings.js','main/application/settings-startup.js','main/repositories/settings-file.js']
 const result={mode,exitSeen,identityEntered,dialogs,sourceDigests:Object.fromEntries(files.map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')]))}
 console.log('settings recovery startup passed:'+JSON.stringify(result));clearTimeout(timeout);realExit(0)
}).catch(error=>{console.error(error);clearTimeout(timeout);realExit(1)})
