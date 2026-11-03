import { test } from 'node:test'
import assert from 'node:assert/strict'
import { measureTextWrap } from '@evenrealities/pretext'
import { paginate, parseBatch, restore, snapshot, freshState, mergeBatch, currentPost, eventAction } from '../src/model.ts'
const post = (id:string,text='A quiet little post.') => ({id,author:'Ada',handle:'ada',text,createdAt:'2026-11-03T09:00:00Z',url:`https://x.com/ada/status/${id}`})
test('measured pages retain long tokens, Unicode, paragraphs and fit seven native rows',()=>{
  for(const text of ['Read slowly. '.repeat(900), '山川 '.repeat(600), 'x'.repeat(1800), 'First paragraph.\n\nNext paragraph. '.repeat(80), '🦆'.repeat(400)]) {
    const pages=paginate(text)
    assert.ok(pages.length>1)
    assert.equal(pages.join('').replace(/\s/g,''),text.replace(/\s/g,''))
    for(const page of pages) { assert.ok(measureTextWrap(page,536).lineCount<=7);assert.ok(Buffer.byteLength(page)<=950) }
  }
})
test('refresh pins exact original reading and exposes arrivals; load more deduplicates',()=>{
  const s=freshState();mergeBatch(s,{posts:[post('2'),post('1')],cursor:'a',mode:'demo'},false)
  s.index=1;s.page=2
  mergeBatch(s,{posts:[post('3'),post('1','Edited upstream')],cursor:'b',mode:'demo'},false)
  assert.equal(currentPost(s)?.id,'1');assert.equal(currentPost(s)?.text,'A quiet little post.');assert.equal(s.page,2);assert.equal(s.arrivals,1)
  mergeBatch(s,{posts:[post('1'),post('0')],cursor:null,mode:'demo'},true)
  assert.equal(s.posts.length,3);assert.equal(s.pending[0]?.id,'3');assert.equal(s.cursor,null)
})
test('strict response validation rejects secret-like/untrusted shapes, excessive text and counts',()=>{
  assert.throws(()=>parseBatch({posts:[post('1')],mode:'pretend',cursor:null}))
  assert.throws(()=>parseBatch({posts:[{...post('1'),url:'javascript:alert(1)'}],mode:'live',cursor:null}))
  assert.throws(()=>parseBatch({posts:[post('1','x'.repeat(32001))],mode:'live',cursor:null}))
  assert.throws(()=>parseBatch({posts:Array.from({length:31},()=>post('1')),mode:'live',cursor:null}))
  assert.equal(parseBatch({posts:[post('1')],mode:'demo',cursor:null}).posts.length,1)
})
test('versioned cache bounded and mode separated; invalid positions/cursors rejected',()=>{
  const s=freshState();mergeBatch(s,{posts:[post('1')],cursor:'a',mode:'demo'},false)
  const saved=snapshot('for-you',{'for-you':s,following:freshState()})
  assert.equal(restore(saved,'demo')?.feeds['for-you'].posts.length,1)
  assert.equal(restore(saved,'live'),null)
  assert.equal(restore('{"version":900}','demo'),null)
  assert.equal(restore('x'.repeat(190001),'demo'),null)
  const parsed=JSON.parse(saved);parsed.feeds['for-you'].index=-1
  assert.equal(restore(JSON.stringify(parsed),'demo'),null)
})
test('cache retains current post under budget and never persists cursor across bounded trimming',()=>{
  const s=freshState();mergeBatch(s,{posts:Array.from({length:20},(_,i)=>post(String(i),'x'.repeat(30000))),cursor:'more',mode:'live'},false);s.index=18
  const saved=snapshot('for-you',{'for-you':s,following:freshState()});assert.ok(saved.length<=180000)
  const got=restore(saved,'live')!.feeds['for-you'];assert.equal(currentPost(got)?.id,'18');assert.equal(got.cursor,null)
})
test('zero defaults only in present envelope, menu independent and exit prioritized',()=>{
  assert.equal(eventAction({audioEvent:{}}),null)
  assert.equal(eventAction({sysEvent:{}}),'next')
  assert.equal(eventAction({textEvent:{eventType:1}}),'previous')
  assert.equal(eventAction({menuItemClickEvent:{itemID:2}}),'for-you')
  assert.equal(eventAction({sysEvent:{eventType:3},textEvent:{eventType:2}}),'exit')
  assert.equal(eventAction({sysEvent:{eventType:5}}),'persist')
})

test('refresh preserves the cursor belonging to the retained older tail',()=>{
 const s=freshState();mergeBatch(s,{posts:[post('2'),post('1')],cursor:'older-tail',mode:'live'},false)
 mergeBatch(s,{posts:[post('3'),post('2')],cursor:'head-bottom',mode:'live'},false)
 assert.equal(s.cursor,'older-tail');assert.equal(s.posts.at(-1)?.id,'1')
});

test('persisted load-more window of 60 short posts restores selected reading rather than discarding cache',()=>{
 const s=freshState();mergeBatch(s,{posts:Array.from({length:30},(_,i)=>post(String(100-i))),cursor:'first',mode:'live'},false)
 s.index=29;mergeBatch(s,{posts:Array.from({length:30},(_,i)=>post(String(70-i))),cursor:'second',mode:'live'},true)
 assert.equal(s.posts.length,60);s.index=50
 const saved=snapshot('for-you',{'for-you':s,following:freshState()}),got=restore(saved,'live')
 assert.ok(got);assert.equal(got.feeds['for-you'].posts.length,60);assert.equal(currentPost(got.feeds['for-you'])?.id,'50');assert.equal(got.feeds['for-you'].cursor,null)
});
