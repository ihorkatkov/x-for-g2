import {test} from 'node:test'
import assert from 'node:assert/strict'
import {normalizeTimeline} from '../server/normalize.ts'
import {freshState,mergeBatch,postText,paginate,currentPost,snapshot,restore} from '../src/model.ts'
import {display} from '../src/host.ts'
import {createServer} from '../server/index.ts'
import {request} from 'node:http'
const user=(name:string,handle:string,modern=false)=>({user_results:{result:modern?{user:{core:{name,screen_name:handle}}}:{legacy:{name,screen_name:handle}}}})
const original=(modern=false)=>({rest_id:'10',core:user('Original Author','original',modern),legacy:{full_text:'Original full text, not an RT preview.',created_at:'2026-11-03T09:00:00Z'}})
const repost=(source:unknown,modern=false)=>({rest_id:'20',core:user('Friend','friend',modern),legacy:{full_text:'RT @original: truncated preview https://t.co/preview',created_at:'2026-11-03T10:00:00Z',...(modern?{retweeted_status_results:{result:source}}:{retweeted_status_result:{result:source}})}})
const timeline=(posts:unknown[])=>({data:{home:{home_timeline_urt:{instructions:[{entries:posts.map(result=>({content:{itemContent:{tweet_results:{result}}}}))}]}}}})
test('legacy repost opens the complete original note and quoted text with separate reposter attribution',()=>{
 const full='A complete original note. '.repeat(200),quote='Quoted original text. '.repeat(50)
 const source={...original(),note_tweet:{note_tweet_results:{result:{text:full}}},quoted_status_result:{result:{...original(),rest_id:'11',note_tweet:{note_tweet_results:{result:{text:quote}}}}}}
 const p=normalizeTimeline(timeline([repost(source)]))!.posts[0]
 assert.equal(p.id,'10');assert.equal(p.handle,'original');assert.equal(p.author,'Original Author');assert.equal(p.url,'https://x.com/original/status/10');assert.equal(p.text,full);assert.equal(p.quote?.text,quote);assert.equal(p.repostedBy,'Friend');assert.equal(p.repostedByHandle,'friend');assert.ok(!p.text.includes('truncated preview'))
})
test('modern repost user wrappers, plural results and visibility wrapper retain original identity',()=>{
 const source={...original(true),details:{full_text:'Modern full original',created_at_ms:1793696400000}}
 const p=normalizeTimeline(timeline([repost({tweet:source},true)]))!.posts[0]
 assert.equal(p.id,'10');assert.equal(p.text,'Modern full original');assert.equal(p.handle,'original');assert.equal(p.repostedBy,'Friend');assert.equal(p.repostedByHandle,'friend')
})
test('deduplication keeps repost attribution even if the original appeared earlier in the same page',()=>{
 for(const items of [[original(),repost(original())],[repost(original()),original()]]){
  const batch=normalizeTimeline(timeline(items))!;assert.equal(batch.posts.length,1);assert.equal(batch.posts[0].repostedByHandle,'friend');assert.equal(batch.posts[0].text,original().legacy.full_text)
 }
})
test('a reposted reply can be read as a standalone feed item; plain replies and unavailable originals stay excluded',()=>{
 const reply={...original(),legacy:{...original().legacy,in_reply_to_status_id_str:'9'}}
 assert.equal(normalizeTimeline(timeline([reply]))!.posts.length,0)
 assert.equal(normalizeTimeline(timeline([repost(reply)]))!.posts[0].id,'10')
 assert.equal(normalizeTimeline(timeline([repost({__typename:'TweetTombstone'})]))!.posts.length,0)
})
test('repost attribution survives cache/refresh and remains visible beyond the first original-text page',()=>{
 const scope='a'.repeat(32),s=freshState(),plain=normalizeTimeline(timeline([original()]))!.posts[0]
 mergeBatch(s,{posts:[{...plain,text:'A long original. '.repeat(150)}],mode:'live',scope,cursor:'old'},false);s.page=2
 const shared=normalizeTimeline(timeline([repost(original())]))!.posts[0];mergeBatch(s,{posts:[shared],mode:'live',scope,cursor:'new'},false)
 assert.equal(s.page,2);assert.equal(currentPost(s)?.repostedByHandle,'friend');assert.ok(currentPost(s)!.text.length>1000)
 const pages=paginate(postText(currentPost(s)!)),view=display('following',s,pages,false,'');assert.match(view.header,/via @friend/);assert.match(view.author,/Original Author/);assert.equal(view.body,pages[2]);assert.ok(!view.body.includes('RT @'))
 const cached=restore(snapshot('following',{'for-you':freshState(),following:s}),'live',scope)!;assert.equal(currentPost(cached.feeds.following)?.repostedByHandle,'friend')
})
test('application remains GET-only: former posting routes are rejected and no mutation capability is exposed',async()=>{
 let upstream=0;const server=createServer({env:{REED_MODE:'demo'},fetcher:async()=>{upstream++;throw Error('No network expected')}});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const a=server.address();assert.ok(a&&typeof a==='object');
 try{for(const path of ['/api/repost','/api/repost/prepare']){
  const status=await new Promise<number>((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:a.port,path,method:'POST',headers:{Host:'127.0.0.1:4040','Content-Type':'application/json','Content-Length':'2',Origin:'http://127.0.0.1:4040'}},response=>{response.resume();resolve(response.statusCode!)});req.on('error',reject);req.end('{}')});assert.equal(status,400)
 }assert.equal(upstream,0)}finally{await new Promise<void>(resolve=>server.close(()=>resolve()))}
})

test('long reposter display-name fallback never hides loading or new-arrival status',()=>{
 const s=freshState();mergeBatch(s,{posts:[{...original().legacy,id:'10',author:'Original Author',handle:'original',text:'Original words',createdAt:'2026-11-03T09:00:00Z',url:'https://x.com/original/status/10',repostedBy:'A very long display name '.repeat(8)}],mode:'demo',cursor:null},false);s.arrivals=2
 assert.match(display('following',s,['Original words'],true,'').header,/Loading/)
 assert.match(display('following',s,['Original words'],false,'').header,/\+2 new/)
})
