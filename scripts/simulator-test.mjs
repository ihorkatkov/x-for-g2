import assert from 'node:assert/strict'
import {mkdirSync,writeFileSync} from 'node:fs'
import {PNG} from 'pngjs'
const base=process.env.X_SIM_URL??'http://127.0.0.1:9902',server=process.env.X_READER_URL??'http://127.0.0.1:4040'
const output=new URL('../artifacts/simulator/',import.meta.url)
mkdirSync(output,{recursive:true})
const status=await fetch(server+'/api/status').then(r=>r.json())
assert.equal(status.mode,'demo','Refusing to automate any live X account. Run npm run demo first.')
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function logs(){const res=await fetch(base+'/api/console');assert.ok(res.ok);return(await res.json()).entries}
async function input(action){const res=await fetch(base+'/api/input',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})});assert.ok(res.ok);await sleep(150)}
async function state(){return(await logs()).filter(e=>e.message.startsWith('REED_STATE ')).map(e=>JSON.parse(e.message.slice(11))).at(-1)}
async function wait(predicate,label){
 const end=Date.now()+12000
 while(Date.now()<end){const entries=await logs();assert.ok(!entries.some(e=>e.message.includes('[uncaught]')||e.message.includes('[unhandledrejection]')),'Unhandled WebView exception');const s=await state();if(s&&predicate(s))return s;await sleep(120)}
 throw Error('Timed out: '+label)
}
async function screenshot(name){
 let raw,previous
 for(let i=0;i<12;i++){
  const res=await fetch(base+'/api/screenshot/glasses');assert.ok(res.ok);raw=Buffer.from(await res.arrayBuffer())
  if(previous?.equals(raw))break
  previous=raw;await sleep(250)
 }
 const png=PNG.sync.read(raw);assert.equal(png.width,576);assert.equal(png.height,288)
 let lit=0;for(let i=3;i<png.data.length;i+=4)if(png.data[i]>0)lit++
 assert.ok(lit>100,'Native framebuffer must contain rendered pixels')
 writeFileSync(new URL(name+'.rgba.png',output),raw)
 // Keep RGBA original; this extra copy composites alpha only for easy viewing.
 for(let i=0;i<png.data.length;i+=4){const a=png.data[i+3]/255;for(let j=0;j<3;j++)png.data[i+j]=Math.round(png.data[i+j]*a);png.data[i+3]=255}
 writeFileSync(new URL(name+'.png',output),PNG.sync.write(png));return {name,litPixels:lit}
}
const report={schema:1,testedAt:new Date().toISOString(),sdk:'0.0.16',simulator:'0.9.5',mode:'demo',checks:[],limits:['No authenticated live X account, BLE, physical G2 legibility, phone lock, reconnect or exit/cancel verification.','Menu selection positions are simulator-specific; a mismatch fails rather than fabricating an app event.']}
await wait(s=>s.count>=3&&!s.busy&&s.demo,'demo feed loaded')
// Normalize a warm restored demo position using the actual menu, not SDK injection.
await input('context_menu');for(let i=0;i<3;i++)await input('down');await input('click');await sleep(450)
const first=await wait(s=>s.index===0&&s.page===0&&!s.busy,'newest reading position')
assert.ok((await logs()).some(e=>e.message.includes('REED_READY sdk=0.0.16')),'Ready marker only after native startup success')
report.checks.push(await screenshot('01-ready'))
await input('down');const after=await wait(s=>s.index!==first.index||s.page!==first.page,'swipe forward')
report.checks.push({behavior:'Native swipe advances measured page or post',from:first,to:after},await screenshot('02-next'))
await input('up');await wait(s=>s.index===first.index&&s.page===first.page,'swipe back')
report.checks.push({behavior:'Native swipe returns to exact reading position'})
await input('click');await wait(s=>s.index!==first.index||s.page!==first.page,'tap forward')
report.checks.push(await screenshot('03-tap'))
await input('context_menu');report.checks.push(await screenshot('04-context-menu'))
await input('double_click');await sleep(250)
// A short native text container may not emit another scroll at its boundary.
// Tap gives a deterministic application event after the overlay closes.
const before=await state();await input('click');await wait(s=>s.index!==before.index||s.page!==before.page,'listener survives menu dismiss')
report.checks.push({behavior:'Context menu opens and listener survives overlay dismissal'})
// Full menu/feed/refresh/load-more flows may be run interactively by the parent.
// Do not synthesize SDK events: keep all inputs at the native simulator boundary.
const companion=await fetch(base+'/api/screenshot/webview')
if(companion.ok)writeFileSync(new URL('companion.png',output),Buffer.from(await companion.arrayBuffer()))
writeFileSync(new URL('report.json',output),JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify(report,null,2))
