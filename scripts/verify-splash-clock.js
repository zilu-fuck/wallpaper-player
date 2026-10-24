const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict'), ts = require('typescript')
const root = path.resolve(__dirname,'..')
function browser({ performanceAvailable = true, start = 1000, reduced = false } = {}) {
  let elapsed = 0, wall = 1792743000000, now = start, sequence = 0, present = true
  const timers = new Map(), events = []
  const performance = { now: () => now }
  const element = { classList: { add(name) { events.push({event:name,at:elapsed}) } }, remove() { present=false;events.push({event:'removed',at:elapsed}) } }
  const document = { getElementById: () => present ? element : null }
  const window = { ...(performanceAvailable ? { performance } : {}), matchMedia: () => ({ matches: reduced }),
    setTimeout(fn,delay) { const id=++sequence;timers.set(id,{fn,at:elapsed+delay,delay});return id }, clearTimeout(id) {timers.delete(id)} }
  const context = vm.createContext({window,document,...(performanceAvailable?{performance}:{}),Date:{now:()=>wall},exports:{},Number,Math})
  vm.runInContext(fs.readFileSync(path.join(root,'src/splash-boot.js'),'utf8'),context)
  vm.runInContext(ts.transpileModule(fs.readFileSync(path.join(root,'src/services/splash.js'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,context)
  function advance(ms) {
    const end=elapsed+ms
    for (;;) {
      const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0]
      if (!next || next[1].at>end) break
      const step=next[1].at-elapsed;elapsed+=step;now+=step;wall+=step;timers.delete(next[0]);next[1].fn()
    }
    const rest=end-elapsed;elapsed=end;now+=rest;wall+=rest
  }
  return { api:context.exports,window,events,advance,delays:()=>[...timers.values()].map(timer=>timer.delay),pending:()=>timers.size,
    wallJump(ms){wall+=ms},hideElement(){present=false},setTimestamp(value){window.__splashStartedAt=value},enablePerformance(){window.performance=performance} }
}
const cases=[]
function check(name,fn){fn();cases.push(name)}
check('Fast startup preserves 1800ms of tracing/branding then the 700ms portal',()=>{
  const b=browser();b.advance(100);b.api.dismissSplash();assert.deepEqual(b.delays(),[1700]);b.advance(1699);assert.deepEqual(b.events,[])
  b.advance(1);assert.deepEqual(b.events,[{event:'is-leaving',at:1800}]);b.advance(700);assert.deepEqual(b.events.at(-1),{event:'removed',at:2500});assert.equal(b.pending(),0)
})
check('A legitimate performance timestamp of zero retains the full minimum',()=>{const b=browser({start:0});b.advance(100);b.api.dismissSplash();assert.deepEqual(b.delays(),[1700])})
check('Wall-clock corrections cannot shorten or extend monotonic startup',()=>{
  for(const jump of [1e12,-1e12]){const b=browser();b.advance(100);b.wallJump(jump);b.api.dismissSplash();assert.deepEqual(b.delays(),[1700])}
})
check('The date fallback keeps its original clock even if performance becomes available later',()=>{
  for(const enable of [false,true]){const b=browser({performanceAvailable:false});b.advance(100);if(enable)b.enablePerformance();b.api.dismissSplash();assert.deepEqual(b.delays(),[1700])}
})
check('Repeated watch and dismiss calls produce one fade and no orphan deadline',()=>{
  const b=browser();b.api.watchSplash();b.api.watchSplash();assert.equal(b.pending(),1);b.advance(100);b.api.dismissSplash();b.api.dismissSplash();b.api.watchSplash();assert.equal(b.pending(),1)
  b.advance(2400);assert.deepEqual(b.events,[{event:'is-leaving',at:1800},{event:'removed',at:2500}]);assert.equal(b.pending(),0)
})
check('Stalled frames or initialization still leave by the original 1800ms deadline plus portal',()=>{
  const b=browser();b.api.watchSplash();b.advance(1799);assert.deepEqual(b.events,[]);b.advance(1);assert.deepEqual(b.events,[{event:'is-leaving',at:1800}]);b.advance(700);assert.equal(b.events.at(-1).at,2500);assert.equal(b.pending(),0)
})
check('A startup already beyond the minimum fades immediately without waiting another cycle',()=>{const b=browser();b.advance(1900);b.api.dismissSplash();assert.deepEqual(b.delays(),[0]);b.advance(700);assert.equal(b.events[0].at,1900);assert.equal(b.pending(),0)})
check('Missing or invalid metadata never creates an unbounded delay',()=>{
  for(const stamp of [undefined,NaN,-1]){const b=browser();b.setTimestamp(stamp);b.api.dismissSplash();assert.deepEqual(b.delays(),[0]);b.advance(700);assert.equal(b.pending(),0)}
})
check('An absent splash cancels an existing deadline and stays settled',()=>{const b=browser();b.api.watchSplash();b.hideElement();b.api.dismissSplash();b.api.watchSplash();assert.equal(b.pending(),0);assert.deepEqual(b.events,[])})
check('A backwards fallback clock is bounded to one minimum interval',()=>{const b=browser({performanceAvailable:false});b.wallJump(-100000);b.api.dismissSplash();assert.deepEqual(b.delays(),[1800])})
check('The hard fallback deadline takes priority over a backwards date clock',()=>{const b=browser({performanceAvailable:false});b.api.watchSplash();b.advance(100);b.wallJump(-100000);b.advance(1700);assert.deepEqual(b.events,[{event:'is-leaving',at:1800}]);b.advance(700);assert.equal(b.events.at(-1).at,2500);assert.equal(b.pending(),0)})
check('Late module initialization uses the original deadline instead of restarting it',()=>{const b=browser();b.advance(1700);b.api.watchSplash();assert.deepEqual(b.delays(),[100]);b.advance(800);assert.equal(b.events.at(-1).at,2500)})
check('Reduced motion skips the zoom and uses a 100ms presentation plus 160ms fade',()=>{const b=browser({reduced:true});b.api.watchSplash();b.advance(260);assert.deepEqual(b.events,[{event:'is-leaving',at:100},{event:'removed',at:260}]);assert.equal(b.pending(),0)})
console.log(JSON.stringify({passed:true,cases,scope:'Both production boot/service modules with deterministic browser clocks, DOM and timers; no native rendering'},null,2))
