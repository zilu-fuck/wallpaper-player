const assert=require('assert'),fs=require('fs'),fsp=require('fs/promises'),path=require('path'),{EventEmitter}=require('events')
const {performance}=require('perf_hooks'),{claimDevice}=require('./verify-helpers')
const root=path.resolve(__dirname,'..'),parent=path.join(root,'.tmp/refactor-tests')
fs.mkdirSync(parent,{recursive:true});const fixture=fs.mkdtempSync(path.join(parent,'mutation-path-lifecycle-'));process.chdir(fixture)
const settings=require('../main/settings'),scanner=require('../main/scanner'),metadata=require('../main/video-metadata')
const {createMediaMutationService,resolveDesktopTarget,createFileTarget}=require('../main/application/media-mutations')
const {getTagRevisionKey}=require('../main/repositories/tag-state'),privacy=require('../main/security/media-access')
const nativeRealpath=fsp.realpath,nativeRename=fsp.rename,nativeError=console.error,delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),gates=new Set()
let gateFilter=()=>false,active=0,maximum=0,issued=0,server
fsp.realpath=async function(input,...args){if(!gateFilter(String(input)))return nativeRealpath.call(this,input,...args)
 let release;const gate=new Promise(resolve=>{release=resolve});gates.add(release);active++;maximum=Math.max(maximum,active);issued++
 try{await gate;return await nativeRealpath.call(this,input,...args)}finally{active--;gates.delete(release)}}
