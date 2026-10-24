const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createSettingsReader } = require('../main/application/settings-reader')
const { createSettingsBroadcast } = require('../main/application/settings-broadcast')
const { settingsReadOptionsSchema, settingsFeedSchema } = require('../packages/contracts')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
fs.mkdirSync(parent, { recursive: true })
const fixture = fs.mkdtempSync(path.join(parent, 'settings-read-')), cases = [], readers = []
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a;reject=b }); return { promise, resolve, reject } }
const version = (revision, epoch = 'read-fixture') => ({ epoch, revision })
const plain = value => JSON.parse(JSON.stringify(value))
const until = async fn => { const end=Date.now()+5000; while(!fn()){if(Date.now()>end)throw Error('Read worker condition timed out');await delay(3)} }
const reader = options => { const value=createSettingsReader(options);readers.push(value);return value }
const deadline = setTimeout(() => { console.error('settings read verification timed out');process.exit(1) },45000)
const controlled = path.join(fixture,'controlled-reader.cjs')
fs.writeFileSync(controlled, `const {parentPort}=require('node:worker_threads'),fs=require('node:fs');const listen=parentPort.on.bind(parentPort);
parentPort.on=(event,callback)=>listen(event,message=>{const input=JSON.parse(message.text);
if(input.__crash)process.exit(17);
if(input.__hang)return;
if(input.__bad){parentPort.postMessage({id:message.id,version:message.version,text:42});return}
if(input.__wrongVersion){parentPort.postMessage({id:message.id,version:{epoch:'other',revision:0},text:'{}'});return}
if(input.__gate){fs.writeFileSync(input.__gate+'.entered','1');const wait=new Int32Array(new SharedArrayBuffer(4));while(!fs.existsSync(input.__gate))Atomics.wait(wait,0,0,10)}
callback(message)});require(${JSON.stringify(path.join(root,'main/application/settings-read-worker.js'))});`)

