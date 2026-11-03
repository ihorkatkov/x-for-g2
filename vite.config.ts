import {defineConfig} from 'vite'
import {glassesOrigin} from './config/glasses.ts'
export default defineConfig(({mode})=>{
 const origin=mode==='glasses'?glassesOrigin():null
 return {base:'./',build:{outDir:mode==='glasses'?'dist-glasses':'dist'},plugins:origin?[{name:'configured-service-endpoint',transformIndexHtml:()=>[{tag:'meta',attrs:{id:'service-endpoint',content:origin},injectTo:'head'}]}]:[]}
})
