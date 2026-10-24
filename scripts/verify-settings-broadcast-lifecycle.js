const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const { createSettingsBroadcast } = require('../main/application/settings-broadcast')
const { settingsEventSchema, settingsLegacyListenerSchema } = require('../packages/contracts')
const { phone } = require('./mobile-module-harness')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
fs.mkdirSync(parent, { recursive: true })
const fixture = fs.mkdtempSync(path.join(parent, 'settings-broadcast-')), cases = []
const version = revision => ({ epoch: 'broadcast-fixture', revision })
const snapshot = (revision, fields = {}) => ({ theme: 'dark', directories: [], privateDirectories: [], favorites: [],
  customTags: {}, customTagRevisions: {}, playbackStates: {}, privacy: { passwordSet: false }, ...fields, _settingsVersion: version(revision) })
const wire = value => ({ kind: 'settings-json-v1', text: JSON.stringify(value) })
const plain = value => JSON.parse(JSON.stringify(value))
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a;reject=b }); return { promise, resolve, reject } }
const tick = async () => { for (let i=0;i<40;i++) await Promise.resolve() }
const until = async check => { const end=Date.now()+5000; while(!check()){if(Date.now()>end)throw Error('Broadcast condition timed out');await new Promise(resolve=>setTimeout(resolve,3))} }
const timeout = setTimeout(()=>{console.error('settings broadcast verification timed out');process.exit(1)},45000)

function controlled(options = {}) {
  let current=snapshot(0), listener, frame=0, plainReads=0, encodedReads=0, sendHook
  const listeners=[], messages=[]
  const contents={mainFrame:{},send(channel,value){messages.push({channel,value:structuredClone(value)});sendHook?.(channel,value)}}
  const event={sender:contents,senderFrame:contents.mainFrame}
  const repository={onSettingsCommitted(fn){listener=fn;listeners.push(fn);return()=>{if(listener===fn)listener=null}},
    sanitizeSettingsForRenderer:value=>value,loadSettings:()=>structuredClone(current),
    captureRendererSettings(){const owned=current;return{version:owned._settingsVersion,read:async()=>wire(owned)}}}
  const publisher=createSettingsBroadcast({settings:repository,maxQueuedMessages:options.maxQueuedMessages||2,
    getMainWindow:()=>({webContents:contents,isDestroyed:()=>false}),captureSender:()=>{
      const captured=frame;return{assertCurrent(){assert.equal(frame,captured,'retired frame')}}
    }})
  let stop=publisher.start()
  function emit(fields={}, {full=false, gate}={}) {
    const base=current._settingsVersion, revision=base.revision+1
    current=snapshot(revision,{...current,...fields,_settingsVersion:version(revision)})
    const owned=current, notice={version:version(revision),baseVersion:base,requiresSnapshot:full,
      readSnapshot(){plainReads++;return structuredClone(owned)},
      captureRendererSnapshot:()=>({version:version(revision),read(){encodedReads++;return gate?gate.promise:Promise.resolve(wire(owned))}}),
      readPatch:()=>({set:fields,maps:{},removed:[]})}
    listener?.(notice);return{snapshot:owned,notice}
  }
  return {publisher,event,messages,emit,listeners,open:()=>publisher.openFeed(event,{encoding:'json-v1'}),
    legacy:(enabled,sequence,encoded=true)=>publisher.setLegacy(event,{enabled,sequence,...(encoded?{encoding:'json-v1'}:{})}),
    navigate:()=>frame++,stop:()=>stop(),currentStop:()=>stop,restart:()=>{stop=publisher.start();return stop},
    hook:fn=>{sendHook=fn},current:()=>current,counts:()=>({plainReads,encodedReads})}
}

