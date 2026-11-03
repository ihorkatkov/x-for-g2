import './sdk-logging.ts'
import './style.css'
import {waitForEvenAppBridge,TextContainerProperty,CreateStartUpPageContainer,TextContainerUpgrade,MenuContainerProperty,MenuItemProperty,ImageContainerProperty,ImageRawDataUpdate,DeviceConnectType,type EvenAppBridge} from '@evenrealities/even_hub_sdk'
import {Diagnostics} from './telemetry.ts'
import {BookmarkAction} from './bookmark.ts'
import {Reader} from './reader.ts'
import {serviceURL,authHeaders,restoreClientAuth,acceptClientAuth,serializedClientAuth} from './service.ts'
import {feedError} from './api.ts'
import {parseBatch,restore,snapshot,currentPost,eventAction,postText,validScope,type Action,type Mode} from './model.ts'
import {Gallery,loadPhoto,blankTile,attachmentOnly,AttachmentSession} from './photo.ts'
import {markBytes} from './mark.ts'
import {SerialHost,LatestRender,pageCounter,headerText,bookmarkHeader,display,geometry,menuItems,type Display} from './host.ts'

const diagnostics=new Diagnostics('reed-g2','0.3.4','0.0.16',200)
diagnostics.record('session.start')
const el=<T extends HTMLElement=HTMLElement>(id:string)=>{const node=document.getElementById(id);if(!node)throw Error('Missing UI element');return node as T}
const queue=new SerialHost()
let bridge:EvenAppBridge|undefined,ready=false,alive=true,mode:Mode|null=null,configured=false,storageTimer:ReturnType<typeof setTimeout>|undefined
let needsPairing=false,pairBusy=false
let cacheWarning='',backendWarning='',bridgeLabel='Phone preview · waiting for glasses bridge',cacheEnabled=true
let lastDisplay:Partial<Display>={}
let retryTimer:ReturnType<typeof setTimeout>|undefined
let interactionRevision=0
let sessionScope:string|undefined
const unsubscribers:Array<()=>void>=[]
const cacheKey='reed.reader.v3'
let renderRetryTimer:ReturnType<typeof setTimeout>|undefined,renderRetried=false
let imageVisible=false,lastImageKey=''
const selectedKey=()=>`${reader.feed}:${reader.state.scope}:${currentPost(reader.state)?.id}`
const clearImage=blankTile()
const gallery=new Gallery(loadPhoto,()=>render())
const attachments=new AttachmentSession(gallery)
const bookmarks=new BookmarkAction(async(id,scope,expectedMode)=>{
 let response:Response;
 try{response=await fetch(serviceURL('/api/bookmark'),{method:'POST',headers:{...authHeaders(),'Content-Type':'application/json'},body:JSON.stringify({id,scope}),signal:AbortSignal.timeout(25000),credentials:'same-origin'})}catch{throw Error('Check X bookmarks')}
 if(!response.ok){let payload:unknown;try{payload=await jsonResponse(response,2000)}catch{}throw feedError(response.status,payload,response.headers.get('retry-after'))}
 let result:{saved?:unknown;mode?:unknown;scope?:unknown};try{result=await jsonResponse(response,2000) as typeof result}catch{throw Error('Check X bookmarks')}
 if(result.saved!==true||result.mode!==expectedMode||result.scope!==scope)throw Error('Check X bookmarks');
},()=>render())
function bookmarkStatus(){const p=currentPost(reader.state);return p&&reader.state.scope?bookmarks.status(p.id,reader.state.scope):{saved:false,message:''}}
function withBookmarkStatus(frame:Display){const status=bookmarkStatus().message;if(status)frame.header=bookmarkHeader(frame.header,status);return frame}
function view(){
 const frame=display(reader.feed,reader.state,reader.pages,reader.busy,reader.message)
 if(needsPairing&&!currentPost(reader.state)){frame.header='Pair phone';frame.author='Connect X in the phone app'}
 if(!gallery.open)return withBookmarkStatus(frame)
 const post=currentPost(reader.state),kind=gallery.frame?.page.kind??post?.images?.[0]?.kind,imageName=kind==='video-still'?'Video still':kind==='gif-still'?'GIF still':'Image'
 frame.header=headerText(`${imageName}${gallery.frame?.page.photoCount&&gallery.frame.page.photoCount>1?' '+gallery.frame.page.photoNumber+'/'+gallery.frame.page.photoCount:''}${reader.state.mode==='demo'?' / DEMO':''}${gallery.loading?' / Loading':gallery.error?(gallery.pages.length?' / ! Partial':' / ! Unavailable'):''}`,post?.repostedBy?(post.repostedByHandle?'@'+post.repostedByHandle:post.repostedBy):undefined)
 frame.pager=gallery.pages.length?pageCounter(gallery.page+1,gallery.pages.length):'';frame.body=''
 frame.photo=gallery.frame
 return withBookmarkStatus(frame)
}
async function imageTiles(tiles:[Uint8Array,Uint8Array]){
 for(let i=0;i<2;i++){
  const result=await bridge!.updateImageRawData(new ImageRawDataUpdate({containerID:6+i,containerName:'photo'+i,imageData:tiles[i]}))
  if(result!=='success')throw Error('Image rejected')
 }
}
const renderer=new LatestRender<Display>(queue,async frame=>{
 if(!bridge||!ready||!alive)return
 const start=performance.now();let writes=0,imageBytes=0,imageTilesCount=0
 // Clear both images before restoring text, including after a partial failed send.
 if(imageVisible&&!frame.photo){await imageTiles([clearImage,clearImage]);imageVisible=false;lastImageKey='';imageTilesCount=2;imageBytes=clearImage.length*2}
 for(const g of geometry){const key=g.containerName;if(frame[key]===lastDisplay[key])continue
  if(!await bridge.textContainerUpgrade(new TextContainerUpgrade({containerID:g.containerID,containerName:key,content:frame[key],contentOffset:0,contentLength:0})))throw Error('Host update rejected')
  lastDisplay[key]=frame[key];writes++
 }
 if(frame.photo&&frame.photo.key!==lastImageKey){
  imageVisible=true;await imageTiles(frame.photo.page.tiles);lastImageKey=frame.photo.key
  imageTilesCount=2;imageBytes=frame.photo.page.tiles.reduce((n,b)=>n+b.length,0)
 }
 renderRetried=false
 diagnostics.record('render',{hostMs:performance.now()-start,writes,bodyChars:frame.body.length,imageBytes,imageTiles:imageTilesCount})
 if(imageTilesCount)console.info('X_IMAGE '+JSON.stringify({tiles:imageTilesCount,bytes:imageBytes,hostMs:Math.round(performance.now()-start),visible:!!frame.photo}))
},()=>{diagnostics.record('error',{host:true});bridgeLabel='Display update failed · reconnect and retry';if(gallery.open)gallery.close();else renderPhone();if(!renderRetried&&alive){renderRetried=true;renderRetryTimer=setTimeout(()=>{renderRetryTimer=undefined;if(alive&&ready)renderer.request(view())},350)}})

