import {createHash,randomBytes,randomInt,timingSafeEqual} from 'node:crypto'
import {mkdir,readFile,rename,writeFile} from 'node:fs/promises'
import {dirname} from 'node:path'
import {BackendError} from './errors.ts'
type State={version:1;clients:{hash:string;until:number}[];pending?:{hash:string;until:number;attempts:number}}
const digest=(value:string)=>createHash('sha256').update(value).digest('hex')
const equal=(a:string,b:string)=>/^[a-f0-9]{64}$/.test(a)&&/^[a-f0-9]{64}$/.test(b)&&timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'))
/** App credentials are runtime device sessions, never bundled X credentials.
 * Store only hashes. One process owns API writes; atomic rename protects readers. */
export class PairingStore {
 private tail:Promise<unknown>=Promise.resolve()
 constructor(private file:string,private now=Date.now){}
 private async read():Promise<State>{
  let value:unknown
  try{value=JSON.parse(await readFile(this.file,'utf8'))}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {version:1,clients:[]};throw new BackendError('internal',500)}
  const v=value as State
  if(v?.version!==1||!Array.isArray(v.clients)||v.clients.length>8||v.clients.some(c=>!/^[a-f0-9]{64}$/.test(c.hash)||!Number.isFinite(c.until))||v.pending&&(!/^[a-f0-9]{64}$/.test(v.pending.hash)||!Number.isFinite(v.pending.until)||!Number.isInteger(v.pending.attempts)||v.pending.attempts<0||v.pending.attempts>5))throw new BackendError('internal',500)
  return v
 }
 private async save(state:State){await mkdir(dirname(this.file),{recursive:true,mode:0o700});const tmp=this.file+'.'+randomBytes(6).toString('hex')+'.tmp';await writeFile(tmp,JSON.stringify(state),{mode:0o600,flag:'wx'});await rename(tmp,this.file)}
 private run<T>(work:()=>Promise<T>){const next=this.tail.then(work);this.tail=next.catch(()=>{});return next}
 issueCode(){return this.run(async()=>{const s=await this.read(),code=String(randomInt(10000000,100000000));s.clients=s.clients.filter(c=>c.until>this.now());s.pending={hash:digest(code),until:this.now()+10*60000,attempts:0};await this.save(s);return code})}
 pair(code:string){return this.run(async()=>{
  const s=await this.read(),pending=s.pending
  if(!pending||pending.until<=this.now()||pending.attempts>=5)throw new BackendError('pairing_invalid',401)
  if(!/^\d{8}$/.test(code)||!equal(digest(code),pending.hash)){pending.attempts++;await this.save(s);throw new BackendError('pairing_invalid',401)}
  const token=randomBytes(32).toString('base64url');s.clients=s.clients.filter(c=>c.until>this.now()).slice(-7);s.clients.push({hash:digest(token),until:this.now()+30*86400000});delete s.pending;await this.save(s);return token
 })}
 async authorized(header:string|undefined){if(!header||!/^Bearer [A-Za-z0-9_-]{43}$/.test(header))return false;const s=await this.read(),hash=digest(header.slice(7));return s.clients.some(c=>c.until>this.now()&&equal(c.hash,hash))}
 revoke(token:string){return this.run(async()=>{const s=await this.read();s.clients=s.clients.filter(c=>!equal(c.hash,digest(token)));await this.save(s)})}
}