async function ordering() {
  const test=controlled(), gate=deferred(), baseline=await test.open()
  const first=test.emit({theme:'first'},{full:true,gate});test.emit({theme:'second'})
  assert.equal(test.messages.length,0)
  gate.resolve(wire(first.snapshot));await until(()=>test.publisher.diagnostics().inFlight===0)
  assert.deepEqual(test.messages.map(item=>item.value.kind),['settings-snapshot-v1','settings-patch-v1'])
  const firstPacket=test.messages[0].value
  assert.deepEqual(JSON.parse(firstPacket.snapshot.text),first.snapshot)
  assert.deepEqual(test.messages[1].value.baseVersion,version(1));assert.equal(firstPacket.feedId,baseline.feedId)
  test.emit({theme:'third'});assert.equal(test.messages.at(-1).value.kind,'settings-patch-v1')
  assert.deepEqual(test.messages.at(-1).value.baseVersion,version(2));assert.equal(test.counts().plainReads,0)
  test.stop();cases.push('a captured historical full snapshot is delivered before later patches, without rewinding the next patch base')
}

async function boundedQueue() {
  const test=controlled(), gate=deferred(), initial=await test.open()
  const first=test.emit({theme:'blocked'},{full:true,gate})
  test.emit({favorites:['must-survive']});test.emit({customTags:{one:['must-survive-too']}})
  test.emit({theme:'four'});test.emit({theme:'five'});test.emit({theme:'six'});test.emit({theme:'seven'})
  assert.deepEqual(test.publisher.diagnostics(),{pendingFrames:1,queuedMessages:2,inFlight:1,compactedMessages:4})
  gate.resolve(wire(first.snapshot));await until(()=>test.publisher.diagnostics().inFlight===0)
  assert.deepEqual(test.messages.map(item=>item.value.kind),['settings-snapshot-v1','settings-snapshot-v1','settings-patch-v1'])
  const { SettingsClient }=phone().load('src/services/settings-client.js'), errors=[]
  const client=new SettingsClient({getSettingsFeed:async()=>({...initial,snapshot:JSON.parse(initial.snapshot.text)}),onSettingsPatched(){}},()=>{},error=>errors.push(error))
  await client.read()
  for (const {value} of test.messages) client.receivePatch(value.kind==='settings-snapshot-v1'?{...value,snapshot:JSON.parse(value.snapshot.text)}:value)
  assert.deepEqual(plain(client.confirmed),test.current());assert.deepEqual(errors,[])
  test.emit({theme:'after-compaction'});assert.deepEqual(test.messages.at(-1).value.baseVersion,version(7))
  assert.equal(test.publisher.diagnostics().pendingFrames,0);client.dispose();test.stop()
  cases.push('bounded queue compaction preserves the latest complete state and later patch causality, including earlier favorites and tags')
}

async function failures() {
  const test=controlled(), gate=deferred();await test.open()
  test.emit({theme:'failure'},{full:true,gate});test.emit({favorites:['queued']})
  gate.reject(Error('SECRET-private-parser-fragment'));await until(()=>test.publisher.diagnostics().inFlight===0)
  assert.deepEqual(test.messages,[{channel:'settings-patched',value:{kind:'settings-resync-v1',feedId:test.messages[0].value.feedId,version:version(2)}}])
  assert.equal(JSON.stringify(test.messages).includes('SECRET'),false)
  test.emit({theme:'recovered'});await until(()=>test.publisher.diagnostics().inFlight===0)
  assert.equal(test.messages.at(-1).value.kind,'settings-snapshot-v1')
  assert.deepEqual(JSON.parse(test.messages.at(-1).value.snapshot.text),test.current())
  test.emit({theme:'normal-again'});assert.equal(test.messages.at(-1).value.kind,'settings-patch-v1');test.stop()

  const reentrant=controlled(), rejected=deferred();await reentrant.open()
  reentrant.hook((_channel,value)=>{if(value.kind==='settings-resync-v1')reentrant.emit({theme:'during-recovery'})})
  reentrant.emit({theme:'bad'},{full:true,gate:rejected});rejected.reject(Error('fixture worker failure'))
  await until(()=>reentrant.messages.length===2&&reentrant.publisher.diagnostics().inFlight===0)
  assert.equal(reentrant.messages[1].value.kind,'settings-snapshot-v1');reentrant.stop()
  cases.push('worker failures emit body-free recovery hints, force a fresh baseline and do not strand commits enqueued during recovery')
}

