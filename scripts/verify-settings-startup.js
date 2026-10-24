const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{createRequire}=require('node:module')
const {createSettingsJson}=require('../main/application/settings-json'),{createSettingsFile,parseDocument}=require('../main/repositories/settings-file')
const {prepareSettingsForStartup}=require('../main/application/settings-startup')
const root=path.resolve(__dirname,'..'),parent=path.join(root,'.tmp/refactor-tests');fs.mkdirSync(parent,{recursive:true})
const fixture=fs.mkdtempSync(path.join(parent,'settings-startup-')),cases=[],apis=[],codecs=[],gates=[]
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);const value={promise,resolve};gates.push(value);return value}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),until=async check=>{const end=Date.now()+5000;while(!check()){if(Date.now()>end)throw Error('Startup condition timed out');await delay(3)}}
const timeout=setTimeout(()=>{console.error('settings startup verification timed out');process.exit(1)},45000)
let sequence=0
const scenario=()=>{const directory=path.join(fixture,'case-'+(++sequence));fs.mkdirSync(directory);return{directory,filename:path.join(directory,'settings.json')}}
function load(file,overrides={},sourceRoot=root){const filename=path.join(root,file),normal=createRequire(filename),module={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(sourceRoot,file),'utf8'),{module,exports:module.exports,require:name=>Object.hasOwn(overrides,name)?overrides[name]:normal(name),JSON,Buffer,console,process,setTimeout,clearTimeout,setImmediate,clearImmediate,structuredClone,URL},{filename});return module.exports}
function apiFor(item,{gate,sourceRoot=root,codecOptions}={}){
 let directory=item.directory,prepares=0,entered=false
 const codec=createSettingsJson(codecOptions);codecs.push(codec)
 const controlled={...codec,async prepare(...args){prepares++;entered=true;if(gate&&prepares===1)await gate.promise;return codec.prepare(...args)}}
 const api=load('main/settings.js',{'electron':{},'./user-data':{getUserDataDir:()=>directory},'./application/settings-json':{createSettingsJson:()=>controlled}},sourceRoot)
 apis.push(api);return{api,codec,prepares:()=>prepares,entered:()=>entered,move:value=>directory=value}
}
const data=directory=>({schemaVersion:1,theme:'light',directories:[directory],privateDirectories:[],downloadDirectories:[directory],
 customTags:Object.fromEntries(Array.from({length:10000},(_,i)=>['file-'+i,[' tag-'+i+' ','tag-'+i]])),customTagRevisions:{['a'.repeat(64)]:2},
 privacy:{salt:'a'.repeat(32),passwordHash:'b'.repeat(64)},unknown:{keep:['extension']},playbackStates:{one:{position:4,volume:0,speed:1.5,updatedAt:1}},networkResources:[]})
