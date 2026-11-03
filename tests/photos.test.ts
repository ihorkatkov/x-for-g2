import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {Photos,photoURL,dimensions} from '../server/photos.ts'
import {normalizeTimeline} from '../server/normalize.ts'
import {Gallery,photoPlan,monochrome,attachmentOnly,AttachmentSession,type PhotoPage} from '../src/photo.ts'
import {freshState,parseBatch,postText,mergeBatch,restore,snapshot} from '../src/model.ts'
import {display,geometry} from '../src/host.ts'
const url='https://pbs.twimg.com/media/example.jpg',image={url:'/api/image/'+'a'.repeat(32)+'.'+'b'.repeat(43),alt:'An accessible description.'}
const p={id:'1',author:'Author',handle:'author',text:'Words remain readable.',createdAt:'2026-11-03T00:00:00Z',url:'https://x.com/author/status/1',images:[image]}
const source=(media:unknown[],legacy=false)=>({rest_id:'1',core:{user_results:{result:{legacy:{name:'Author',screen_name:'author'}}}},legacy:{full_text:'',created_at:p.createdAt,...(legacy?{extended_entities:{media}}:{})},...(!legacy?{media_entities2:media}:{})})
const timeline=(value:unknown)=>({data:{home:{home_timeline_urt:{instructions:[{entries:[{content:{itemContent:{tweet_results:{result:value}}}}]}]}}}})
test('legacy and modern original photos survive repost normalization; video stills and foreign targets are distinguished',()=>{
 for(const legacy of [true,false]){
  const original=source([{type:'photo',media_url_https:url,ext_alt_text:image.alt},{type:'video',media_url_https:url},{type:'photo',media_url_https:'https://evil.test/p.png'}],legacy)
  const wrapper={...source([]),legacy:{full_text:'RT truncated',created_at:p.createdAt,retweeted_status_result:{result:original}}}
  const post=normalizeTimeline(timeline(wrapper))!.posts[0];assert.equal(post.id,'1');assert.deepEqual(post.images,[{url,alt:image.alt}])
 }
 assert.equal(normalizeTimeline(timeline(source([{type:'video',media_url_https:url}])) )!.posts[0].images?.[0].kind,'video-still')
})
test('opaque photo fetches are bounded, survive restart, reject tampering and redirects and omit all session credentials',async()=>{
 const bytes=await readFile(new URL('../public/demo-earthrise.jpg',import.meta.url));let calls=0
 const photos=new Photos(async(target,init)=>{calls++;assert.equal(target,url);assert.equal(init?.method,'GET');assert.equal(init?.redirect,'error');assert.deepEqual(init?.headers,{Accept:'image/jpeg,image/png'});return new Response(bytes,{headers:{'content-type':'image/jpeg'}})},new Uint8Array(32).fill(7))
 const path=photos.register(url);assert.match(path,/^\/api\/image\/[A-Za-z0-9_-]{20,667}\.[A-Za-z0-9_-]{43}$/);assert.equal(photos.register(url),path)
 const loaded=await photos.load(path.slice(11));assert.deepEqual(loaded.body,bytes);assert.deepEqual(dimensions(bytes),{width:640,height:640});assert.equal(calls,1)
 await assert.rejects(photos.load('x'.repeat(32)),/not_found/);const restarted=new Photos(async()=>new Response(bytes,{headers:{'content-type':'image/jpeg'}}),new Uint8Array(32).fill(7));assert.deepEqual((await restarted.load(path.slice(11))).body,bytes);await assert.rejects(photos.load(path.slice(11)+'x'),/not_found/);await assert.rejects(new Photos().load(path.slice(11)),/not_found/);assert.equal(calls,1)
 for(const bad of ['http://pbs.twimg.com/media/x.jpg','https://pbs.twimg.com.evil/media/x.jpg','https://pbs.twimg.com@evil/media/x.jpg','https://pbs.twimg.com/media/a.svg','https://pbs.twimg.com/media/a.jpg?url=internal','https://pbs.twimg.com/media/a.jpg#x','https://pbs.twimg.com/media/a.jpg?format=jpg&format=png'])assert.equal(photoURL(bad),false,bad)
 assert.equal(photoURL('https://pbs.twimg.com/media/abc?format=jpg&name=small'),true)
})
test('photo proxy rejects declared/streamed oversize, wrong MIME and decoded allocation bombs',async()=>{
 const png=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.writeUInt32BE(99999,16);png.writeUInt32BE(99999,20)
 for(const response of [new Response('x',{headers:{'content-length':'2000001','content-type':'image/png'}}),new Response(new Uint8Array(2000001),{headers:{'content-type':'image/png'}}),new Response(png,{headers:{'content-type':'image/png'}}),new Response('<svg/>',{headers:{'content-type':'image/svg+xml'}})]){
  const photos=new Photos(async()=>response),path=photos.register(url);await assert.rejects(photos.load(path.slice(11)),/upstream_changed/)
 }
})
test('image overview preserves aspect; detail strips cover the whole raster within bounded pages and sixteen grey levels',()=>{
 const plan=photoPlan(640,640);assert.deepEqual(plan[0],{width:144,height:144,offset:0,overview:true});assert.equal(plan.length,6);assert.equal(plan.at(-1)!.offset,392);assert.equal(plan.at(-1)!.height,536)
 assert.ok(photoPlan(100,4096).length<=13);assert.throws(()=>photoPlan(4096,4096));assert.throws(()=>photoPlan(0,1))
 const data=monochrome(Uint8ClampedArray.from([255,0,0,255,255,255,255,0,255,255,255,255]));assert.deepEqual(Array.from(data),[51,51,51,255,0,0,0,255,255,255,255,255])
})
test('leaving an in-flight gallery prevents late image reopening; errors retain a text return path',async()=>{
 let resolve!:(v:PhotoPage[])=>void,changes=0;const g=new Gallery(()=>new Promise(r=>resolve=r),()=>changes++)
 const pending=g.show([image]);assert.equal(g.loading,true);g.close();resolve([{tiles:[new Uint8Array(),new Uint8Array()],pixels:new Uint8ClampedArray()}]);await pending;assert.equal(g.open,false);assert.equal(g.frame,undefined);assert.equal(changes,2)
 const failed=new Gallery(async()=>{throw Error('private url or payload')},()=>{});await failed.show([image]);assert.equal(failed.open,true);assert.equal(failed.loading,false);assert.ok(!failed.error.includes('private'));failed.close();assert.equal(failed.open,false)
})
test('post descriptions stay accessible as text; image metadata cannot introduce arbitrary fetch URLs; system status stays in header',()=>{
 const batch=parseBatch({posts:[p],cursor:null,mode:'demo'});assert.match(postText(batch.posts[0]),/Image 1 description: An accessible description/)
 assert.throws(()=>parseBatch({posts:[{...p,images:[{url:'https://evil/x.jpg',alt:''}]}],cursor:null,mode:'demo'}))
 const state=freshState();mergeBatch(state,batch,false);const view=display('for-you',state,['Original words.'],false,'Offline');assert.equal(view.body,'Original words.');assert.equal(view.pager.trim(),'1/1');assert.match(view.header,/! Retry/);assert.equal('footer' in view,false)
 for(const c of geometry.filter(g=>g.containerName!=='body'))assert.ok(c.yPosition+c.height<=67)
 assert.equal(display('for-you',freshState(),[''],false,'Unavailable').body,'')
})

