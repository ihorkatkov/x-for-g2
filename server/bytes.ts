import {BackendError} from './errors.ts'
/** Bound decompressed bytes before retaining an upstream response in memory. */
export async function boundedText(response:Response,max:number):Promise<string>{
 if(Number(response.headers.get('content-length'))>max){await response.body?.cancel();throw new BackendError('upstream_changed')}
 const reader=response.body?.getReader();if(!reader)throw new BackendError('upstream_changed')
 const chunks:Uint8Array[]=[];let length=0
 try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>max)throw new BackendError('upstream_changed');chunks.push(value)}}finally{await reader.cancel()}
 return Buffer.concat(chunks).toString('utf8')
}
