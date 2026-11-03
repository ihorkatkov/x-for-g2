import {readFile,writeFile} from 'node:fs/promises'
import {glassesOrigin} from '../config/glasses.ts'
const manifest=JSON.parse(await readFile(new URL('../app.json',import.meta.url),'utf8'))
manifest.permissions=manifest.permissions.map((p:{name:string})=>p.name==='network'?{name:'network',desc:'Reads timelines and still previews from your own private backend. No posting.',whitelist:[glassesOrigin()]}:p)
await writeFile(new URL('../app.glasses.json',import.meta.url),JSON.stringify(manifest,null,2)+'\n')
console.info('Glasses manifest generated with the configured HTTPS origin. No credentials bundled.')