async function countInitial(api,filename){
 const parse=JSON.parse,read=fs.readFileSync,real=fs.realpathSync.native;let fullParses=0,syncReads=0,syncRealpaths=0
 JSON.parse=(...args)=>{const value=parse(...args);if(value&&typeof value==='object'&&['customTags','directories','privacy'].every(key=>Object.hasOwn(value,key)))fullParses++;return value}
 fs.readFileSync=function(file,...args){if(path.resolve(String(file))===filename)syncReads++;return read.call(this,file,...args)}
 fs.realpathSync.native=function(...args){syncRealpaths++;return real.apply(this,args)}
 try{assert.equal(await prepareSettingsForStartup({settings:api,dialog:{showMessageBox(){throw Error('unexpected recovery dialog')}}}),true)}
 finally{JSON.parse=parse;fs.readFileSync=read;fs.realpathSync.native=real}
 return{fullParses,syncReads,syncRealpaths}
}
async function comparison(){
 const item=scenario(),input=data(item.directory);Object.defineProperty(input,'__proto__',{value:{safe:true},enumerable:true});const original=Buffer.from('\ufeff'+JSON.stringify(input));fs.writeFileSync(item.filename,original)
 const current=apiFor(item),joined=current.api.initializeSettings(),second=current.api.initializeSettings();assert.equal(joined,second);await joined
 assert.equal(current.prepares(),1);assert.deepEqual(fs.readFileSync(item.filename),original)
 const normalized=current.api.loadSettings();assert.equal(normalized.customTags['file-1'].length,1);assert.equal(normalized.playbackStates.one.volume,0)
 assert.equal(Object.hasOwn(normalized,'__proto__'),true);assert.equal(normalized.__proto__.safe,true);assert.equal(Object.prototype.safe,undefined)
 normalized.unknown.keep.push('outside');assert.equal(current.api.loadSettings().unknown.keep.length,1)
 cases.push('coalesced startup publishes one detached canonical cache, preserves private/extension data and special keys, and remains read-only')

 const cold=scenario();fs.writeFileSync(cold.filename,JSON.stringify(data(cold.directory)))
 const counters=await countInitial(apiFor(cold).api,cold.filename);assert.deepEqual(counters,{fullParses:0,syncReads:0,syncRealpaths:0})
 const baselinePath=path.join(parent,'r7-settings-startup/baseline'),prior=scenario();fs.writeFileSync(prior.filename,JSON.stringify(data(prior.directory)))
 let before=null
 if(fs.existsSync(path.join(baselinePath,'main/settings.js'))){before=await countInitial(apiFor(prior,{sourceRoot:baselinePath}).api,prior.filename);assert.equal(before.fullParses,3);assert.equal(before.syncReads,1);assert.ok(before.syncRealpaths>0)}
 cases.push('10000-tag initial preparation performs zero full main JSON.parse, synchronous settings reads and synchronous canonical-path calls; captured previous source is a positive control when present')
 return{before,after:counters,tags:10000}
}
async function coreRaces(){
 const sync=scenario();fs.writeFileSync(sync.filename,JSON.stringify(data(sync.directory)));const held=deferred(),owner=apiFor(sync,{gate:held})
 const preparing=owner.api.initializeSettings();await until(owner.entered);owner.api.saveSettings({theme:'newer-synchronous-intent'});held.resolve();await preparing
 assert.equal(owner.api.loadSettingsFields(['theme']).theme,'newer-synchronous-intent');await owner.api.flushSettingsWrites()
 cases.push('a synchronous reader/write during startup supersedes the old storage read and its newer cache cannot be overwritten')

 const busy=scenario(),release=path.join(busy.directory,'release'),worker=path.join(busy.directory,'held-worker.cjs')
 fs.writeFileSync(busy.filename,JSON.stringify({...data(busy.directory),__hold:release}))
 gates.push({resolve:()=>fs.writeFileSync(release,'release')})
 fs.writeFileSync(worker,`const {parentPort}=require('node:worker_threads'),fs=require('node:fs'),listen=parentPort.on.bind(parentPort);parentPort.on=(event,callback)=>listen(event,message=>{if(message.op==='prepare'){const value=JSON.parse(Buffer.from(message.input).toString());if(value.__hold){fs.writeFileSync(value.__hold+'.entered','1');const wait=new Int32Array(new SharedArrayBuffer(4));while(!fs.existsSync(value.__hold))Atomics.wait(wait,0,0,10)}}callback(message)});require(${JSON.stringify(path.join(root,'main/application/settings-json-worker.js'))});`)
 const queued=apiFor(busy,{codecOptions:{workerFile:worker}}),loading=queued.api.initializeSettings()
 await until(()=>fs.existsSync(release+'.entered'));assert.equal(queued.codec.diagnostics().active,true)
 queued.api.saveSettings({theme:'queued-intent'});await delay(110)
 fs.writeFileSync(release,'release');await loading;await queued.api.flushSettingsWrites()
 assert.equal(JSON.parse(fs.readFileSync(busy.filename)).theme,'queued-intent')
 cases.push('a debounced synchronous save waits for an actually blocked startup worker, then durably commits the newer intent without a busy-serializer failure')

 const section=scenario();fs.writeFileSync(section.filename,JSON.stringify({...data(section.directory),custom:{value:7}}));const sectionGate=deferred(),registered=apiFor(section,{gate:sectionGate}),calls=[]
 const first=registered.api.initializeSettings();await until(registered.entered)
 const remove=registered.api.registerSettingsSection('custom',{defaults:{value:1},normalize:value=>{calls.push(value?.value);return{toJSON(key){return{value:value?.value??1,key}}}}})
 sectionGate.resolve();await first;assert.equal(registered.prepares(),2)
 assert.deepEqual(JSON.parse(JSON.stringify(registered.api.loadSettingsFields(['custom']).custom)),{value:7,key:'custom'});assert.deepEqual(calls,[1,7]);remove()
 const facade=load('main/plugins/core-api.js',{'../settings':registered.api}).requireCoreModule('settings')
 assert.equal(facade.initializeSettings,undefined);assert.equal(facade.recoverSettingsBackup,undefined)
 cases.push('late extension registration retries the owned read, keeps main-owned callback/toJSON semantics and hides startup privileges from the plugin facade')

 const old=scenario(),fresh=scenario();fs.writeFileSync(old.filename,JSON.stringify({...data(old.directory),theme:'old-profile'}));fs.writeFileSync(fresh.filename,JSON.stringify({...data(fresh.directory),theme:'new-profile'}))
 const scopeGate=deferred(),scope=apiFor(old,{gate:scopeGate}),oldRead=scope.api.initializeSettings(),retired=assert.rejects(oldRead,{code:'settings_startup_retired'})
 await until(scope.entered);scope.move(fresh.directory);const freshRead=scope.api.initializeSettings();scopeGate.resolve();await retired;await freshRead
 assert.equal(scope.api.loadSettingsFields(['theme']).theme,'new-profile')
 const closing=scenario();fs.writeFileSync(closing.filename,JSON.stringify(data(closing.directory)));const closeGate=deferred(),closed=apiFor(closing,{gate:closeGate})
 const pending=closed.api.initializeSettings(),cancelled=assert.rejects(pending,{code:'app_quitting'});await until(closed.entered);await closed.api.disposeSettingsSerialization({cancel:true});closeGate.resolve();await cancelled
 assert.equal(closed.codec.diagnostics().worker,false);assert.equal(closed.codec.diagnostics().active,false)
 cases.push('changed profile scopes and shutdown invalidate late preparation, without publishing an old profile or reviving a closed worker')
}
async function storageRaces(){
 const item=scenario(),raw=Buffer.from(JSON.stringify({schemaVersion:1,theme:'first'}));fs.writeFileSync(item.filename,raw)
 const store=createSettingsFile(item.filename),gate=deferred();let entered=false
 const pending=store.readAsync(async bytes=>{entered=true;await gate.promise;return parseDocument(bytes)}),superseded=assert.rejects(pending,{code:'settings_read_changed'})
 await until(()=>entered);assert.equal(store.read().theme,'first');gate.resolve();await superseded
 await store.write(Buffer.from(JSON.stringify({schemaVersion:1,theme:'second'})));assert.deepEqual(fs.readFileSync(store.paths().backup),raw)
 const external=scenario();fs.writeFileSync(external.filename,raw);const externalStore=createSettingsFile(external.filename),changedGate=deferred();let reached=false
 const changed=externalStore.readAsync(async bytes=>{reached=true;await changedGate.promise;return parseDocument(bytes)}),rejected=assert.rejects(changed,{code:'settings_read_changed'})
 await until(()=>reached);fs.writeFileSync(external.filename,JSON.stringify({schemaVersion:1,theme:'external'}));changedGate.resolve();await rejected
 assert.equal(externalStore.read().theme,'external')
 cases.push('storage generation and byte revalidation reject superseded/external edits, while later backups retain exact previous committed bytes')

 const corrupt=scenario(),backup=path.join(corrupt.directory,'settings.v1.backup.json');fs.writeFileSync(corrupt.filename,'SECRET-broken-json');fs.writeFileSync(backup,JSON.stringify({schemaVersion:1,theme:'recovered'}))
 const owner=apiFor(corrupt),dialogs=[]
 assert.equal(await prepareSettingsForStartup({settings:owner.api,dialog:{showMessageBox:async value=>{dialogs.push(value);return{response:0}}}}),false)
 assert.equal(fs.readFileSync(corrupt.filename,'utf8'),'SECRET-broken-json');assert.equal(dialogs[0].defaultId,0);assert.equal(dialogs[0].message.includes('SECRET'),false)
 assert.equal(await prepareSettingsForStartup({settings:owner.api,dialog:{showMessageBox:async()=>({response:1})}}),true)
 assert.equal(owner.api.loadSettingsFields(['theme']).theme,'recovered');assert.equal(fs.readdirSync(corrupt.directory).filter(name=>name.startsWith('settings.corrupt-')).length,1)
 const future=scenario();fs.writeFileSync(future.filename,JSON.stringify({schemaVersion:2,theme:'future'}));fs.writeFileSync(path.join(future.directory,'settings.v1.backup.json'),JSON.stringify({schemaVersion:1,theme:'old'}))
 await assert.rejects(apiFor(future).api.initializeSettings(),{code:'settings_unsupported_version',schemaVersion:2})
 const missing=scenario();const empty=apiFor(missing);await empty.api.initializeSettings();assert.equal(fs.existsSync(missing.filename),false)
 const legacy=scenario(),legacyBytes=Buffer.from('\ufeff'+JSON.stringify({theme:'light',unknown:{keep:true}}));fs.writeFileSync(legacy.filename,legacyBytes)
 const migrated=apiFor(legacy);await migrated.api.initializeSettings();await migrated.api.commitSettingsPatch({theme:'dark'},{returnSettings:false})
 assert.deepEqual(fs.readFileSync(path.join(legacy.directory,'settings.v1.backup.json')),legacyBytes)
 const journal=JSON.parse(fs.readFileSync(path.join(legacy.directory,'settings-migration.json')));assert.equal(journal.from,0);assert.equal(journal.sourceSha256,crypto.createHash('sha256').update(legacyBytes).digest('hex'))
 cases.push('asynchronous startup keeps explicit backup consent, corrupt originals, future-version refusal and read-only missing-profile behavior')
}
async function workerBehavior(){
 const codec=createSettingsJson({maxBytes:1000});codecs.push(codec)
 await assert.rejects(codec.prepare(Buffer.from('SECRET-parse-fragment')),error=>error.code==='settings_corrupt'&&!error.message.includes('SECRET'))
 await assert.rejects(codec.prepare(Buffer.from(JSON.stringify({schemaVersion:1,large:'a'.repeat(5000)}))),{code:'settings_too_large'})
 const ready=await codec.prepare(Buffer.from('{"schemaVersion":1,"theme":"light"}'));assert.equal(ready.value.theme,'light')
 const next=await codec.encode({base:ready.value,baseId:ready.id,changes:[['theme','dark']]});assert.equal(JSON.parse(next.text).theme,'dark')
 await codec.close();assert.equal(codec.diagnostics().worker,false)
 assert.equal(await prepareSettingsForStartup({settings:{initializeSettings:async()=>{throw Object.assign(Error('closing'),{code:'app_quitting'})}},dialog:{showMessageBox(){throw Error('shutdown must not open a dialog')}}}),false)
 cases.push('startup worker masks private parser fragments, enforces configured size limits, hands its canonical base to later encoding and closes without a shutdown dialog')
 const controlled=path.join(fixture,'controlled-startup.cjs')
 fs.writeFileSync(controlled,`const {parentPort}=require('node:worker_threads'),listen=parentPort.on.bind(parentPort);parentPort.on=(event,callback)=>listen(event,message=>{
 if(message.op==='prepare'){const value=JSON.parse(Buffer.from(message.input).toString());if(value.__crash)process.exit(17);if(value.__hang)return;if(value.__bad){parentPort.postMessage({id:message.id,text:'{}',value:{},version:1,sections:{},documentVersion:1});return}}callback(message)});require(${JSON.stringify(path.join(root,'main/application/settings-json-worker.js'))});`)
 for(const[flag,code]of[['__crash','settings_serializer_stopped'],['__bad','settings_startup_invalid_reply'],['__hang','settings_startup_timeout']]){
  const fault=createSettingsJson({workerFile:controlled,timeoutMs:200});codecs.push(fault)
  await assert.rejects(fault.prepare(Buffer.from(JSON.stringify({[flag]:true}))),{code})
  assert.equal((await fault.prepare(Buffer.from('{}'))).value.schemaVersion,1);await fault.close();assert.equal(fault.diagnostics().worker,false)
 }
 const invalid=createSettingsJson({workerFile:'relative-invalid.cjs'});codecs.push(invalid)
 await assert.rejects(invalid.prepare(Buffer.from('{}')),{code:'ERR_WORKER_PATH'});await invalid.close()
 cases.push('startup crash, malformed reply, timeout and worker construction failure settle callers, retire owned workers and permit recovery')
}
;(async()=>{try{const mainComparison=await comparison();await coreRaces();await storageRaces();await workerBehavior()
 const files=['main/settings.js','main/repositories/settings-file.js','main/repositories/settings-normalize.js','main/path-identity.js','main/repositories/tag-state.js','main/repositories/tag-normalizers.js','main/application/settings-json.js','main/application/settings-json-worker.js','main/application/settings-startup.js','main/index.js','main/plugins/core-api.js','scripts/verify-settings-startup.js']
 const result={date:new Date().toISOString(),passed:true,fixture,cases,mainComparison,sourceDigests:Object.fromEntries(files.map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')])),scope:'Real Node workers, storage and settings code in isolated VM owners with actual atomic writes; controlled IO/worker delays and dialog choices. No native startup latency, interactive budget or full installer acceptance.'}
 fs.writeFileSync(path.join(fixture,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2))
}finally{gates.forEach(gate=>gate.resolve());await Promise.allSettled(apis.map(api=>api.disposeSettingsSerialization({cancel:true})));await Promise.allSettled(codecs.map(codec=>codec.close({cancel:true})));clearTimeout(timeout)}})().catch(error=>{console.error(error);process.exitCode=1})
