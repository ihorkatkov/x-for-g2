import {test} from 'node:test'
import assert from 'node:assert/strict'
import {request,type Server} from 'node:http'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createServer} from '../server/index.ts'
import {PairingStore} from '../server/pairing.ts'
import {resolveServiceURL,serviceURL} from '../src/service.ts'
const origin='https://reader.example.ts.net:8449',env={REED_MODE:'demo',REED_REMOTE:'1',REED_ORIGIN:origin,REED_TAILSCALE_USER:'reader@example.test'}
async function setup(){const dir=await mkdtemp(join(tmpdir(),'x-pair-')),file=join(dir,'pair.json'),store=new PairingStore(file),code=await store.issueCode(),token=await store.pair(code),server=createServer({env:{...env,REED_PAIRING_FILE:file}});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return {dir,store,token,server,close:async()=>{await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true})}}}
async function http(server:Server,headers:Record<string,string>={},method='GET',path='/api/status',body?:string){
 const a=server.address();assert.ok(a&&typeof a==='object')
 return new Promise<{status:number;headers:import('node:http').IncomingHttpHeaders;body:string}>((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:a.port,path,method,headers:{Host:new URL(origin).host,...headers}},res=>{const chunks:Buffer[]=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode!,headers:res.headers,body:Buffer.concat(chunks).toString()}))});req.on('error',reject);req.end(body)})
}
const identity={'Tailscale-User-Login':'reader@example.test'}
test('private beta needs both tailnet identity and runtime device session; origin alone grants no feed access',async()=>{
 const x=await setup(),trusted={...identity,Authorization:'Bearer '+x.token}
 try{
  const cases:Record<string,string>[]=[{}, {'Tailscale-User-Login':'other@example.test'}, {...trusted,Origin:'https://evil.test'}, {...trusted,Host:'127.0.0.1:4040'}]
  for(const headers of cases){const r=await http(x.server,headers);assert.equal(r.status,403);assert.equal(r.headers['access-control-allow-origin'],undefined)}
  for(const path of ['/api/status','/api/feed?feed=for-you','/api/image/anything','/./api/status','/%2e/api/status','/x/../api/feed?feed=for-you','/x/../api/image/anything']){const r=await http(x.server,{...identity,Origin:'null'},'GET',path);assert.equal(r.status,401);assert.equal(JSON.parse(r.body).error,'pairing_required');assert.ok(!('scope' in JSON.parse(r.body)))}
  for(const source of ['http://localhost:49200','http://127.0.0.1:49200','https://localhost']){assert.equal((await http(x.server,{...identity,Origin:source})).status,401);const r=await http(x.server,{...trusted,Origin:source});assert.equal(r.status,200);assert.equal(r.headers['access-control-allow-origin'],source)}
  const packaged=await http(x.server,{...trusted,Origin:'null','Sec-Fetch-Site':'cross-site',Cookie:'incidental=value'});assert.equal(packaged.status,200);assert.equal(packaged.headers['access-control-allow-origin'],'null');assert.equal(JSON.parse(packaged.body).mode,'demo')
  assert.equal((await http(x.server,{...trusted,Origin:origin})).status,200);assert.equal((await http(x.server,{...identity,Authorization:'Bearer invalid',Origin:'null'})).status,401)
  assert.equal((await http(x.server,{...trusted,Origin:'null'},'POST')).status,400)
 }finally{await x.close()}
})
test('preflight authenticates the tailnet hop and permits only paired-client headers and the pairing POST',async()=>{
 const x=await setup()
 try{
  const headers={...identity,Origin:'null','Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'Content-Type, Authorization'}
  const response=await http(x.server,headers,'OPTIONS');assert.equal(response.status,204);assert.equal(response.headers['access-control-allow-origin'],'null')
  for(const other of [{'Access-Control-Request-Method':'DELETE'},{'Access-Control-Request-Headers':'X-Arbitrary'},{'Tailscale-User-Login':'wrong@example.test'}])assert.ok((await http(x.server,{...headers,...other},'OPTIONS')).status>=400)
  assert.equal((await http(x.server,{...headers,'Access-Control-Request-Method':'POST'},'OPTIONS','/api/pair')).status,204)
  assert.equal((await http(x.server,{...headers,'Access-Control-Request-Method':'POST'},'OPTIONS','/api/feed')).status,400)
 }finally{await x.close()}
 assert.throws(()=>createServer({env:{...env,REED_ACCESS_TOKEN:'x'.repeat(32)}}),/one remote authentication/)
 assert.throws(()=>createServer({env:{...env,REED_ORIGIN:'https://public.example'}}),/Tailscale/)
})
test('one-time laptop code pairs the device over HTTP; no token or code is exposed by status',async()=>{
 const x=await setup()
 try{
  const code=await x.store.issueCode(),body=JSON.stringify({code}),headers={...identity,Origin:'null','Content-Type':'application/json','Content-Length':String(Buffer.byteLength(body))}
  const response=await http(x.server,headers,'POST','/api/pair',body);assert.equal(response.status,200);const token=JSON.parse(response.body).token;assert.match(token,/^[A-Za-z0-9_-]{43}$/)
  assert.equal((await http(x.server,headers,'POST','/api/pair',body)).status,401)
  const status=await http(x.server,{...identity,Origin:'null',Authorization:'Bearer '+token});assert.equal(status.status,200);assert.ok(!status.body.includes(token)&&!status.body.includes(code))
  assert.equal((await http(x.server,{...headers,Authorization:'Bearer '+token},'POST','/api/repost',body)).status,400)
 }finally{await x.close()}
})
test('packaged API URLs resolve against HTTPS service, never a phone file origin or arbitrary target',()=>{
 assert.equal(resolveServiceURL('/api/status',origin),origin+'/api/status');assert.equal(resolveServiceURL('/api/feed?feed=following',origin),origin+'/api/feed?feed=following');assert.equal(resolveServiceURL('/api/image/abc.def',origin),origin+'/api/image/abc.def');assert.equal(resolveServiceURL('/api/pair',origin),origin+'/api/pair')
 assert.equal(serviceURL('/api/status'),'/api/status')
 for(const path of ['https://evil.test/api/feed','//evil.test/api/feed','/api/../secret','/assets/main.js','/api/image/../secret'])assert.throws(()=>resolveServiceURL(path,origin))
 for(const base of ['http://reader.test','https://reader.test/path','https://user:pass@reader.test'])assert.throws(()=>resolveServiceURL('/api/status',base))
})
