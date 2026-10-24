const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto')
const root=path.resolve(__dirname,'..'),parent=path.join(root,'.tmp/refactor-tests')
fs.mkdirSync(parent,{recursive:true});const fixture=fs.mkdtempSync(path.join(parent,'media-fields-'))
const hash=file=>fs.existsSync(file)?crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'):null
const fallback=path.join(root,'.tmp-wallpaper-player/settings.json'),fallbackBefore=hash(fallback),passed=[]
process.chdir(fixture);assert.equal(require('../main/user-data').getUserDataDir(),path.join(fixture,'.tmp-wallpaper-player'))
const settings=require('../main/settings'),{updateUserMedia}=require('../main/repositories/user-media')
const {prepareMediaMutationPaths}=require('../main/application/media-mutation-paths'),{createMediaMutationService}=require('../main/application/media-mutations')
const parse=JSON.parse,realpath=fs.promises.realpath,rename=fs.promises.rename
const library=path.join(fixture,'library'),targetPath=path.join(library,'target.mp4'),fileKey='file:'+Buffer.from(targetPath).toString('base64url')
const target={fullPath:targetPath},service=createMediaMutationService({returnSettings:false,returnVersion:true})
const deferred=()=>{let resolve;const promise=new Promise(fn=>{resolve=fn});return{promise,resolve}}
;(async()=>{
 fs.mkdirSync(library);fs.writeFileSync(targetPath,'fixture; never decoded')
 const tags=Object.fromEntries(Array.from({length:10000},(_,i)=>[i%3===0?'file:'+Buffer.from(path.join(library,i+'.mp4')).toString('base64url'):i%3===1?'workshop:'+i:'https://fixture.invalid/'+i,['tag-'+i]]));tags[fileKey]=['current']
 await settings.saveSettingsAndFlush({directories:[library],customTags:tags,fixtureUnrelated:{secret:'not a media field'},playbackStates:{unrelated:{position:1,updatedAt:1}},networkResources:[{id:'network',url:'https://fixture.invalid/actual.mp4',kind:'direct',title:'network'}]})
 const selected=['favorites'],prep=[]
 const queued=settings.updateSettingsAndFlush((view)=>{assert.deepEqual(Object.keys(view),['favorites']);return{patch:{favorites:['selected']}}},{fields:selected,prepareFields:prep,prepare:async view=>{assert.deepEqual(view,{});view.leak='detached'}})
 selected.push('privacy');prep.push('customTags');await queued
 passed.push('queued field and preparation selections are captured before caller mutation')
 let preparations=0
 const keyCopy=settings.loadSettingsMapKeys('customTags');keyCopy.length=0;assert.equal(settings.loadSettingsMapKeys('customTags').length,10001)
 await updateUserMedia('readTags',(view,prepared)=>{assert.deepEqual(Object.keys(view),['customTags','customTagRevisions']);assert.equal(prepared,true);return{patch:{},value:7}},
  {readOnly:true,returnSettings:false,prepare:async view=>{preparations++;assert.deepEqual(Object.keys(view),['customTagKeys']);assert.ok(view.customTagKeys.includes(fileKey));view.customTagKeys.length=0;return true}})
 assert.equal(preparations,1);assert.ok(settings.loadSettingsMapKeys('customTags').includes(fileKey))
 passed.push('logical media preparation owns detached key names while callbacks see only operation fields')
 const oldVersion=settings.sanitizeSettingsForRenderer(settings.loadSettings())._settingsVersion
 await assert.rejects(updateUserMedia('favorite',()=>({patch:{theme:'unrelated'}})),/unrelated settings/)
 assert.throws(()=>updateUserMedia('constructor',()=>({patch:{}})),/Unknown/)
 assert.deepEqual(settings.sanitizeSettingsForRenderer(settings.loadSettings())._settingsVersion,oldVersion)
 assert.throws(()=>settings.loadSettingsMapKeys('privacy'),/Invalid/)
 passed.push('logical operation boundary rejects unrelated writes and unsupported map/operation names')
 const unchanged=await updateUserMedia('readTags',view=>{view.customTags[fileKey].push('unsaved');return{patch:{},value:view.customTags[fileKey]}},{readOnly:true,returnVersion:true})
 assert.equal(unchanged.settings.theme,'dark');assert.deepEqual(unchanged.settings.customTags[fileKey],['current'])
 unchanged.settings.customTags[fileKey].push('caller');assert.deepEqual(settings.loadSettingsFields(['customTags']).customTags[fileKey],['current'])
 passed.push('read-only selected callbacks and legacy complete results cannot mutate committed state')
 let fullReads=0
 JSON.parse=(...args)=>{const value=parse(...args);if(value?.fixtureUnrelated){fullReads++;throw Error('unexpected unrelated settings parse')}return value}
 try {
  const read=await service.getVideoTags(target);assert.deepEqual(read.value.customTags,['current'])
  const favorite=await service.setFavorite(target,true);assert.equal(favorite.value.favorite,true)
  const condition={expectedRevision:read.value.customTagsRevision,operationId:'media_fields_test'}
  const write=await service.setVideoTags(target,['written'],condition);assert.deepEqual(write.value.customTags,['written'])
  const replay=await service.setVideoTags(target,['written'],condition);assert.equal(replay.value.replayed,true)
  const bulk=await service.appendTagsBulk([target],['bulk']);assert.equal(bulk.value.updatedCount,1)
  const network=await service.getVideoTags({sourceType:'network',url:'https://fixture.invalid/actual.mp4'});assert.deepEqual(network.value.customTags,[])
  const progress=await service.savePlayback(target,{position:12});assert.equal(progress.value.playback.position,12)
  assert.equal(fullReads,0)
 }finally{JSON.parse=parse}
 passed.push('actual favorite/tag/CAS/replay/bulk/network/progress services avoid unrelated configuration snapshots')
 const rawCalls=[],link=path.join(fixture,'legacy-alias');fs.symlinkSync(library,link,process.platform==='win32'?'junction':'dir')
 const legacy=path.join(link,'target.mp4')
 await settings.saveSettingsAndFlush({customTags:{...settings.loadSettingsFields(['customTags']).customTags,[legacy]:['legacy']}})
 fs.promises.realpath=async function(input,...args){rawCalls.push(String(input));return realpath.call(this,input,...args)}
 try {
  const read=await service.getVideoTags(target);assert.deepEqual(read.value.customTags,['written','bulk','legacy'])
  const forbidden=new Set(Object.keys(tags).map(key=>path.resolve(key)))
  assert.ok(!rawCalls.some(key=>forbidden.has(key)),'typed file/workshop/URL keys must never be resolved as filesystem paths')
  assert.ok(rawCalls.includes(legacy),'actual legacy junction path must still be resolved')
  await service.setVideoTags(target,['migrated']);assert.ok(!Object.hasOwn(settings.loadSettingsFields(['customTags']).customTags,legacy))
 }finally{fs.promises.realpath=realpath}
 passed.push('canonical namespaces skip filesystem work while actual legacy aliases retain order and migrate on write')
 const entered=deferred(),release=deferred()
 const pending=updateUserMedia('favorite',view=>({patch:{favorites:[...view.favorites,'after-prepare']}}),{returnSettings:false,
  prepare:async()=>{entered.resolve();await release.promise}})
 await entered.promise;settings.saveSettings({favorites:['newer']});release.resolve();await pending
 assert.deepEqual(settings.loadSettingsFields(['favorites']).favorites,['newer','after-prepare'])
 passed.push('selected callbacks re-read the latest fields after asynchronous preparation')
 const failedVersion=settings.sanitizeSettingsForRenderer(settings.loadSettings())._settingsVersion
 fs.promises.rename=async()=>{throw Object.assign(Error('fixture replacement failure'),{code:'EACCES'})}
 try {await assert.rejects(service.setFavorite(target,false),{code:'EACCES'});assert.deepEqual(settings.sanitizeSettingsForRenderer(settings.loadSettings())._settingsVersion,failedVersion)}finally{fs.promises.rename=rename}
 await service.setFavorite(target,true)
 passed.push('failed replacement never publishes selected changes and later operations recover')
 const files=['main/settings.js','main/repositories/user-media.js','main/application/media-mutations.js','main/application/media-mutation-paths.js','main/remote/handlers/network-resources.js']
 const evidence={date:new Date().toISOString(),fixture:path.relative(root,fixture),passed,sourceDigests:Object.fromEntries(files.map(file=>[file,hash(path.join(root,file))])),
 conditions:'Actual repository/service/settings worker and filesystem with 10000 mixed canonical keys, real legacy junction and synthetic video header. Field/callback gates and JSON parse guard controlled. No native decode or physical-device performance claim.'}
 fs.writeFileSync(path.join(parent,'media-fields-lifecycle.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence))
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{JSON.parse=parse;fs.promises.realpath=realpath;fs.promises.rename=rename;await settings.flushSettingsWrites();await settings.disposeSettingsSerialization();process.chdir(root);assert.equal(hash(fallback),fallbackBefore)})
