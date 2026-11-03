import {readFile} from 'node:fs/promises'
import {parseEnv} from 'node:util'
import {fileURLToPath} from 'node:url'
import {start} from './index.ts'
/** Opt-in private beta entry. Reuse the authorized local session without copying
 * cookies to disk, CLI arguments, the frontend or Even Hub package. */
export async function betaEnvironment(env:NodeJS.ProcessEnv=process.env){
 const origin=env.REED_ORIGIN??env.X_SERVICE_ORIGIN,user=env.REED_TAILSCALE_USER
 if(!origin||!user)throw Error('Private beta endpoint and user must be configured')
 const values=env.REED_SESSION_ENV?parseEnv(await readFile(env.REED_SESSION_ENV,'utf8')):{};
 const auth=env.AUTH_TOKEN||values.AUTH_TOKEN,ct0=env.CT0||values.CT0
 if(!auth||!ct0)throw Error('Private X session is unavailable')
 return {REED_MODE:'live',REED_HOST:'127.0.0.1',REED_PORT:env.REED_PORT??'4043',REED_REMOTE:'1',REED_ORIGIN:origin,REED_TAILSCALE_USER:user,AUTH_TOKEN:auth,CT0:ct0,...(env.REED_BOOKMARK_QUERY_ID?{REED_BOOKMARK_QUERY_ID:env.REED_BOOKMARK_QUERY_ID}:{}),...(env.REED_PAIRING_FILE?{REED_PAIRING_FILE:env.REED_PAIRING_FILE}:{})}
}
export async function privateBeta(env:NodeJS.ProcessEnv=process.env){return start({distDir:fileURLToPath(new URL('../dist-glasses/',import.meta.url)),env:await betaEnvironment(env)})}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
 try{
  const server=await privateBeta();console.info('X private beta service ready. Credentials remain in server memory.')
  for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>server.close(()=>process.exit(0)))
 }catch{console.error('X private beta startup failed. Check private endpoint/session configuration. No private values logged.');process.exitCode=1}
}
