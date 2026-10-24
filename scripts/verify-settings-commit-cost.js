const assert=require('assert'),fs=require('fs'),path=require('path'),crypto=require('crypto'),{performance}=require('perf_hooks')
const root=path.resolve(__dirname,'..'),parent=path.join(root,'.tmp/refactor-tests'),baseline=process.argv.includes('--baseline')
fs.mkdirSync(parent,{recursive:true});const fixture=fs.mkdtempSync(path.join(parent,'settings-commit-cost-'));process.chdir(fixture)
let settings,source
if(baseline){
 const captured=JSON.parse(fs.readFileSync(path.join(parent,'settings-commit-cost-baseline.json'),'utf8'))
 const snapshot=path.resolve(root,captured.fixture,'settings-at-start.cjs');assert.ok(snapshot.startsWith(parent+path.sep));source=fs.readFileSync(snapshot)
 assert.strictEqual(crypto.createHash('sha256').update(source).digest('hex'),captured.sourceSha256)
 const Module=require('module'),filename=path.join(root,'main/settings.js'),loaded=new Module(filename,module)
 loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename));loaded._compile(source.toString('utf8'),filename);settings=loaded.exports
}else{settings=require('../main/settings');source=fs.readFileSync(path.join(root,'main/settings.js'))}
fs.writeFileSync(path.join(fixture,'settings-at-start.cjs'),source)
const stringify=JSON.stringify,nativeRealpath=fs.realpathSync.native,results=[]
let counting=false,fullCopies=0,pathCalls=0,sectionCalls=0
JSON.stringify=function(value,...args){if(counting&&value?.customTags&&value?.privacy&&value?.directories)fullCopies++;return stringify(value,...args)}
fs.realpathSync.native=function(...args){if(counting)pathCalls++;return nativeRealpath.apply(this,args)}
const unregister=settings.registerSettingsSection('commitFixture',{defaults:{enabled:true},normalize(value){if(counting)sectionCalls++;return {enabled:value?.enabled!==false}}})
async function measure(name,run){fullCopies=pathCalls=sectionCalls=0;const started=performance.now();let last=started,maxGap=0
 const timer=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-last);last=now},1);counting=true
 try{await run();await new Promise(resolve=>setImmediate(resolve));maxGap=Math.max(maxGap,performance.now()-last)
  results.push({name,milliseconds:performance.now()-started,maxHeartbeatGapMs:maxGap,fullStateStringifies:fullCopies,synchronousRealpaths:pathCalls,unrelatedSectionNormalizations:sectionCalls})
 }finally{counting=false;clearInterval(timer)}}
;(async()=>{
 const directory=path.join(fixture,'library');fs.mkdirSync(directory)
 const tags=Object.fromEntries(Array.from({length:10000},(_,i)=>['file:'+Buffer.from(path.join(directory,i+'.mp4')).toString('base64url'),['大库标签','tag-'+i,'third']]))
 await settings.saveSettingsAndFlush({directories:[directory],customTags:tags})
 const unsubscribe=settings.onSettingsChanged(()=>{})
 await measure('favorite patch',()=>settings.saveSettingsAndFlush({favorites:['file:one']}))
 await measure('theme patch',()=>settings.saveSettingsAndFlush({theme:'light'}))
 const nextTags={...tags,'file:changed':['replacement']}
 await measure('whole tag map patch',()=>settings.saveSettingsAndFlush({customTags:nextTags}))
 await measure('read-only snapshot',()=>settings.updateSettingsAndFlush(()=>({patch:{}}),{readOnly:true}))
 unsubscribe()
 if(!baseline)for(const result of results){assert.strictEqual(result.synchronousRealpaths,0,result.name);assert.strictEqual(result.unrelatedSectionNormalizations,0,result.name)
  assert.ok(result.fullStateStringifies<=(result.name==='read-only snapshot'?2:5),result.name+' must stay within the full-snapshot serialization budget')}
 const evidence={date:new Date().toISOString(),fixture:path.relative(root,fixture),baseline,sourceSha256:crypto.createHash('sha256').update(source).digest('hex'),tagEntries:10000,results,
  ...(baseline?{baselineMode:'SHA-verified settings module captured before this batch; current unchanged dependency modules; production source is not replaced.'}:{}),
  conditions:'Production settings repository, one real local directory, preloaded 10000 generated JSON tag entries, one settings listener, actual atomic file writes. Each operation is one observation after setup, not event-loop P95 or cold-start/media/phone acceptance.'}
 fs.writeFileSync(path.join(parent,'settings-commit-cost-'+(baseline?'baseline-replay':'after')+'.json'),stringify(evidence,null,2));console.log(stringify(evidence))
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{counting=false;JSON.stringify=stringify;fs.realpathSync.native=nativeRealpath;unregister();await settings.flushSettingsWrites()})
