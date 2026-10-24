const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),Module=require('node:module')
const {performance}=require('node:perf_hooks'),root=path.resolve(__dirname,'..'),parent=path.join(root,'.tmp/refactor-tests')
fs.mkdirSync(parent,{recursive:true})
const before=process.argv.includes('--before'),fixture=fs.mkdtempSync(path.join(parent,'media-fields-cost-'))
const hash=file=>fs.existsSync(file)?crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'):null
const fallback=path.join(root,'.tmp-wallpaper-player/settings.json'),fallbackBefore=hash(fallback)
const manifest=JSON.parse(fs.readFileSync(path.join(parent,'media-fields-before.json'),'utf8')),sourceDigests={}
process.chdir(fixture);assert.equal(require('../main/user-data').getUserDataDir(),path.join(fixture,'.tmp-wallpaper-player'))
// Load captured dependencies before their consumers so replay never closes over new helpers.
for(const file of ['main/settings.js','main/remote/handlers/network-resources.js','main/application/media-mutation-paths.js','main/application/media-mutations.js']){
 const selected=before?path.join(root,manifest.fixture,file.replaceAll('/','_')):path.join(root,file);sourceDigests[file]=hash(selected)
 if(before){assert.equal(sourceDigests[file],manifest.sourceDigests[file]);const filename=path.join(root,file),loaded=new Module(filename,module)
  loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename));require.cache[filename]=loaded;loaded._compile(fs.readFileSync(selected,'utf8'),filename)}
}
if(!before)sourceDigests['main/repositories/user-media.js']=hash(path.join(root,'main/repositories/user-media.js'))
const settings=require('../main/settings'),{createMediaMutationService,createFileTarget}=require('../main/application/media-mutations')
const service=createMediaMutationService({returnSettings:false,returnVersion:true}),results=[],parse=JSON.parse,realpath=fs.promises.realpath,nativeSync=fs.realpathSync.native
let counting=false,parses=0,parsedCharacters=0,fullParses=0,pathCalls=0,nonPathCalls=0,syncCalls=0,active=0,maximum=0
const nonPathInputs=new Set()
const nonPath=input=>nonPathInputs.has(String(input))
fs.promises.realpath=async function(input,...args){if(!counting)return realpath.call(this,input,...args);pathCalls++;if(nonPath(input))nonPathCalls++;active++;maximum=Math.max(maximum,active)
 try{return await realpath.call(this,input,...args)}finally{active--}}
fs.realpathSync.native=function(input,...args){if(counting)syncCalls++;return nativeSync.call(this,input,...args)}
JSON.parse=(...args)=>{const value=parse(...args);if(counting){parses++;parsedCharacters+=typeof args[0]==='string'?args[0].length:0;if(value?.customTags&&value?.directories&&value?.privacy)fullParses++}return value}
async function measure(name,fn){const observations=[]
 for(let i=0;i<3;i++){parses=0;parsedCharacters=0;fullParses=0;pathCalls=0;nonPathCalls=0;syncCalls=0;maximum=0
  let last=performance.now(),gap=0;const start=last,timer=setInterval(()=>{const now=performance.now();gap=Math.max(gap,now-last);last=now},1);counting=true
  try{const result=await fn(i);await new Promise(resolve=>setImmediate(resolve));const end=performance.now();gap=Math.max(gap,end-last);counting=false
   observations.push({milliseconds:end-start,maxHeartbeatGapMs:gap,mainJsonParses:parses,mainParsedCharacters:parsedCharacters,fullStateParses:fullParses,asyncRealpathCalls:pathCalls,nonPathRealpathCalls:nonPathCalls,synchronousRealpathCalls:syncCalls,maximumActiveRealpath:maximum})
   assert.ok(result.value);assert.equal(active,0)
   if(name.startsWith('canonical'))assert.equal(before ? nonPathCalls>=10000 : nonPathCalls===0,true,'canonical identifier IO regression')
   if(name.startsWith('10240 legacy'))assert.ok(pathCalls>=10240,'legacy alias resolution must be retained')
  }finally{counting=false;clearInterval(timer)}}results.push({name,observations})}
;(async()=>{
 const library=path.join(fixture,'library');fs.mkdirSync(library);const files=Array.from({length:1280},(_,i)=>path.join(library,'clip-'+i+'.mp4'))
 for(const file of files)fs.writeFileSync(file,'fixture; never decoded')
 const target={fullPath:files[0]},fileKey=value=>'file:'+Buffer.from(value).toString('base64url')
 const unrelated=Object.fromEntries(Array.from({length:10000},(_,i)=>['https://fixture.invalid/progress/'+i,{position:i,updatedAt:i+1,revision:i}]))
 const canonical=Object.fromEntries(Array.from({length:10000},(_,i)=>[i%3===0?fileKey(path.join(library,'canonical-'+i+'.mp4')):i%3===1?'workshop:'+i:'https://fixture.invalid/video/'+i,['tag-'+i]]))
 canonical[fileKey(files[0])]=['current']
 for(const key of Object.keys(canonical))nonPathInputs.add(path.resolve(key))
 await settings.saveSettingsAndFlush({directories:[library],customTags:canonical,playbackStates:unrelated,networkResources:[{id:'field-network',url:'https://fixture.invalid/actual.mp4',kind:'direct',title:'network'}]})
 await service.getVideoTags(target)
 await measure('canonical tag read',()=>service.getVideoTags(target))
 await measure('canonical tag replace',i=>service.setVideoTags(target,['canonical-'+i]))
 await measure('favorite with unrelated data',i=>service.setFavorite(target,i%2===0))
 await measure('network tag read',()=>service.getVideoTags({sourceType:'network',url:'https://fixture.invalid/actual.mp4'}))
 const legacy={}
 for(let i=0;i<8;i++){const alias=path.join(fixture,'alias-'+i);fs.symlinkSync(library,alias,process.platform==='win32'?'junction':'dir');for(const file of files)legacy[path.join(alias,path.basename(file))]=['legacy-'+i]}
 await settings.saveSettingsAndFlush({customTags:legacy})
 await measure('10240 legacy tag read',async()=>{const result=await service.getVideoTags(target);assert.equal(result.value.customTags.length,8);return result})
 const evidence={date:new Date().toISOString(),fixture:path.relative(root,fixture),before,sourceDigests,results,
  conditions:'Actual media service, production settings/worker, 10000 mixed canonical/URL keys plus 10000 unrelated progress records; separate 10240 legacy path keys, 1280 file headers and eight actual junctions. Three sequential observations per operation per process. No renderer, IPC transport, decoder, physical phone, P95 or cold start claim.'}
 fs.writeFileSync(path.join(fixture,'result.json'),JSON.stringify(evidence,null,2));fs.writeFileSync(path.join(parent,'media-fields-cost-'+(before?'before':'after')+'.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence))
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{counting=false;JSON.parse=parse;fs.promises.realpath=realpath;fs.realpathSync.native=nativeSync;await settings.flushSettingsWrites();await settings.disposeSettingsSerialization();process.chdir(root);assert.equal(hash(fallback),fallbackBefore)})
