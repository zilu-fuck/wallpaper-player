const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const { phone } = require('./mobile-module-harness')
const root = path.resolve(__dirname, '..'), parent = path.join(root, '.tmp/refactor-tests')
const fixture = fs.mkdtempSync(path.join(parent, 'settings-replies-')), passed = []
const hash = file => fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null
const fallback = path.join(root, '.tmp-wallpaper-player/settings.json'), fallbackBefore = hash(fallback)
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b }); return {promise,resolve,reject} }
const tick = async () => { for(let i=0;i<50;i++) await Promise.resolve() }
const version = revision => ({epoch:'receipt-fixture',revision})
const snapshot = (revision, theme='dark') => ({theme, customTags:{stable:['tag']}, privacy:{passwordSet:false}, _settingsVersion:version(revision)})
const feed = (revision,theme) => ({kind:'settings-feed-v1',feedId:'receipt-feed',snapshot:snapshot(revision,theme)})
const ack = revision => ({success:true,settingsVersion:version(revision)})
async function renderer() {
  const {SettingsClient} = phone().load('src/services/settings-client.js'), reads=[], writes=[], errors=[]
  const api={onSettingsPatched(){},getSettingsFeed(){const d=deferred();reads.push(d);return d.promise}, saveSettings(patch,options){const d=deferred();writes.push({...d,patch,options});return d.promise}}
  const client=new SettingsClient(api,()=>{},error=>errors.push(error))
  const initial=client.read();await tick();reads[0].resolve(feed(1));await initial
  const save=client.save({theme:'light'});await tick()
  assert.deepEqual(JSON.parse(JSON.stringify(writes[0].options)),{settingsReply:'version-v1'})
  client.receivePatch({kind:'settings-patch-v1',feedId:'receipt-feed',baseVersion:version(1),version:version(2),set:{theme:'light'},removed:[],maps:{}})
  writes[0].resolve(ack(2));await save;assert.equal(reads.length,1)
  passed.push('normal version acknowledgment uses the already observed feed without a full read')
  const lost=client.save({theme:'dark'});await tick();writes[1].resolve(ack(3));await tick()
  assert.equal(reads.length,2);reads[1].resolve(feed(3));await lost
  passed.push('missing final broadcast recovers from the acknowledgment with one authoritative read')
  const one=client.reconcileMutation(ack(4)),two=client.reconcileMutation(ack(4));await tick();assert.equal(reads.length,3)
  reads[2].resolve(feed(4,'light'));await Promise.all([one,two]);assert.equal(client.confirmed.theme,'light')
  await client.reconcileMutation(ack(2));assert.equal(reads.length,3)
  passed.push('concurrent media acknowledgments share a recovery read and old acknowledgments preserve new state')
  const impossible=client.reconcileMutation(ack(900));await tick();assert.equal(reads.length,4)
  reads[3].resolve(feed(4,'light'));await assert.rejects(impossible,/同步未完成/);await tick();assert.equal(reads.length,4)
  await assert.rejects(client.reconcileMutation({settingsVersion:version(-1)}));assert.equal(reads.length,4)
  passed.push('malformed or unreachable acknowledgment cannot spin, silently succeed or mutate confirmed state')
  const failed=client.save({theme:'dark'});await tick();writes[2].resolve({success:false,error:'fixture failure'})
  await assert.rejects(failed,/fixture failure/);assert.equal(client.view.theme,'light');assert.equal(errors.at(-1),'fixture failure')
  const retiring=client.save({theme:'dark'});await tick();client.dispose();writes[3].resolve(ack(5));await assert.rejects(retiring,/已关闭/)
  passed.push('failed persistence rolls back intent and retired save acknowledgments cannot publish')
  let legacyOptions
  const legacy=new SettingsClient({getSettings:async()=>snapshot(1),saveSettings:async(_patch,options)=>{legacyOptions=options;return {success:true,settings:snapshot(2,'light')}}},()=>{},()=>{})
  await legacy.read();await legacy.save({theme:'light'});assert.equal(legacyOptions,undefined);assert.equal(legacy.confirmed.theme,'light')
  passed.push('legacy save API retains complete snapshot behavior without the reply option')
}
async function repository() {
  process.chdir(fixture)
  assert.equal(require('../main/user-data').getUserDataDir(),path.join(fixture,'.tmp-wallpaper-player'))
  const settings=require('../main/settings'),handlers=new Map(),ipc={handle:(channel,fn)=>handlers.set(channel,fn)}
  require('../main/ipc/settings').registerSettingsIpc(ipc);require('../main/ipc/media-data').registerMediaDataIpc(ipc)
  const dir=path.join(fixture,'library');fs.mkdirSync(dir);const fullPath=path.join(dir,'target.mp4');fs.writeFileSync(fullPath,'fixture; never decoded')
  await settings.saveSettingsAndFlush({directories:[dir],customTags:{stable:['original']}})
  const call=(channel,...args)=>handlers.get(channel)({},...args),opt={settingsReply:'version-v1'}
  try {
    const old=await call('save-settings',{theme:'light'});assert.ok(old.settings);assert.equal(Object.hasOwn(old,'settingsVersion'),false)
    const result=await call('save-settings',{theme:'dark'},opt);assert.ok(result.settingsVersion);assert.equal(Object.hasOwn(result,'settings'),false)
    result.settingsVersion.revision=999;assert.notEqual(settings.sanitizeSettingsForRenderer(settings.loadSettings())._settingsVersion.revision,999)
    await assert.rejects(call('save-settings',{theme:'forbidden'},{settingsReply:'unknown'}));assert.equal(settings.loadSettings().theme,'dark')
    const empty=await call('save-settings',{},opt);assert.equal(empty.settingsVersion.revision,settings.sanitizeSettingsForRenderer(settings.loadSettings())._settingsVersion.revision)
    passed.push('production IPC opt-in returns detached commit versions including no-op and rejects invalid options before writes')
    const legacy=await call('media-get-tags',{fullPath});assert.ok(legacy.settings)
    const read=await call('media-get-tags',{fullPath},opt);assert.equal(Object.hasOwn(read,'settings'),false);assert.ok(read.settingsVersion)
    const favorite=await call('media-set-favorite',{fullPath},true,opt);assert.equal(favorite.favorite,true);assert.ok(favorite.settingsVersion)
    const condition={expectedRevision:read.customTagsRevision,operationId:'receipt_test_op'}
    const tagged=await call('media-set-tags',{fullPath},['new'],condition,opt);assert.equal(tagged.success,true)
    const replay=await call('media-set-tags',{fullPath},['new'],condition,opt);assert.equal(replay.replayed,true)
    assert.deepEqual(replay.settingsVersion,tagged.settingsVersion)
    const conflict=await call('media-set-tags',{fullPath},['other'],{...condition,operationId:'other_receipt_op'},opt);assert.equal(conflict.code,'tags_conflict')
    const bulk=await call('media-append-tags',[{fullPath},{fullPath:path.join(fixture,'not-permitted.mp4')}],['bulk'],opt)
    assert.equal(bulk.updatedCount,1);assert.equal(bulk.failed.length,1);assert.ok(bulk.settingsVersion)
    const invalid=await call('media-set-favorite',{fullPath},false,{settingsReply:'unknown'});assert.equal(invalid.success,false)
    assert.ok(settings.loadSettings().favorites.includes(favorite.favoriteKey))
    passed.push('media IPC preserves tag CAS/replay, bulk partial failure and legacy replies while version replies omit full settings')
    const parse=JSON.parse;let fullParses=0
    JSON.parse=(...args)=>{const value=parse(...args);if(value?.customTags&&value?.privacy&&value?.directories)fullParses++;return value}
    try { settings.sanitizeSettingsForSave({theme:'light'});assert.equal(fullParses,0) } finally {JSON.parse=parse}
    const prior=settings.loadSettings().directories
    assert.deepEqual(settings.sanitizeSettingsForSave({directories:[dir,path.join(fixture,'unapproved')]}).directories,prior)
    const custom=settings.registerSettingsSection('receiptSection',{defaults:{enabled:false},sanitizeForSave(next,current){current.enabled=true;return next}})
    await settings.saveSettingsAndFlush({receiptSection:{enabled:false}})
    settings.sanitizeSettingsForSave({receiptSection:{enabled:false}});assert.equal(settings.loadSettings().receiptSection.enabled,false);custom()
    passed.push('save sanitation reads selected fields, preserves directory policy and isolates custom sanitizer inputs')
    const rename=fs.promises.rename;fs.promises.rename=async()=>{throw Object.assign(Error('fixture disk failure'),{code:'EACCES'})}
    const priorVersion=settings.sanitizeSettingsForRenderer(settings.loadSettings())._settingsVersion
    try {await assert.rejects(call('save-settings',{theme:'light'},opt));assert.deepEqual(settings.sanitizeSettingsForRenderer(settings.loadSettings())._settingsVersion,priorVersion)}finally{fs.promises.rename=rename}
    passed.push('failed disk replacement cannot return a success version or publish a new snapshot')
  } finally {await settings.flushSettingsWrites();await settings.disposeSettingsSerialization();process.chdir(root)}
}
;(async()=>{
  await renderer();await repository();assert.equal(hash(fallback),fallbackBefore)
  const files=['main/settings.js','main/ipc/settings.js','main/ipc/media-data.js','main/application/media-mutations.js','preload.js','src/services/settings-client.js','src/api/media.ts','src/hooks/useAppState.js','src/hooks/useAppController.js','src/hooks/useFavorites.js','src/hooks/useTagEditor.js','packages/contracts/src/settings-feed.ts']
  const evidence={date:new Date().toISOString(),fixture:path.relative(root,fixture),passed,sourceDigests:Object.fromEntries(files.map(file=>[file,hash(path.join(root,file))])),conditions:'Actual production settings, JSON worker and IPC handlers under controlled registration; production SettingsClient through module harness. Native frame/preload/App checks are separate.'}
  fs.writeFileSync(path.join(parent,'settings-replies-lifecycle.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence))
})().catch(error=>{console.error(error);process.exitCode=1})
