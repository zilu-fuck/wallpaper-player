const assert=require('assert'),fs=require('fs'),fsp=require('fs/promises'),path=require('path'),crypto=require('crypto')
const {performance}=require('perf_hooks')
const root=path.resolve(__dirname,'..'),parent=path.join(root,'.tmp/refactor-tests'),baseline=process.argv.includes('--baseline')
fs.mkdirSync(parent,{recursive:true});const fixture=fs.mkdtempSync(path.join(parent,'media-mutation-paths-'))
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(path.join(root,f))).digest('hex')
const sourceFiles=['main/application/media-mutations.js','main/application/media-mutation-paths.js','main/settings.js','main/repositories/tag-state.js','main/ipc/media-data.js','main/remote/media-mutations.js']
const sourceDigests=Object.fromEntries(sourceFiles.map(f=>[f,hash(f)]))
fs.copyFileSync(path.join(root,sourceFiles[0]),path.join(fixture,'media-mutations-before.cjs'))
process.chdir(fixture)
const settings=require('../main/settings'),scanner=require('../main/scanner'),metadata=require('../main/video-metadata')
let mediaModule
if(baseline){
 const captured=JSON.parse(fs.readFileSync(path.join(parent,'media-mutation-paths-baseline.json'),'utf8'))
 const original=path.resolve(root,captured.fixture,'media-mutations-before.cjs')
 assert.ok(original.startsWith(parent+path.sep))
 const content=fs.readFileSync(original),digest=crypto.createHash('sha256').update(content).digest('hex')
 assert.strictEqual(digest,captured.sourceDigests['main/application/media-mutations.js'])
 const Module=require('module'),filename=path.join(root,'main/application/media-mutations.js'),loaded=new Module(filename,module)
 loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename));loaded._compile(content.toString('utf8'),filename)
 mediaModule=loaded.exports;sourceDigests['main/application/media-mutations.js']=digest
}else mediaModule=require('../main/application/media-mutations')
const {createMediaMutationService}=mediaModule
const nativeSync=fs.realpathSync.native
let counting=false,allSync=0,mediaSync=0
fs.realpathSync.native=function(input,...args){if(counting){allSync++;if(String(input).endsWith('.mp4'))mediaSync++}return nativeSync.call(this,input,...args)}
const large=process.argv.includes('--large'),fileCount=large?1280:64
const library=path.join(fixture,'library'),files=Array.from({length:fileCount},(_,i)=>path.join(library,'clip-'+i+'.mp4'))
const tags={},favorites=[],results=[]
async function measure(name,run){allSync=0;mediaSync=0;counting=true;const start=performance.now();let last=start,maxGap=0
 const tick=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-last);last=now},1)
 try{await run();await new Promise(resolve=>setImmediate(resolve));maxGap=Math.max(maxGap,performance.now()-last)
  results.push({name,milliseconds:performance.now()-start,maxHeartbeatGapMs:maxGap,synchronousRealpathCalls:allSync,mediaSynchronousRealpathCalls:mediaSync})
 }finally{counting=false;clearInterval(tick)}}
;(async()=>{
 fs.mkdirSync(library);for(const file of files)fs.writeFileSync(file,Buffer.from('000000186674797069736f6d0000000069736f6d6d703432','hex'))
 for(let i=0;i<8;i++){const alias=path.join(fixture,'alias-'+i);fs.symlinkSync(library,alias,process.platform==='win32'?'junction':'dir')
  for(const file of files)tags[path.join(alias,path.basename(file))]=['legacy-'+i]
  favorites.push(path.join(alias,path.basename(files[0])))
 }
 metadata.setVideoMetadataWarmPaused(true)
 await settings.saveSettingsAndFlush({directories:[library],customTags:tags,favorites})
 const scan=await scanner.scanWithCache(library,true),videos=files.map(file=>scan.videos.find(v=>v.fullPath===file)),service=createMediaMutationService()
 await measure('read legacy tags',async()=>{const got=await service.getVideoTags(videos[0]);assert.strictEqual(got.value.customTags.length,8)})
 await measure('replace tags',()=>service.setVideoTags(videos[0],['replacement']))
 await measure('append eight targets',async()=>{const result=await service.appendTagsBulk(videos.slice(1,9),['appended']);assert.strictEqual(result.value.updatedCount,8)})
 await measure('clear alias favorites',async()=>{await service.setFavorite(videos[0],false);assert.strictEqual(settings.loadSettings().favorites.length,0)})
 if(!baseline){for(const result of results)assert.strictEqual(result.mediaSynchronousRealpathCalls,0,result.name+' must not resolve media/legacy paths synchronously')}
 const evidence={date:new Date().toISOString(),fixture:path.relative(root,fixture),baseline,sourceDigests,files:fileCount,legacyKeys:fileCount*8,aliases:8,results,
  ...(baseline?{baselineMode:'Captured pre-change media service module; current compatible settings/revision helpers. The optional preparation API is unused by the captured module.'}:{}),
  conditions:'Production media service/settings/scanner, actual Windows junctions (directory symlinks on other platforms) and generated MP4 file headers. Not decoding or physical mobile performance. Explicit path-setting normalization, legacy identity bridges and renderer/IPC preparation are outside this diagnostic; media/legacy realpath counts are scoped to .mp4 paths.'}
 fs.writeFileSync(path.join(parent,'media-mutation-paths-'+(baseline?'baseline-replay':large?'large':'after')+'.json'),JSON.stringify(evidence,null,2))
 console.log(JSON.stringify(evidence))
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{counting=false;fs.realpathSync.native=nativeSync;await scanner.waitForBackgroundScanRefreshes();scanner.unwatchAllDirectories();await metadata.disposeVideoMetadata();await settings.flushSettingsWrites()})