async function lifetime() {
  const legacy=controlled(), held=deferred();legacy.legacy(true,1)
  const old=legacy.emit({theme:'old-subscription'},{gate:held});legacy.legacy(false,2);legacy.legacy(true,3)
  legacy.emit({theme:'current-subscription'});held.resolve(wire(old.snapshot))
  await until(()=>legacy.publisher.diagnostics().inFlight===0)
  assert.equal(legacy.messages.length,1);assert.equal(legacy.messages[0].value.sequence,3)
  assert.equal(JSON.parse(legacy.messages[0].value.snapshot.text).theme,'current-subscription')
  legacy.legacy(false,4);legacy.emit({theme:'unsubscribed'});assert.equal(legacy.messages.length,1);legacy.stop()

  const test=controlled(), gate=deferred();await test.open()
  const first=test.emit({theme:'old-frame'},{full:true,gate});test.navigate();const fresh=await test.open()
  test.emit({theme:'current-frame'});gate.resolve(wire(first.snapshot));await tick()
  assert.equal(test.messages.length,1);assert.equal(test.messages[0].value.feedId,fresh.feedId)
  const closing=deferred(), pending=test.emit({theme:'closing'},{full:true,gate:closing})
  const staleStop=test.currentStop();staleStop();const stopNew=test.restart();await test.open()
  staleStop();test.emit({theme:'new-lifetime'});closing.resolve(wire(pending.snapshot));await tick()
  assert.equal(test.messages.at(-1).value.set.theme,'new-lifetime')
  const count=test.messages.length;test.listeners[0](pending.notice);assert.equal(test.messages.length,count)
  assert.deepEqual(test.publisher.diagnostics(),{pendingFrames:0,queuedMessages:0,inFlight:0,compactedMessages:0})
  stopNew();test.emit({theme:'stopped'});assert.equal(test.messages.length,count)
  cases.push('legacy unsubscribe/rejoin, navigation, close/restart and stale stop/listener closures cannot publish into newer owners')
}

async function compatibility() {
  const test=controlled();test.emit({theme:'old-preload'})
  assert.equal(test.messages[0].value.kind,undefined)
  const initial=test.publisher.openFeed(test.event);assert.equal(initial.snapshot.kind,undefined)
  test.legacy(true,1,false);test.emit({theme:'legacy-both'},{full:true})
  assert.deepEqual(test.messages.slice(-2).map(item=>item.channel),['settings-changed','settings-patched'])
  assert.equal(test.messages.at(-1).value.snapshot.theme,'legacy-both');assert.equal(test.counts().encodedReads,0)
  assert.deepEqual(settingsLegacyListenerSchema.parse({enabled:true,sequence:1}),{enabled:true,sequence:1})
  assert.throws(()=>settingsLegacyListenerSchema.parse({enabled:true,sequence:2,encoding:'unknown'}));test.stop()
  cases.push('option-free older feeds and legacy subscriptions retain their ordinary object replies')
}

function bridge() {
  const ipcRenderer=new EventEmitter(), requests=[], reads=[];let api
  ipcRenderer.invoke=(channel,...args)=>{
    requests.push({channel,args})
    if(channel==='get-settings'){const held=deferred();reads.push(held);return held.promise}
    return Promise.resolve()
  }
  const context=vm.createContext({require:()=>({ipcRenderer,contextBridge:{exposeInMainWorld(_key,value){api=value}},webUtils:{}}),
    window:{localStorage:{getItem(){return null}}},document:{},console})
  vm.runInContext(fs.readFileSync(path.join(root,'preload.js'),'utf8'),context,{filename:'preload.js'})
  return{api,requests,reads,send:(channel,value)=>ipcRenderer.emit(channel,{},value)}
}

