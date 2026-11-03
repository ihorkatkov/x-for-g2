import {boundedText} from './bytes.ts'
import {BackendError} from './errors.ts'
export type Operation='HomeTimeline'|'HomeLatestTimeline'|'CreateBookmark'
export type Query={id:string;name:string;format:'legacy'|'relay';providers:Record<string,boolean>}
export type Queries=Partial<Record<Operation,Query>>
const providerValues:Record<string,boolean>={
 __relay_internal__pv__xclientsfeaturesappviewerisloggedinrelayprovider:true,
 __relay_internal__pv__xclientsfeaturestranslationgroktranslatedpostenabledrelayprovider:false,
 __relay_internal__pv__xclientsfeaturestweetcomponentsgrokanalyzepostrelayprovider:false,
 __relay_internal__pv__xclientsfeaturestranslationnoteautotranslationenabledrelayprovider:false,
 __relay_internal__pv__liveeventpostcontextenabledrelayprovider:false,
 __relay_internal__pv__sportspostcontextenabledrelayprovider:false
}
export const relayProviders=()=>({...providerValues})
const assetPattern=/^https:\/\/abs\.twimg\.com\/(?:x-web\/x-web\/(?:assets\/)?[A-Za-z0-9_.-]+|responsive-web\/client-web(?:-legacy)?\/[A-Za-z0-9_.-]+)\.js$/
const wanted=/(?:entry-client-|startup(?:-dynamic)?-|for-you-preload-|following-preload-|view-count-|actions-bar-)/
export function parseQueries(js:string):Queries {
 const result:Queries={}
 for(const match of js.matchAll(/queryId\s*:\s*["'`]([A-Za-z0-9_-]{1,100})["'`]\s*,\s*operationName\s*:\s*["'`](HomeTimeline|HomeLatestTimeline|CreateBookmark)["'`]/g)){
  const name=match[2] as Operation;result[name]={id:match[1],name,format:'legacy',providers:{}}
 }
 for(const match of js.matchAll(/operationName\s*:\s*["'`](HomeTimeline|HomeLatestTimeline|CreateBookmark)["'`]\s*,\s*queryId\s*:\s*["'`]([A-Za-z0-9_-]{1,100})["'`]/g)){
  const name=match[1] as Operation;result[name]={id:match[2],name,format:'legacy',providers:{}}
 }
 for(const match of js.matchAll(/params\s*:\s*\{id\s*:\s*["'`]([A-Za-z0-9_-]{1,100})["'`],metadata\s*:\s*\{[^{}]*\},name\s*:\s*["'`](HomeTimelineQuery|HomeLatestTimelineQuery|bookmarkStateAddMutation)["'`],operationKind\s*:\s*["'`](query|mutation)["'`]/g)){
  if(match[3]!== (match[2]==='bookmarkStateAddMutation'?'mutation':'query'))continue
  // Only inspect this operation's bounded params object, never evaluate JS.
  const start=match.index!+match[0].length,tail=js.slice(start,start+2500),provided=tail.match(/providedVariables:\{([^{}]*)\}/)?.[1]??''
  const providers:Record<string,boolean>={}
  for(const name of provided.match(/__relay_internal__pv__[A-Za-z0-9_]+(?=\s*:)/g)??[]){
   if(!Object.hasOwn(providerValues,name))throw new BackendError('upstream_changed')
   providers[name]=providerValues[name]
  }
  const name=match[2]==='bookmarkStateAddMutation'?'CreateBookmark':match[2].replace(/Query$/,'') as Operation
  result[name]={id:match[1],name:match[2],format:'relay',providers}
 }
 return result
}
/** Public, credential-free query discovery. Follows only selected fixed-CDN
 * startup/preload imports; max 16 requests / 16 MB total / 5 MB per JS asset.
 * No script execution, generic crawler, guessed IDs or authenticated discovery. */
export async function discoverQueries(get:(url:string,signal:AbortSignal)=>Promise<Response>,signal:AbortSignal,required:Operation[]=['HomeTimeline','HomeLatestTimeline']):Promise<Queries>{
 const page=await get('https://x.com/?lang=en',signal)
 if(!page.ok){await page.body?.cancel();throw new BackendError('upstream_changed')}
 const html=await boundedText(page,2_000_000),queue:string[]=[],visited=new Set<string>(),result:Queries={}
 let bytes=Buffer.byteLength(html)
 function enqueue(url:string){if(assetPattern.test(url)&&!visited.has(url)&&!queue.includes(url)&&queue.length<24)queue.push(url)}
 for(const url of html.match(/https:\/\/abs\.twimg\.com\/(?:x-web\/x-web\/(?:assets\/)?|responsive-web\/client-web(?:-legacy)?\/)[A-Za-z0-9_.-]+\.js/g)??[])enqueue(url)
 while(queue.length&&visited.size<15){
  queue.sort((a,b)=>priority(a)-priority(b))
  const url=queue.shift()!;visited.add(url)
  const response=await get(url,signal)
  if(!response.ok){await response.body?.cancel();continue}
  // Some public hosts omit content type; reject an explicit HTML interstitial.
  if(response.headers.get('content-type')?.includes('text/html')){await response.body?.cancel();continue}
  const js=await boundedText(response,Math.min(5_000_000,16_000_000-bytes));bytes+=Buffer.byteLength(js)
  Object.assign(result,parseQueries(js));if(required.every(name=>result[name]))return result
  for(const match of js.matchAll(/["'`]((?:\.\/)?(?:assets\/)?[A-Za-z0-9_.-]+\.js)["'`]/g)){
   if(!wanted.test(match[1]))continue
   // Vite mapDeps paths start at the x-web root; ES imports use current folder.
   const base=match[1].startsWith('assets/')?'https://abs.twimg.com/x-web/x-web/':url
   enqueue(new URL(match[1],base).href)
  }
 }
 throw new BackendError('upstream_changed')
}
function priority(url:string){return /(?:for-you|following)-preload/.test(url)?0:/startup-dynamic/.test(url)?1:/entry-client/.test(url)?2:3}
