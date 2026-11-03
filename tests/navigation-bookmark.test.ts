import {test} from 'node:test'
import assert from 'node:assert/strict'
import {Reader} from '../src/reader.ts'
import {BookmarkAction} from '../src/bookmark.ts'
import {eventAction,type Batch} from '../src/model.ts'
import {bookmarkHeader,menuItems} from '../src/host.ts'
import {TimelineTransport} from '../server/transport.ts'
import {parseQueries} from '../server/discovery.ts'
const post=(id:string,text='Long text '.repeat(900))=>({id,text,author:'A',handle:'a',createdAt:'',url:`https://x.com/a/status/${id}`})
const batch=(ids:string[],cursor:string|null=null):Batch=>({posts:ids.map(id=>post(id)),mode:'demo',scope:'demo-v1',cursor})
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve}}
test('whole-post navigation skips unread pages and returns to the start of the previous post',async()=>{
 const r=new Reader(async()=>batch(['1','2']),()=>{});await r.refresh();r.next();assert.equal(r.state.page,1);
 await r.nextPost();assert.equal(r.state.posts[r.state.index].id,'2');assert.equal(r.state.page,0);
 r.next();r.previousPost();assert.equal(r.state.posts[r.state.index].id,'1');assert.equal(r.state.page,0);
 r.select('following');await r.refresh();assert.equal(r.state.page,0);assert.equal(r.feeds['for-you'].index,0);
 assert.equal(eventAction({menuItemClickEvent:{itemID:8}}),'next-post');assert.equal(eventAction({menuItemClickEvent:{itemID:9}}),'previous-post');assert.equal(eventAction({menuItemClickEvent:{itemID:10}}),'bookmark');assert.equal(menuItems.length,10);
})
test('skipping the loaded tail fetches older posts once without requiring its last text page',async()=>{
 const d=deferred<Batch>();let calls=0;const r=new Reader(async()=>++calls===1?batch(['1'],'older'):d.promise,()=>{});await r.refresh();
 const skip=r.nextPost();void r.nextPost();assert.equal(calls,2);assert.equal(r.state.page,0);
 d.resolve(batch(['2']));await skip;assert.equal(r.state.posts[r.state.index].id,'2');assert.equal(r.state.page,0);
 await r.nextPost();assert.equal(calls,2);
})
test('failed tail skip preserves exact reading position; changing feeds ignores late skip navigation',async()=>{
 let fail=true;const d=deferred<Batch>();let calls=0;const r=new Reader(async(feed)=>{if(feed==='following')return batch(['8']);if(++calls===1)return batch(['1'],'older');if(fail)throw Error('Offline');return d.promise},()=>{});
 await r.refresh();r.next();await r.nextPost();assert.equal(r.state.page,1);assert.equal(r.state.index,0);assert.match(r.message,/Offline/);
 fail=false;const skip=r.nextPost();r.select('following');await r.refresh();d.resolve(batch(['2']));await skip;assert.equal(r.feed,'following');assert.equal(r.state.posts[r.state.index].id,'8');assert.equal(r.feeds['for-you'].index,0);assert.equal(r.feeds['for-you'].page,1);
})
test('bookmark confirmation is post/account bound, suppresses duplicate taps, and never saves optimistically',async()=>{
 const d=deferred<void>();let calls=0;const action=new BookmarkAction(async()=>{calls++;return d.promise},()=>{});
 const save=action.save('1','scope-a','live');void action.save('1','scope-a','live');void action.save('2','scope-a','live');assert.equal(calls,1);assert.equal(action.status('1','scope-a').saved,false);assert.equal(action.status('2','scope-a').message,'');
 d.resolve();await save;assert.equal(action.status('1','scope-a').message,'Saved to X');assert.equal(action.status('1','scope-b').saved,false);await action.save('1','scope-a','live');assert.equal(calls,1);
})
test('uncertain saves are reported without retry and demo success never claims an X account write',async()=>{
 let calls=0;const action=new BookmarkAction(async()=>{calls++;throw Error('Check X bookmarks')},()=>{});await action.save('1','s','live');assert.equal(calls,1);assert.equal(action.status('1','s').saved,false);assert.equal(action.status('1','s').message,'Check X bookmarks');
 const demo=new BookmarkAction(async()=>{},()=>{});await demo.save('1','demo-v1','demo');assert.equal(demo.status('1','demo-v1').message,'Demo saved');
})
test('bookmark discovery recognizes only the add mutation and keeps query/mutation kinds separate',()=>{
 const js='params:{id:`public-id`,metadata:{},name:`bookmarkStateAddMutation`,operationKind:`mutation`,text:null}';assert.equal(parseQueries(js).CreateBookmark?.name,'bookmarkStateAddMutation');assert.equal(parseQueries(js.replace('`mutation`','`query`')).CreateBookmark,undefined);
 assert.equal(parseQueries('queryId:"legacy",operationName:"CreateBookmark"').CreateBookmark?.format,'legacy');
})
test('bookmark transport sends exactly one fixed add-only Relay mutation with server credentials',async()=>{
 let calls=0;const t=new TimelineTransport('fabricated-auth','fabricated-csrf',async(url,init)=>{calls++;assert.equal(String(url),'https://api.x.com/graphql/public-add/bookmarkStateAddMutation');assert.equal(init?.method,'POST');assert.equal(init?.redirect,'error');assert.deepEqual(JSON.parse(String(init?.body)),{variables:{tweetId:'123'},queryId:'public-add'});const headers=new Headers(init?.headers);assert.equal(headers.get('cookie'),'auth_token=fabricated-auth; ct0=fabricated-csrf');return Response.json({data:{tweet_bookmark_put:'Done'}})},Date.now,{CreateBookmark:'public-add'},'relay');
 await t.bookmark('123');assert.equal(calls,1);
})
test('mutation timeout, server error and malformed success remain uncertain and are never automatically retried',async()=>{
 for(const response of [()=>{throw Error('fabricated-private-error')},()=>new Response('private',{status:500}),()=>Response.json({data:{}}),()=>new Response('not-json'),()=>new Response(null),()=>new Response('x'.repeat(64001)),()=>new Response('x',{headers:{'content-length':'64001'}}),()=>Response.json({errors:[{code:999,message:'fabricated-private-error'}]})]){let calls=0;const t=new TimelineTransport('auth','csrf',async()=>{calls++;return response()},Date.now,{CreateBookmark:'public'},'relay');await assert.rejects(t.bookmark('1'),(error:unknown)=>{assert.equal((error as {code:string}).code,'bookmark_unknown');assert.ok(!String(error).includes('private'));return true});assert.equal(calls,1)}
})
test('duplicate bookmarks are accepted; expired credentials latch across reads and writes',async()=>{
 const duplicate=new TimelineTransport('auth','csrf',async()=>Response.json({errors:[{code:405}]}),Date.now,{CreateBookmark:'public'},'relay');await duplicate.bookmark('1');
 let calls=0;const expired=new TimelineTransport('auth','csrf',async()=>{calls++;return new Response('',{status:401})},Date.now,{CreateBookmark:'public'},'relay');await assert.rejects(expired.bookmark('1'),/expired/);await assert.rejects(expired.feed('following'),/expired/);assert.equal(calls,1);
})

