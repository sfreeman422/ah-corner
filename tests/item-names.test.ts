import assert from 'node:assert/strict';
import test from 'node:test';
import {ItemNameResolver} from '../src/item-names.ts';

const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(condition:()=>boolean){
 for(let i=0;i<100;i++){if(condition())return;await delay(5);}
 assert.fail('Timed out waiting for name resolver');
}

test('resolves requested names with bounded concurrency and deduplicates queued work',async()=>{
 const names:Record<number,string>={99:'Already known'};
 const calls:number[]=[];
 let active=0,maxActive=0;
 const resolver=new ItemNameResolver({
  maxConcurrent:2,maxPerWindow:100,
  isKnown:id=>!!names[id],
  async lookup(id){calls.push(id);active++;maxActive=Math.max(maxActive,active);await delay(10);active--;return `Name ${id}`;},
  async onName(id,name){names[id]=name;}
 });
 try{
  resolver.enqueue([1,1,2,3,99,0,-1]);
  resolver.enqueue([1,2,3]);
  await waitFor(()=>!!names[1]&&!!names[2]&&!!names[3]);
  assert.deepEqual(calls.sort((a,b)=>a-b),[1,2,3]);
  assert.ok(maxActive<=2);
 }finally{resolver.close();}
});

test('missing names and transient failures are retried only after their backoff',async()=>{
 const calls:Record<number,number>={};
 const names:Record<number,string>={};
 const resolver=new ItemNameResolver({
  maxPerWindow:100,missingTtlMs:60,retryTtlMs:60,isKnown:id=>!!names[id],
  async lookup(id){calls[id]=(calls[id]||0)+1;if(calls[id]===1){if(id===2)throw Error('offline');return null;}return `Name ${id}`;},
  onName(id,name){names[id]=name;}
 });
 try{
  resolver.enqueue([1,2]);
  await waitFor(()=>calls[1]===1&&calls[2]===1);
  await delay(5);
  resolver.enqueue([1,2]);
  await delay(10);
  assert.equal(calls[1],1);assert.equal(calls[2],1);
  await delay(65);
  resolver.enqueue([1,2]);
  await waitFor(()=>!!names[1]&&!!names[2]);
  assert.equal(calls[1],2);assert.equal(calls[2],2);
 }finally{resolver.close();}
});

test('a rolling request budget delays excess work and fallback placeholders are not names',async()=>{
 const calls:number[]=[];
 const names:Record<number,string>={};
 const resolver=new ItemNameResolver({
  maxConcurrent:3,maxPerWindow:2,windowMs:100,missingTtlMs:1000,isKnown:id=>!!names[id],
  async lookup(id){calls.push(id);return id===1?'Item #1':`Name ${id}`;},
  onName(id,name){names[id]=name;}
 });
 try{
  resolver.enqueue([1,2,3]);
  await waitFor(()=>calls.length===2);
  await delay(20);
  assert.equal(calls.length,2);
  assert.equal(names[1],undefined);
  await waitFor(()=>!!names[3]);
  assert.deepEqual(calls,[1,2,3]);
 }finally{resolver.close();}
});

test('closing prevents in-flight lookups from updating state',async()=>{
 let release:(value:string)=>void=()=>{};
 let persisted=false;
 const resolver=new ItemNameResolver({
  isKnown:()=>false,
  lookup:()=>new Promise(resolve=>{release=resolve;}),
  onName(){persisted=true;}
 });
 resolver.enqueue([1]);
 resolver.close();
 release('Found name');
 await delay(5);
 assert.equal(persisted,false);
});
