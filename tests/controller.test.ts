import {test} from 'node:test'
import assert from 'node:assert/strict'
import {Reader} from '../src/reader.ts'
import {FeedError,feedError} from '../src/api.ts'
import {currentPost,freshState,type Batch} from '../src/model.ts'
const batch=(id:string):Batch=>({posts:[{id,author:'A',handle:'a',text:'Hello',createdAt:'',url:`https://x.com/a/status/${id}`}],cursor:'next',mode:'demo'})
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r});return {resolve,promise}}
test('late old-feed responses cannot change active reading; duplicate refresh suppressed',async()=>{
 const pending=deferred<Batch>();let calls=0
 const r=new Reader(async()=>{calls++;return pending.promise},()=>{})
 const a=r.refresh();void r.refresh();assert.equal(calls,1)
 r.select('following');assert.equal(calls,2)
 pending.resolve(batch('1'));await a;await Promise.resolve()
 assert.equal(r.feed,'following');assert.equal(currentPost(r.state)?.id,'1')
 assert.equal(r.feeds['for-you'].posts.length,1)
})
test('disposed request ignored; errors preserve cached reading and no automatic live fallback',async()=>{
 let fail=false;const late=deferred<Batch>()
 const r=new Reader(async()=>{if(fail)throw Error('Offline');return batch('1')},()=>{})
 await r.refresh();fail=true;await r.refresh();assert.equal(currentPost(r.state)?.id,'1');assert.match(r.message,/Offline/)
 const other=new Reader(()=>late.promise,()=>{});const p=other.refresh();other.dispose();late.resolve(batch('2'));await p;assert.equal(other.state.posts.length,0)
})
test('next / previous cross pages and posts; load-more guarded until reading end',async()=>{
 let calls=0;const r=new Reader(async()=>{calls++;return {...batch(String(calls)),posts:[...batch('1').posts,...batch('2').posts]}},()=>{})
 await r.refresh();await r.more();assert.equal(calls,1)
 r.next();assert.equal(currentPost(r.state)?.id,'2');r.previous();assert.equal(currentPost(r.state)?.id,'1')
 r.next();await r.more();assert.equal(calls,2)
})
test('refresh while a load-more is pending does not overlap cursor workflows',async()=>{
 const d=deferred<Batch>();let calls=0;const r=new Reader(async()=>{calls++;return calls===1?batch('1'):d.promise},()=>{})
 await r.refresh();const more=r.more();await r.refresh();assert.equal(calls,2);d.resolve({...batch('2'),cursor:null});await more;assert.equal(r.state.posts.length,2)
})
test('host cache restoration during fetch is merged by ID without losing saved reading',async()=>{
 const d=deferred<Batch>();const r=new Reader(()=>d.promise,()=>{})
 const p=r.refresh();r.feeds['for-you']={...freshState(),posts:batch('9').posts,mode:'demo',updatedAt:1}
 d.resolve(batch('1'));await p
 assert.equal(currentPost(r.state)?.id,'9');assert.equal(r.state.arrivals,1)
})
test('clearing during a fetch ignores late completion and permits a new request',async()=>{
 const d=deferred<Batch>();let calls=0;const r=new Reader(()=>++calls===1?d.promise:Promise.resolve(batch('2')),()=>{})
 const p=r.refresh();r.clear();await r.refresh();d.resolve(batch('1'));await p
 assert.equal(currentPost(r.state)?.id,'2');assert.equal(r.busy,false)
})

test('expired cursor is cleared and reports refresh recovery; rate cooldown suppresses requests',async()=>{
 let calls=0;const r=new Reader(async()=>{calls++;if(calls===1)return batch('1');throw new FeedError('cursor_expired','Refresh to recover')},()=>{})
 await r.refresh();await r.more();assert.equal(r.state.cursor,null);assert.match(r.message,/Refresh/);r.next();assert.equal(calls,2)
 const limited=new Reader(async()=>{calls++;throw feedError(429,{error:'rate_limited'},'120')},()=>{})
 await limited.refresh();const before=calls;await limited.refresh();limited.select('following');await limited.refresh();assert.equal(calls,before);assert.equal(limited.coolingDown,true)
 assert.match(feedError(503,{error:'busy'},'1').message,/Another feed/)
 assert.ok(!feedError(500,{message:'untrusted private exception'},null).message.includes('private exception'))
});