async function workers() {
  const codec=reader(), source=JSON.stringify({ customTags: { '__proto__safe': ['tag'] }, privacy:{salt:'a'.repeat(32),passwordHash:'b'.repeat(64)},tagMutationReceipts:{private:'receipt'},_settingsVersion:version(999),unknown:{keep:true} })
  const first=await codec.read(source,version(1)), parsed=JSON.parse(first.text)
  assert.deepEqual(parsed.privacy,{passwordSet:true});assert.equal(Object.hasOwn(parsed,'tagMutationReceipts'),false)
  assert.deepEqual(parsed._settingsVersion,version(1));assert.deepEqual(parsed.unknown,{keep:true});assert.equal(Object.isFrozen(first),true)
  assert.equal(first.text.includes('b'.repeat(64)),false);assert.equal(first.text.includes('a'.repeat(32)),false)
  const special=Object.fromEntries([['__proto__',{safe:true}],['privacy',{passwordSet:true}]])
  const specialResult=JSON.parse((await codec.read(JSON.stringify(special),version(99))).text)
  assert.equal(Object.hasOwn(specialResult,'__proto__'),true);assert.equal(specialResult.__proto__.safe,true);assert.equal(Object.prototype.safe,undefined)
  const cached=await codec.read(source,version(1));assert.equal(cached.text,first.text)
  assert.equal((await codec.read(source,version(1))).text,first.text);assert.equal(codec.diagnostics().started,3)
  await assert.rejects(codec.read('{}',version(1)),{code:'settings_read_version_conflict'})
  cases.push('real worker redacts secrets/receipts, owns metadata, preserves extensions and caches one immutable result')

  const queue=reader({workerFile:controlled,maxPending:2}), gate=path.join(fixture,'queue-release'), text=JSON.stringify({__gate:gate,theme:'dark'})
  const held=queue.read(text,version(2)), joined=queue.read(text,version(2));assert.equal(held,joined)
  await until(()=>fs.existsSync(gate+'.entered'))
  const next=queue.read('{"theme":"light"}',version(3))
  await assert.rejects(queue.read('{}',version(4)),{code:'settings_read_busy'})
  assert.equal(queue.diagnostics().queued,1);fs.writeFileSync(gate,'release');await Promise.all([held,next])
  assert.equal(queue.diagnostics().started,2);assert.equal(queue.diagnostics().active,false)
  cases.push('same-version reads coalesce while distinct queued snapshots have a strict capacity')

  for(const [flag,code] of [['__crash','settings_reader_stopped'],['__bad','settings_read_invalid_reply'],['__wrongVersion','settings_read_invalid_reply']]){
    const client=reader({workerFile:controlled})
    await assert.rejects(client.read(JSON.stringify({[flag]:true}),version(10)),{code})
    assert.equal(JSON.parse((await client.read('{"theme":"recovered"}',version(11))).text).theme,'recovered')
    await client.close()
  }
  const timed=reader({workerFile:controlled,timeoutMs:150})
  await assert.rejects(timed.read('{"__hang":true}',version(20)),{code:'settings_read_timeout'})
  assert.equal(JSON.parse((await timed.read('{"theme":"after-timeout"}',version(21))).text).theme,'after-timeout')
  const broken=reader({workerFile:'relative-worker-path.cjs'})
  await assert.rejects(broken.read('{}',version(1)),{code:'ERR_WORKER_PATH'});await broken.close()
  const invalid=reader()
  await assert.rejects(invalid.read('SECRET-private-fragment',version(1)),error=>!error.message.includes('SECRET'))
  await assert.rejects(invalid.read('[]',version(2)),{code:'settings_read_failed'})
  await invalid.close()
  cases.push('crash, invalid replies, wrong versions, timeout and worker startup failure settle requests and allow recovery')

  const idle=reader({idleTimeoutMs:20});await idle.read('{}',version(30));await until(()=>!idle.diagnostics().worker)
  await idle.read('{}',version(30));assert.equal(idle.diagnostics().started,1)
  await idle.read('{}',version(31));assert.equal(idle.diagnostics().started,2);await idle.close()
  cases.push('idle worker retires, cached reads need no worker and a new version starts a fresh worker')

  const draining=reader({workerFile:controlled}), drainGate=path.join(fixture,'drain-release')
  const drainRead=draining.read(JSON.stringify({__gate:drainGate}),version(40));await until(()=>fs.existsSync(drainGate+'.entered'))
  const close=draining.close();await assert.rejects(draining.read('{}',version(41)),{code:'settings_reader_closed'})
  fs.writeFileSync(drainGate,'release');await drainRead;await close;assert.equal(draining.diagnostics().worker,false)
  const cancel=reader({workerFile:controlled}), cancelGate=path.join(fixture,'cancel-release')
  const active=cancel.read(JSON.stringify({__gate:cancelGate}),version(50));active.catch(()=>{})
  await until(()=>fs.existsSync(cancelGate+'.entered'));const queued=cancel.read('{}',version(51));queued.catch(()=>{})
  await cancel.close({cancel:true});await assert.rejects(active,{code:'settings_reader_closed'});await assert.rejects(queued,{code:'settings_reader_closed'})
  assert.equal(cancel.diagnostics().worker,false);assert.equal(cancel.diagnostics().queued,0)
  cases.push('graceful close drains existing work, forced close rejects active/queued work and both reject new reads')
}

function bridge(handlers,event) {
  const ipcRenderer=new EventEmitter();let api
  ipcRenderer.invoke=(channel,...args)=>Promise.resolve().then(()=>handlers.get(channel)(event,...args))
  const context=vm.createContext({require:()=>({ipcRenderer,contextBridge:{exposeInMainWorld(_name,value){api=value}},webUtils:{}}),window:{localStorage:{getItem(){return null}}},document:{},console})
  vm.runInContext(fs.readFileSync(path.join(root,'preload.js'),'utf8'),context,{filename:'preload.js'})
  return {api,ipcRenderer}
}

