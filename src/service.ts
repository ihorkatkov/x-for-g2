/** The packaged reader has an explicit HTTPS service origin. Development keeps
 * same-origin API calls. X credentials never enter this module; device sessions
 * are acquired through one-time pairing and restored from the host. */
export function resolveServiceURL(path:string,base=''){
 // The invented local demo has one bundled photo; packaged live clients must
 // continue to use authenticated API image handles only.
 if(!base&&path==='/demo-earthrise.jpg')return path
 if(!path.startsWith('/api/')||path.startsWith('//'))throw Error('Invalid service path')
 const origin=base||'https://local.invalid'
 const root=new URL(origin)
 if(base&&(root.protocol!=='https:'||root.origin!==base||root.username||root.password))throw Error('Invalid service origin')
 const url=new URL(path,origin)
 if(url.origin!==root.origin||!/^\/api\/(?:status|feed|pair|image\/[A-Za-z0-9_.-]+)$/.test(url.pathname))throw Error('Invalid service path')
 return base?url.href:path
}
function serviceOrigin(){return typeof document==='undefined'?'':(document.getElementById('service-endpoint') as HTMLMetaElement|null)?.content??''}
export function serviceURL(path:string){return resolveServiceURL(path,serviceOrigin())}


let clientToken=''
export function restoreClientAuth(raw:string){try{const v=JSON.parse(raw);if(v.version===1&&/^[A-Za-z0-9_-]{43}$/.test(v.token))clientToken=v.token}catch{/* No valid saved device session. */}}
export function acceptClientAuth(token:unknown){if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))throw Error('Invalid device session');clientToken=token}
export function serializedClientAuth(){return JSON.stringify({version:1,token:clientToken})}
export function authHeaders():Record<string,string>{return clientToken&&serviceOrigin()?{Authorization:'Bearer '+clientToken}:{}}