test('partial photo failures keep earlier pages and preserve original description numbering',async()=>{
 const page={tiles:[new Uint8Array(),new Uint8Array()] as [Uint8Array,Uint8Array],pixels:new Uint8ClampedArray()};let count=0
 const g=new Gallery(async()=>{if(count++===1)throw Error('unavailable');return [page]},()=>{})
 await g.show([image,image]);assert.equal(g.pages.length,1);assert.equal(g.frame?.page.photoNumber,1);assert.equal(g.frame?.page.photoCount,2);assert.match(g.error,/Some images/);assert.equal(g.loading,false)
 assert.match(postText({...p,images:[{...image,alt:''},image]}),/Image 2 description/)
 const state=freshState();mergeBatch(state,{posts:[{...p,repostedBy:'Friend',repostedByHandle:'friend'}],cursor:null,mode:'demo'},false);assert.match(display('following',state,['text'],false,'Long failure '.repeat(20)).header,/via @friend/)
 assert.equal(dimensions(Uint8Array.from([255,216,255,255,255,255])),null)
})

test('HTTP feed issues session-signed image handles that work after backend restart and reject foreign sessions',async()=>{
 const {createServer}=await import('../server/index.ts'),{request}=await import('node:http'),bytes=await readFile(new URL('../public/demo-earthrise.jpg',import.meta.url))
 const env={REED_MODE:'live',REED_QUERY_FORMAT:'legacy',AUTH_TOKEN:'test-auth',CT0:'test-csrf',REED_HOME_QUERY_ID:'home',REED_LATEST_QUERY_ID:'latest'}
 const upstream=timeline(source([{type:'photo',media_url_https:url,ext_alt_text:image.alt}]))
 const fetcher=async(target:string|URL|Request)=>String(target).startsWith('https://pbs.twimg.com/')?new Response(bytes,{headers:{'content-type':'image/jpeg'}}):new Response(JSON.stringify(upstream),{headers:{'content-type':'application/json'}})
 const get=async(server:ReturnType<typeof createServer>,path:string)=>{const address=server.address();assert.ok(address&&typeof address==='object');return await new Promise<{status:number;body:Buffer}>(resolve=>{request({hostname:'127.0.0.1',port:address.port,path,headers:{Host:'127.0.0.1:4040'}},res=>{const chunks:Buffer[]=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode!,body:Buffer.concat(chunks)}))}).end()})}
 let path=''
 for(const [n,auth] of ['test-auth','test-auth','different-session'].entries()){
  const server=createServer({env:{...env,AUTH_TOKEN:auth},fetcher});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
  try{
   if(n===0){const response=await get(server,'/api/feed?feed=for-you');assert.equal(response.status,200);const batch=parseBatch(JSON.parse(response.body.toString()));path=batch.posts[0].images![0].url;assert.ok(!response.body.includes(Buffer.from('test-auth')))}
   const photo=await get(server,path);assert.equal(photo.status,n===2?404:200);if(n!==2)assert.deepEqual(photo.body,bytes)
   assert.equal((await get(server,path+'x')).status,400)
  }finally{await new Promise<void>(r=>server.close(()=>r()))}
 }
})