async function repository() {
  process.chdir(fixture)
  const settings=require('../main/settings'),directory=path.join(fixture,'library');fs.mkdirSync(directory)
  assert.equal(require('../main/user-data').getUserDataDir(),path.join(fixture,'.tmp-wallpaper-player'))
  const tags=Object.fromEntries(Array.from({length:10000},(_,i)=>['file-'+i,['tag-'+i]]))
  await settings.saveSettingsAndFlush({directories:[directory],customTags:tags,privacy:{salt:'a'.repeat(32),passwordHash:'b'.repeat(64)}})
  const captured=settings.captureRendererSettings()
  let parses=0;const parse=JSON.parse
  JSON.parse=function(text,...args){if(typeof text==='string'&&text.includes('"customTags":')&&text.includes('"directories":'))parses++;return parse(text,...args)}
  let wire,legacy,legacyParses
  try {
    legacy=settings.sanitizeSettingsForRenderer(settings.loadSettings());legacyParses=parses;assert.equal(legacyParses,1)
    parses=0;wire=await captured.read();assert.equal(parses,0)
  } finally {JSON.parse=parse}
  assert.deepEqual(JSON.parse(wire.text),legacy)
  await settings.commitSettingsPatch({favorites:['newer']},{returnSettings:false})
  assert.deepEqual(JSON.parse((await captured.read()).text).favorites,legacy.favorites)
  assert.deepEqual(JSON.parse((await settings.captureRendererSettings().read()).text).favorites,['newer'])
  assert.equal(Object.isFrozen(captured.version),true)
  cases.push('actual 10000-tag repository returns equivalent public settings: legacy main full JSON.parse 1, encoded read 0; captured-version ownership preserved')

  const handlers=new Map(),contents={mainFrame:{},send(){}},event={sender:contents,senderFrame:contents.mainFrame}
  const publisher=createSettingsBroadcast({settings,getMainWindow:()=>({webContents:contents,isDestroyed:()=>false}),captureSender:()=>({assertCurrent(){}})})
  const imports={'electron':{app:{getVersion:()=> 'fixture'}},'../security/ipc':{},'../ipc-channels':require('../main/ipc-channels'),
    '../../packages/contracts':require('../packages/contracts'),'../application/settings-broadcast':{settingsBroadcast:publisher},'../settings':settings}
  const context=vm.createContext({require:name=>{if(!Object.hasOwn(imports,name))throw Error(name);return imports[name]},module:{exports:{}},Object})
  vm.runInContext(fs.readFileSync(path.join(root,'main/ipc/settings.js'),'utf8'),context)
  context.module.exports.registerSettingsIpc({handle:(channel,action)=>handlers.set(channel,action)})
  const {api}=bridge(handlers,event)
  const publicSnapshot=await api.getSettings(),feed=settingsFeedSchema.parse(await api.getSettingsFeed())
  assert.deepEqual(plain(publicSnapshot),settings.sanitizeSettingsForRenderer(settings.loadSettings()))
  publicSnapshot.customTags['file-0'].push('caller-mutation')
  assert.deepEqual(plain((await api.getSettings()).customTags['file-0']),['tag-0'])
  publicSnapshot.customTags['file-0'].pop()
  assert.deepEqual(plain(feed.snapshot),plain(publicSnapshot));assert.equal(publicSnapshot.kind,undefined)
  assert.deepEqual(plain(await handlers.get('get-settings')(event)),plain(publicSnapshot))
  await assert.rejects(handlers.get('get-settings')(event,{encoding:'invalid'}))
  await assert.rejects(handlers.get('settings-get-feed')(event,{encoding:'invalid'}))
  assert.deepEqual(settingsReadOptionsSchema.parse({encoding:'json-v1',extra:true}),{encoding:'json-v1'})
  cases.push('real preload/IPC modules negotiate encoded reads but expose unchanged object contracts; old option-free replies and input validation remain')
  const legacyBridge=bridge(new Map([['get-settings',async()=>publicSnapshot],['settings-get-feed',async()=>({kind:'settings-feed-v1',feedId:'old-core',snapshot:publicSnapshot})]]),event)
  assert.deepEqual(plain(await legacyBridge.api.getSettings()),plain(publicSnapshot));assert.equal((await legacyBridge.api.getSettingsFeed()).feedId,'old-core')
  const unsafe=bridge(new Map([['get-settings',async()=>({kind:'settings-json-v1',text:JSON.stringify({...publicSnapshot,privacy:{passwordSet:true,passwordHash:'unsafe'}})})]]),event)
  await assert.rejects(unsafe.api.getSettings(),/无效/)
  cases.push('new preload tolerates older object replies and rejects encoded snapshots that expose private fields')
  publisher.start()()
  await settings.disposeSettingsSerialization()
  process.chdir(root)
  return {legacy:legacyParses,encoded:parses,tags:10000}
}

