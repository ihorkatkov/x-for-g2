import assert from 'node:assert/strict'
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs'
import {PNG} from 'pngjs'
const base=process.env.X_SIM_URL??'http://127.0.0.1:9902',out=new URL('../artifacts/simulator/',import.meta.url)
assert.equal((await fetch((process.env.X_READER_URL??'http://127.0.0.1:4040')+'/api/status').then(r=>r.json())).mode,'demo');mkdirSync(out,{recursive:true})
const sleep=ms=>new Promise(r=>setTimeout(r,ms));const logs=async()=>(await fetch(base+'/api/console').then(r=>r.json())).entries
const states=async(after=-1)=>(await logs()).filter(e=>e.id>after&&e.message.startsWith('REED_STATE ')).map(e=>JSON.parse(e.message.slice(11)))
const state=async()=>(await states()).at(-1)
async function wait(test,label,after=-1){for(let i=0;i<80;i++){const s=(await states(after)).findLast(test);if(s)return s;await sleep(100)}throw Error(label)}
async function input(action){assert.ok((await fetch(base+'/api/input',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})})).ok);await sleep(180)}
async function menu(index,predicate,label){await input('context_menu');for(let i=0;i<index;i++)await input('down');const cursor=(await logs()).at(-1)?.id??-1;await input('click');const s=await wait(predicate,label,cursor);await sleep(450);return s}
async function shot(name){await sleep(300);const raw=Buffer.from(await fetch(base+'/api/screenshot/glasses').then(r=>r.arrayBuffer()));writeFileSync(new URL(name+'.rgba.png',out),raw);const p=PNG.sync.read(raw);for(let i=0;i<p.data.length;i+=4){const a=p.data[i+3]/255;for(let j=0;j<3;j++)p.data[i+j]*=a;p.data[i+3]=255}writeFileSync(new URL(name+'.png',out),PNG.sync.write(p))}
const report={automationOrigin:base,readerOrigin:process.env.X_READER_URL??'http://127.0.0.1:4040',app:'X '+JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version,testedAt:new Date().toISOString(),sdk:'0.0.16',simulator:'0.9.5',mode:'demo',checks:[],limits:['Actual native input API and framebuffer; no live account, BLE or physical G2.']}
await menu(2,s=>s.feed===1&&!s.busy&&s.count>=3,'Following selection');await shot('05-following');report.checks.push('Native contextual menu selects Following')
await menu(1,s=>s.feed===0&&!s.busy&&s.count>=3,'For You selection');report.checks.push('Native contextual menu selects For You')
// Reach a multi-page post through real native gestures.
for(let i=0;i<35;i++){if((await state()).page>0)break;await input('down')}
const pinned=await state();assert.ok(pinned.page>0,'Long post page must be reachable');await shot('06-long-page')
await menu(0,s=>s.feed===0&&!s.busy&&s.arrivals>0,'Refresh with queued arrival');const refreshed=await state();assert.equal(refreshed.index,pinned.index);assert.equal(refreshed.page,pinned.page);await shot('07-refresh-pinned');report.checks.push('Refresh queues a real fixture arrival while pinning the exact post/page')
await menu(3,s=>s.index===0&&s.page===0&&s.arrivals===0,'Jump to newest');await shot('08-newest');report.checks.push('Jump to newest applies queued arrivals deliberately')
let older=false
for(let i=0;i<65;i++){const s=await state();if(!s.hasCursor&&!s.busy){older=true;break}await input('down')}
assert.ok(older,'Native forward navigation must exhaust fixture cursor');await shot('09-older-end');report.checks.push('Forward navigation loads older posts and reaches the actual end')
writeFileSync(new URL('feeds-report.json',out),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