function releaseAll(){gateFilter=()=>false;for(const release of gates)release()}
async function until(predicate){const end=Date.now()+10000;while(!predicate()){if(Date.now()>end)throw Error('mutation path test timed out');await delay(2)}}
const library=path.join(fixture,'library'),other=path.join(fixture,'other'),allowed=path.join(fixture,'allowed-root'),alias=path.join(fixture,'legacy-alias'),extraAlias=path.join(fixture,'extra-alias')
const files=Array.from({length:16},(_,i)=>path.join(library,'clip-'+i+'.mp4')),header=Buffer.from('000000186674797069736f6d0000000069736f6d6d703432','hex')
const link=(target,destination)=>fs.symlinkSync(target,destination,process.platform==='win32'?'junction':'dir')
async function gateWork(run){issued=0;maximum=0;gateFilter=input=>input.startsWith(alias+path.sep);const pending=run();pending.catch(()=>{});await until(()=>active===8);assert.strictEqual(issued,8);return {pending}}
;(async()=>{
 fs.mkdirSync(library);fs.mkdirSync(other);for(const file of files)fs.writeFileSync(file,header);fs.writeFileSync(path.join(other,path.basename(files[1])),header);link(library,allowed);link(library,alias);link(library,extraAlias)
 metadata.setVideoMetadataWarmPaused(true)
 await settings.saveSettingsAndFlush({directories:[allowed],customTags:Object.fromEntries(files.map(file=>[path.join(alias,path.basename(file)),['legacy']]))})
 const scan=await scanner.scanWithCache(library,true),videos=files.map(file=>scan.videos.find(v=>v.fullPath===file)),service=createMediaMutationService()
 const identity=require('../main/remote/identity'),{createRemoteServer}=require('../main/remote/server')
 server=createRemoteServer({port:0});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const baseUrl='http://127.0.0.1:'+server.address().port
 const paired=await claimDevice({baseUrl,clientId:'mutation-path-fixture',...identity}),headers={Authorization:'Bearer '+paired.token}
 const page=await fetch(baseUrl+'/v1/library?limit=1',{headers,signal:AbortSignal.timeout(5000)});assert.strictEqual(page.status,200);await page.json();const videoId=require('../main/remote/video-index').getVideoId(files[0])

 const read=await gateWork(()=>service.getVideoTags(videos[0]));const controlStart=performance.now()
 const control=await fetch(baseUrl+'/v1/playback/'+videoId,{headers,signal:AbortSignal.timeout(5000)});assert.strictEqual(control.status,200);await control.json();const controlMs=performance.now()-controlStart
 settings.saveSettings({customTags:{...settings.loadSettings().customTags,[path.join(extraAlias,path.basename(files[0]))]:['late-key']}})
 releaseAll();assert.ok((await read.pending).value.customTags.includes('late-key'),'a changed key set must be prepared again')
 assert.strictEqual(active,0);assert.strictEqual(maximum,8)

 const baseline=(await service.getVideoTags(videos[0])).value.customTagsRevision,revisionKey=getTagRevisionKey({path:files[0]})
 const conflict=await gateWork(()=>service.setVideoTags(videos[0],['stale'],{expectedRevision:baseline,operationId:'delayed-conflict'}))
 const latest=settings.loadSettings();settings.saveSettings({customTags:{...latest.customTags,[videos[0].favoriteKey]:['newer']},customTagRevisions:{...latest.customTagRevisions,[revisionKey]:baseline+1}})
 releaseAll();await assert.rejects(conflict.pending,error=>error.code==='tags_conflict')

 const flushWork=await gateWork(()=>service.setVideoTags(videos[0],['flush-owned']));let flushed=false
 const flush=settings.flushSettingsWrites().then(()=>{flushed=true});await delay(15);assert.strictEqual(flushed,false)
 settings.saveSettings({customTags:{...settings.loadSettings().customTags,[path.join(extraAlias,'clip-2.mp4')]:['added-during-flush']}})
 releaseAll();await flushWork.pending;await flush;assert.strictEqual(flushed,true)
 const disk=JSON.parse(fs.readFileSync(path.join(fixture,'.tmp-wallpaper-player/settings.json'),'utf8'));assert.deepStrictEqual(disk.customTags[videos[0].favoriteKey],['flush-owned'])

 const sender=new EventEmitter();sender.id=703;sender.isDestroyed=()=>false;settings.sessionPrivateDirectories.add(library);privacy.unlockDesktopPrivacy(sender)
 const access={senderId:sender.id},desktop=createMediaMutationService({resolveTarget:input=>resolveDesktopTarget(input,access)})
 const locked=await gateWork(()=>desktop.setVideoTags(videos[1],['must-not-save']));privacy.lockDesktopPrivacy(sender);releaseAll()
 await assert.rejects(locked.pending,error=>error.code==='media_access_denied');settings.sessionPrivateDirectories.delete(library)

 const partial=await gateWork(()=>service.appendTagsBulk([videos[1],videos[2]],['partial']));await fsp.unlink(files[2]);releaseAll()
 const mixed=(await partial.pending).value;assert.strictEqual(mixed.updatedCount,1);assert.strictEqual(mixed.failed.length,1);assert.strictEqual(mixed.failed[0].index,1);fs.writeFileSync(files[2],header)

 let resolveActive=0,resolveMaximum=0;const releases=[]
 const bounded=createMediaMutationService({async resolveTarget(input){resolveActive++;resolveMaximum=Math.max(resolveMaximum,resolveActive)
  await new Promise(resolve=>releases.push(resolve));resolveActive--;if(input===17)throw Error('missing fixture target');return createFileTarget(files[input%files.length],{favoriteKey:videos[input%files.length].favoriteKey})}})
 const bulk=bounded.appendTagsBulk(Array.from({length:32},(_,i)=>i),['bounded']);await until(()=>resolveActive===8)
 while(releases.length||resolveActive){for(const resolve of releases.splice(0))resolve();await delay(2)}
 const boundedResult=(await bulk).value;assert.strictEqual(resolveMaximum,8);assert.strictEqual(boundedResult.updatedCount,31);assert.strictEqual(boundedResult.failed[0].index,17)

 await settings.saveSettingsAndFlush({customTags:{...settings.loadSettings().customTags,...Object.fromEntries(files.map(file=>[path.join(alias,path.basename(file)),['legacy-again']]))}})
 const retargeted=await gateWork(()=>service.setVideoTags(videos[1],['outside-current-root']));assert.ok(fs.lstatSync(allowed).isSymbolicLink());fs.unlinkSync(allowed);link(other,allowed);releaseAll()
 await assert.rejects(retargeted.pending,error=>error.code==='media_access_denied');fs.unlinkSync(allowed);link(library,allowed)
 const aliasService=createMediaMutationService({resolveTarget:async()=>createFileTarget(files[1],{rawPath:path.join(alias,path.basename(files[1])),favoriteKey:videos[1].favoriteKey})})
 const changedAlias=await gateWork(()=>aliasService.setVideoTags('alias',['must-not-follow-a-new-file']))
 assert.ok(fs.lstatSync(alias).isSymbolicLink());fs.unlinkSync(alias);link(other,alias);releaseAll()
 try{await assert.rejects(changedAlias.pending,error=>error.code==='video_not_found')}finally{assert.ok(fs.lstatSync(alias).isSymbolicLink());fs.unlinkSync(alias);link(library,alias)}
 let attempts=0
 await assert.rejects(settings.updateSettingsAndFlush(()=>{throw Object.assign(Error('retry fixture'),{code:'retry'})},{prepare:async()=>{attempts++},retryPreparation:error=>error.code==='retry'}))
 assert.strictEqual(attempts,3);await service.setFavorite(videos[0],true)
 let networkPathCalls=0;const gatedRealpath=fsp.realpath
 fsp.realpath=async function(...args){networkPathCalls++;return gatedRealpath.apply(this,args)}
 try{
  await require('../main/application/media-mutation-paths').prepareMediaMutationPaths({...settings.loadSettings(),favorites:[files[0]]},[{path:'https://fixture.invalid/video',favoriteKey:'network-fixture'}],{tags:true,favorites:true})
  assert.strictEqual(networkPathCalls,0,'network-only preparation must not resolve unrelated local tags/favorites')
 }finally{fsp.realpath=gatedRealpath}
 let mappedDriveChecked=false
 if(process.platform==='win32'){
  const {execFileSync}=require('child_process'),{pathKey}=require('../main/paths')
  const drive='ZYXWVUTSRQP'.split('').find(letter=>!fs.existsSync(letter+':\\'));assert.ok(drive)
  const driveName=drive+':',driveRoot=driveName+'\\',subst=path.join(process.env.SystemRoot,'System32/subst.exe')
  execFileSync(subst,[driveName,library],{windowsHide:true})
  try{
   assert.strictEqual(pathKey(fs.realpathSync.native(driveRoot)),pathKey(library))
   const mapped=path.join(driveRoot,path.basename(files[0]))
   await settings.saveSettingsAndFlush({customTags:{...settings.loadSettings().customTags,[mapped]:['actual-subst']}})
   assert.ok((await service.getVideoTags(videos[0])).value.customTags.includes('actual-subst'))
   await service.setVideoTags(videos[0],['subst-saved']);assert.ok(!Object.hasOwn(settings.loadSettings().customTags,mapped));mappedDriveChecked=true
  }finally{assert.strictEqual(pathKey(fs.realpathSync.native(driveRoot)),pathKey(library));execFileSync(subst,[driveName,'/D'],{windowsHide:true})}
 }
 let diskFailed=false,diskErrorLogged=false
 console.error=(...args)=>{if(args.some(value=>value?.message==='read-only-background-write-fixture')){diskErrorLogged=true;return}nativeError(...args)}
 fsp.rename=async function(source,destination){if(destination===path.join(fixture,'.tmp-wallpaper-player/settings.json')){diskFailed=true;throw Error('read-only-background-write-fixture')}return nativeRename.call(this,source,destination)}
 settings.saveSettings({favorites:[]});await until(()=>diskFailed);await new Promise(resolve=>setImmediate(resolve));fsp.rename=nativeRename
 await service.getVideoTags(videos[0]);await assert.rejects(settings.flushSettingsWrites(),/read-only-background-write-fixture/);assert.ok(diskErrorLogged);console.error=nativeError
 await settings.saveSettingsAndFlush({favorites:[]})
 const evidence={date:new Date().toISOString(),fixture:path.relative(root,fixture),legacyMaximum:maximum,targetResolutionMaximum:resolveMaximum,authenticatedPlaybackWhileBlockedMs:controlMs,mappedDriveChecked,
  passed:['key-set reprepare','latest CAS rejection','flush joins preparation and retry','current desktop lock','partial deleted target','bounded ordered target resolution','retargeted root rejected','retargeted original alias rejected','three-attempt limit and recovery','network-only preparation skips local IO','read preserves background write failure',...(mappedDriveChecked?['actual Windows subst read and legacy removal']:[])],
  conditions:'Production service/settings/scanner and authenticated HTTP, real local files and junctions; only async realpath timing is controlled. Metadata scheduler paused. No decoder or physical-phone performance claim.'}
 fs.writeFileSync(path.join(parent,'media-mutation-path-lifecycle.json'),JSON.stringify(evidence,null,2));console.log('media mutation path lifecycle passed',JSON.stringify(evidence))
})().catch(error=>{nativeError(error);process.exitCode=1}).finally(async()=>{releaseAll();fsp.realpath=nativeRealpath;fsp.rename=nativeRename;console.error=nativeError;if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}await scanner.waitForBackgroundScanRefreshes();scanner.unwatchAllDirectories();await metadata.disposeVideoMetadata();await settings.flushSettingsWrites()})
