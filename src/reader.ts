import {freshState,currentPost,mergeBatch,jumpToNewest,paginate,postText,type Batch,type Feed,type FeedState} from './model.ts'
import {FeedError} from './api.ts'
export type FetchFeed=(feed:Feed,cursor:string|null,signal:AbortSignal)=>Promise<Batch>
/** Owns feed browsing and network workflows. Trusted parsed batches enter here;
 * no bridge or persistence side effects. A per-feed lock prevents cursor races.
 * Views subscribe to changes; the adapter owns transport and SDK persistence. */
export class Reader {
 feed:Feed='for-you'
 feeds:Record<Feed,FeedState>={'for-you':freshState(),following:freshState()}
 errors:Record<Feed,string>={'for-you':'',following:''}
 retryAt=0
 private pending=new Map<Feed,AbortController>()
 private alive=true
 private pageCache=new WeakMap<object,string[]>()
 constructor(private fetchFeed:FetchFeed,private changed:()=>void){}
 get state(){return this.feeds[this.feed]}
 get busy(){return this.pending.has(this.feed)}
 get coolingDown(){return Date.now()<this.retryAt}
 get message(){return this.errors[this.feed]}
 get pages(){
  const p=currentPost(this.state);if(!p)return ['Connect your private X server to read.']
  let pages=this.pageCache.get(p);if(!pages){pages=paginate(postText(p));this.pageCache.set(p,pages)}return pages
 }
 get atEnd(){return !this.state.posts.length || this.state.index===this.state.posts.length-1 && this.state.page>=this.pages.length-1}
 notify(){if(this.alive)this.changed()}
 select(feed:Feed){this.feed=feed;this.notify();if(!this.state.posts.length)void this.refresh()}
 async refresh(){await this.fetch(false)}
 async more(){if(this.atEnd && this.state.cursor)await this.fetch(true)}
 private async fetch(append:boolean) {
  const feed=this.feed
  if(!this.alive||this.pending.has(feed)||this.coolingDown)return
  const abort=new AbortController();this.pending.set(feed,abort);this.errors[feed]='';this.notify()
  try {
   const batch=await this.fetchFeed(feed,append?this.feeds[feed].cursor:null,abort.signal)
   if(!this.alive||abort.signal.aborted)return
   if(batch.scope&&Object.values(this.feeds).some(s=>s.scope&&s.scope!==batch.scope)){
    for(const [other,pending] of this.pending)if(other!==feed){pending.abort();this.pending.delete(other)}
    this.feeds={'for-you':freshState(),following:freshState()};this.errors={'for-you':'',following:''}
   }
   const s=this.feeds[feed]
   mergeBatch(s,batch,append);s.page=Math.min(s.page,Math.max(0,paginate(currentPost(s)?postText(currentPost(s)!):'').length-1))
   if(!s.posts.length)this.errors[feed]='No original text posts in this page. Refresh or load more.'
  }catch(error){if(this.alive&&!abort.signal.aborted){
   this.errors[feed]=error instanceof Error?error.message:'Connection unavailable'
   if(error instanceof FeedError){if(error.code==='cursor_expired'){this.feeds[feed].cursor=null;this.feeds[feed].headCursor=null}if(error.retryAfter)this.retryAt=Date.now()+error.retryAfter*1000}
  }}
  finally {if(this.pending.get(feed)===abort)this.pending.delete(feed);this.notify()}
 }
 next(){
  const s=this.state
  if(s.page<this.pages.length-1)s.page++
  else if(s.index<s.posts.length-1){s.index++;s.page=0}
  else if(s.cursor){void this.more();return}
  this.notify()
 }
 previous(){const s=this.state;if(s.page>0)s.page--;else if(s.index>0){s.index--;s.page=this.pages.length-1}this.notify()}
 newest(){jumpToNewest(this.state);this.notify()}
 clear(){for(const a of this.pending.values())a.abort();this.pending.clear();this.feeds={'for-you':freshState(),following:freshState()};this.errors={'for-you':'',following:''};this.notify()}
 dispose(){this.alive=false;for(const a of this.pending.values())a.abort();this.pending.clear()}
}
