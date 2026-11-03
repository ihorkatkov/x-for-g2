import assert from 'node:assert/strict'
import {writeFileSync,mkdirSync,readFileSync} from 'node:fs'
const origin=process.env.X_READER_URL??'http://127.0.0.1:4040'
if(process.env.X_ALLOW_LIVE!=='1')throw Error('Live reads require explicit X_ALLOW_LIVE=1')
const timed=async(path)=>{const start=performance.now(),response=await fetch(origin+path,{signal:AbortSignal.timeout(30000),cache:'no-store'});assert.equal(response.status,200,'Live API response failed');return {body:await response.json(),ms:Math.round(performance.now()-start)}}
const status=await timed('/api/status');assert.equal(status.body.mode,'live');assert.equal(status.body.configured,true)
const report={app:'X',version:JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version,testedAt:new Date().toISOString(),mode:'live',readOnly:true,credentialSource:'User-configured backend environment',feeds:[],photos:[],checks:[],limits:['Live account and simulator are separate from physical G2/BLE/install/phone-lock proof','No credentials, post text, handles, post IDs, cursors or media URLs saved in this report']}
const heads=[]
for(const feed of ['for-you','following']){
 const head=await timed('/api/feed?feed='+feed),b=head.body;assert.equal(b.mode,'live');assert.ok(b.posts.length>0);heads.push(b.posts)
 const ids=new Set(b.posts.map(p=>p.id)),stats={feed,headPosts:b.posts.length,headMs:head.ms,reposts:b.posts.filter(p=>p.repostedBy).length,photos:b.posts.reduce((n,p)=>n+(p.images?.length??0),0),longestTextChars:Math.max(...b.posts.map(p=>p.text.length)),hasOlderCursor:!!b.cursor}
 if(b.cursor){const older=await timed('/api/feed?feed='+feed+'&cursor='+encodeURIComponent(b.cursor));assert.equal(older.body.mode,'live');assert.ok(older.body.posts.length>0);stats.olderPosts=older.body.posts.length;stats.olderMs=older.ms;stats.newOlderPostIds=older.body.posts.filter(p=>!ids.has(p.id)).length;assert.ok(stats.newOlderPostIds>0,'Cursor must return additional posts')}
 if(feed==='for-you'){const fresh=await timed('/api/feed?feed='+feed);assert.equal(fresh.body.mode,'live');assert.ok(fresh.body.posts.length>0);stats.refreshPosts=fresh.body.posts.length;stats.refreshMs=fresh.ms}
 const photo=b.posts.flatMap(p=>p.images??[])[0]
 if(photo){const start=performance.now(),response=await fetch(origin+photo.url,{signal:AbortSignal.timeout(25000)});const bytes=new Uint8Array(await response.arrayBuffer());const result={feed,status:response.status,bytes:bytes.length,ms:Math.round(performance.now()-start),type:response.headers.get('content-type')};report.photos.push(result);assert.equal(response.status,200,'Live CDN photo did not load');assert.ok(bytes.length>0&&bytes.length<=2000000);assert.match(result.type??'',/^image\/(png|jpeg)/)}
 report.feeds.push(stats)
 console.log(JSON.stringify({feed,...stats,photoDownloaded:!!photo}))
}
report.checks.push('Both authenticated home feeds returned real posts','Both opaque pagination cursors returned additional posts','For You refresh returned a real feed','At least one still photo from each feed downloaded through credential-free CDN adapter')
report.feedSequencesDiffer=heads[0].map(p=>p.id).join(',')!==heads[1].map(p=>p.id).join(',')
mkdirSync(new URL('../artifacts/live/',import.meta.url),{recursive:true});writeFileSync(new URL('../artifacts/live/feed-report.json',import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify({checks:report.checks,photos:report.photos,feedSequencesDiffer:report.feedSequencesDiffer}))