async function feedOrdering() {
  const messages=[],reads=[];let revision=1,listener,valid=true
  const repository={onSettingsCommitted(fn){listener=fn;return()=>{}},captureRendererSettings(){const current=revision,read=deferred();reads.push(read);return {version:version(current),read:()=>read.promise}},sanitizeSettingsForRenderer:value=>value}
  const contents={mainFrame:{},send(channel,value){messages.push({channel,value})}},event={sender:contents,senderFrame:contents.mainFrame}
  const publisher=createSettingsBroadcast({settings:repository,getMainWindow:()=>({webContents:contents,isDestroyed:()=>false}),captureSender:()=>({assertCurrent(){assert.equal(valid,true,'Retired frame')}})})
  publisher.start()
  const first=publisher.openFeed(event,{encoding:'json-v1'})
  revision=2;listener({version:version(2),baseVersion:version(1),requiresSnapshot:false,readPatch:()=>({set:{theme:'light'},maps:{},removed:[]})})
  assert.equal(messages[0].value.kind,'settings-patch-v1')
  reads[0].resolve({kind:'settings-json-v1',text:'first'});await first
  revision=3;listener({version:version(3),baseVersion:version(2),requiresSnapshot:false,readPatch:()=>({set:{theme:'dark'},maps:{},removed:[]})})
  assert.equal(messages[1].value.kind,'settings-patch-v1');assert.deepEqual(messages[1].value.baseVersion,version(2))
  const older=publisher.openFeed(event,{encoding:'json-v1'});revision=4;const newer=publisher.openFeed(event,{encoding:'json-v1'})
  reads[2].resolve({kind:'settings-json-v1',text:'newer'});await newer;reads[1].resolve({kind:'settings-json-v1',text:'older'});await older
  revision=5;listener({version:version(5),baseVersion:version(4),requiresSnapshot:false,readPatch:()=>({set:{theme:'latest'},maps:{},removed:[]})})
  assert.deepEqual(messages.at(-1).value.baseVersion,version(4))
  const retired=publisher.openFeed(event,{encoding:'json-v1'});valid=false;reads[3].resolve({kind:'settings-json-v1',text:'retired'});await assert.rejects(retired,/Retired frame/)
  valid=true;const closing=publisher.openFeed(event,{encoding:'json-v1'});publisher.start()();reads[4].resolve({kind:'settings-json-v1',text:'closing'});await assert.rejects(closing,{code:'app_quitting'})
  cases.push('commits during decode and out-of-order feed replies cannot rewind the publisher; retired frames and shutdown reject late baselines')
}

;(async()=>{try{await workers();const mainFullParseComparison=await repository();await feedOrdering();const result={passed:true,fixture,cases,mainFullParseComparison,scope:'Real Node workers, current repository, actual preload/IPC code in VM and controlled feed ordering; no windows or foreground activity'};fs.writeFileSync(path.join(fixture,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2))}
finally{await Promise.allSettled(readers.map(client=>client.close({cancel:true})));try{await require('../main/settings').disposeSettingsSerialization({cancel:true})}catch{}process.chdir(root);clearTimeout(deadline)}})().catch(error=>{console.error(error);process.exitCode=1})
