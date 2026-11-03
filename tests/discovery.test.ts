import {test} from 'node:test'
import assert from 'node:assert/strict'
import {discoverQueries,parseQueries} from '../server/discovery.ts'
import {TimelineTransport,type Fetcher} from '../server/transport.ts'
import {normalizeTimeline} from '../server/normalize.ts'
// Minimal public-source shapes, not an authenticated response or live success.
const relay=(name:string,id:string)=>'params:{id:`'+id+'`,metadata:{},name:`'+name+'`,operationKind:`query`,text:null,providedVariables:{__relay_internal__pv__xclientsfeaturesappviewerisloggedinrelayprovider:n,__relay_internal__pv__sportspostcontextenabledrelayprovider:i}}'
const base='https://abs.twimg.com/x-web/x-web/'
const assets:Record<string,string>={
 'https://x.com/?lang=en':`<script src="${base}entry-client-logged-out-hash.js"></script>`,
 [base+'entry-client-logged-out-hash.js']:'import "./assets/startup-dynamic-hash.js";',
 [base+'assets/startup-dynamic-hash.js']:'const deps=["assets/for-you-preload-hash.js","assets/following-preload-hash.js","assets/unrelated-big.js","https://evil.test/for-you-preload.js","../for-you-preload-escape.js"]',
 [base+'assets/for-you-preload-hash.js']:relay('HomeTimelineQuery','modern-home'),
 [base+'assets/following-preload-hash.js']:relay('HomeLatestTimelineQuery','modern-following')
}
const user={core:{name:'Modern writer',screen_name:'writer'}}
const modernPost=(id:string)=>({rest_id:id,core:{user_results:{result:user}},details:{full_text:'Full current text',created_at_ms:1793707200000}})
const modernEntry=(tweet:unknown)=>({entry_id:'tweet-1',content:{__typename:'TimelineTimelineItem',content:{tweet_results:{result:tweet}}}})
const modernTimeline=(posts:unknown[])=>{const entries:unknown[]=posts.map(modernEntry);return {data:{home_timeline:{home_timeline_urt:{instructions:[{__typename:'TimelineAddEntries',entries}]}}}}}
test('modern Vite import/manifest discovery is bounded, selects both Relay queries, rejects foreign assets',async()=>{
 const calls:string[]=[]
 const result=await discoverQueries(async url=>{calls.push(url);assert.ok(url in assets,url);return new Response(assets[url],{headers:{'content-type':url.includes('abs.twimg')?'text/javascript':'text/html'}})},AbortSignal.timeout(1000))
 assert.equal(calls.length,5);assert.equal(result.HomeTimeline?.name,'HomeTimelineQuery');assert.equal(result.HomeLatestTimeline?.id,'modern-following')
 assert.equal(result.HomeTimeline?.providers.__relay_internal__pv__xclientsfeaturesappviewerisloggedinrelayprovider,true)
 assert.equal(result.HomeTimeline?.providers.__relay_internal__pv__sportspostcontextenabledrelayprovider,false)
 assert.throws(()=>parseQueries(relay('HomeTimelineQuery','id').replace('sportspostcontextenabledrelayprovider','unknownfutureflag')),/upstream_changed/)
})
test('modern transport uses current api.x.com route, Relay booleans and chronological Following; public discovery stays credential-free',async()=>{
 let publicCalls=0;const timelineCalls:URL[]=[]
 const fetcher:Fetcher=async(input,init)=>{
  const url=String(input),headers=new Headers(init?.headers);assert.equal(init?.redirect,'error');assert.equal(init?.method,'GET')
  if(url in assets){publicCalls++;assert.equal(headers.get('cookie'),null);assert.equal(headers.get('authorization'),null);return new Response(assets[url])}
  const u=new URL(url);assert.equal(u.origin,'https://api.x.com');timelineCalls.push(u)
  assert.equal(headers.get('cookie'),'auth_token=server-auth; ct0=server-csrf')
  const variables=JSON.parse(u.searchParams.get('variables')!);assert.equal(variables.__relay_internal__pv__xclientsfeaturesappviewerisloggedinrelayprovider,true)
  assert.equal(u.searchParams.has('features'),false)
  if(u.pathname.endsWith('HomeLatestTimelineQuery')){assert.equal(variables.enableRanking,false);assert.equal(variables.cursor,'next-page')}
  return new Response(JSON.stringify(modernTimeline([modernPost('1')])))
 }
 const transport=new TimelineTransport('server-auth','server-csrf',fetcher)
 assert.equal((await transport.feed('for-you')).posts[0].text,'Full current text')
 await transport.feed('following','next-page');assert.equal(publicCalls,5);assert.equal(timelineCalls.length,2)
 assert.equal(timelineCalls[0].pathname,'/graphql/modern-home/HomeTimelineQuery')
})
test('modern details, notes, quotes, reposts, modules, replies, promotions and snake-case cursor normalize without truncation',()=>{
 const original={...modernPost('2'),note_tweet:{note_tweet_results:{result:{text:'Long text '.repeat(1000)}}},quoted_tweet_results:{result:modernPost('3')}}
 const repost={...modernPost('4'),legacy:{retweeted_status_results:{result:original}}}
 const reply={...modernPost('5'),reply_to_results:{rest_id:'9'}}
 const value=modernTimeline([repost,reply]);const entries=value.data.home_timeline.home_timeline_urt.instructions[0].entries
 entries.push({entry_id:'cursor-bottom',content:{cursor_type:'Bottom',value:'modern-cursor'}})
 entries.push({entry_id:'module',content:{items:[{item:{content:{tweet_results:{result:modernPost('6')}}}}]}})
 entries.push({entry_id:'ad',content:{content:{promoted_metadata:{advertiser_id:'1'},tweet_results:{result:modernPost('7')}}}})
 const result=normalizeTimeline(value);assert.equal(result?.posts.length,2);assert.equal(result?.cursor,'modern-cursor')
 assert.equal(result?.posts[0].id,'2');assert.equal(result?.posts[0].text.length,10000);assert.equal(result?.posts[0].quote?.text,'Full current text');assert.equal(result?.posts[0].repostedBy,'Modern writer')
})
