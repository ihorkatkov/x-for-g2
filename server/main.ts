/** CLI adapter only. Importing this module never opens a listener. */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { start } from './index.ts';
export { createServer, start } from './index.ts';

/** A shared .env may also contain the separate beta launcher's identity. */
export function localEnvironment(env:NodeJS.ProcessEnv=process.env){
  if(env.REED_REMOTE==='1')return env;
  const {REED_TAILSCALE_USER:_betaIdentity,...local}=env;
  return local;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const env=localEnvironment(process.argv.includes('--demo')?{...process.env,REED_MODE:'demo'}:process.env);
  start({env}).then(() => console.log('X backend ready (no private values logged).')).catch(() => {
    console.error('X backend startup failed. Check private configuration.');
    process.exitCode = 1;
  });
}