test('reaction-only Relay video attachment becomes a still, not an unreadable shortened URL',()=>{
 const short='https://t.co/testVideo',raw='😆 '+short
 const media={type:'video',indices:[3,raw.length],media_url_https:'https://pbs.twimg.com/ext_tw_video_thumb/123/pu/img/preview.jpg',video_info:{variants:[{url:'https://video.twimg.com/private.mp4'}]}}
 const node={...source([media]),details:{full_text:raw,created_at_ms:1793664000000}}
 const post=normalizeTimeline(timeline(node))!.posts[0]
 assert.equal(post.text,'😆');assert.equal(post.images?.[0].kind,'video-still');assert.ok(!JSON.stringify(post).includes('private.mp4'))
 const batch=parseBatch({posts:[{...post,images:[{...post.images![0],url:image.url}]}],cursor:null,mode:'live'})
 assert.equal(batch.posts[0].images?.[0].kind,'video-still');assert.equal(attachmentOnly(batch.posts[0]),true)
 assert.equal(attachmentOnly({...batch.posts[0],text:'A readable caption'}),false)
 assert.equal(attachmentOnly({...batch.posts[0],text:'中文'}),false)
 assert.equal(attachmentOnly({...batch.posts[0],quote:{author:'Writer',handle:'writer',text:'Read the quoted post.'}}),false)
 assert.equal(attachmentOnly({...batch.posts[0],images:undefined}),false)
 for(const path of ['/ext_tw_video_thumb/123/pu/img/a.jpg','/amplify_video_thumb/456/img/a.jpg','/tweet_video_thumb/a.jpg'])assert.equal(photoURL('https://pbs.twimg.com'+path),true)
 for(const path of ['/ext_tw_video_thumb/123/pu/vid/a.mp4','/anything/a.jpg'])assert.equal(photoURL('https://pbs.twimg.com'+path),false)
})
test('modern standalone URL entities expand links and remove only quoted links with readable inline content',()=>{
 const short='https://t.co/quoted',quote={...source([]),rest_id:'2',details:{full_text:'The entire original quoted post.',created_at_ms:1793664000000}}
 const raw={...source([]),details:{full_text:'😆 '+short,created_at_ms:1793664000000},url_entities:[{url:short,expanded_url:'https://x.com/author/status/2',display_url:'x.com/author/status/2'}],quoted_tweet_results:{result:quote}}
 const post=normalizeTimeline(timeline(raw))!.posts[0];assert.equal(post.text,'😆');assert.equal(post.quote?.text,'The entire original quoted post.')
 const quoteOnly=normalizeTimeline(timeline({...raw,details:{...raw.details,full_text:short}}))!.posts[0];assert.equal(quoteOnly.text,'');assert.equal(quoteOnly.quote?.text,'The entire original quoted post.');
 const unavailable=normalizeTimeline(timeline({...raw,quoted_tweet_results:{result:{__typename:'TweetTombstone'}}}))!.posts[0];assert.match(unavailable.text,/x.com\/author\/status\/2/)
})
test('media attachment removal accepts code-point indices without deleting other links',()=>{
 const short='https://t.co/media',other='https://t.co/article',raw='😆 '+short+' '+other
 const node={...source([{type:'photo',indices:[2,2+short.length],media_url_https:url}]),details:{full_text:raw,created_at_ms:1793664000000},url_entities:[{url:other,expanded_url:'https://example.com/story',display_url:'example.com/story'}]}
 const post=normalizeTimeline(timeline(node))!.posts[0];assert.equal(post.text,'😆  example.com/story')
})

