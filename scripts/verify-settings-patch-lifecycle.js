const assert=require('assert'),fs=require('fs'),fsp=require('fs/promises'),path=require('path')
const root=path.resolve(__dirname,'..'),parent=path.join(root,'.tmp/refactor-tests')
fs.mkdirSync(parent,{recursive:true});const fixture=fs.mkdtempSync(path.join(parent,'settings-patch-lifecycle-'));process.chdir(fixture)
const settings=require('../main/settings'),{createMediaAccessPolicyAsync}=require('../main/security/media-access')
const nativeRename=fsp.rename,delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
let release,entered=false,fail=false
const settingsPath=path.join(fixture,'.tmp-wallpaper-player/settings.json')
fsp.rename=async function(source,destination){if(destination===settingsPath){if(release){entered=true;await new Promise(resolve=>{release=resolve})}if(fail)throw Error('settings-patch-fixture-failure')}return nativeRename.call(this,source,destination)}
async function until(predicate){const deadline=Date.now()+10000;while(!predicate()){if(Date.now()>deadline)throw Error('settings patch lifecycle timed out');await delay(2)}}
function hold(){entered=false;release=()=>{}}
function resume(){const wake=release;release=null;wake?.()}
;(async()=>{
 const library=path.join(fixture,'library'),other=path.join(fixture,'other'),alias=path.join(fixture,'root-alias');fs.mkdirSync(library);fs.mkdirSync(other)
 fs.writeFileSync(path.join(library,'clip.mp4'),'fixture');fs.writeFileSync(path.join(other,'clip.mp4'),'fixture')
 const link=target=>fs.symlinkSync(target,alias,process.platform==='win32'?'junction':'dir');link(library)
 const providerDefaults={nested:{value:7}},stopDefaults=settings.registerSettingsSection('ownedDefaults',{defaults:providerDefaults,normalize:value=>value||providerDefaults})
 settings.loadSettings();providerDefaults.nested.value=999;assert.strictEqual(settings.loadSettings().ownedDefaults.nested.value,7)
 const unregister=settings.registerSettingsSection('patchFixture',{defaults:{nested:{value:1}},normalize(value){return {nested:{value:Number(value?.nested?.value)||1}}},merge(current,next){current.nested.value=next.nested.value;return current}})
 await settings.saveSettingsAndFlush({directories:[alias],customTags:{stable:['original']},plugins:{alpha:{enabled:true,config:{keep:true}}}})
 let callbackSnapshot
 const patch={favorites:['file:requested']}
 const before=settings.loadSettings(),beforeVersion=settings.getSettingsSnapshotVersion(before)
 const observed=[];const unsubscribe=settings.onSettingsChanged((snapshot,change)=>{observed.push(change.changedKeys);snapshot.customTags.stable.push('observer-only')})
 hold();const pending=settings.updateSettingsAndFlush(current=>{callbackSnapshot=current;current.customTags.unmentioned=['must-not-commit'];return {patch}})
 await until(()=>entered);assert.deepStrictEqual(settings.loadSettings().favorites,[])
 settings.saveSettings({theme:'light',plugins:{beta:{enabled:true}},remoteAccess:{enabled:false,port:48123}})
 resume();const result=await pending;await settings.flushSettingsWrites()
 assert.strictEqual(result.settings.theme,'light');assert.strictEqual(result.settings.remoteAccess.port,48123);assert.ok(result.settings.plugins.alpha&&result.settings.plugins.beta)
 assert.deepStrictEqual(result.settings.favorites,['file:requested']);assert.ok(!result.settings.customTags.unmentioned)
 assert.deepStrictEqual(result.settings.customTags.stable,['original']);assert.deepStrictEqual(before.customTags.stable,['original'])
 result.settings.customTags.stable.push('returned-only');callbackSnapshot.customTags.stable.push('callback-only');patch.favorites.push('caller-after-ack')
 assert.deepStrictEqual(settings.loadSettings().customTags.stable,['original']);assert.deepStrictEqual(settings.loadSettings().favorites,['file:requested'])
 const disk=JSON.parse(fs.readFileSync(settingsPath,'utf8'));assert.strictEqual(disk.theme,'light');assert.strictEqual(disk.remoteAccess.port,48123);assert.ok(disk.plugins.beta)
 const afterVersion=settings.getSettingsSnapshotVersion(settings.loadSettings());assert.strictEqual(afterVersion.epoch,beforeVersion.epoch);assert.ok(afterVersion.revision>beforeVersion.revision)
 unsubscribe()
 hold();const mutable={favorites:['captured-intent']};const capturedWrite=settings.saveSettingsAndFlush(mutable)
 await until(()=>entered);mutable.favorites.push('changed-while-writing');resume();const capturedResult=await capturedWrite
 assert.deepStrictEqual(capturedResult.favorites,['captured-intent']);assert.deepStrictEqual(JSON.parse(fs.readFileSync(settingsPath,'utf8')).favorites,['captured-intent'])
 hold();const first=settings.saveSettingsAndFlush({theme:'dark'});await until(()=>entered)
 const queuedPatch={favorites:['queued-intent']},queued=settings.saveSettingsAndFlush(queuedPatch);queuedPatch.favorites.push('changed-before-admission')
 resume();await first;assert.deepStrictEqual((await queued).favorites,['queued-intent'])

 fail=true;const notices=[];const stopNotice=settings.onSettingsChanged((_,change)=>notices.push(change.changedKeys))
 await assert.rejects(settings.saveSettingsAndFlush({patchFixture:{nested:{value:99}},favorites:['failed']}),/settings-patch-fixture-failure/)
 assert.strictEqual(settings.loadSettings().patchFixture.nested.value,1);assert.deepStrictEqual(settings.loadSettings().favorites,['queued-intent']);assert.strictEqual(notices.length,0)
 fail=false;await settings.saveSettingsAndFlush({patchFixture:{nested:{value:2}}});assert.strictEqual(settings.loadSettings().patchFixture.nested.value,2);stopNotice()

 // Explicit undefined remains a reset; it must not disappear from the patch.
 await settings.saveSettingsAndFlush({plugins:{alpha:{enabled:undefined}},favorites:undefined,windowClose:undefined})
 assert.strictEqual(settings.loadSettings().plugins.alpha.enabled,false);assert.deepStrictEqual(settings.loadSettings().favorites,[]);assert.strictEqual(settings.loadSettings().windowClose.mode,'ask')
 const rootsBefore=settings.getMediaAccessSettings(),defaultBefore=settings.loadSettings().defaultDirectory
 assert.ok(fs.lstatSync(alias).isSymbolicLink());fs.unlinkSync(alias);link(other)
 await settings.saveSettingsAndFlush({theme:'dark'})
 assert.deepStrictEqual(settings.getMediaAccessSettings(),rootsBefore);assert.strictEqual(settings.loadSettings().defaultDirectory,defaultBefore)
 const policy=await createMediaAccessPolicyAsync({audience:'remote'})
 assert.strictEqual(policy.canReadResolvedPath(path.join(other,'clip.mp4'),false),true);assert.strictEqual(policy.canReadResolvedPath(path.join(library,'clip.mp4'),false),false)
 await settings.saveSettingsAndFlush({directories:[alias]});assert.strictEqual(settings.loadSettings().defaultDirectory,other)
 unregister();stopDefaults();await settings.flushSettingsWrites()
 const evidence={date:new Date().toISOString(),fixture:path.relative(root,fixture),passed:['detached initial/provider defaults','patch-only intent','cache unchanged before rename','sync field/plugin rebase','observer/result/callback/input isolation after commit','in-flight input cannot change durable intent','queued input captured at call','snapshot stamps','failed custom merge does not mutate cache or notify','explicit undefined reset','unrelated patch preserves path config','actual policy re-resolves retargeted root','explicit path patch normalizes current root'],
  conditions:'Production settings and media policy, actual atomic file writes and real directory junction/symlink. Rename delay/failure controlled; no renderer/native performance claim.'}
 fs.writeFileSync(path.join(parent,'settings-patch-lifecycle.json'),JSON.stringify(evidence,null,2));console.log('settings patch lifecycle passed',JSON.stringify(evidence))
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{fail=false;resume();fsp.rename=nativeRename;await settings.flushSettingsWrites()})
