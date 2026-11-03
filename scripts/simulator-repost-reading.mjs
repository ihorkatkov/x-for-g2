import assert from 'node:assert/strict'
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs'
import {PNG} from 'pngjs'
const api=process.env.X_SIM_URL??'http://127.0.0.1:9902',out=new URL('../artifacts/repost-reading/',import.meta.url);mkdirSync(out,{recursive:true})
assert.equal((await fetch((process.env.X_READER_URL??'http://127.0.0.1:4040')+'/api/status').then(r=>r.json())).mode,'demo')
const sleep=ms=>new Promise(r=>setTimeout(r,ms));const logs=async()=>(await fetch(api+'/api/console').then(r=>r.json())).entries
const state=async()=>(await logs()).filter(e=>e.message.startsWith('REED_STATE ')).map(e=>JSON.parse(e.message.slice(11))).at(-1)
async function input(action){assert.ok((await fetch(api+'/api/input',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})})).ok);await sleep(230)}
async function shot(name){await sleep(300);const bytes=Buffer.from(await fetch(api+'/api/screenshot/glasses').then(r=>r.arrayBuffer()));writeFileSync(new URL(name+'.rgba.png',out),bytes);const png=PNG.sync.read(bytes);for(let i=0;i<png.data.length;i+=4){const a=png.data[i+3]/255;for(let j=0;j<3;j++)png.data[i+j]*=a;png.data[i+3]=255}writeFileSync(new URL(name+'.png',out),PNG.sync.write(png))}
for(let i=0;i<80;i++){const s=await state();if(s?.demo&&s.count>=5&&s.index===s.count-1&&!s.busy)break;await input('down')}
const first=await state();assert.ok(first.count>=5&&first.index===first.count-1&&!first.hasCursor);assert.equal(first.page,0);await shot('01-reposted-original')
await input('down');const second=await state();assert.equal(second.index,first.index);assert.equal(second.page,1);await shot('02-reposted-original-next-page')
const report={app:'X',version:JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version,sdk:'0.0.16',simulator:'0.9.5',testedAt:new Date().toISOString(),checks:['Actual native navigation loads older sample containing a repost','Original author Nia Moss and text are retained; reposter shown separately via @sam_demo','Second page retains attribution and continues original text'],readingOnly:true,limits:['Invented fixture, no live account or physical G2 proof']};writeFileSync(new URL('simulator-report.json',out),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
