import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {request,type Server} from 'node:http'
import {createServer} from '../server/index.ts'
import {PairingStore} from '../server/pairing.ts'
const origin='https://reader.example.test',env={REED_MODE:'demo',REED_REMOTE:'1',REED_PAIRED_HTTPS:'1',REED_ORIGIN:origin};
async function http(server:Server,path:string,headers:Record<string,string>={},body?:unknown,method=body===undefined?'GET':'POST'){
 const address=server.address();assert.ok(address&&typeof address==='object');const raw=body===undefined?undefined:JSON.stringify(body);
 return new Promise<{status:number;headers:import('node:http').IncomingHttpHeaders;body:Record<string,unknown>}>((resolve,reject)=>{const r=request({hostname:'127.0.0.1',port:address.port,path,method,headers:{Host:new URL(origin).host,Origin:'null',...(raw?{'Content-Type':'application/json','Content-Length':String(Buffer.byteLength(raw))}:{}),...headers}},res=>{const chunks:Buffer[]=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode!,headers:res.headers,body:chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{}}))});r.on('error',reject);r.end(raw)})
}
test('paired HTTPS fails closed unless explicitly selected as the sole remote HTTPS authentication',()=>{
 for(const other of [{REED_REMOTE:'0'},{REED_ORIGIN:'http://reader.example.test'},{REED_TAILSCALE_USER:'a@example.test'},{REED_ACCESS_TOKEN:'x'.repeat(32)},{REED_PAIRED_HTTPS:'yes'},{REED_HOST:'0.0.0.0'}])assert.throws(()=>createServer({env:{...env,...other}}));
 assert.throws(()=>createServer({env:{...env,REED_PAIRED_HTTPS:'0'}}));
})
test('public paired HTTPS gates every normalized API path, ignores forged identity, and retains packaged CORS',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'x-https-')),file=join(dir,'pairs.json'),pairing=new PairingStore(file),server=createServer({env:{...env,REED_PAIRING_FILE:file}});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{
  for(const path of ['/api/status','/api/feed?feed=for-you','/api/image/abc','/x/../api/status','/%2e/api/feed?feed=following']){const r=await http(server,path,{'Tailscale-User-Login':'forged@example.test'});assert.equal(r.status,401);assert.equal(r.body.error,'pairing_required')}
  assert.equal((await http(server,'/api/bookmark',{}, {id:'1',scope:'demo-v1'})).status,401);
  assert.equal((await http(server,'/api/pair',{}, {code:'00000000'})).status,401);
  assert.equal((await http(server,'/api\\pair',{}, {code:'00000000'})).status,400);
  assert.equal((await http(server,'/api/pair#bypass',{}, {code:'00000000'})).status,400);
  const paired=await http(server,'/api/pair',{}, {code:await pairing.issueCode()});assert.equal(paired.status,200);const headers={Authorization:'Bearer '+paired.body.token};
  assert.equal((await http(server,'/api/status',headers)).status,200);
  for(const other of [{Origin:'https://evil.test'},{Host:'evil.test'}] as Record<string,string>[] )assert.equal((await http(server,'/api/status',{...headers,...other})).status,403);
  const preflight=await http(server,'/api/bookmark',{'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'Content-Type, Authorization'},undefined,'OPTIONS');assert.equal(preflight.status,204);assert.equal(preflight.headers['access-control-allow-origin'],'null');
  assert.equal((await http(server,'/api/feed',{'Access-Control-Request-Method':'POST'},undefined,'OPTIONS')).status,400);
  const feed=await http(server,'/api/feed?feed=for-you',headers);assert.equal(feed.status,200);const id=(feed.body.posts as {id:string}[])[0].id;assert.equal((await http(server,'/api/bookmark',headers,{id,scope:feed.body.scope})).status,200);
  await pairing.revoke(String(paired.body.token));assert.equal((await http(server,'/api/status',headers)).status,401);
 }finally{await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true})}
})
