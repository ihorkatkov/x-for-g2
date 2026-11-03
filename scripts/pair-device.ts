import {fileURLToPath} from 'node:url'
import {spawn} from 'node:child_process'
import {PairingStore} from '../server/pairing.ts'
if(process.platform!=='darwin'&&!process.stdout.isTTY)throw Error('Run pairing from an interactive terminal.')
const file=process.env.REED_PAIRING_FILE??fileURLToPath(new URL('../.local/beta-pairing.json',import.meta.url))
const code=await new PairingStore(file).issueCode()
if(process.platform==='darwin'){
 const script=`display dialog ("X phone pairing code:" & return & return & "${code}" & return & return & "Enter this code in X on your phone. It expires in 10 minutes and works once. Your X cookies stay on this laptop.") with title "Connect X" buttons {"OK"} default button "OK"`
 const dialog=spawn('/usr/bin/osascript',[],{detached:true,stdio:['pipe','ignore','ignore']});dialog.stdin.end(script);dialog.unref();await new Promise<void>((resolve,reject)=>{dialog.once('error',()=>reject(Error('Could not show pairing dialog')));dialog.once('exit',code=>code===0?resolve():reject(Error('Could not show pairing dialog')));setTimeout(resolve,400)})
 console.info('Pairing code displayed privately on this Mac. It expires in ten minutes.')
}else process.stdout.write(`X phone pairing code: ${code}\nExpires in ten minutes; use once in the phone companion.\n`)
