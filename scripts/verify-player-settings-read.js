const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto')
const {createRequire}=require('node:module'),{EventEmitter}=require('node:events'),{performance}=require('node:perf_hooks')
const {ResourceScheduler}=require('../main/application/resource-scheduler')
const root=path.resolve(__dirname,'..'),parent=path.join(root,'.tmp/refactor-tests')
fs.mkdirSync(parent,{recursive:true});const fixture=fs.mkdtempSync(path.join(parent,'player-settings-read-'))
const baselineOption=process.argv.find(value=>value.startsWith('--baseline-root='))
const sourceRoot=baselineOption?path.resolve(root,baselineOption.slice('--baseline-root='.length)):root
if(baselineOption){const relative=path.relative(parent,sourceRoot);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative))}
const sources=['main/application/player-service.js','main/ipc/player.js','main/mpv-integration.js','main/mpv.js','main/ipc/network-resource-service.js']
const cases=[],measurements={},gates=[]
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return{promise,resolve}}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const until=async check=>{const end=Date.now()+5000;while(!check()){if(Date.now()>end)throw Error('Player settings condition timed out');await delay(3)}}
const deadline=setTimeout(()=>{console.error('player settings verification timed out');process.exit(1)},30000)
function load(file,overrides={}){
  const filename=path.join(root,file),normal=createRequire(filename),module={exports:{}}
  const context=vm.createContext({module,exports:module.exports,require:name=>Object.hasOwn(overrides,name)?overrides[name]:normal(name),
    __dirname:path.dirname(filename),__filename:filename,process,Buffer,URL,console,JSON,AbortController,AbortSignal,setTimeout,clearTimeout,setImmediate,clearImmediate})
  vm.runInContext(fs.readFileSync(path.join(sourceRoot,file),'utf8'),context,{filename});return module.exports
}
async function measure(name,action){
  const original=JSON.parse;let fullParses=0,fullParseBytes=0
  JSON.parse=(text,...args)=>{const value=original(text,...args)
    if(value&&typeof value==='object'&&['customTags','directories','privacy'].every(key=>Object.hasOwn(value,key))){fullParses++;fullParseBytes+=Buffer.byteLength(text)}
    return value
  }
  const start=performance.now();let result
  try{result=await action()}finally{JSON.parse=original}
  measurements[name]={fullParses,fullParseBytes,elapsedMs:performance.now()-start}
  assert.equal(fullParses>0,Boolean(baselineOption),name+' should '+(baselineOption?'exercise prior full reads':'avoid unrelated full settings'))
  return result
}
async function main(){
  process.chdir(fixture)
  const settings=require('../main/settings'),library=path.join(fixture,'library'),executable=path.join(fixture,'mpv.exe')
  fs.mkdirSync(library);fs.writeFileSync(executable,'fixture only; never executed')
  const target=path.join(library,'Target.mp4');fs.writeFileSync(target,'fixture only; never decoded')
  assert.equal(require('../main/user-data').getUserDataDir(),path.join(fixture,'.tmp-wallpaper-player'))
  const direct='https://media.example.com/Direct.MP4',page='https://media.example.com/watch',resolved='https://media.example.com/Resolved.MP4'
  const resources=[{id:'direct',url:direct,kind:'direct',title:'Direct'},{id:'page',url:page,kind:'webpage',title:'Page',httpHeaders:{referer:'https://media.example.com/',userAgent:'fixture'}}]
  await settings.saveSettingsAndFlush({directories:[library],mpvPath:executable,customTags:Object.fromEntries(Array.from({length:10000},(_,i)=>['file-'+i,['tag-'+i]])),
    playbackStates:{[settings.getPlaybackStateKey(target)]:{position:40,volume:0,speed:1.5,updatedAt:1,writers:{fixture:{session:1,sequence:1,position:40,updatedAt:1}}},
      [settings.getPlaybackStateKey(direct)]:{position:25,volume:10,speed:1.25,updatedAt:1}},networkResources:resources})
  const scheduler=new ResourceScheduler({subscribe:()=>()=>{},getPressure:()=>({})}),sender=new EventEmitter()
  sender.id=71;sender.mainFrame={};sender.isDestroyed=()=>false
  const event={sender,senderFrame:sender.mainFrame},window={webContents:sender},handlers=new Map(),plays=[],pressure=[],authority=[]
  const control={parserGate:null,parserEntered:0,parserSignals:[],toolGate:null,toolEntered:0,allowed:true,paths:[]}
  const initial=()=>({filePath:null,timePos:0,duration:100,paused:false,ready:false,volume:100,muted:false,speed:1,eofReached:false,trackList:[],sessionId:'',engineSessionId:0})
  class Manager extends EventEmitter{
    constructor(){super();this.state=initial();this.path=null}
    getState(){return this.state} getMpvPath(){return this.path}
    async setMpvPath(value,options){options?.throwIfAborted?.();this.path=value;control.paths.push(value);return value}
    async findMpv(){throw Error('unexpected tool discovery')}
    async stop(){this.state=initial()}
    async play(value,options){options.isCurrent();plays.push({target:value,options});this.state={...initial(),filePath:value,resourceTarget:options.resourceTarget,
      ready:true,sessionId:options.sessionId,engineSessionId:plays.length,volume:options.resume.volume??100,timePos:options.resume.position??0,speed:options.resume.speed??1}}
    async destroy(){}
  }
  const integration=load('main/mpv-integration.js',{'./settings':settings,'./mpv':Manager,'./window':{getMainWindow:()=>window},
    './thumbnail':{setMediaPlaybackActive:value=>pressure.push(value)},'./application/media-mutations':{savePlaybackRecord(){throw Error('unexpected persistence')}}})
  const network=load('main/ipc/network-resource-service.js',{'../settings':settings,'../scanner':{resolveExistingPath:async value=>value},
    '../network-resource-parser':{getParserForUrl:()=>null,async parseNetworkResourcePage(_url,options){
      control.parserEntered++;control.parserSignals.push(options.signal);if(control.parserGate)await control.parserGate.promise
      return{playbackUrl:resolved,httpHeaders:{referer:'https://media.example.com/'},parser:'fixture',page:{openMode:'video'}}
    }}})
  const service=load('main/application/player-service.js',{'./resource-scheduler':{mediaScheduler:scheduler}})
  const ipc=load('main/ipc/player.js',{'electron':{dialog:{showOpenDialog(){throw Error('unexpected dialog')}}},'../security/ipc':{},
    '../exec':{execFileTreeAsync(){throw Error('unexpected native process')}},'../application/resource-scheduler':{mediaScheduler:scheduler},
    '../application/media-work-service':{},'../settings':settings,'../scanner':{async assertAllowedVideoPath(value,options){
      options.throwIfAborted();authority.push(value);if(!control.allowed)throw Object.assign(Error('fixture access revoked'),{code:'media_access_denied'});return value
    }},'../mpv-integration':{mpvManager:integration.mpvManager,async resolveMpvPath(options){
      control.toolEntered++;if(control.toolGate)await control.toolGate.promise;return integration.resolveMpvPath(options)
    }},'../thumbnail':{setMediaPlaybackActive:value=>pressure.push(value)},'../window':{getMainWindow:()=>window},
    './network-resource-service':network,'../application/player-service':service})
  ipc.registerPlayerIpc({handle:(channel,action)=>handlers.set(channel,action)})
  const {IPC}=require('../main/ipc-channels')
  const invoke=request=>handlers.get(IPC.PLAYER_ACTION)(event,{action:'load',...request})
  const commit=patch=>settings.commitSettingsPatch(patch,{returnSettings:false})
  try{
    const local=await measure('localResume',()=>invoke({sessionId:'local',source:'local',target}))
    assert.equal(local.success,true);assert.equal(plays.at(-1).options.resume.position,40);assert.equal(plays.at(-1).options.resume.volume,0)
    assert.equal(plays.at(-1).options.resume.speed,1.5);assert.equal(authority.length,2)
    plays.at(-1).options.resume.writers.fixture.position=999
    assert.equal(settings.readPlaybackState(target).writers.fixture.position,40)
    cases.push('production player IPC uses detached per-target resume state, keeps zero volume/speed and rechecks local authority after tool resolution')

    const restart=await measure('localRestart',()=>handlers.get(IPC.MPV_PLAY)(event,target,{resume:false}))
    assert.equal(restart.success,true);assert.equal(plays.at(-1).options.resume.position,0);assert.equal(plays.at(-1).options.resume.volume,0)
    cases.push('legacy local restart resets position while preserving saved playback preferences')

    const known=await measure('knownNetwork',()=>invoke({sessionId:'known',source:'network',target:direct}))
    assert.equal(known.success,true);assert.equal(plays.at(-1).options.resume.position,25);assert.equal(plays.at(-1).options.resourceTarget,direct)
    const temporary=await measure('temporaryNetwork',()=>handlers.get(IPC.MPV_PLAY_URL)(event,'https://media.example.com/Temporary.MP4',{temporary:true}))
    assert.equal(temporary.success,true);assert.equal(plays.at(-1).target,'https://media.example.com/Temporary.MP4')
    cases.push('known and temporary network playback retain logical resource targets through actual production resolver and IPC wiring')

    const installers=[]
    const RawManager=load('main/mpv.js',{'electron':{app:{getPath:()=>fixture,isPackaged:false}},'./settings':settings,
      './application/mpv-installer':{MpvInstaller:class{constructor(options){installers.push(options)}}},'./window':{getMainWindow:()=>null},
      './mpv-host':{},'./ytdlp-service':{getSystemProxyAsync:async()=>null},'child_process':{spawn(){throw Error('native process forbidden')}}})
    new RawManager();assert.equal(installers.length,1)
    const pinned=await measure('mpvConfiguredPin',()=>installers[0].configuredPaths());assert.deepEqual(Array.from(pinned),[executable])
    const directory=await measure('libraryDirectoryPolicy',()=>network.isPersistentLibraryDirectory(target));assert.equal(directory,true)
    assert.equal(network.isPersistentLibraryDirectory(path.dirname(library)),false)
    cases.push('real mpv constructor retains the configured-path protection callback and directory policy reads only its own field')

    control.toolGate=deferred();gates.push(control.toolGate);const entered=control.toolEntered
    const latest=invoke({sessionId:'latest-resume',source:'local',target});await until(()=>control.toolEntered>entered)
    const state=settings.loadSettingsFields(['playbackStates']).playbackStates
    await commit({playbackStates:{...state,[settings.getPlaybackStateKey(target)]:{position:88,volume:0,speed:2,updatedAt:2}}})
    control.toolGate.resolve();control.toolGate=null;assert.equal((await latest).success,true);assert.equal(plays.at(-1).options.resume.position,88)
    assert.equal(plays.at(-1).options.resume.speed,2)
    cases.push('resume reads stay after asynchronous tool preparation and observe the latest committed record')

    const before=plays.length;control.toolGate=deferred();gates.push(control.toolGate);const accessEntered=control.toolEntered
    const revoked=invoke({sessionId:'revoked',source:'local',target});await until(()=>control.toolEntered>accessEntered)
    control.allowed=false;control.toolGate.resolve();control.toolGate=null
    assert.equal((await revoked).code,'media_access_denied');assert.equal(plays.length,before);control.allowed=true
    cases.push('local authority revoked during tool preparation prevents any late play')

    control.parserGate=deferred();gates.push(control.parserGate);const parseEntered=control.parserEntered
    const removed=invoke({sessionId:'removed-network',source:'network',target:page});await until(()=>control.parserEntered>parseEntered)
    assert.ok(control.parserSignals.at(-1) instanceof AbortSignal)
    await commit({networkResources:[resources[0]]});control.parserGate.resolve();control.parserGate=null
    assert.equal((await removed).code,'stale_network_resource');assert.equal(plays.length,before)
    await commit({networkResources:resources})
    control.parserGate=deferred();gates.push(control.parserGate);const changedEntered=control.parserEntered
    const changed=invoke({sessionId:'changed-network',source:'network',target:page});await until(()=>control.parserEntered>changedEntered)
    await commit({networkResources:[resources[0],{...resources[1],httpHeaders:{referer:'https://media.example.com/changed',userAgent:'fixture'}}]})
    control.parserGate.resolve();control.parserGate=null;assert.equal((await changed).code,'stale_network_resource');assert.equal(plays.length,before)
    cases.push('known network resources are freshly revalidated after parsing; removal or changed credentials cannot play an old result')

    await commit({networkResources:resources});control.parserGate=deferred();gates.push(control.parserGate);const stopEntered=control.parserEntered
    const stopped=invoke({sessionId:'stopped-network',source:'network',target:page});await until(()=>control.parserEntered>stopEntered)
    await handlers.get(IPC.MPV_STOP)(event);control.parserGate.resolve();control.parserGate=null
    assert.equal((await stopped).code,'stale_session');assert.equal(plays.length,before)
    await scheduler.waitForIdle(['player-prepare']);assert.equal(scheduler.diagnostics().used.prepare||0,0)
    assert.equal(pressure.at(-1),false)
    cases.push('stop reaches the real resolver context, invalidates pending parsing and releases the preparation slot without a late play')

    const sourceDigests=Object.fromEntries(sources.map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(sourceRoot,file))).digest('hex')]))
    const result={date:new Date().toISOString(),passed:true,baselineMode:Boolean(baselineOption),fixture,cases,measurements,sourceDigests,
      conditions:'Actual isolated 10000-tag settings repository and worker writes, current or explicitly captured source modules in VM, real IPC registration/service/resolver/integration paths. Manager, window, parser and authority dependencies controlled. No external network, decoder, native player process, window or focus action. Parse counts are not native latency/P95 or memory-budget acceptance.'}
    fs.writeFileSync(path.join(fixture,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2))
  }finally{gates.forEach(gate=>gate.resolve());await scheduler.dispose();await settings.disposeSettingsSerialization();process.chdir(root)}
}
main().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{gates.forEach(gate=>gate.resolve());try{await require('../main/settings').disposeSettingsSerialization({cancel:true})}catch{}process.chdir(root);clearTimeout(deadline)})