/** Same-origin read adapter. No X credentials, remote URLs or arbitrary server
 * errors enter the UI. Bytes are bounded before parsing, then validated. */
async function jsonResponse(response:Response,maxBytes=2200000):Promise<unknown>{
 const declared=Number(response.headers.get('content-length'))
 if(Number.isFinite(declared)&&declared>maxBytes)throw Error('Server response too large')
 if(!response.body)throw Error('Server returned no data')
 const stream=response.body.getReader(),chunks:Uint8Array[]=[];let size=0
 try{while(true){const {done,value}=await stream.read();if(done)break;size+=value.byteLength;if(size>maxBytes)throw Error('Server response too large');chunks.push(value)}}finally{await stream.cancel()}
 const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length}
 return JSON.parse(new TextDecoder().decode(bytes))
}
const reader=new Reader(async(feed,cursor,signal)=>{
 const started=performance.now(),params=new URLSearchParams({feed});if(cursor)params.set('cursor',cursor)
 let response:Response
 try {response=await fetch(serviceURL(`/api/feed?${params}`),{signal:AbortSignal.any([signal,AbortSignal.timeout(25000)]),credentials:'same-origin',headers:authHeaders(),cache:'no-store'})}
 catch{throw Error('Offline or timed out. Cached posts remain readable; refresh to retry.')}
 diagnostics.record('health',{fetchMs:performance.now()-started,httpStatus:response.status})
 if(!response.ok){
  let payload:unknown=null
  try{payload=await jsonResponse(response,2000)}catch{/* Fixed fallback below; never expose raw response text. */}
  if(payload&&typeof payload==='object'&&'error' in payload&&payload.error==='pairing_required'){needsPairing=true;renderPhone()}
  throw feedError(response.status,payload,response.headers.get('retry-after'))
 }
 const batch=parseBatch(await jsonResponse(response))
 if(!validScope(batch.scope))throw Error('Server session could not be verified. Refresh after restarting X.')
 sessionScope=batch.scope
 mode=batch.mode;configured=batch.mode==='live';backendWarning=''
 diagnostics.record('health',{posts:batch.posts.length,demo:batch.mode==='demo'})
 return batch
},()=>{render();scheduleStorage()})