test('unrenderable and over-budget media keep their link instead of erasing the post',()=>{
 const short='https://t.co/unknown',raw={...source([{type:'video',url:short,media_url_https:'https://pbs.twimg.com/unknown/thumb.jpg'}]),details:{full_text:short,created_at_ms:1793664000000}}
 const fallback=normalizeTimeline(timeline(raw))!.posts[0];assert.equal(fallback.text,short);assert.equal(fallback.images,undefined)
 const links=Array.from({length:5},(_,n)=>'https://t.co/attach'+n),node={...source(links.map((url,n)=>({type:'photo',url,media_url_https:`https://pbs.twimg.com/media/item${n}.jpg`}))),details:{full_text:links.join(' '),created_at_ms:1793664000000}}
 const limited=normalizeTimeline(timeline(node))!.posts[0];assert.equal(limited.images?.length,4);assert.equal(limited.text,links[4])
 assert.equal(attachmentOnly({...p,text:'https://example.org/article'}),false);assert.equal(attachmentOnly({...p,text:'example.org/article'}),false)
})
test('automatic attachment dismissal and boundary gestures restore caption/alt page zero without reopening',async()=>{
 const page={tiles:[new Uint8Array(),new Uint8Array()] as [Uint8Array,Uint8Array],pixels:new Uint8ClampedArray()},selected={...p,text:'😆'},g=new Gallery(async()=>[page,page],()=>{}),a=new AttachmentSession(g)
 assert.equal(a.synchronize('a',selected,false),true);await new Promise(r=>setImmediate(r));assert.equal(g.open,true);assert.equal(a.automatic,true)
 assert.equal(a.input('next'),true);assert.equal(g.page,1);assert.equal(a.input('next'),true);assert.equal(g.open,false);assert.equal(a.synchronize('a',selected,false),false)
 assert.equal(a.input('next'),false,'Reader handles next only after full text is visible')
 assert.equal(a.synchronize('b',{...p,text:'Words to read.'},false),false)
 assert.equal(a.synchronize('a',selected,false),true);await new Promise(r=>setImmediate(r));assert.equal(a.input('previous'),true);assert.equal(g.open,false);assert.equal(a.synchronize('a',selected,false),false)
 a.show('a',selected.images);await new Promise(r=>setImmediate(r));assert.equal(a.automatic,false);a.input('previous');assert.equal(g.open,true);a.input('exit');assert.equal(g.open,false);assert.equal(a.synchronize('a',selected,false),false)
})
test('selection changes cancel late auto media; failed auto media retries only on an explicit new visit',async()=>{
 let release!:(v:never[])=>void,calls=0;const selected={...p,text:''},g=new Gallery(()=>{calls++;return new Promise(r=>release=r)},()=>{}),a=new AttachmentSession(g)
 assert.equal(a.synchronize('a',selected,true),false);assert.equal(a.synchronize('a',selected,false),true);assert.equal(a.synchronize('a',selected,false),false)
 assert.equal(a.synchronize('b',{...p,text:'Readable'},false),true);release([]);await new Promise(r=>setImmediate(r));assert.equal(g.open,false);assert.equal(calls,1)
 const failed=new Gallery(async()=>{throw Error('network')},()=>{}),session=new AttachmentSession(failed)
 session.synchronize('a',selected,false);await new Promise(r=>setImmediate(r));assert.match(failed.error,/unavailable/);session.input('next');assert.equal(failed.open,false);assert.equal(session.synchronize('a',selected,false),false)
})

test('pre-attachment cache projection is rejected; current cache retains still kind and readable descriptions',()=>{
 const state=freshState();mergeBatch(state,{mode:'live',scope:'a'.repeat(32),cursor:null,posts:[{...p,images:[{...image,kind:'video-still'}]}]},false)
 const raw=snapshot('for-you',{'for-you':state,following:freshState()}),legacy=JSON.stringify({...JSON.parse(raw),version:2})
 assert.equal(restore(legacy,'live','a'.repeat(32)),null)
 const current=restore(raw,'live','a'.repeat(32))!;assert.equal(current.version,3);assert.equal(current.feeds['for-you'].posts[0].images?.[0].kind,'video-still');assert.match(postText(current.feeds['for-you'].posts[0]),/An accessible description/)
})
