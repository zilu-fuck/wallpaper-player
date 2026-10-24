const assert=require('assert'),fs=require('fs'),path=require('path'),crypto=require('crypto'),{performance}=require('perf_hooks')
const root=path.resolve(__dirname,'..'),parent=path.join(root,'.tmp/refactor-tests'),baseline=process.argv.includes('--baseline')
fs.mkdirSync(parent,{recursive:true});const fixture=fs.mkdtempSync(path.join(parent,'settings-json-cost-'));process.chdir(fixture)
let settings,source
const capturedBaseline=path.join(parent,'settings-json-cost-baseline.json'),replay=baseline&&fs.existsSync(capturedBaseline)
if(replay){
 const captured=JSON.parse(fs.readFileSync(path.join(parent,'settings-json-cost-baseline.json'),'utf8'))
 const snapshot=path.resolve(root,captured.fixture,'settings-at-start.cjs');assert.ok(snapshot.startsWith(parent+path.sep));source=fs.readFileSync(snapshot)
 assert.strictEqual(crypto.createHash('sha256').update(source).digest('hex'),captured.sourceSha256)
 const Module=require('module'),filename=path.join(root,'main/settings.js'),loaded=new Module(filename,module)
 loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename));loaded._compile(source.toString('utf8'),filename);settings=loaded.exports
}else{settings=require('../main/settings');source=fs.readFileSync(path.join(root,'main/settings.js'))}
fs.writeFileSync(path.join(fixture,'settings-at-start.cjs'),source)
const {Worker}=require('worker_threads'),stringify=JSON.stringify,parse=JSON.parse,nativePost=Worker.prototype.postMessage,nativeRealpath=fs.realpathSync.native,results=[]
let counting=false,fullCopies=0,fullParses=0,pathCalls=0,sectionCalls=0,workerMessages=0,workerSeeds=0
JSON.stringify=function(value,...args){if(counting&&value?.customTags&&value?.privacy&&value?.directories)fullCopies++;return stringify(value,...args)}
JSON.parse=function(...args){const value=parse(...args);if(counting&&value?.customTags&&value?.privacy&&value?.directories)fullParses++;return value}
Worker.prototype.postMessage=function(message,...args){if(counting&&Array.isArray(message?.changes)){workerMessages++;if(Object.hasOwn(message,'seed'))workerSeeds++}return nativePost.call(this,message,...args)}
fs.realpathSync.native=function(...args){if(counting)pathCalls++;return nativeRealpath.apply(this,args)}
const unregister=settings.registerSettingsSection('commitFixture',{defaults:{enabled:true},normalize(value){if(counting)sectionCalls++;return {enabled:value?.enabled!==false}}})
async function measure(name,run){fullCopies=fullParses=pathCalls=sectionCalls=workerMessages=workerSeeds=0;const started=performance.now();let last=started,maxGap=0
 const timer=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-last);last=now},1);counting=true
 try{await run();await new Promise(resolve=>setImmediate(resolve));maxGap=Math.max(maxGap,performance.now()-last)
  results.push({name,milliseconds:performance.now()-started,maxHeartbeatGapMs:maxGap,fullStateStringifies:fullCopies,fullStateParses:fullParses,synchronousRealpaths:pathCalls,unrelatedSectionNormalizations:sectionCalls,workerMessages,workerSeeds})
 }finally{counting=false;clearInterval(timer)}}
;(async()=>{
 const memoryBeforeSetup=process.memoryUsage()
 const directory=path.join(fixture,'library');fs.mkdirSync(directory)
 const tags=Object.fromEntries(Array.from({length:10000},(_,i)=>['file:'+Buffer.from(path.join(directory,i+'.mp4')).toString('base64url'),['大库标签','tag-'+i,'third']]))
 await settings.saveSettingsAndFlush({directories:[directory],customTags:tags})
 const memoryBeforeOperations=process.memoryUsage()
 const unsubscribe=settings.onSettingsChanged(()=>{})
 await measure('favorite patch',()=>settings.saveSettingsAndFlush({favorites:['file:one']}))
 await measure('theme patch',()=>settings.saveSettingsAndFlush({theme:'light'}))
 const nextTags={...tags,'file:changed':['replacement']}
 await measure('whole tag map patch',()=>settings.saveSettingsAndFlush({customTags:nextTags}))
 await measure('read-only snapshot',()=>settings.updateSettingsAndFlush(()=>({patch:{}}),{readOnly:true}))
 unsubscribe()
 if(!baseline)for(const result of results){assert.strictEqual(result.synchronousRealpaths,0,result.name);assert.strictEqual(result.unrelatedSectionNormalizations,0,result.name)
  assert.ok(result.fullStateStringifies<=(result.name==='read-only snapshot'?1:0),result.name+' must avoid full-state JSON stringify on the main thread');assert.ok(result.fullStateParses<=2,result.name);assert.strictEqual(result.workerMessages,result.name==='read-only snapshot'?0:1)}
 const sourceSha256=crypto.createHash('sha256').update(source).digest('hex'),sourceDigests={'main/settings.js':sourceSha256}
 if(!baseline)for(const file of ['main/application/settings-json.js','main/application/settings-json-worker.js'])sourceDigests[file]=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')
 const evidence={date:new Date().toISOString(),fixture:path.relative(root,fixture),baseline,sourceSha256,sourceDigests,tagEntries:10000,results,memory:{beforeSetup:memoryBeforeSetup,beforeOperations:memoryBeforeOperations,afterOperations:process.memoryUsage()},
  ...(replay?{baselineMode:'SHA-verified settings module captured before this batch; current dependency modules; production source is not replaced.'}:{}),
  conditions:'Production settings repository, one local directory, warmed 10000 generated tags, one no-op listener and actual atomic writes. JSON stringify/parse counts instrument the main thread only; worker serialization is separate. RSS is a process observation including threads, not peak memory or mobile PSS. Individual observations exclude actual renderer/IPC preparation and are not P95, cold-start or native acceptance.'}
 fs.writeFileSync(path.join(fixture,'result.json'),stringify(evidence,null,2));fs.writeFileSync(path.join(parent,'settings-json-cost-'+(baseline?(replay?'baseline-replay':'baseline'):'after')+'.json'),stringify(evidence,null,2));console.log(stringify(evidence))
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{counting=false;JSON.stringify=stringify;JSON.parse=parse;Worker.prototype.postMessage=nativePost;fs.realpathSync.native=nativeRealpath;unregister();await settings.flushSettingsWrites();await settings.disposeSettingsSerialization?.()})
