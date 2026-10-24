const fs = require('node:fs'), fsp = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const root = path.resolve(__dirname,'..'), testRoot = path.join(root,'.tmp/refactor-tests')
let nativePhase='starting'
async function native() {
  const { app, BrowserWindow } = require('electron'), { pathToFileURL } = require('node:url')
  const fixture = process.env.WALLPAPER_SPLASH_FIXTURE
  assert.ok(path.resolve(fixture).startsWith(testRoot + path.sep)); assert.ok(path.basename(fixture).startsWith('splash-ui-'))
  app.setPath('userData',fixture); app.on('window-all-closed',()=>{})
  const mark=phase=>{nativePhase=phase;fs.appendFileSync(path.join(fixture,'progress.log'),phase+'\n')}
  await app.whenReady()
  mark('app ready')
  const settings = require('../main/settings'), { IPC } = require('../main/ipc-channels'), { ipcMain } = require('../main/security/ipc')
  await settings.saveSettingsAndFlush({ theme:'dark',directories:[],remoteAccess:{enabled:false},windowClose:{mode:'exit'} })
  mark('settings ready')
  let held = null
  require('../main/ipc/settings').registerSettingsIpc({handle(channel,action){ipcMain.handle(channel,async(...args)=>{
    if(held && [IPC.GET_SETTINGS,IPC.GET_SETTINGS_FEED].includes(channel)) await held
    return action(...args)
  })}})
  for(const [channel,result] of [[IPC.PLUGINS_LIST,[]],[IPC.CHECK_FFMPEG,{available:false}],[IPC.CHECK_MPV,{available:false}],[IPC.SCAN_DIRECTORY,{videos:[]}],[IPC.UPDATER_GET_STATUS,{status:'disabled'}]]) ipcMain.handle(channel,async()=>result)
  const results=[]
  try {
    for(const scenario of ['fast','wall-clock-jump','raf-and-settings-held']) {
      mark(scenario+': create window')
      let release
      if(scenario==='raf-and-settings-held') held=new Promise(resolve=>{release=resolve})
      const window=new BrowserWindow({show:false,width:1100,height:760,webPreferences:{preload:path.join(root,'preload.js'),contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}})
      require('../main/window').setMainWindow(window)
      const entry=path.join(root,'dist/index.html')
      const remove=settings.onSettingsChanged(snapshot=>{if(!window.isDestroyed())window.webContents.send(require('../main/ipc-channels').EVENT.SETTINGS_CHANGED,settings.sanitizeSettingsForRenderer(snapshot))})
      const run=source=>window.webContents.executeJavaScript(source)
      try {
        await window.loadURL('about:blank')
        require('../main/security/ipc-sender').bindAppWindow(window,pathToFileURL(entry).href)
        mark(scenario+': blank loaded')
        window.webContents.debugger.attach('1.3')
        await window.webContents.debugger.sendCommand('Page.enable')
        mark(scenario+': page enabled')
        await window.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument',{source:`
          window.__splashObserved = { scenario: ${JSON.stringify(scenario)}, errors: [] };
          window.addEventListener('error', event => window.__splashObserved.errors.push(String(event.message)));
          window.addEventListener('unhandledrejection', event => window.__splashObserved.errors.push(String(event.reason)));
          ${scenario==='wall-clock-jump' ? "const wallNow = Date.now; Date.now = () => wallNow() + 86400000;" : ''}
          ${scenario==='raf-and-settings-held' ? "window.__realSplashRaf = window.requestAnimationFrame; window.requestAnimationFrame = () => 1;" : ''}
          let splash;
          const observer = new MutationObserver(() => {
            splash ||= document.getElementById('app-splash');
            if (!splash) return;
            const result = window.__splashObserved;
            if (splash.classList.contains('is-leaving') && result.leave === undefined) {
              result.clock = window.__splashClock; result.start = window.__splashStartedAt;
              result.leave = performance.now() - result.start;
              result.primaryUi = Boolean(document.querySelector('.sidebar'));
            }
            if (!splash.isConnected) {
              result.removed = performance.now() - window.__splashStartedAt;
              observer.disconnect();
            }
          });
          observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
        `})
        mark(scenario+': observer installed')
        window.showInactive(); await window.loadFile(entry)
        mark(scenario+': loaded')
        const deadline=Date.now()+10000
        while(!await run('Number.isFinite(window.__splashObserved?.removed)')) {
          if(Date.now()>deadline) throw Error('Native splash did not leave: '+scenario)
          await new Promise(resolve=>setTimeout(resolve,20))
        }
        const result=await run('window.__splashObserved')
        mark(scenario+': removed '+JSON.stringify(result))
        assert.equal(result.clock,'performance'); assert.ok(result.leave>=1798,'native minimum was truncated: '+JSON.stringify(result))
        assert.ok(result.removed>=result.leave+698,'native portal was truncated')
        if(scenario==='raf-and-settings-held') {
          assert.ok(result.leave>=1798 && result.leave<2500,'fallback deadline was not bounded')
          assert.equal(result.primaryUi,false,'settings must still be held when splash leaves')
          await run('window.requestAnimationFrame = window.__realSplashRaf; true'); release(); held=null
        }
        assert.deepEqual(result.errors,[])
        results.push(result)
        if (scenario === 'fast') {
          const state = () => run(`({ visible: Boolean(document.getElementById('app-splash')), inert: document.getElementById('root').inert, rootTransform: getComputedStyle(document.getElementById('root')).transform, phase: document.documentElement.className, width: innerWidth, scrollWidth: document.documentElement.scrollWidth })`)
          const waitForReady = async () => {
            const end = Date.now() + 5000
            while ((await state()).visible) { if(Date.now()>end) throw Error('Project replay did not leave'); await new Promise(resolve=>setTimeout(resolve,20)) }
            const actual = await state(); assert.equal(actual.inert,false); assert.equal(actual.rootTransform,'none'); return actual
          }
          for (const size of [[1100,760],[390,844],[320,568],[844,390]]) {
            window.setContentSize(...size)
            await run(`document.getElementById('app-splash-replay').click(); true`)
            assert.equal((await state()).inert,true)
            await run(`new Promise(resolve => setTimeout(resolve,1350))`)
            const visual = await run(`({ image: document.querySelector('.splash-mark img').complete && document.querySelector('.splash-mark img').naturalWidth, trace: getComputedStyle(document.querySelector('.splash-trace')).strokeDashoffset, spacing: parseFloat(getComputedStyle(document.querySelector('.splash-title')).letterSpacing), scene: getComputedStyle(document.querySelector('.splash-scene')).transform, count: document.querySelectorAll('#app-splash').length })`)
            assert.equal(visual.image,1024); assert.equal(visual.trace,'0px'); assert.equal(visual.count,1); assert.ok(visual.spacing>=8 && visual.spacing<24)
            fs.writeFileSync(path.join(fixture,`project-splash-${size.join('x')}.png`),(await window.webContents.capturePage()).toPNG())
            const ready = await waitForReady(); assert.ok(ready.scrollWidth<=ready.width)
            if(size[0]===1100) fs.writeFileSync(path.join(fixture,'project-main-1100x760.png'),(await window.webContents.capturePage()).toPNG())
            results.push({scenario:'project-replay-responsive',size,visual,ready})
          }
          await run(`document.getElementById('app-splash-replay').click(); document.getElementById('app-splash-replay').click(); true`)
          assert.equal(await run(`document.querySelectorAll('#app-splash').length`),1)
          results.push({scenario:'project-rapid-replay',ready:await waitForReady()})
          await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
          const reducedAt=Date.now(); await run(`document.getElementById('app-splash-replay').click(); true`)
          const reducedReady=await waitForReady(); assert.ok(Date.now()-reducedAt<1000)
          results.push({scenario:'project-reduced-motion',ready:reducedReady})
          await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]})
          await run(`window.__testPlayer = document.createElement('div'); __testPlayer.className='player-overlay'; document.body.append(__testPlayer); document.getElementById('app-splash-replay').click(); true`)
          assert.equal((await state()).visible,false)
          assert.equal(await run(`getComputedStyle(document.getElementById('app-splash-replay')).display`),'none')
          await run(`__testPlayer.remove(); delete window.__testPlayer; true`)
          results.push({scenario:'project-block-replay-while-player-open',passed:true})
          assert.deepEqual(await run('window.__splashObserved.errors'),[])
        }
      } finally { release?.(); held=null;remove();if(!window.isDestroyed()){if(window.webContents.debugger.isAttached())window.webContents.debugger.detach();window.destroy()}require('../main/window').setMainWindow(null) }
    }
    const result={passed:true,cases:results,electron:process.versions.electron,scope:'Current production dist/App/preload and guarded settings IPC in actual Electron; optional plugin/media status probes are controlled fixtures, no full application main or installer acceptance'}
    await fsp.writeFile(path.join(fixture,'splash-result.json'),JSON.stringify(result,null,2))
    console.log('Native splash passed: '+JSON.stringify(result))
  } finally { mark('cleanup settings'); await settings.flushSettingsWrites(); await settings.disposeSettingsSerialization() }
}
async function driver() {
  const output=process.env.WALLPAPER_SPLASH_OUTPUT_DIR?path.resolve(process.env.WALLPAPER_SPLASH_OUTPUT_DIR):testRoot
  assert.ok(output===testRoot || output.startsWith(testRoot+path.sep));await fsp.mkdir(output,{recursive:true})
  const fixture=await fsp.mkdtemp(path.join(output,'splash-ui-'))
  const env={...process.env,WALLPAPER_SPLASH_FIXTURE:fixture};delete env.ELECTRON_RUN_AS_NODE
  const result=await new Promise(resolve=>require('node:child_process').execFile(require('electron'),[__filename],{cwd:root,env,windowsHide:true,timeout:40000,maxBuffer:2*1024*1024},(error,stdout,stderr)=>resolve({error,stdout,stderr})))
  await fsp.writeFile(path.join(fixture,'electron.log'),result.stdout+result.stderr)
  if(result.error || !result.stdout.includes('Native splash passed:')) throw result.error || Error(result.stderr || 'Native splash failed')
  const actual=JSON.parse(await fsp.readFile(path.join(fixture,'splash-result.json'),'utf8'));assert.equal(actual.passed,true);assert.equal(actual.cases.length,10)
  console.log(JSON.stringify({passed:true,fixture,cases:actual.cases,electron:actual.electron}))
}
if(process.versions.electron) {
  const timeout=setTimeout(()=>{console.error('Native splash deadline: '+nativePhase);require('electron').app.exit(1)},35000)
  native().then(()=>{clearTimeout(timeout);require('electron').app.exit(0)},error=>{console.error(error);clearTimeout(timeout);require('electron').app.exit(1)})
} else driver().catch(error=>{console.error(error);process.exitCode=1})
