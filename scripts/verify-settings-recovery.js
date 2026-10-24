const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{fork,execFile}=require('node:child_process')
const {createSettingsFile}=require('../main/repositories/settings-file'),{prepareSettingsForStartup}=require('../main/application/settings-startup')
const root=path.resolve(__dirname,'..'),parent=path.join(root,'.tmp/refactor-tests');fs.mkdirSync(parent,{recursive:true})
const fixture=fs.mkdtempSync(path.join(parent,'settings-recovery-')),passed=[],sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex')
const encoded=(theme,extra={})=>Buffer.from(JSON.stringify({schemaVersion:1,theme,...extra})),read=file=>fs.readFileSync(file)
function scenario(name){const dir=path.join(fixture,name);fs.mkdirSync(dir);const filename=path.join(dir,'settings.json'),warnings=[],store=createSettingsFile(filename,{onWarning:error=>warnings.push(error.code)});return{dir,filename,store,warnings,...store.paths()}}
function throwsRead(store,code){let failure;try{store.read()}catch(error){failure=error}assert.equal(failure?.code,code);return failure}
async function adapterCases(){
 const fresh=scenario('fresh');assert.deepEqual(fresh.store.read(),{});assert.equal(fs.existsSync(fresh.filename),false)
 await fresh.store.write(encoded('first'));assert.deepEqual(read(fresh.backup),read(fresh.filename));await fresh.store.write(encoded('second'))
 assert.equal(JSON.parse(read(fresh.backup)).theme,'first');assert.equal(JSON.parse(read(fresh.filename)).theme,'second')
 passed.push('fresh installs stay read-only until a commit; first backup and prior-generation rotation are complete')
 const ownership=scenario('buffer-ownership'),intent=encoded('captured');const committing=ownership.store.write(intent);intent.fill(0);await committing
 await ownership.store.write(encoded('next'));assert.equal(JSON.parse(read(ownership.backup)).theme,'captured')
 passed.push('write input bytes are captured before asynchronous IO and cannot mutate the next backup generation')
 const legacy=scenario('legacy'),raw=Buffer.from('\ufeff'+JSON.stringify({theme:'light',unknown:{keep:['all']},favorites:['legacy-key']}))
 fs.writeFileSync(legacy.filename,raw);assert.equal(legacy.store.read().theme,'light');await legacy.store.write(encoded('dark',{unknown:{keep:['all']},favorites:['legacy-key']}))
 assert.deepEqual(read(legacy.backup),raw);const journal=JSON.parse(read(legacy.migration));assert.equal(journal.from,0);assert.equal(journal.to,1);assert.equal(journal.sourceSha256,sha(raw))
 passed.push('legacy BOM/plain-object data is backed up byte-for-byte and schema migration records retain source identity')
 for(const text of['{broken','[]','null','',JSON.stringify({schemaVersion:-1})]){const item=scenario('bad-'+crypto.randomUUID());fs.writeFileSync(item.filename,text)
  throwsRead(item.store,'settings_recovery_unavailable');await assert.rejects(item.store.write(encoded('must-not-write')));assert.equal(read(item.filename).toString(),text)}
 passed.push('truncation, empty, non-object and invalid versions never turn into defaults or get overwritten')
 const future=scenario('future');fs.writeFileSync(future.filename,JSON.stringify({schemaVersion:2,theme:'newer'}));fs.writeFileSync(future.backup,encoded('old'))
 throwsRead(future.store,'settings_unsupported_version');await assert.rejects(future.store.write(encoded('downgrade')));assert.equal(JSON.parse(read(future.filename)).schemaVersion,2)
 passed.push('unsupported primary versions cannot silently fall back or be downgraded by a write')
 const both=scenario('both-invalid');fs.writeFileSync(both.filename,'bad-primary');fs.writeFileSync(both.backup,'bad-backup')
 throwsRead(both.store,'settings_recovery_unavailable');await assert.rejects(both.store.write(encoded('must-not-write')));assert.equal(read(both.filename).toString(),'bad-primary');assert.equal(read(both.backup).toString(),'bad-backup')
 passed.push('simultaneously invalid primary and backup remain unchanged and cannot be replaced by defaults')
 const recovery=scenario('recovery');const corrupt=Buffer.from('{broken-original'),good=encoded('backup',{privacy:{passwordHash:'synthetic-private-value'}})
 fs.writeFileSync(recovery.filename,corrupt);fs.writeFileSync(recovery.backup,good);const candidate=throwsRead(recovery.store,'settings_backup_available')
 assert.ok(!candidate.message.includes('synthetic-private-value'));assert.deepEqual(read(recovery.filename),corrupt)
 const restored=await recovery.store.recover(candidate.recoveryId);assert.deepEqual(read(restored.preservedPath),corrupt);assert.deepEqual(read(recovery.filename),good);assert.deepEqual(read(recovery.backup),good)
 passed.push('recovery is explicit, preserves corrupt bytes separately and never exposes document content in diagnostics')
 const restoreFailure=scenario('restore-failure');fs.writeFileSync(restoreFailure.filename,'keep-broken');fs.writeFileSync(restoreFailure.backup,encoded('safe'));const failureCandidate=throwsRead(restoreFailure.store,'settings_backup_available'),renameBefore=fs.promises.rename
 fs.promises.rename=async(from,to)=>{if(to===restoreFailure.filename)throw Object.assign(Error('fixture'),{code:'EACCES'});return renameBefore(from,to)}
 try{await assert.rejects(restoreFailure.store.recover(failureCandidate.recoveryId),error=>error.code==='settings_recovery_failed'&&error.settingsPath===restoreFailure.filename);assert.equal(read(restoreFailure.filename).toString(),'keep-broken');assert.equal(JSON.parse(read(restoreFailure.backup)).theme,'safe')}finally{fs.promises.rename=renameBefore}
 passed.push('failed restore reports stable diagnostic paths and retains the corrupt primary and valid backup')
 const missing=scenario('missing-primary');fs.writeFileSync(missing.backup,encoded('surviving'));const mc=throwsRead(missing.store,'settings_backup_available');const mr=await missing.store.recover(mc.recoveryId);assert.equal(mr.preservedPath,null);assert.equal(missing.store.read().theme,'surviving')
 passed.push('a missing primary with a surviving backup requires recovery rather than a new blank profile')
 const changed=scenario('changed');fs.writeFileSync(changed.filename,'bad');fs.writeFileSync(changed.backup,encoded('prior'));const cc=throwsRead(changed.store,'settings_backup_available');fs.writeFileSync(changed.filename,encoded('external-repair'))
 await assert.rejects(changed.store.recover(cc.recoveryId),{code:'settings_recovery_changed'});assert.equal(changed.store.read().theme,'external-repair')
 const bc=throwsRead((()=>{fs.writeFileSync(changed.filename,'bad-again');return changed.store})(),'settings_backup_available');fs.writeFileSync(changed.backup,encoded('different'))
 await assert.rejects(changed.store.recover(bc.recoveryId),{code:'settings_recovery_changed'})
 passed.push('changed primary/backup candidates cannot be restored using a stale confirmation')
 const permission=scenario('permission'),nativeRead=fs.readFileSync
 fs.readFileSync=function(file,...args){if(file===permission.filename)throw Object.assign(Error('fixture'),{code:'EACCES'});return nativeRead.call(this,file,...args)}
 try{throwsRead(permission.store,'settings_unreadable')}finally{fs.readFileSync=nativeRead}
 passed.push('permission and filesystem read failures are visible and do not create defaults')
 const failure=scenario('failed-commit');await failure.store.write(encoded('stable'));const nativeRename=fs.promises.rename
 for(const destination of[failure.backup,failure.filename]){fs.promises.rename=async(from,to)=>{if(to===destination)throw Object.assign(Error('fixture rename failure'),{code:'EACCES'});return nativeRename(from,to)}
  try{await assert.rejects(failure.store.write(encoded('failed')),{code:'EACCES'});assert.equal(JSON.parse(read(failure.filename)).theme,'stable')}finally{fs.promises.rename=nativeRename}}
 await failure.store.write(encoded('recovered'));assert.equal(JSON.parse(read(failure.backup)).theme,'stable');assert.equal(fs.readdirSync(failure.dir).some(name=>name.endsWith('.tmp')),false)
 passed.push('backup and primary rename failures keep the last committed primary, clean own temporaries and allow retry')
 const audit=scenario('audit-failure');fs.writeFileSync(audit.filename,JSON.stringify({theme:'legacy'}));audit.store.read()
 fs.promises.rename=async(from,to)=>{if(to===audit.migration)throw Error('fixture audit failure');return nativeRename(from,to)}
 try{await audit.store.write(encoded('committed'));assert.equal(JSON.parse(read(audit.filename)).theme,'committed');assert.deepEqual(audit.warnings,['settings_migration_log_failed'])}finally{fs.promises.rename=nativeRename}
 await audit.store.write(encoded('next'));assert.equal(JSON.parse(read(audit.migration)).from,0)
 passed.push('audit failure cannot report an already committed write as failed and its record retries later')
 const first=scenario('first-backup-failure');fs.promises.rename=async(from,to)=>{if(to===first.backup)throw Error('fixture initial backup failure');return nativeRename(from,to)}
 try{await first.store.write(encoded('committed'));assert.equal(JSON.parse(read(first.filename)).theme,'committed');assert.deepEqual(first.warnings,['settings_backup_failed'])}finally{fs.promises.rename=nativeRename}
 await first.store.write(encoded('next'));assert.equal(JSON.parse(read(first.backup)).theme,'committed')
 passed.push('initial backup failure preserves successful primary semantics and a later commit repairs the backup')
 const sync=scenario('sync');sync.store.writeSync(encoded('one'));sync.store.writeSync(encoded('two'));assert.equal(JSON.parse(read(sync.backup)).theme,'one')
 fs.writeFileSync(sync.filename,'bad-now');throwsRead(sync.store,'settings_backup_available');assert.throws(()=>sync.store.writeSync(encoded('forbidden')));assert.equal(read(sync.filename).toString(),'bad-now')
 passed.push('synchronous exit writes rotate backups and a later failed read also blocks synchronous overwrite')
 const prompt=scenario('prompt');fs.writeFileSync(prompt.filename,'corrupt');fs.writeFileSync(prompt.backup,encoded('safe'))
 const api={loadSettings:()=>prompt.store.read(),recoverSettingsBackup:id=>prompt.store.recover(id)},dialogs=[]
 assert.equal(await prepareSettingsForStartup({settings:api,dialog:{showMessageBox:async value=>{dialogs.push(value);return{response:0}}}}),false);assert.equal(read(prompt.filename).toString(),'corrupt');assert.equal(dialogs[0].defaultId,0)
 assert.equal(await prepareSettingsForStartup({settings:api,dialog:{showMessageBox:async()=>({response:1})}}),true);assert.equal(prompt.store.read().theme,'safe')
 passed.push('startup cancellation preserves files and explicit recovery starts only after successful restore')
}
async function crashCases(){
 const child=path.join(fixture,'interrupted.cjs'),storage=path.join(root,'main/repositories/settings-file.js')
 fs.writeFileSync(child,`const fs=require('node:fs'),{createSettingsFile}=require(${JSON.stringify(storage)}),file=process.argv[2],phase=process.argv[3],fsp=fs.promises,nativeRename=fsp.rename,nativeWrite=fsp.writeFile;const hold=()=>{process.send({ready:true});return new Promise(()=>{})};
fsp.rename=async(from,to)=>{if(to===file&&phase==='before-primary')return hold();const result=await nativeRename(from,to);if(to===file&&phase==='after-primary')return hold();return result};
fsp.writeFile=async(fileName,bytes,options)=>{if(String(fileName).startsWith(file+'.')&&phase==='partial-temp'){await nativeWrite(fileName,Buffer.from('partial'),options);return hold()}return nativeWrite(fileName,bytes,options)};
createSettingsFile(file).write(Buffer.from(JSON.stringify({schemaVersion:1,theme:'new'}))).catch(error=>{console.error(error);process.exit(1)});`)
 for(const phase of['partial-temp','before-primary','after-primary']){
  const item=scenario('crash-'+phase);fs.writeFileSync(item.filename,encoded('old'))
  const processChild=fork(child,[item.filename,phase],{windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});let stderr='';processChild.stderr.on('data',data=>stderr+=data)
  try{await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Crash gate timeout: '+phase+' '+stderr)),10000);processChild.once('message',()=>{clearTimeout(timer);resolve()});processChild.once('error',reject);processChild.once('exit',()=>{clearTimeout(timer);reject(Error('Child exited before gate: '+stderr))})});processChild.kill();await new Promise(resolve=>processChild.once('exit',resolve))}
  finally{if(processChild.exitCode===null&&processChild.signalCode===null){processChild.kill();await new Promise(resolve=>processChild.once('exit',resolve))}}
  assert.equal(createSettingsFile(item.filename).read().theme,phase==='after-primary'?'new':'old');assert.equal(JSON.parse(read(item.backup)).theme,'old')
 }
 passed.push('actual owned child termination during partial temp, before primary rename and after primary rename leaves readable committed generations')
}
async function coreCases(){
 const profile=path.join(fixture,'core-profile');fs.mkdirSync(profile);process.chdir(profile)
 assert.equal(require('../main/user-data').getUserDataDir(),path.join(profile,'.tmp-wallpaper-player'))
 const settings=require('../main/settings');assert.equal(settings.loadSettings().schemaVersion,1)
 await settings.saveSettingsAndFlush({theme:'light',schemaVersion:500});const file=path.join(profile,'.tmp-wallpaper-player/settings.json')
 assert.equal(JSON.parse(read(file)).schemaVersion,1);assert.throws(()=>settings.registerSettingsSection('schemaVersion'),/reserved/)
 await settings.saveSettingsAndFlush({theme:'dark'});assert.equal(JSON.parse(read(path.join(profile,'.tmp-wallpaper-player/settings.v1.backup.json'))).theme,'light')
 await settings.flushSettingsWrites();await settings.disposeSettingsSerialization();process.chdir(root)
 const core=require('../main/plugins/core-api'),pluginSettings=core.requireCoreModule('settings')
 assert.equal(pluginSettings.recoverSettingsBackup,undefined);assert.equal(pluginSettings,core.requireCoreModule('settings'));assert.equal(pluginSettings.loadSettings,settings.loadSettings)
 passed.push('production settings reserve schemaVersion, preserve legacy result contracts and rotate backup through actual worker commits')
 passed.push('plugin settings facade retains existing helpers and stable identity without exposing startup recovery')
}
;(async()=>{await adapterCases();await crashCases();await coreCases();const files=['main/repositories/settings-file.js','main/application/settings-startup.js','main/settings.js','main/application/settings-json-worker.js','main/index.js','main/plugins/core-api.js','scripts/run-verify.cjs','scripts/test-data-guard.cjs']
 const result={date:new Date().toISOString(),fixture:path.relative(root,fixture),passed,sourceDigests:Object.fromEntries(files.map(file=>[file,sha(read(path.join(root,file)))])),conditions:'Actual production storage/settings worker and filesystem, controlled rename/read errors and actual owned Node child termination at three commit gates. Startup dialog selection controlled; separate actual Electron startup checks required. No power-loss, fsync/directory durability or signed-update acceptance.'};fs.writeFileSync(path.join(parent,'settings-recovery-lifecycle.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result))})().catch(error=>{console.error(error);process.exitCode=1})
