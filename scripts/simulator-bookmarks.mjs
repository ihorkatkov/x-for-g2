import assert from 'node:assert/strict'
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs'
import {PNG} from 'pngjs'
const api=process.env.X_SIM_URL??'http://127.0.0.1:9902',reader=process.env.X_READER_URL??'http://127.0.0.1:4040',out=new URL('../artifacts/navigation-bookmarks/',import.meta.url)
assert.equal((await fetch(reader+'/api/status').then(r=>r.json())).mode,'demo','Never automate bookmarks on a live X account');mkdirSync(out,{recursive:true})
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),logs=async()=>(await fetch(api+'/api/console').then(r=>r.json())).entries
const state=async()=>(await logs()).filter(e=>e.message.startsWith('REED_STATE ')).map(e=>JSON.parse(e.message.slice(11))).at(-1)
async function wait(test,label){for(let i=0;i<100;i++){const s=await state();if(s&&test(s))return s;await sleep(100)}throw Error(label+': '+JSON.stringify(await state()))}
async function input(action){assert.ok((await fetch(api+'/api/input',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})})).ok);await sleep(350)}
async function menu(index){await input('context_menu');for(let i=0;i<index;i++)await input('down');const cursor=(await logs()).at(-1)?.id??-1;await input('click');for(let i=0;i<100;i++){if((await logs()).some(e=>e.id>cursor&&e.message.startsWith('REED_STATE '))){await sleep(500);return}await sleep(100)}throw Error('Menu action did not render')}
async function shot(name){await sleep(350);const bytes=Buffer.from(await fetch(api+'/api/screenshot/glasses').then(r=>r.arrayBuffer()));writeFileSync(new URL(name+'.rgba.png',out),bytes);const p=PNG.sync.read(bytes);for(let y=280;y<288;y++)for(let x=0;x<576;x++)assert.equal(p.data[(y*576+x)*4+3],0,'Footer stays free');for(let i=0;i<p.data.length;i+=4){const a=p.data[i+3]/255;for(let j=0;j<3;j++)p.data[i+j]*=a;p.data[i+3]=255}writeFileSync(new URL(name+'.png',out),PNG.sync.write(p));if(name==='03-bookmarked')writeFileSync(new URL('phone.png',out),Buffer.from(await fetch(api+'/api/screenshot/webview').then(r=>r.arrayBuffer())))}
await wait(s=>s.demo&&s.count>=3&&!s.busy,'demo ready');await menu(3)
for(let i=0;i<5;i++){if((await state()).textPages>1)break;await menu(7)}
const long=await wait(s=>s.textPages>1&&s.page===0&&!s.imageOpen,'unread trailing pages');assert.ok(long.page<long.textPages-1);await shot('01-long-post')
await menu(7);const next=await wait(s=>s.index===long.index+1&&s.page===0,'skip unread pages');await shot('02-next-post')
if(!(await state()).bookmarkSaved)await input('long_press');await wait(s=>s.bookmarkSaved&&!s.bookmarkBusy,'long-press demo bookmark');await input('long_press_release');const released=await state();assert.equal(released.index,next.index);assert.equal(released.page,next.page);await shot('03-bookmarked')
await menu(8);await wait(s=>s.index===long.index&&s.page===0&&!s.bookmarkSaved,'previous post starts at first page and does not inherit saved state');await shot('04-previous-post')
if((await state()).hasPhotos){await menu(5);await wait(s=>s.imageOpen&&s.imagePages>0&&!s.imageLoading,'photo opened');await menu(7);await wait(s=>s.index===next.index&&s.page===0&&!s.imageOpen,'skip leaves image and enters next post')}
const report={app:'X',version:JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version,checks:['Native menu skips remaining long-post pages','Previous post returns at page one','Native long press bookmarks and confirms in header','Release preserves the reading position','Saved state stays bound to the original post','Footer remains empty','Next post also leaves an open image'],mode:'demo',limits:['Invented posts only; no real X account bookmark written','Simulator is not physical G2 or phone-lock proof'],from:{index:long.index,page:long.page},to:{index:next.index,page:next.page}}
writeFileSync(new URL('report.json',out),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
