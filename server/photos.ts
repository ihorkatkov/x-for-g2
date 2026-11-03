import {randomBytes,createHmac,timingSafeEqual} from 'node:crypto'
import {BackendError} from './errors.ts'
import type {Fetcher} from './transport.ts'
export function photoURL(value:unknown):value is string {
 if(typeof value!=='string'||value.length>500)return false
 try{const u=new URL(value);if(u.origin!=='https://pbs.twimg.com'||u.username||u.password||u.hash||!/^\/(?:media\/[A-Za-z0-9_-]+|tweet_video_thumb\/[A-Za-z0-9_-]+|(?:ext_tw_video_thumb|amplify_video_thumb)\/[0-9]{1,30}\/(?:pu\/)?img\/[A-Za-z0-9_-]+)(?:\.(?:jpg|jpeg|png))?$/.test(u.pathname))return false
 if([...u.searchParams.keys()].some(k=>k!=='format'&&k!=='name')||u.searchParams.getAll('format').length>1||u.searchParams.getAll('name').length>1)return false
 if(u.searchParams.has('format')&&!['jpg','jpeg','png'].includes(u.searchParams.get('format')!))return false
 if(u.searchParams.has('name')&&!['small','medium','large','orig'].includes(u.searchParams.get('name')!))return false
 return /\.(?:jpg|jpeg|png)$/.test(u.pathname)||u.searchParams.has('format')
 }catch{return false}
}
/** Refuse oversized decoded rasters before the phone image decoder allocates them. */
export function dimensions(bytes:Uint8Array):{width:number;height:number}|null {
 const b=Buffer.from(bytes)
 if(b.length>=24&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {width:b.readUInt32BE(16),height:b.readUInt32BE(20)}
 if(b[0]!==255||b[1]!==216)return null
 let p=2
 while(p+4<=b.length){if(b[p++]!==255)return null;while(b[p]===255)p++;const marker=b[p++];if(marker===217||marker===218)break;if(marker===1||marker>=208&&marker<=215)continue;if(p+2>b.length)return null;const n=b.readUInt16BE(p);if(n<2||p+n>b.length)return null;if([192,193,194].includes(marker)&&n>=7)return {width:b.readUInt16BE(p+5),height:b.readUInt16BE(p+3)};p+=n}
 return null
}
export class Photos {
 constructor(private fetcher:Fetcher=fetch,private key:Uint8Array=randomBytes(32)){}
 register(url:string){
  if(!photoURL(url))throw new BackendError('upstream_changed')
  const payload=Buffer.from(url).toString('base64url'),signature=createHmac('sha256',this.key).update(payload).digest('base64url')
  return '/api/image/'+payload+'.'+signature
 }
 async load(token:string){
  if(!/^[A-Za-z0-9_-]{20,667}\.[A-Za-z0-9_-]{43}$/.test(token))throw new BackendError('not_found',404)
  const [payload,signature]=token.split('.'),actual=Buffer.from(signature,'base64url'),expected=createHmac('sha256',this.key).update(payload).digest()
  const url=Buffer.from(payload,'base64url').toString('utf8')
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected)||!photoURL(url))throw new BackendError('not_found',404)
  // Fixed CDN only, no cookies/bearer/forwarded headers; redirects never followed.
  const response=await this.fetcher(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Accept:'image/jpeg,image/png'}})
  const type=response.headers.get('content-type')?.split(';')[0]
  if(!response.ok||!['image/jpeg','image/png'].includes(type??'')||Number(response.headers.get('content-length'))>2_000_000){await response.body?.cancel();throw new BackendError('upstream_changed')}
  const reader=response.body?.getReader();if(!reader)throw new BackendError('upstream_changed')
  const chunks:Uint8Array[]=[];let length=0
  try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>2_000_000)throw new BackendError('upstream_changed');chunks.push(value)}}finally{await reader.cancel()}
  const body=Buffer.concat(chunks),d=dimensions(body)
  if(!d||!d.width||!d.height||d.width>4096||d.height>4096||d.width*d.height>8_000_000)throw new BackendError('upstream_changed')
  const png=body[0]===137;if(png!==(type==='image/png'))throw new BackendError('upstream_changed')
  return {body,type:type!}
 }
}
