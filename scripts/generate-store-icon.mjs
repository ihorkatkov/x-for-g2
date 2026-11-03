import {PNG} from 'pngjs'
import {readFileSync,writeFileSync} from 'node:fs'
const source=PNG.sync.read(readFileSync(new URL('../public/x-mark.png',import.meta.url))),icon=new PNG({width:24,height:24})
for(let cy=0;cy<12;cy++)for(let cx=0;cx<12;cx++){
 const sx=Math.min(source.width-1,Math.floor((cx+.5)*source.width/12)),sy=Math.min(source.height-1,Math.floor((cy+.5)*source.height/12))
 if(source.data[(sy*source.width+sx)*4+3]<128)continue
 for(let y=0;y<2;y++)for(let x=0;x<2;x++){const k=((cy*2+y)*24+cx*2+x)*4;icon.data[k]=icon.data[k+1]=icon.data[k+2]=244;icon.data[k+3]=255}
}
writeFileSync(new URL('../icon.png',import.meta.url),PNG.sync.write(icon))