test('explicit X Done confirmation takes precedence over nonfatal GraphQL warnings',async()=>{
 const t=new TimelineTransport('auth','csrf',async()=>Response.json({data:{tweet_bookmark_put:'Done'},errors:[{code:999}]}),Date.now,{CreateBookmark:'public'},'relay');await t.bookmark('1');
})

test('only explicit protected/repost bookmark rejections are definite failures',async()=>{
 for(const codes of [[406],[463],[406,463],[406,999]]){const t=new TimelineTransport('auth','csrf',async()=>Response.json({errors:codes.map(code=>({code}))}),Date.now,{CreateBookmark:'public'},'relay');await assert.rejects(t.bookmark('1'),new RegExp(codes.includes(999)?'bookmark_unknown':'bookmark_failed'));}
})

test('bookmark feedback preserves image identity and existing header metadata',()=>{
 assert.equal(bookmarkHeader('For You / DEMO / Photo','Demo saved'),'For You / Demo saved / DEMO / Photo');
 assert.equal(bookmarkHeader('Image 1/2 / DEMO / Loading','Saving demo'),'Image 1/2 / Saving demo / DEMO / Loading');
 assert.match(bookmarkHeader('For You / ! Retry','Saved to X'),/! Retry/);
 assert.match(bookmarkHeader('For You / +2 new','Saved to X'),/\+2 new/);
})
