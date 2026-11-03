import {test} from 'node:test'
import assert from 'node:assert/strict'
import {request,type Server} from 'node:http'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createServer} from '../server/index.ts'
import {PairingStore} from '../server/pairing.ts'
const origin='https://reader.example.ts.net:8449',identity={'Tailscale-User-Login':'reader@example.test'}
async function http(server:Server,path:string,headers:Record<string,string>={},body?:unknown,method=body===undefined?'GET':'POST'){
 const address=server.address();assert.ok(address&&typeof address==='object');const raw=body===undefined?undefined:JSON.stringify(body);
 return new Promise<{status:number;body:Record<string,unknown>}>((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:address.port,path,method,headers:{Host:new URL(origin).host,...(raw?{'Content-Type':'application/json','Content-Length':String(Buffer.byteLength(raw))}:{}),...headers}},res=>{const chunks:Buffer[]=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode!,body:chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{}}))});req.on('error',reject);req.end(raw)})
}
async function setup(mode='live'){
 const dir=await mkdtemp(join(tmpdir(),'x-bookmark-')),file=join(dir,'pair.json'),store=new PairingStore(file),token=await store.pair(await store.issueCode());let writes=0;
 const fixture=JSON.parse(await readFile(new URL('../server/fixtures/demo.json',import.meta.url),'utf8'));
 const server=createServer({env:{REED_MODE:mode,REED_REMOTE:'1',REED_ORIGIN:origin,REED_TAILSCALE_USER:'reader@example.test',REED_PAIRING_FILE:file,AUTH_TOKEN:'fabricated-auth',CT0:'fabricated-csrf',REED_HOME_QUERY_ID:'home',REED_LATEST_QUERY_ID:'following',REED_BOOKMARK_QUERY_ID:'save'},fetcher:async(url,init)=>{
  if(init?.method==='POST'){writes++;assert.equal(String(url),'https://api.x.com/graphql/save/bookmarkStateAddMutation');return Response.json({data:{tweet_bookmark_put:'Done'}})}
  return Response.json(fixture.pages[0]);
 }});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return {server,headers:{...identity,Origin:'null',Authorization:'Bearer '+token},writes:()=>writes,close:async()=>{await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true})}}
}
test('bookmark HTTP requires tailnet AND paired device, validates post/account and never exposes provider credentials',async()=>{
 const x=await setup();try{
  const feed=await http(x.server,'/api/feed?feed=for-you',x.headers);assert.equal(feed.status,200);const id=(feed.body.posts as {id:string}[])[0].id,body={id,scope:feed.body.scope};
  for(const path of ['/api/bookmark','/x/../api/bookmark','/%2e/api/bookmark']){assert.equal((await http(x.server,path,{...identity,Origin:'null'},body)).status,401)}
  assert.equal((await http(x.server,'/api/bookmark',{...x.headers,'Tailscale-User-Login':'wrong@example.test'},body)).status,403);
  assert.equal((await http(x.server,'/api/bookmark',{...x.headers,Origin:'https://evil.test'},body)).status,403);
  for(const bad of [{...body,scope:'wrong'},{...body,id:'999999999'},{...body,extra:true},{...body,id:'../evil'},{...body,id:'1'.repeat(200)}])assert.ok((await http(x.server,'/api/bookmark',x.headers,bad)).status>=400);
  assert.equal((await http(x.server,'/api/bookmark',{...x.headers,'Content-Type':'text/plain'},body)).status,400);assert.equal(x.writes(),0);
  const saved=await http(x.server,'/api/bookmark',x.headers,body);assert.equal(saved.status,200);assert.deepEqual(saved.body,{saved:true,mode:'live',scope:feed.body.scope});assert.equal(x.writes(),1);
  assert.equal((await http(x.server,'/api/bookmark',x.headers,body)).status,200);assert.equal(x.writes(),1);
  for(const route of ['/api/repost','/api/like','/api/post','/api/bookmark?extra=1'])assert.ok((await http(x.server,route,x.headers,body)).status>=400);
 }finally{await x.close()}
})
test('demo bookmarking is explicitly demo-only and preflight permits this one add route',async()=>{
 const x=await setup('demo');try{
  const feed=await http(x.server,'/api/feed?feed=for-you',x.headers),id=(feed.body.posts as {id:string}[])[0].id;
  const saved=await http(x.server,'/api/bookmark',x.headers,{id,scope:feed.body.scope});assert.equal(saved.body.mode,'demo');assert.equal(saved.body.saved,true);assert.equal(x.writes(),0);
  const preflight={...identity,Origin:'null','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'Content-Type, Authorization'};
  assert.equal((await http(x.server,'/api/bookmark',preflight,undefined,'OPTIONS')).status,204);assert.equal((await http(x.server,'/api/feed',preflight,undefined,'OPTIONS')).status,400);
 }finally{await x.close()}
})