function renderPhone(){
 const s=reader.state,p=currentPost(s),pages=reader.pages,frame=view()
 el('pairing').hidden=!needsPairing
 el<HTMLButtonElement>('pairConnect').disabled=pairBusy
 el('mode').textContent=needsPairing?'PAIR THIS PHONE':mode==='demo'?'DEMO · invented sample posts':mode==='live'?'LIVE X · private backend':'Backend unavailable'
 el('connection').textContent=bridgeLabel
 document.documentElement.dataset.reading=p?'true':'false'
 el('forYou').setAttribute('aria-pressed',String(reader.feed==='for-you'));el('following').setAttribute('aria-pressed',String(reader.feed==='following'))
 el<HTMLButtonElement>('refresh').disabled=reader.busy||reader.coolingDown
 if(retryTimer)clearTimeout(retryTimer)
 if(reader.coolingDown)retryTimer=setTimeout(()=>{retryTimer=undefined;renderPhone()},reader.retryAt-Date.now()+50)
 el('refresh').textContent=reader.busy?'Loading…':reader.coolingDown?'Waiting for rate limit':'Refresh feed'
 el('notice').textContent=backendWarning||(mode==='demo'?'Sample timeline · invented posts':configured?'Your place stays pinned when you refresh.':'Connect your X session in private server setup.')
 const warning=[reader.message,cacheWarning].filter(Boolean).join(' ')
 el('error').hidden=!warning;el('error').textContent=warning
 el('author').textContent=p?.author??'Your reading space';el('handle').textContent=p?`@${p.handle}`:''
 el('timestamp').textContent=p?.createdAt?new Date(p.createdAt).toLocaleString():''
 el('postText').textContent=p?(pages.length>1?pages[Math.min(s.page,pages.length-1)]:p.text):'No posts loaded. Refresh, switch feeds, or check setup below.'
 el('fullPost').hidden=!p||pages.length<2;el('originalText').textContent=p?postText(p):''
 el('repost').hidden=!p?.repostedBy;el('repost').textContent=p?.repostedBy?`Reposted by ${p.repostedBy}${p.repostedByHandle?` (@${p.repostedByHandle})`:''}`:''
 el('quote').hidden=!p?.quote||pages.length>1;el('quote').textContent=p?.quote?`${p.quote.author} · @${p.quote.handle}\n\n${p.quote.text}`:''
 const link=el<HTMLAnchorElement>('postLink');link.hidden=!p||s.mode==='demo';if(p)link.href=p.url
 el('position').textContent=p?`Post ${s.index+1} / ${s.posts.length} · Page ${Math.min(s.page,pages.length-1)+1} / ${pages.length}`:'No posts yet'
 el<HTMLButtonElement>('previous').disabled=!p||s.index===0&&s.page===0
 el<HTMLButtonElement>('next').disabled=reader.busy||!p||reader.atEnd&&(!s.cursor||reader.coolingDown)
 el<HTMLButtonElement>('nextPost').disabled=reader.busy||!p||s.index===s.posts.length-1&&(!s.cursor||reader.coolingDown)
 el<HTMLButtonElement>('previousPost').disabled=!p||s.index===0
 el<HTMLButtonElement>('bookmark').disabled=!p||!s.scope||needsPairing||bookmarks.busy||bookmarkStatus().saved
 el('bookmark').textContent=bookmarks.busy?'Saving…':bookmarkStatus().saved?'Bookmarked':s.mode==='demo'?'Bookmark demo post':'Bookmark on X'
 el('bookmarkStatus').textContent=bookmarkStatus().message
 el('bookmarkStatus').hidden=!bookmarkStatus().message
 el('more').hidden=!s.cursor||!reader.atEnd;el<HTMLButtonElement>('more').disabled=reader.busy||reader.coolingDown
 el('arrivals').hidden=!s.arrivals;el('arrivals').textContent=`${s.arrivals} new · Jump to newest`
 for(const key of ['header','author','body','pager'] as const)el(`lens${key[0].toUpperCase()+key.slice(1)}`).textContent=frame[key]
 el('viewImage').textContent=p?.images?.some(i=>i.kind)?'View attachment stills':'View images on glasses'
 el('viewImage').hidden=!p?.images?.length||gallery.open
 el('backText').hidden=!gallery.open
 el('imageStatus').hidden=!p?.images?.length
 el('imageStatus').textContent=gallery.open?(gallery.loading?'Preparing image…':gallery.error||`Image page ${gallery.page+1} / ${gallery.pages.length} · Swipe for detail; double-tap returns to text.`):p&&attachmentOnly(p)?'Attachment shown automatically. Video/GIF attachments show a still preview; descriptions remain readable text.':'Still images open separately. Image descriptions are included as readable text.'
 const photo=el<HTMLCanvasElement>('lensPhoto');photo.hidden=!frame.photo
 if(frame.photo){const ctx=photo.getContext('2d')!;const image=ctx.createImageData(536,144);image.data.set(frame.photo.page.pixels);ctx.putImageData(image,0,0)}
 el('previous').textContent=gallery.open&&attachments.automatic&&gallery.page===0?'← Read text':!gallery.open&&pages.length>1?(s.page>0?'← Previous page':'← Previous post'):'← Previous'
 el('next').textContent=gallery.open&&attachments.automatic&&gallery.page>=gallery.pages.length-1?'Read text →':!gallery.open&&pages.length>1?(s.page<pages.length-1?'Next page →':'Next post →'):'Next →'
 if(gallery.open){el<HTMLButtonElement>('previous').disabled=gallery.page===0&&!attachments.automatic;el<HTMLButtonElement>('next').disabled=gallery.page>=gallery.pages.length-1&&!attachments.automatic;el('position').textContent=gallery.loading?'Loading image…':`Image page ${gallery.page+1} / ${gallery.pages.length}`}
 el('cacheLabel').textContent=s.updatedAt?`Cached · ${new Date(s.updatedAt).toLocaleTimeString()}`:'No cache'
 el('setupStatus').textContent=`Backend: ${configured?'configured':mode==='demo'?'explicit demo':'not ready'}. Glasses: ${ready?'startup accepted by host':'not connected'}. ${cacheEnabled?'Host reading cache enabled.':'Host reading cache cleared; caching paused for this session.'}`
}
function render(){
 if(!alive)return
 if(attachments.synchronize(selectedKey(),currentPost(reader.state),reader.busy))return
 renderPhone()
 const state={hasVideoPreview:!!currentPost(reader.state)?.images?.some(i=>i.kind==='video-still'),autoEligible:!!currentPost(reader.state)&&attachmentOnly(currentPost(reader.state)!),autoImage:attachments.automatic&&gallery.open,videoStill:gallery.frame?.page.kind==='video-still',hasPhotos:!!currentPost(reader.state)?.images?.length,reposted:!!currentPost(reader.state)?.repostedBy,textPages:reader.pages.length,imageOpen:gallery.open,imagePage:gallery.page,imagePages:gallery.pages.length,imageLoading:gallery.loading,feed:reader.feed==='for-you'?0:1,index:reader.state.index,page:reader.state.page,count:reader.state.posts.length,bookmarkSaved:bookmarkStatus().saved,bookmarkBusy:bookmarks.busy,arrivals:reader.state.arrivals,busy:reader.busy,hasCursor:!!reader.state.cursor,demo:reader.state.mode==='demo'}
 diagnostics.record('screen',state)
 console.info('REED_STATE '+JSON.stringify(state))
 if(ready)renderer.request(view())
}
function scheduleStorage(){
 if(!ready||!cacheEnabled||!alive)return
 if(storageTimer)clearTimeout(storageTimer)
 storageTimer=setTimeout(()=>{storageTimer=undefined;void persist()},1200)
}
async function persist(){
 if(!bridge||!ready||!cacheEnabled)return
 try{await queue.run(async()=>{
  if(!bridge)return
  const saved=snapshot(reader.feed,reader.feeds)
  if(!await bridge.setLocalStorage(cacheKey,saved))throw Error('Storage rejected')
  if(!await bridge.setLocalStorage('reed.diagnostics.v1',JSON.stringify(diagnostics.export())))throw Error('Diagnostics storage rejected')
 });cacheWarning=''}catch{cacheWarning='Host storage failed. Current reading stays available in memory.';diagnostics.record('error',{storage:true});renderPhone()}
}
function act(action:Action){
 if(!alive)return
 diagnostics.record('input',{action:['next','previous','exit','refresh','for-you','following','newest','more','persist','resume','dispose','image','text','next-post','previous-post','bookmark'].indexOf(action)})
 renderRetried=false
 if(!['persist','resume'].includes(action))interactionRevision++
 if((action==='next'||action==='previous'||action==='exit')&&attachments.input(action))return
 if(gallery.open&&!['image','bookmark','next-post','previous-post','persist','resume'].includes(action))gallery.close()
 switch(action){
  case 'next-post':void reader.nextPost();break
  case 'previous-post':reader.previousPost();break
  case 'bookmark':{const p=currentPost(reader.state),scope=reader.state.scope,mode=reader.state.mode;if(p&&scope&&mode&&!needsPairing)void bookmarks.save(p.id,scope,mode);break}
  case 'image':{const p=currentPost(reader.state);if(p?.images)attachments.show(selectedKey(),p.images);break}
  case 'text':gallery.close();break
  case 'next':reader.next();break
  case 'previous':reader.previous();break
  case 'for-you':case 'following':reader.select(action);break
  case 'refresh':void reader.refresh();break
  case 'more':void reader.more();break
  case 'newest':reader.newest();break
  case 'exit':if(bridge&&ready)void queue.run(async()=>{if(!await bridge!.shutDownPageContainer(1))throw Error('Exit rejected')}).catch(()=>{bridgeLabel='Exit request failed; try again';renderPhone()});break
  case 'persist':void persist();break
  case 'resume':lastImageKey='';lastDisplay={};render();break
  case 'dispose':cleanup();break
 }
}
for(const [id,action] of Object.entries({forYou:'for-you',following:'following',refresh:'refresh',previous:'previous',next:'next',more:'more',arrivals:'newest',viewImage:'image',backText:'text',nextPost:'next-post',previousPost:'previous-post',bookmark:'bookmark'}))el(id).addEventListener('click',()=>act(action as Action))
el('pairForm').addEventListener('submit',event=>{event.preventDefault();if(pairBusy)return;pairBusy=true;renderPhone();void(async()=>{
 try{
  const input=el<HTMLInputElement>('pairCode'),response=await fetch(serviceURL('/api/pair'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:input.value.trim()}),signal:AbortSignal.timeout(15000),credentials:'omit'})
  if(!response.ok)throw Error('Code invalid, expired or locked. Generate a new server pairing code.')
  const result=await jsonResponse(response,2000) as {token?:unknown};acceptClientAuth(result.token);input.value=''
  if(bridge){if(!await queue.run(()=>bridge!.setLocalStorage('x.device.v1',serializedClientAuth())))throw Error('Could not save pairing on this phone. Try again.')}
  else try{sessionStorage.setItem('x.device.v1',serializedClientAuth())}catch{/* This browser stays paired only until reload. */}
  await checkStatus();if(!needsPairing)await reader.refresh();el('pairStatus').textContent='Connected.'
 }catch(error){el('pairStatus').textContent=error instanceof Error?error.message:'Pairing unavailable. Check the server.'}finally{pairBusy=false;render()}
})()})
el('export').addEventListener('click',()=>{
 const blob=new Blob([JSON.stringify(diagnostics.export(),null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='x-diagnostics.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
})
el('clearCache').addEventListener('click',()=>{
 interactionRevision++
 cacheEnabled=false;if(storageTimer)clearTimeout(storageTimer)
 gallery.close();reader.clear()
 if(bridge)void queue.run(async()=>{if(!await bridge!.setLocalStorage(cacheKey,''))throw Error('Clear rejected')}).catch(()=>{cacheWarning='Could not clear host cache. Retry after reconnect.';renderPhone()})
})
function cleanup(){
 if(!alive)return
 diagnostics.record('session.end');void persist();alive=false;bookmarks.dispose();gallery.close();reader.dispose();if(renderRetryTimer)clearTimeout(renderRetryTimer);if(retryTimer)clearTimeout(retryTimer);if(storageTimer)clearTimeout(storageTimer);for(const unsubscribe of unsubscribers)unsubscribe()
}
window.addEventListener('beforeunload',cleanup)
window.addEventListener('keydown',event=>{
 if(event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||event.target instanceof Element&&event.target.closest('input,textarea,select,[contenteditable="true"]'))return
 if(event.key==='ArrowRight'||event.key==='ArrowLeft'){event.preventDefault();act(event.key==='ArrowRight'?'next':'previous')}
})
window.addEventListener('online',()=>{backendWarning='Connection restored. Refresh when ready.';renderPhone()})
window.addEventListener('offline',()=>{backendWarning='Offline. Cached posts remain readable.';renderPhone()})

async function checkStatus(){
 try{
  const res=await fetch(serviceURL('/api/status'),{headers:authHeaders(),signal:AbortSignal.timeout(5000),cache:'no-store'});if(res.status===401){const payload=await jsonResponse(res,2000) as {error?:unknown};if(payload.error==='pairing_required'){needsPairing=true;configured=false;backendWarning='Enter the server pairing code to connect this phone.';renderPhone();return}}if(!res.ok)throw Error('Unavailable')
  const status=await jsonResponse(res,2000) as {mode?:unknown;configured?:unknown;scope?:unknown}
  if(status.mode!=='demo'&&status.mode!=='live'||!validScope(status.scope))throw Error('Invalid status')
  needsPairing=false;mode=status.mode;configured=status.configured===true;sessionScope=status.scope
 }catch{backendWarning='Backend unreachable. Cached posts remain readable; refresh to retry.'}
 renderPhone()
}
async function connectGlasses(){
 if(!('flutter_inappwebview' in window)){bridgeLabel='Phone preview · open in Even App or simulator';renderPhone();return}
 try{
  bridge??=await waitForEvenAppBridge();if(!alive)return
  const revision=interactionRevision
  try{
   const raw=await queue.run(()=>bridge!.getLocalStorage(cacheKey))
   const saved=restore(raw,mode??'demo',sessionScope)??(mode===null?restore(raw,'live',sessionScope):null)
   if(saved && revision===0 && interactionRevision===0){reader.feed=saved.feed;reader.feeds=saved.feeds;mode=reader.state.mode;renderPhone()}
  }catch{cacheWarning='Could not restore host cache; current session still works.'}
  const frame=display(reader.feed,reader.state,reader.pages,reader.busy,reader.message)
  const result=await queue.run(()=>bridge!.createStartUpPageContainer(new CreateStartUpPageContainer({containerTotalNum:7,textObject:geometry.map(g=>new TextContainerProperty({...g,paddingLength:0,borderWidth:0,content:frame[g.containerName]})),imageObject:[new ImageContainerProperty({containerID:5,containerName:'reedMark',xPosition:20,yPosition:8,width:28,height:28,zOrderIndex:0}),...([20,288].map((x,i)=>new ImageContainerProperty({containerID:6+i,containerName:'photo'+i,xPosition:x,yPosition:76,width:268,height:144,zOrderIndex:1+i})))],menuObject:new MenuContainerProperty({menuItems:menuItems.map(item=>new MenuItemProperty(item))})})))
  if(result!==0)throw Error('Startup rejected')
  // One small cached bitmap; post navigation only upgrades native text.
  try{const started=performance.now();const result=await queue.run(()=>bridge!.updateImageRawData(new ImageRawDataUpdate({containerID:5,containerName:'reedMark',imageData:markBytes})));diagnostics.record('render',{imageBytes:markBytes.length,imageTiles:1,hostMs:performance.now()-started});if(result!=='success')throw Error('Image rejected')}catch{diagnostics.record('error',{image:true})}
  ready=true;lastDisplay=frame;bridgeLabel='Glasses page ready · host accepted';console.info('REED_READY sdk=0.0.16')
  unsubscribers.push(bridge.onEvenHubEvent(event=>{const action=eventAction(event);if(action)act(action)}))
  unsubscribers.push(bridge.onDeviceStatusChanged(status=>{
   const connected=status.connectType===DeviceConnectType.Connected
   bridgeLabel=connected?'Glasses reconnected · reading preserved':'Glasses disconnected · reading preserved'
   diagnostics.record('health',{connected});if(connected){lastImageKey='';lastDisplay={};render()}else renderPhone()
  }))
  render();scheduleStorage()
 }catch{bridgeLabel='Glasses startup failed. Restart the app to retry.';diagnostics.record('error',{startup:true});renderPhone()}
}
renderPhone()
async function boot(){
 try{if('flutter_inappwebview' in window){bridge=await waitForEvenAppBridge();restoreClientAuth(await queue.run(()=>bridge!.getLocalStorage('x.device.v1')))}else restoreClientAuth(sessionStorage.getItem('x.device.v1')??'')}catch{/* Pair again if device storage is unavailable. */}
 await checkStatus();await connectGlasses();if(!needsPairing&&(configured||mode==='demo'))void reader.refresh()
}
void boot()
// Stable, read-only state for simulator assertions. No posts, IDs or secrets.
Object.defineProperty(window,'__reed',{get:()=>({feed:reader.feed,mode,ready,busy:reader.busy,index:reader.state.index,page:reader.state.page,count:reader.state.posts.length,arrivals:reader.state.arrivals,hasCursor:!!reader.state.cursor,diagnostics:diagnostics.export(),hasPhotos:!!currentPost(reader.state)?.images?.length,reposted:!!currentPost(reader.state)?.repostedBy,textPages:reader.pages.length,imageOpen:gallery.open,imagePage:gallery.page,imagePages:gallery.pages.length,imageLoading:gallery.loading,bodyChars:currentPost(reader.state)?postText(currentPost(reader.state)!).length:0})})