async function preload() {
  const test=bridge(), frames=[], first=[], second=[], rejoined=[]
  const stopFeed=test.api.onSettingsPatched(value=>frames.push(plain(value)))
  test.send('settings-patched',{kind:'settings-snapshot-v1',feedId:'fixture',snapshot:wire(snapshot(1))})
  assert.equal(frames[0].snapshot.theme,'dark');assert.equal(frames[0].snapshot.kind,undefined)
  test.send('settings-patched',{kind:'settings-snapshot-v1',feedId:'fixture',version:version(2),snapshot:{kind:'settings-json-v1',text:'malformed'}})
  assert.deepEqual(frames[1],{kind:'settings-resync-v1',feedId:'fixture',version:version(2)});settingsEventSchema.parse(frames[1])
  test.send('settings-patched',{kind:'settings-snapshot-v1',feedId:'old-core',snapshot:snapshot(3)})
  assert.equal(frames[2].snapshot._settingsVersion.revision,3);stopFeed()

  const stopFirst=test.api.onSettingsChanged(value=>first.push(plain(value))), stopSecond=test.api.onSettingsChanged(value=>second.push(plain(value)))
  assert.deepEqual(plain(test.requests[0]),{channel:'settings-legacy-listener',args:[{enabled:true,sequence:1,encoding:'json-v1'}]})
  for(let i=0;i<30;i++)test.send('settings-changed',{kind:'settings-legacy-resync-v1',sequence:1})
  assert.equal(test.reads.length,1);test.reads[0].resolve(wire(snapshot(1)));await tick()
  assert.equal(first.length,1);assert.equal(second.length,1)
  test.send('settings-changed',{kind:'settings-legacy-resync-v1',sequence:1});assert.equal(test.reads.length,2)
  test.send('settings-changed',{kind:'settings-legacy-json-v1',sequence:1,snapshot:wire(snapshot(3,{theme:'live-newer'}))})
  test.reads[1].resolve(wire(snapshot(2,{theme:'late-older-read'})));await tick()
  assert.deepEqual(first.map(value=>value._settingsVersion.revision),[1,3]);assert.deepEqual(second.map(value=>value._settingsVersion.revision),[1,3])
  test.send('settings-changed',{kind:'settings-legacy-resync-v1',sequence:1});assert.equal(test.reads.length,3)
  stopFirst();stopSecond();test.api.onSettingsChanged(value=>rejoined.push(plain(value)))
  test.reads[2].resolve(wire(snapshot(4)));await tick();assert.equal(first.length,2);assert.equal(rejoined.length,0)
  test.send('settings-changed',{kind:'settings-legacy-json-v1',sequence:1,snapshot:wire(snapshot(5))});assert.equal(rejoined.length,0)
  test.send('settings-changed',{kind:'settings-legacy-json-v1',sequence:3,snapshot:wire(snapshot(6))});assert.equal(rejoined.length,1)
  test.send('settings-changed',{kind:'settings-legacy-json-v1',sequence:3,snapshot:{kind:'settings-json-v1',text:'bad'}})
  test.reads[3].reject(Error('read failed'));await tick();assert.equal(test.reads.length,4)
  cases.push('actual preload decodes full packets, coalesces recovery once per listener and blocks stale reads and retired subscription callbacks')
}

async function recoveryClient() {
  const { SettingsClient }=phone().load('src/services/settings-client.js'), reads=[], errors=[], views=[]
  const client=new SettingsClient({getSettingsFeed(){const held=deferred();reads.push(held);return held.promise},onSettingsPatched(){}},value=>views.push(value),error=>errors.push(error))
  const initial=client.read();await tick();reads[0].resolve({kind:'settings-feed-v1',feedId:'fixture',snapshot:snapshot(1)});await initial
  const hint=revision=>({kind:'settings-resync-v1',feedId:'fixture',version:version(revision)})
  client.receivePatch({...hint(2),feedId:'retired'});client.receivePatch(hint(1));await tick();assert.equal(reads.length,1)
  for(let i=0;i<30;i++)client.receivePatch(hint(2));await tick();assert.equal(reads.length,2)
  reads[1].reject(Error('visible recovery failure'));await tick();assert.deepEqual(errors,['visible recovery failure']);assert.equal(reads.length,2)
  client.receivePatch(hint(3));await tick();assert.equal(reads.length,3)
  reads[2].resolve({kind:'settings-feed-v1',feedId:'fixture',snapshot:snapshot(3,{theme:'resynced'})});await tick()
  assert.equal(client.confirmed.theme,'resynced');assert.equal(reads.length,3)
  client.receivePatch(hint(4));await tick();const count=views.length;client.dispose()
  reads[3].resolve({kind:'settings-feed-v1',feedId:'fixture',snapshot:snapshot(4)});await tick();assert.equal(views.length,count)
  cases.push('renderer resync hints coalesce authoritative reads, report failures without retry loops and reject late disposed reads')
}

