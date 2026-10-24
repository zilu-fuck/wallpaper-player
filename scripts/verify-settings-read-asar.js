const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto')
const root=path.resolve(__dirname,'..'),parent=path.join(root,'.tmp/refactor-tests')
const sources=['main/application/settings-reader.js','main/application/settings-read-worker.js','main/repositories/settings-renderer.js','main/security/privacy-password.js']
async function native(){
 require('./test-data-guard.cjs')
 const {app,BaseWindow}=require('electron'),fixture=process.env.WALLPAPER_SETTINGS_READ_ASAR_FIXTURE
 assert.equal(path.dirname(path.resolve(fixture)),parent);assert.ok(path.basename(fixture).startsWith('settings-read-asar-'))
 app.setPath('userData',path.join(fixture,'profile'));app.setPath('sessionData',path.join(fixture,'profile'));app.disableHardwareAcceleration()
 await app.whenReady();assert.equal(BaseWindow.getAllWindows().length,0)
 const {createSettingsReader}=require(path.join(fixture,'reader.asar/main/application/settings-reader.js'))
 const reader=createSettingsReader({idleTimeoutMs:20})
 try{
  const text=JSON.stringify({customTags:Object.fromEntries(Array.from({length:10000},(_,i)=>['file-'+i,['tag-'+i]])),privacy:{salt:'a'.repeat(32),passwordHash:'b'.repeat(64)},tagMutationReceipts:{private:true}})
  const wire=await reader.read(text,{epoch:'asar-native',revision:1}),value=JSON.parse(wire.text)
  assert.equal(Object.keys(value.customTags).length,10000);assert.deepEqual(value.privacy,{passwordSet:true});assert.equal(value.tagMutationReceipts,undefined)
  const end=Date.now()+5000;while(reader.diagnostics().worker){assert.ok(Date.now()<end);await new Promise(resolve=>setTimeout(resolve,5))}
  await reader.read(text,{epoch:'asar-native',revision:1});assert.equal(reader.diagnostics().started,1)
  await reader.read(text,{epoch:'asar-native',revision:2});assert.equal(reader.diagnostics().started,2)
  await reader.close();assert.equal(reader.diagnostics().worker,false);assert.equal(BaseWindow.getAllWindows().length,0)
  const result={passed:true,electron:process.versions.electron,asar:true,tags:10000,windowsCreated:0,workerRetired:true,afterClose:reader.diagnostics(),scope:'Actual Electron worker module loaded from a dedicated minimal ASAR; no production installer, decoder, window or foreground activity'}
  await fs.writeFile(path.join(fixture,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result))
 }finally{await reader.close({cancel:true})}
}
async function driver(){
 await fs.mkdir(parent,{recursive:true});const fixture=await fs.mkdtemp(path.join(parent,'settings-read-asar-')),payload=path.join(fixture,'payload');await fs.mkdir(path.join(fixture,'profile'))
 const sourceHashes=[];for(const file of sources){const bytes=await fs.readFile(path.join(root,file));await fs.mkdir(path.dirname(path.join(payload,file)),{recursive:true});await fs.writeFile(path.join(payload,file),bytes);sourceHashes.push({file,sha256:crypto.createHash('sha256').update(bytes).digest('hex')})}
 await require('@electron/asar').createPackage(payload,path.join(fixture,'reader.asar'))
 await fs.writeFile(path.join(fixture,'source-hashes.json'),JSON.stringify(sourceHashes,null,2))
 const env={...process.env,WALLPAPER_SETTINGS_READ_ASAR_FIXTURE:fixture};delete env.ELECTRON_RUN_AS_NODE
 try{const result=await require('node:util').promisify(require('node:child_process').execFile)(require('electron'),[__filename],{cwd:root,env,windowsHide:true,timeout:20000,maxBuffer:1024*1024});await fs.writeFile(path.join(fixture,'electron.log'),result.stdout+result.stderr);console.log(result.stdout.trim())}
 catch(error){await fs.writeFile(path.join(fixture,'electron.log'),(error.stdout||'')+(error.stderr||''));throw error}
}
if(process.versions.electron){const timer=setTimeout(()=>require('electron').app.exit(2),15000);native().then(()=>{clearTimeout(timer);require('electron').app.exit(0)},error=>{console.error(error);require('electron').app.exit(1)})}
else driver().catch(error=>{console.error(error);process.exitCode=1})
