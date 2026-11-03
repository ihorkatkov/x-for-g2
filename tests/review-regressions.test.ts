import {test} from 'node:test'
import assert from 'node:assert/strict'
import {freshState,mergeBatch,snapshot,restore,currentPost,jumpToNewest,type Batch} from '../src/model.ts'
import {Reader} from '../src/reader.ts'
const post=(id:number)=>({id:String(id),author:'Writer',handle:'writer',text:'An original post.',createdAt:'2026-11-03T09:00:00Z',url:`https://x.com/writer/status/${id}`})
const scopeA='a'.repeat(32),scopeB='b'.repeat(32)
const batch=(id:number,scope=scopeA):Batch=>({posts:[post(id)],mode:'live',scope,cursor:'next'})
test('full reading window preserves every unread post and tail cursor while refresh arrivals wait',()=>{
 const s=freshState();mergeBatch(s,{...batch(0),posts:Array.from({length:30},(_,i)=>post(i)),cursor:'page2'},false);
 s.index=29;mergeBatch(s,{...batch(0),posts:Array.from({length:30},(_,i)=>post(i+30)),cursor:'tail'},true);s.index=40;
 const unread=s.posts.slice(40).map(p=>p.id);
 mergeBatch(s,{...batch(0),posts:Array.from({length:20},(_,i)=>post(i+100)),cursor:'head2'},false);
 assert.equal(currentPost(s)?.id,'40');assert.deepEqual(s.posts.slice(s.index).map(p=>p.id),unread);assert.equal(s.cursor,'tail');assert.equal(s.arrivals,20);assert.equal(s.posts.length,60);
 jumpToNewest(s);assert.equal(currentPost(s)?.id,'100');assert.equal(s.posts.length,60);assert.equal(s.arrivals,0);assert.equal(s.cursor,'head2');
})
test('session-mismatched host cache is rejected; same session retains its exact place',()=>{
 const s=freshState();mergeBatch(s,batch(1),false);
 const saved=snapshot('for-you',{'for-you':s,following:freshState()});assert.ok(restore(saved,'live',scopeA));assert.equal(restore(saved,'live',scopeB),null);
 const old=JSON.parse(saved);old.version=1;assert.equal(restore(JSON.stringify(old),'live',scopeA),null);
})
test('a changed X session clears both feeds, cancels stale completions and starts clean',async()=>{
 let next=batch(1);let release!:(v:Batch)=>void;
 const reader=new Reader(async(feed)=>feed==='following'?new Promise<Batch>(r=>{release=r}):next,()=>{});
 await reader.refresh();reader.select('following');reader.select('for-you');next=batch(2,scopeB);await reader.refresh();
 release(batch(9,scopeA));await new Promise(r=>setImmediate(r));
 assert.deepEqual(reader.feeds['for-you'].posts.map(p=>p.id),['2']);assert.equal(reader.feeds.following.posts.length,0);assert.equal(reader.feeds['for-you'].pending.length,0);
})

test('expired or stripped cursor recovers through refresh and actually loads older posts without moving reading',async()=>{
 const {FeedError}=await import('../src/api.ts');let step=0;
 const reader=new Reader(async()=>{
  step++;if(step===1)return {...batch(10),cursor:'expired'};
  if(step===2)throw new FeedError('cursor_expired','Refresh to continue');
  if(step===3)return {...batch(10),cursor:'fresh'}; // No arrivals: recovery cannot depend on Jump to newest.
  return {...batch(9),cursor:null};
 },()=>{});
 await reader.refresh();await reader.more();assert.equal(reader.state.cursor,null);assert.equal(reader.state.headCursor,null);
 await reader.refresh();assert.equal(reader.state.cursor,'fresh');assert.equal(reader.state.arrivals,0);assert.equal(currentPost(reader.state)?.id,'10');
 await reader.more();assert.deepEqual(reader.state.posts.map(p=>p.id),['10','9']);assert.equal(currentPost(reader.state)?.id,'10');
 const saved=snapshot('for-you',reader.feeds),restored=restore(saved,'live',scopeA)!;
 const restarted=new Reader(async()=>({...batch(10),cursor:'restart-fresh'}),()=>{});restarted.feeds=restored.feeds;
 assert.equal(restarted.state.cursor,null);await restarted.refresh();assert.equal(restarted.state.cursor,'restart-fresh');assert.equal(currentPost(restarted.state)?.id,'10');
})
