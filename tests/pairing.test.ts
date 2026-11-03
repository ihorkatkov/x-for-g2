import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PairingStore} from '../server/pairing.ts'
async function setup(now=Date.now){const dir=await mkdtemp(join(tmpdir(),'x-device-')),file=join(dir,'state.json');return {dir,file,store:new PairingStore(file,now),close:()=>rm(dir,{recursive:true,force:true})}}
test('pair code is single-use, sessions are hashed on disk and survive service restart until expiry',async()=>{
 let now=1000;const x=await setup(()=>now)
 try{const code=await x.store.issueCode();assert.match(code,/^\d{8}$/);assert.ok(!(await readFile(x.file,'utf8')).includes(code));const token=await x.store.pair(code);assert.equal(await x.store.authorized('Bearer '+token),true);assert.equal(await new PairingStore(x.file,()=>now).authorized('Bearer '+token),true);assert.ok(!(await readFile(x.file,'utf8')).includes(token));assert.equal((await stat(x.file)).mode&0o777,0o600);await assert.rejects(x.store.pair(code));assert.equal(await x.store.authorized('Bearer invalid'),false);now+=31*86400000;assert.equal(await x.store.authorized('Bearer '+token),false)}finally{await x.close()}
})
test('five wrong attempts lock the short code; expired codes fail; explicit rotation recovers',async()=>{
 let now=0;const x=await setup(()=>now)
 try{let code=await x.store.issueCode();for(let i=0;i<5;i++)await assert.rejects(x.store.pair('invalid'));await assert.rejects(x.store.pair(code));code=await x.store.issueCode();now+=10*60000+1;await assert.rejects(x.store.pair(code));const current=await x.store.issueCode();assert.match(await x.store.pair(current),/^[A-Za-z0-9_-]{43}$/)}finally{await x.close()}
})
test('concurrent pairing consumes the code once and revocation removes access',async()=>{
 const x=await setup()
 try{const code=await x.store.issueCode(),results=await Promise.allSettled([x.store.pair(code),x.store.pair(code)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const token=results.find(r=>r.status==='fulfilled')!.value;await x.store.revoke(token);assert.equal(await x.store.authorized('Bearer '+token),false)}finally{await x.close()}
})
