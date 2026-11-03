import {test} from 'node:test'
import assert from 'node:assert/strict'
import {LatestRender,SerialHost,geometry,menuItems} from '../src/host.ts'
const tick=()=>new Promise<void>(r=>setImmediate(r))
test('bridge serializes render / storage, coalesces stale frames and recovers from rejection',async()=>{
 const queue=new SerialHost();const sent:number[]=[];let release!:()=>void
 const hold=new Promise<void>(r=>{release=r});let active=0,max=0
 const render=new LatestRender<number>(queue,async n=>{active++;max=Math.max(max,active);sent.push(n);if(n===1)await hold;active--;if(n===4)throw Error('Host rejected')},()=>sent.push(-1))
 render.request(1);await tick();render.request(2);render.request(3)
 const store=queue.run(async()=>{assert.equal(active,0);sent.push(9)})
 release();await store;await tick();assert.deepEqual(sent,[1,9,3]);assert.equal(max,1)
 render.request(4);await tick();render.request(5);await tick();assert.deepEqual(sent.slice(-3),[4,-1,5])
})
test('fixed native geometry follows display contract',()=>{
 assert.equal(geometry.filter(c=>c.isEventCapture===1).length,1)
 for(const c of geometry){assert.ok(c.xPosition+c.width<=576);assert.ok(c.yPosition+c.height<=288);assert.ok(c.containerName.length<=16)}
 assert.equal(new Set(geometry.map(c=>c.containerID)).size,4)
 assert.equal(new Set(menuItems.map(c=>c.itemID)).size,menuItems.length)
})
