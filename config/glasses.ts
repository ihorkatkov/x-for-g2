import {loadEnv} from 'vite'
export function validateServiceOrigin(value:unknown):string {
 if(typeof value!=='string'||!value)throw Error('Set X_SERVICE_ORIGIN to your own HTTPS service origin before building for glasses.')
 let u:URL;try{u=new URL(value)}catch{throw Error('Invalid X_SERVICE_ORIGIN.')}
 if(u.protocol!=='https:'||u.origin!==value||u.username||u.password)throw Error('X_SERVICE_ORIGIN must be an exact HTTPS origin without credentials or a path.')
 return u.origin
}
/** Only a public origin is exposed to Vite; provider credentials remain server-only. */
export function glassesOrigin(cwd=process.cwd()){
 return validateServiceOrigin(process.env.X_SERVICE_ORIGIN??loadEnv('glasses',cwd,'X_SERVICE_').X_SERVICE_ORIGIN)
}
