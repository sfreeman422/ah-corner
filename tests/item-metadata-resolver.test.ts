import assert from 'node:assert/strict';
import test from 'node:test';
import {ItemMetadataResolver} from '../src/item-metadata-resolver.ts';
import type {ItemMetadata} from '../src/item-metadata-resolver.ts';

const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(condition:()=>boolean){
 for(let i=0;i<100;i++){if(condition())return;await pause(5);}
 assert.fail('Timed out waiting for metadata resolver');
}

test('resolves only requested items sequentially, deduplicates work and persists misses',async()=>{
 const results:Record<number,ItemMetadata|null>={99:{itemClassId:0,itemSubclassId:5}};
 const calls:number[]=[];
 let active=0,maximum=0;
 const resolver=new ItemMetadataResolver({
  maxPerWindow:100,
  shouldLookup:id=>!Object.hasOwn(results,id),
  async lookup(id){calls.push(id);active++;maximum=Math.max(maximum,active);await pause(5);active--;return id===2?null:{itemClassId:0,itemSubclassId:5};},
  onResult(id,metadata){results[id]=metadata;}
 });
 try{
  resolver.enqueue([1,1,2,3,99,0,-1]);
  resolver.enqueue([1,2,3]);
  await waitFor(()=>Object.hasOwn(results,3));
  assert.deepEqual(calls,[1,2,3]);
  assert.equal(maximum,1);
  assert.equal(results[2],null);
  resolver.enqueue([2]);await pause(10);
  assert.deepEqual(calls,[1,2,3],'persisted misses are governed by the caller, not fetched again');
 }finally{resolver.close();}
});

test('rolling request budget delays excess work',async()=>{
 const calls:number[]=[];
 const results=new Set<number>();
 const resolver=new ItemMetadataResolver({
  maxPerWindow:2,windowMs:100,shouldLookup:id=>!results.has(id),
  async lookup(id){calls.push(id);return {itemClassId:0,itemSubclassId:5};},
  onResult(id){results.add(id);}
 });
 try{
  resolver.enqueue([1,2,3]);
  await waitFor(()=>calls.length===2);
  await pause(20);assert.equal(calls.length,2);
  await waitFor(()=>results.has(3));assert.deepEqual(calls,[1,2,3]);
 }finally{resolver.close();}
});

test('upstream, persistence and invalid-response failures retry after backoff',async()=>{
 const calls:Record<number,number>={};
 const results=new Set<number>();
 const resolver=new ItemMetadataResolver({
  maxPerWindow:100,retryTtlMs:60,shouldLookup:id=>!results.has(id),
  async lookup(id){calls[id]=(calls[id]||0)+1;if(calls[id]===1&&id===1)throw Error('offline');if(calls[id]===1&&id===2)return {itemClassId:-1,itemSubclassId:5};return {itemClassId:0,itemSubclassId:5};},
  onResult(id){if(id===3&&calls[id]===1)throw Error('database unavailable');results.add(id);}
 });
 try{
  resolver.enqueue([1,2,3]);
  await waitFor(()=>calls[3]===1);await pause(5);
  resolver.enqueue([1,2,3]);await pause(10);
  assert.deepEqual(calls,{1:1,2:1,3:1});
  await pause(65);resolver.enqueue([1,2,3]);
  await waitFor(()=>results.size===3);
  assert.deepEqual(calls,{1:2,2:2,3:2});
 }finally{resolver.close();}
});

test('closing prevents pending results from being persisted',async()=>{
 let release:(value:ItemMetadata|null)=>void=()=>{};
 let persisted=false;
 const resolver=new ItemMetadataResolver({
  shouldLookup:()=>true,
  lookup:()=>new Promise(resolve=>{release=resolve;}),
  onResult(){persisted=true;}
 });
 resolver.enqueue([1,2]);resolver.close();release({itemClassId:0,itemSubclassId:5});
 await pause(5);assert.equal(persisted,false);
});
