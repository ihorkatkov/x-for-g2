import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {glassesOrigin,validateServiceOrigin} from '../config/glasses.ts'
import {privateBeta,betaEnvironment} from '../server/private-beta.ts'
import {localEnvironment} from '../server/main.ts'
import {createServer} from '../server/index.ts'
import {resolveServiceURL} from '../src/service.ts'
test('bundled demo photo is local-only while packaged images require API handles',()=>{
 assert.equal(resolveServiceURL('/demo-earthrise.jpg'),'/demo-earthrise.jpg');
 assert.throws(()=>resolveServiceURL('/demo-earthrise.jpg','https://reader.example'));
 for(const path of ['/other.jpg','//remote.example/demo-earthrise.jpg','/demo-earthrise.jpg?private=1'])assert.throws(()=>resolveServiceURL(path));
 assert.equal(resolveServiceURL('/api/image/signed-handle','https://reader.example'),'https://reader.example/api/image/signed-handle');
})
test('shared beta settings do not break local startup or weaken explicit remote authentication',()=>{
 const env={REED_MODE:'demo',X_SERVICE_ORIGIN:'https://reader.example.ts.net:8449',REED_TAILSCALE_USER:'reader@example.test'};
 assert.doesNotThrow(()=>createServer({env:localEnvironment(env)}));
 assert.equal(env.REED_TAILSCALE_USER,'reader@example.test');
 assert.equal(localEnvironment({...env,REED_REMOTE:'1'}).REED_TAILSCALE_USER,env.REED_TAILSCALE_USER);
 assert.throws(()=>createServer({env:localEnvironment({...env,REED_REMOTE:'1'})}));
})
test('glasses config requires a public exact HTTPS origin rather than a maintainer endpoint',async()=>{
 for(const value of [undefined,'','http://laptop.example','https://user:secret@laptop.example','https://laptop.example/path','https://laptop.example/'])assert.throws(()=>validateServiceOrigin(value))
 assert.equal(validateServiceOrigin('https://reader.example.ts.net:8449'),'https://reader.example.ts.net:8449')
 const dir=await mkdtemp(join(tmpdir(),'x-origin-'));const previous=process.env.X_SERVICE_ORIGIN;delete process.env.X_SERVICE_ORIGIN
 try{assert.throws(()=>glassesOrigin(dir));await writeFile(join(dir,'.env'),'X_SERVICE_ORIGIN=https://reader.example.ts.net:8449\nAUTH_TOKEN=fabricated-private-auth\n');assert.equal(glassesOrigin(dir),'https://reader.example.ts.net:8449');process.env.X_SERVICE_ORIGIN='https://override.example';assert.equal(glassesOrigin(dir),'https://override.example')}finally{if(previous===undefined)delete process.env.X_SERVICE_ORIGIN;else process.env.X_SERVICE_ORIGIN=previous;await rm(dir,{recursive:true,force:true})}
})
test('beta startup does not read unrelated personal configuration as a credential fallback',async()=>{
 await assert.rejects(privateBeta({X_SERVICE_ORIGIN:'https://reader.example.ts.net:8449',REED_TAILSCALE_USER:'reader@example.test'}),/session is unavailable/)
})
test('the extracted tree owns its telemetry and contains no parent-workspace import',async()=>{
 const main=await readFile(new URL('../src/main.ts',import.meta.url),'utf8');assert.ok(main.includes("from './telemetry.ts'"));assert.ok(!main.includes('../../../packages/'))
})

test('an explicitly selected session file works with blank template values and forwards pairing configuration',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'x-config-')),file=join(dir,'session.env')
 try{await writeFile(file,'AUTH_TOKEN=fabricated-auth\nCT0=fabricated-csrf\n');const settings={X_SERVICE_ORIGIN:'https://reader.example.ts.net:8449',REED_TAILSCALE_USER:'reader@example.test',REED_SESSION_ENV:file,AUTH_TOKEN:'',CT0:'',REED_PAIRING_FILE:join(dir,'paired.json')};const config=await betaEnvironment(settings);assert.equal(config.AUTH_TOKEN,'fabricated-auth');assert.equal(config.CT0,'fabricated-csrf');assert.equal(config.REED_PAIRING_FILE,settings.REED_PAIRING_FILE);assert.equal(config.REED_ORIGIN,settings.X_SERVICE_ORIGIN);assert.equal((await betaEnvironment({...settings,AUTH_TOKEN:'explicit-auth'})).AUTH_TOKEN,'explicit-auth')}finally{await rm(dir,{recursive:true,force:true})}
})
