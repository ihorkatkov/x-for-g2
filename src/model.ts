import { measureTextWrap } from '@evenrealities/pretext'
export type Feed = 'for-you' | 'following'
export type Mode = 'demo' | 'live'
export type Quote = {author:string;handle:string;text:string}
export type Photo={url:string;alt:string;kind?:'video-still'|'gif-still'}
export type Post = Quote & {id:string;createdAt:string;url:string;quote?:Quote;repostedBy?:string;repostedByHandle?:string;images?:Photo[]}
export type Batch = {posts:Post[];cursor:string|null;mode:Mode;scope?:string}
export type FeedState = {posts:Post[];index:number;page:number;cursor:string|null;arrivals:number;mode:Mode|null;updatedAt:number;scope:string|null;pending:Post[];headCursor:string|null}
export const freshState = ():FeedState => ({posts:[],index:0,page:0,cursor:null,arrivals:0,mode:null,updatedAt:0,scope:null,pending:[],headCursor:null})
export const validScope = (v:unknown):v is string => typeof v==='string' && /^(?:demo-v1|[a-f0-9]{32})$/.test(v)
export const currentPost = (s:FeedState) => s.posts[s.index]
export const postText = (p:Post) => `${p.text}${p.images?.some(i=>i.alt)?'\n\n'+p.images.map((i,n)=>i.alt?`Image ${n+1} description: ${i.alt}`:'').filter(Boolean).join('\n\n'):''}${p.quote ? `\n\nQuoted: ${p.quote.author} @${p.quote.handle}\n${p.quote.text}` : ''}`

/** Measure actual native glyphs, also leaving room beneath the seven body rows.
 * Byte bound protects hosts with older byte-based text limits. No words are lost. */
