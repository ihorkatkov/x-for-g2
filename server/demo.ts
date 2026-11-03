import {stat,readFile} from 'node:fs/promises'
import {BackendError} from './errors.ts'
import {normalizeTimeline,obj} from './normalize.ts'
import type {Feed} from './transport.ts'
/** Explicit demo workflow only. Trusted local path, bounded fixture JSON; no
 * network, credentials or fallback. Refresh reveals a prewritten sample page. */
export class DemoTimeline {
 private refreshed=new Set<Feed>()
 async feed(path:string,feed:Feed,cursor?:string){
  if((await stat(path)).size>2_000_000)throw new BackendError('internal',500)
  const data:unknown=JSON.parse(await readFile(path,'utf8')),root=obj(data)
  let source=data,next:string|null=null
  if(root.schema==='reed.demo.v1'){
   if(!Array.isArray(root.pages)||!root.pages.length||root.pages.length>10)throw new BackendError('internal',500)
   const page=cursor&&/^demo:[0-9]$/.test(cursor)?Number(cursor.slice(5)):0
   if(page>=root.pages.length)throw new BackendError('cursor_expired',410)
   source=page===0&&this.refreshed.has(feed)&&root.refresh?root.refresh:root.pages[page]
   if(!cursor)this.refreshed.add(feed)
   if(page+1<root.pages.length)next=`demo:${page+1}`
  }
  const result=normalizeTimeline(source)
  if(!result)throw new BackendError('internal',500)
  result.cursor=next
  if(feed==='following')result.posts.sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt))
  return result
 }
}
