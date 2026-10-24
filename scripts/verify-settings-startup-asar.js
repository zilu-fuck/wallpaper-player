const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict')
const root=path.resolve(__dirname,'..'),parent=path.join(root,'.tmp/refactor-tests')
async function native(){
 require('./test-data-guard.cjs')
 const {app,BaseWindow}=require('electron'),fixture=process.env.WALLPAPER_SETTINGS_STARTUP_ASAR_FIXTURE
 assert.equal(path.dirname(path.resolve(fixture)),parent);assert.ok(path.basename(fixture).startsWith('settings-startup-asar-'))
 app.setPath('userData',path.join(fixture,'profile'));app.setPath('sessionData',path.join(fixture,'profile'));app.disableHardwareAcceleration();await app.whenReady()
 const {createSettingsJson}=require(path.join(fixture,'startup.asar/main/application/settings-json.js')),codec=createSettingsJson({idleTimeoutMs:25})
 try{
  const input=Buffer.from(JSON.stringify({customTags:Object.fromEntries(Array.from({length:10000},(_,i)=>['file-'+i,[' tag-'+i+' ']])),privacy:{salt:'a'.repeat(32),passwordHash:'b'.repeat(64)},directories:[fixture],unknown:{keep:true}}))
  const prepared=await codec.prepare(input,{cwd:fixture,sectionKeys:['unknown']})
  assert.equal(prepared.version,0);assert.equal(prepared.value.schemaVersion,1);assert.equal(Object.keys(prepared.value.customTags).length,10000)
  assert.equal(prepared.value.customTags['file-1'][0],'tag-1');assert.equal(prepared.value.privacy.passwordHash,'b'.repeat(64));assert.deepEqual(prepared.sections.unknown,{keep:true})
  const encoded=await codec.encode({base:prepared.value,baseId:prepared.id,changes:[['theme','light']]});assert.equal(JSON.parse(encoded.text).theme,'light')
  const end=Date.now()+5000;while(codec.diagnostics().worker){assert.ok(Date.now()<end);await new Promise(resolve=>setTimeout(resolve,5))}
  const fresh=await codec.prepare(Buffer.from('{}'));assert.equal(fresh.value.schemaVersion,1)
  await codec.close();assert.equal(codec.diagnostics().worker,false);assert.equal(BaseWindow.getAllWindows().length,0)
  const result={date:new Date().toISOString(),passed:true,electron:process.versions.electron,asar:true,tags:10000,windowsCreated:0,workerRetired:true,afterClose:codec.diagnostics(),scope:'Actual Electron preparation and subsequent encode from a dedicated minimal ASAR, including all relative worker/normalizer/schema imports. No native window, full installer or interactive startup timing.'}
  await fs.writeFile(path.join(fixture,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result))
 }finally{await codec.close({cancel:true})}
}
async function driver(){
 await fs.mkdir(parent,{recursive:true});const fixture=await fs.mkdtemp(path.join(parent,'settings-startup-asar-')),payload=path.join(fixture,'payload');await fs.mkdir(path.join(fixture,'profile'))
 const files=new Set(),visit=async file=>{
  if(files.has(file))return;files.add(file);const text=await fs.readFile(path.join(root,file),'utf8')
  for(const match of text.matchAll(/require\(['"]([^'"]+)['"]\)/g))if(match[1].startsWith('.')){
   let target=path.posix.normalize(path.posix.join(path.posix.dirname(file),match[1]));if(!path.posix.extname(target))target+='.js';await visit(target)
  }
 }
 await visit('main/application/settings-json.js');await visit('main/application/settings-json-worker.js')
 const sourceHashes=[];for(const file of files){const bytes=await fs.readFile(path.join(root,file));await fs.mkdir(path.dirname(path.join(payload,file)),{recursive:true});await fs.writeFile(path.join(payload,file),bytes);sourceHashes.push({file,sha256:crypto.createHash('sha256').update(bytes).digest('hex')})}
 await require('@electron/asar').createPackage(payload,path.join(fixture,'startup.asar'));await fs.writeFile(path.join(fixture,'source-hashes.json'),JSON.stringify(sourceHashes,null,2))
 const env={...process.env,WALLPAPER_SETTINGS_STARTUP_ASAR_FIXTURE:fixture};delete env.ELECTRON_RUN_AS_NODE
 try{const result=await require('node:util').promisify(require('node:child_process').execFile)(require('electron'),[__filename],{cwd:root,env,windowsHide:true,timeout:20000,maxBuffer:1024*1024});await fs.writeFile(path.join(fixture,'electron.log'),result.stdout+result.stderr);console.log(result.stdout.trim())}
 catch(error){await fs.writeFile(path.join(fixture,'electron.log'),(error.stdout||'')+(error.stderr||''));throw error}
}
if(process.versions.electron){const timer=setTimeout(()=>require('electron').app.exit(2),15000);native().then(()=>{clearTimeout(timer);require('electron').app.exit(0)},error=>{console.error(error);require('electron').app.exit(1)})}
else driver().catch(error=>{console.error(error);process.exitCode=1})