export function paginate(source:string):string[] {
  let rest=source.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g,'').trim()
  const pages:string[]=[]
  while(rest) {
    const chars=Array.from(rest);let low=1,high=Math.min(chars.length,900),take=1
    while(low<=high) {
      const mid=Math.floor((low+high)/2), candidate=chars.slice(0,mid).join('')
      if(measureTextWrap(candidate,536).lineCount<=7 && new TextEncoder().encode(candidate).length<=950){take=mid;low=mid+1}else high=mid-1
    }
    let page=chars.slice(0,take).join('')
    if(take<chars.length && !/\s/.test(chars[take]) && !/\s$/.test(page)) {
      const space=Math.max(page.lastIndexOf(' '),page.lastIndexOf('\n'))
      if(space>page.length/2) page=page.slice(0,space)
    }
    pages.push(page.trim());rest=rest.slice(page.length).trimStart()
  }
  return pages.length?pages:['[No text in this post]']
}
function record(v:unknown):Record<string,unknown> { if(!v || typeof v!=='object' || Array.isArray(v))throw Error('Invalid data');return v as Record<string,unknown> }
function text(v:unknown,max:number):string {if(typeof v!=='string'||v.length>max)throw Error('Invalid text');return v}
function quote(v:unknown):Quote { const p=record(v);return {author:text(p.author,200),handle:text(p.handle,100),text:text(p.text,32000)} }
function parsePost(v:unknown):Post {
  const p=record(v),id=text(p.id,40),url=text(p.url,300)
  if(!/^\d{1,40}$/.test(id)||!/^https:\/\/x\.com\/[A-Za-z0-9_]+\/status\/\d+$/.test(url))throw Error('Invalid post')
  if(p.repostedByHandle!==undefined&&(typeof p.repostedByHandle!=='string'||!/^[A-Za-z0-9_]{1,30}$/.test(p.repostedByHandle)))throw Error('Invalid repost attribution')
  let images:Photo[]|undefined
  if(p.images!==undefined){
    if(!Array.isArray(p.images)||p.images.length>4)throw Error('Invalid images')
    images=p.images.map(v=>{const i=record(v),url=text(i.url,800);if(!/^(?:\/api\/image\/[A-Za-z0-9_-]{20,667}\.[A-Za-z0-9_-]{43}|\/demo-earthrise\.jpg)$/.test(url))throw Error('Invalid image');if(i.kind!==undefined&&i.kind!=='video-still'&&i.kind!=='gif-still')throw Error('Invalid image kind');return {url,alt:text(i.alt,2000),...(i.kind?{kind:i.kind as Photo['kind']}:{})}})
  }
  return {...(images?.length?{images}:{}),...quote(p),id,url,createdAt:text(p.createdAt,100),...(p.quote?{quote:quote(p.quote)}:{}),...(p.repostedBy?{repostedBy:text(p.repostedBy,200)}:{}),...(p.repostedByHandle?{repostedByHandle:p.repostedByHandle as string}:{})}
}
export function parseBatch(v:unknown,maxPosts=30):Batch {
  const b=record(v)
  if(b.mode!=='demo'&&b.mode!=='live')throw Error('Invalid feed mode')
  if(!Array.isArray(b.posts)||b.posts.length>maxPosts)throw Error('Invalid posts')
  if(b.scope!==undefined&&b.scope!==null&&!validScope(b.scope))throw Error('Invalid session scope')
  if(b.cursor!==null && (typeof b.cursor!=='string'||b.cursor.length>2048||/[\x00-\x20]/.test(b.cursor)))throw Error('Invalid cursor')
  return {posts:b.posts.map(parsePost),mode:b.mode,cursor:b.cursor,...(validScope(b.scope)?{scope:b.scope}:{})}
}
/** Refresh never replaces a post being read, even if upstream edits it. */
export function mergeBatch(s:FeedState,b:Batch,append:boolean) {
  if(s.mode && s.mode!==b.mode || b.scope&&s.scope&&s.scope!==b.scope)Object.assign(s,freshState())
  const selected=currentPost(s), previousTail=s.posts.at(-1)?.id, previousCursor=s.cursor, existing=new Map(s.posts.map(p=>[p.id,p]))
  const incoming=b.posts.filter((p,i,a)=>a.findIndex(q=>q.id===p.id)===i)
  // Keep repost context when an already-cached original appears again as a
  // repost, without replacing the text/page the user is currently reading.
  for(const p of incoming){const old=existing.get(p.id);if(old&&p.repostedBy){old.repostedBy=p.repostedBy;old.repostedByHandle=p.repostedByHandle;}}
  const additions=incoming.filter(p=>!existing.has(p.id))
  // New arrivals wait separately. Refresh must not evict the unread tail or
  // replace its pagination cursor with the refreshed head's cursor.
  if(!append&&selected){
    const seen=new Set<string>()
    s.pending=[...additions,...s.pending].filter(p=>{if(existing.has(p.id)||seen.has(p.id))return false;seen.add(p.id);return true}).slice(0,30)
    s.arrivals=s.pending.length;s.headCursor=b.cursor;
    // After expiry/restart there is no usable tail cursor. Resume from a fresh
    // head cursor; overlap is deduplicated until paging reaches older content.
    if(!s.cursor)s.cursor=b.cursor
    s.mode=b.mode;s.scope=b.scope??s.scope;s.updatedAt=Date.now();return
  }
  let merged=append?[...s.posts,...additions]:incoming
  const selectedIndex=selected?merged.findIndex(p=>p.id===selected.id):0
  // Keep at most 60 in memory, preserving the reading and the end of appended pages.
  const start=append?Math.min(Math.max(0,merged.length-60),selectedIndex):0
  merged=merged.slice(start,start+60)
  if(selected&&!merged.some(p=>p.id===selected.id))merged[merged.length-1]=selected
  s.posts=merged;s.index=selected?Math.max(0,merged.findIndex(p=>p.id===selected.id)):0
  if(!selected)s.page=0
  s.cursor=!append&&previousCursor&&merged.at(-1)?.id===previousTail?previousCursor:b.cursor;s.mode=b.mode;s.scope=b.scope??s.scope;s.updatedAt=Date.now()
}
export function jumpToNewest(s:FeedState){
  if(s.pending.length){const tail=s.posts.at(-1)?.id;const ids=new Set(s.pending.map(p=>p.id));s.posts=[...s.pending,...s.posts.filter(p=>!ids.has(p.id))].slice(0,60);if(s.posts.at(-1)?.id!==tail)s.cursor=s.headCursor}
  s.pending=[];s.headCursor=null;s.arrivals=0;s.index=0;s.page=0
}
export type Saved = {version:3;feed:Feed;feeds:Record<Feed,FeedState>}
export function snapshot(feed:Feed,feeds:Record<Feed,FeedState>):string {
  const saved:Saved={version:3,feed,feeds:structuredClone(feeds)}
  // Cache at most 180k characters total, never discard the currently read post.
  for(const s of Object.values(saved.feeds)) {
    s.arrivals=0;s.cursor=null;s.pending=[];s.headCursor=null
  }
  while(JSON.stringify(saved).length>180000) {
    const candidates=Object.values(saved.feeds).filter(s=>s.posts.length>1).sort((a,b)=>b.posts.length-a.posts.length)
    const s=candidates[0];if(!s)break
    if(s.index>0){s.posts.shift();s.index--}else s.posts.pop()
  }
  return JSON.stringify(saved)
}
export function restore(raw:string,mode:Mode,scope?:string):Saved|null {
  if(raw.length>180000)return null
  try {
    const v=record(JSON.parse(raw));if(v.version!==3||(v.feed!=='for-you'&&v.feed!=='following'))return null
    const feeds=record(v.feeds),result:Record<Feed,FeedState>={'for-you':freshState(),following:freshState()}
    for(const key of ['for-you','following'] as const) {
      const s=record(feeds[key]);if(s.mode===null && Array.isArray(s.posts)&&s.posts.length===0)continue
      if(s.mode!==mode || scope&&s.scope!==scope)return null
      const b=parseBatch({...s,posts:s.posts},60);const index=s.index,page=s.page
      if(!Number.isInteger(index)||typeof index!=='number'||index<0||index>=Math.max(1,b.posts.length)||!Number.isInteger(page)||typeof page!=='number'||page<0||page>3000||typeof s.updatedAt!=='number'||!Number.isFinite(s.updatedAt))return null
      result[key]={...freshState(),...b,index,page:b.posts[index]?Math.min(page,paginate(postText(b.posts[index])).length-1):0,updatedAt:s.updatedAt}
    }
    return {version:3,feed:v.feed,feeds:result}
  }catch{return null}
}
export type Action = 'next-post'|'previous-post'|'bookmark'|'next'|'previous'|'exit'|'refresh'|Feed|'newest'|'more'|'persist'|'resume'|'dispose'|'image'|'text'
export function eventAction(event:{sysEvent?:{eventType?:number};textEvent?:{eventType?:number};menuItemClickEvent?:{itemID?:number};audioEvent?:unknown}):Action|null {
  const sys=event.sysEvent?event.sysEvent.eventType??0:null, txt=event.textEvent?event.textEvent.eventType??0:null
  if(sys===6||sys===7)return 'dispose'
  if(sys===3||txt===3)return 'exit'
  const menu:Record<number,Action>={1:'refresh',2:'for-you',3:'following',4:'newest',5:'more',6:'image',7:'text',8:'next-post',9:'previous-post',10:'bookmark'}
  if(event.menuItemClickEvent)return menu[event.menuItemClickEvent.itemID??0]??null
  if(txt===1)return 'previous'
  if(txt===2||sys===0||txt===0)return 'next'
  return sys===4?'resume':sys===5?'persist':null
}
