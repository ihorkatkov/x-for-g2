import {pxTruncate,getTextWidth} from '@evenrealities/pretext'
import {currentPost,type FeedState,type Feed} from './model.ts'
export class SerialHost {
 private tail:Promise<unknown>=Promise.resolve()
 run<T>(work:()=>Promise<T>):Promise<T> { const next=this.tail.then(work);this.tail=next.catch(()=>{});return next }
}
/** Coalesce intermediate states without releasing serialization on a slow host.
 * Rejections are reported and a later update retries; no Promise.race unlock. */
export class LatestRender<T> {
 private latest:T|undefined
 private running=false
 constructor(private queue:SerialHost,private send:(value:T)=>Promise<void>,private failed:()=>void){}
 request(value:T){this.latest=value;if(!this.running)void this.drain()}
 private async drain(){
  this.running=true
  while(this.latest!==undefined){const value=this.latest;this.latest=undefined;try{await this.queue.run(()=>this.send(value))}catch{this.failed()}}
  this.running=false
 }
}
import type {PhotoFrame} from './photo.ts'
export type Display={photo?:PhotoFrame;header:string;author:string;body:string;pager:string}
export function pageCounter(page:number,total:number){const text=`${page}/${total}`;return ' '.repeat(Math.max(0,Math.floor((86-getTextWidth(text))/getTextWidth(' '))))+text}
export function headerText(base:string,who?:string){
 return who?`${pxTruncate(base,250)} / ${pxTruncate('via '+who,112)}`:pxTruncate(base,390)
}
/** Keep the current feed/image identity and its state tokens when adding feedback. */
export function bookmarkHeader(header:string,status:string){
 const [identity,...tokens]=header.split(' / ');
 return pxTruncate([identity,status,...tokens].join(' / '),390);
}
export function display(feed:Feed,s:FeedState,pages:string[],busy:boolean,message:string):Display {
 const post=currentPost(s),page=Math.min(s.page,pages.length-1),name=feed==='for-you'?'For You':'Following'
 return {
  header:headerText(`${name}${s.mode==='demo'?' / DEMO':''}${busy?' / Loading':message?' / ! Retry':s.arrivals?` / +${s.arrivals} new`:''}${post?.images?.length?' / Photo':''}`,post?.repostedBy?(post.repostedByHandle?'@'+post.repostedByHandle:post.repostedBy):undefined),
  author:pxTruncate(post?`${post.author}  @${post.handle}`:'Your quiet text reader',536),
  body:post?pages[page]:'',
  pager:post?pageCounter(page+1,pages.length):'',
 }
}
export const geometry=[
 {containerID:1,containerName:'header',xPosition:60,yPosition:8,width:390,height:28,isEventCapture:0,textColor:2,zOrderIndex:3},
 {containerID:2,containerName:'author',xPosition:20,yPosition:39,width:536,height:28,isEventCapture:0,textColor:3,zOrderIndex:4},
 {containerID:3,containerName:'body',xPosition:20,yPosition:76,width:536,height:200,isEventCapture:1,textColor:4,zOrderIndex:5},
 {containerID:4,containerName:'pager',xPosition:470,yPosition:8,width:86,height:28,isEventCapture:0,textColor:2,zOrderIndex:6}
] as const
export const menuItems=[{itemID:1,itemName:'Refresh'},{itemID:2,itemName:'Read For You'},{itemID:3,itemName:'Read Following'},{itemID:4,itemName:'Jump to newest'},{itemID:5,itemName:'Load more at end'},{itemID:6,itemName:'View post images'},{itemID:7,itemName:'Back to post text'},{itemID:8,itemName:'Next post'},{itemID:9,itemName:'Previous post'},{itemID:10,itemName:'Bookmark post'}]