async function actualRepository() {
  process.chdir(fixture)
  const settings=require('../main/settings'), directory=path.join(fixture,'library');fs.mkdirSync(directory)
  assert.equal(require('../main/user-data').getUserDataDir(),path.join(fixture,'.tmp-wallpaper-player'))
  await settings.saveSettingsAndFlush({directories:[directory],customTags:Object.fromEntries(Array.from({length:10000},(_,i)=>['file-'+i,['tag-'+i]])),
    privacy:{salt:'a'.repeat(32),passwordHash:'b'.repeat(64)}})
  const messages=[], contents={mainFrame:{},send(channel,value){messages.push({channel,value})}}, event={sender:contents,senderFrame:contents.mainFrame}
  const publisher=createSettingsBroadcast({settings,getMainWindow:()=>({webContents:contents,isDestroyed:()=>false}),captureSender:()=>({assertCurrent(){}})}),stop=publisher.start()
  const countFull=async action=>{
    let count=0;const parse=JSON.parse
    JSON.parse=(text,...args)=>{if(typeof text==='string'&&text.includes('"customTags":')&&text.includes('"directories":')&&text.includes('"privacy":'))count++;return parse(text,...args)}
    try {await action();await until(()=>publisher.diagnostics().inFlight===0)} finally {JSON.parse=parse}
    return count
  }
  let unregister
  try {
    publisher.setLegacy(event,{enabled:true,sequence:1})
    const legacy=await countFull(()=>settings.commitSettingsPatch({theme:'old-notification'},{returnSettings:false}));assert.equal(legacy,1)
    publisher.setLegacy(event,{enabled:true,sequence:2,encoding:'json-v1'});messages.length=0
    const encodedLegacy=await countFull(()=>settings.commitSettingsPatch({theme:'encoded-notification'},{returnSettings:false}));assert.equal(encodedLegacy,0)
    const legacyView=JSON.parse(messages[0].value.snapshot.text)
    assert.deepEqual(legacyView.privacy,{passwordSet:true});assert.equal(Object.hasOwn(legacyView,'tagMutationReceipts'),false)
    publisher.setLegacy(event,{enabled:false,sequence:3,encoding:'json-v1'});await publisher.openFeed(event,{encoding:'json-v1'})
    unregister=settings.registerSettingsSection('broadcastFixture',{defaults:{enabled:true}});messages.length=0
    const encodedFallback=await countFull(()=>settings.commitSettingsPatch({theme:'encoded-fallback'},{returnSettings:false}));assert.equal(encodedFallback,0)
    const packet=messages[0].value;assert.equal(packet.kind,'settings-snapshot-v1')
    const publicSnapshot=JSON.parse(packet.snapshot.text);settingsEventSchema.parse({...packet,snapshot:publicSnapshot})
    assert.equal(publicSnapshot.theme,'encoded-fallback');assert.equal(Object.keys(publicSnapshot.customTags).length,10000)
    assert.deepEqual(publicSnapshot.privacy,{passwordSet:true});assert.equal(Object.hasOwn(publicSnapshot,'tagMutationReceipts'),false)
    cases.push('actual 10000-tag commits: old legacy full main JSON.parse 1, encoded legacy 0, encoded forced-fallback 0; public snapshots stay redacted')
    return{tags:10000,legacy,encodedLegacy,encodedFallback}
  } finally {stop();unregister?.();await settings.disposeSettingsSerialization();process.chdir(root)}
}

;(async()=>{try{
  await ordering();await boundedQueue();await failures();await lifetime();await compatibility();await preload();await recoveryClient()
  const mainFullParses=await actualRepository(), files=['main/application/settings-broadcast.js','main/settings.js','preload.js','src/services/settings-client.js','packages/contracts/src/settings-feed.ts','scripts/verify-settings-broadcast-lifecycle.js']
  const result={date:new Date().toISOString(),passed:true,fixture,cases,mainFullParses,sourceDigests:Object.fromEntries(files.map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')])),scope:'Real repository/workers plus controlled delays, frame lifetimes and actual preload in VM. No windows, focus changes or foreground work.'}
  fs.writeFileSync(path.join(fixture,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2))
}finally{try{await require('../main/settings').disposeSettingsSerialization({cancel:true})}catch{}process.chdir(root);clearTimeout(timeout)}})().catch(error=>{console.error(error);process.exitCode=1})
