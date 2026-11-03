import {serviceURL,authHeaders} from './service.ts'
import type {Photo,Post} from './model.ts'
export const attachmentOnly=(post:Post)=>Boolean(post.images?.length)&&!post.quote?.text&&!/[\p{L}\p{N}]/u.test(post.text)
export type PhotoPage={kind?:Photo['kind'];photoNumber?:number;photoCount?:number;tiles:[Uint8Array,Uint8Array];pixels:Uint8ClampedArray}
export type PhotoFrame={key:string;page:PhotoPage}
/** Overview first, then full-width strips, capped at twelve detail pages.
 * Scaling preserves the whole image even for unusually tall photographs. */
export function photoPlan(width:number,height:number){
 if(!width||!height||width>4096||height>4096||width*height>8_000_000)throw Error('Image dimensions unsupported')
 const fit=Math.min(536/width,144/height),zoom=Math.min(536/width,1376/height)
 const overview={width:Math.max(1,Math.round(width*fit)),height:Math.max(1,Math.round(height*fit)),offset:0,overview:true}
 const w=Math.max(1,Math.round(width*zoom)),h=Math.max(1,Math.round(height*zoom))
 return [overview,...(h>144?Array.from({length:Math.ceil((h-144)/112)+1},(_,n)=>({width:w,height:h,offset:Math.min(n*112,h-144),overview:false})):[])]
}
/** Quantize luminance to the display's sixteen grey levels; black is unlit. */
export function monochrome(data:Uint8ClampedArray){
 const linear=(n:number)=>{const v=n/255;return (v<=.04045?v/12.92:((v+.055)/1.055)**2.4)*255}
 for(let i=0;i<data.length;i+=4){const l=(.2126*linear(data[i])+.7152*linear(data[i+1])+.0722*linear(data[i+2]))*data[i+3]/255,v=Math.round(l/17)*17;data[i]=data[i+1]=data[i+2]=v;data[i+3]=255}return data
}
function canvas(){const c=document.createElement('canvas');c.width=536;c.height=144;return c}
function bytes(c:HTMLCanvasElement){return Uint8Array.from(atob(c.toDataURL('image/png').split(',')[1]),n=>n.charCodeAt(0))}
export function blankTile(){const c=canvas();c.width=268;return bytes(c)}
export async function loadPhoto(photo:Photo,signal:AbortSignal):Promise<PhotoPage[]>{
 const res=await fetch(serviceURL(photo.url),{headers:authHeaders(),signal,cache:'no-store',credentials:'same-origin'});if(!res.ok||Number(res.headers.get('content-length'))>2_000_000)throw Error('Image unavailable. Refresh the feed and try again.')
 const stream=res.body?.getReader();if(!stream)throw Error('Image unavailable')
 const chunks:Uint8Array[]=[];let size=0
 try{while(true){const {done,value}=await stream.read();if(done)break;size+=value.length;if(size>2_000_000)throw Error('Image too large');chunks.push(value)}}finally{await stream.cancel()}
 const buffer=new Uint8Array(size);let offset=0;for(const c of chunks){buffer.set(c,offset);offset+=c.length}
 const type=res.headers.get('content-type')?.split(';')[0];if(type!=='image/png'&&type!=='image/jpeg')throw Error('Unsupported image')
 // Data URL works under the app CSP without granting blob: image access.
 const url=await new Promise<string>((resolve,reject)=>{const f=new FileReader();f.onload=()=>resolve(String(f.result));f.onerror=()=>reject(Error('Image unavailable'));f.readAsDataURL(new Blob([buffer],{type}))})
 if(signal.aborted)throw Error('Canceled')
 const image=new Image();image.src=url;await image.decode();if(signal.aborted)throw Error('Canceled')
 return photoPlan(image.naturalWidth,image.naturalHeight).map(plan=>{
  const c=canvas(),ctx=c.getContext('2d')!;ctx.fillStyle='#000';ctx.fillRect(0,0,536,144);ctx.drawImage(image,(536-plan.width)/2,plan.overview?(144-plan.height)/2:-plan.offset,plan.width,plan.height)
  const pixels=ctx.getImageData(0,0,536,144);monochrome(pixels.data);ctx.putImageData(pixels,0,0)
  const tiles=[0,268].map(x=>{const tile=canvas();tile.width=268;tile.getContext('2d')!.drawImage(c,x,0,268,144,0,0,268,144);return bytes(tile)}) as [Uint8Array,Uint8Array]
  return {tiles,pixels:pixels.data}
 })
}
/** A late download cannot reopen an image after returning to text or switching posts. */
export class Gallery {
 open=false;loading=false;error='';page=0;pages:PhotoPage[]=[];private revision=0;private abort?:AbortController
 constructor(private load:(p:Photo,s:AbortSignal)=>Promise<PhotoPage[]>,private changed:()=>void){}
 close(){this.revision++;this.abort?.abort();this.open=false;this.loading=false;this.error='';this.pages=[];this.page=0;this.changed()}
 async show(photos:Photo[]){
  if(!photos.length)return
  this.abort?.abort();const revision=++this.revision;this.abort=new AbortController();this.open=true;this.loading=true;this.error='';this.pages=[];this.page=0;this.changed()
  const signal=AbortSignal.any([this.abort.signal,AbortSignal.timeout(20000)])
  try{
   for(let n=0;n<photos.length;n++){
    try{const pages=await this.load(photos[n],signal);if(revision!==this.revision)return;this.pages.push(...pages.map(p=>({...p,photoNumber:n+1,photoCount:photos.length,kind:photos[n].kind})));this.changed()}
    catch{if(revision!==this.revision)return;this.error='Some images unavailable. Return to text to retry.'}
    if(signal.aborted)break
   }
  }finally{if(revision===this.revision){this.loading=false;if(!this.pages.length)this.error='Image unavailable. Return to text to retry.';this.changed()}}
 }
 next(){if(this.page<this.pages.length-1)this.page++;this.changed()}
 previous(){if(this.page>0)this.page--;this.changed()}
 get frame():PhotoFrame|undefined{return this.open&&this.pages[this.page]?{key:`${this.revision}:${this.page}`,page:this.pages[this.page]}:undefined}
}

/** Automatic media is a first view, never a substitute for its caption/alt text.
 * Boundary gestures return to that same text page; the next gesture reads on. */
export class AttachmentSession {
 automatic=false
 private owner=''
 private selection=''
 private attempted=''
 constructor(private gallery:Gallery){}
 synchronize(key:string,post:Post|undefined,busy:boolean){
  if(this.selection!==key){this.selection=key;this.attempted=''}
  if(this.gallery.open&&this.owner!==key){this.gallery.close();return true}
  if(!this.gallery.open&&!busy&&post&&attachmentOnly(post)&&this.attempted!==key){
   this.attempted=key;this.owner=key;this.automatic=true;void this.gallery.show(post.images!);return true
  }
  return false
 }
 show(key:string,photos:Photo[]){this.automatic=false;this.owner=key;this.attempted=key;void this.gallery.show(photos)}
 input(action:'next'|'previous'|'exit'){
  if(!this.gallery.open)return false
  if(action==='exit'||this.automatic&&(action==='next'&&this.gallery.page>=this.gallery.pages.length-1||action==='previous'&&this.gallery.page===0)){this.gallery.close();return true}
  if(action==='next')this.gallery.next();else this.gallery.previous()
  return true
 }
}
