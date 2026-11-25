import assert from 'node:assert/strict';
import test from 'node:test';
import {fetchForeverItems} from '../src/forever-item-catalog.ts';

const dataset='gamedata-265d3184f52e7b14316a',build='1.60.1.71139';
const manifest={schemaVersion:1,defaultChannel:'latest',channels:{latest:{product:'wowf',build,datasets:{items:dataset}}}};
const response=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const envelope=(data:unknown[],missingIds:number[]=[])=>({schemaVersion:1,dataset,locale:'enUS',resource:'items',source:{product:'wowf',build},data,missingIds});

function fetcherFor(handler:(ids:number[],index:number)=>unknown){
 const calls:string[]=[];let batches=0;
 const fetcher:typeof fetch=async input=>{
  const url=new URL(String(input));calls.push(url.pathname+url.search);
  if(url.pathname.endsWith('/manifest'))return response(manifest);
  const ids=url.searchParams.get('ids')!.split(',').map(Number);
  return response(handler(ids,batches++));
 };
 return {fetcher,calls};
}

test('uses pinned Forever item batches with deduplication, 0 class, names and missing IDs',async()=>{
 const {fetcher,calls}=fetcherFor(ids=>envelope(ids.filter(id=>id!==999).map(id=>({id,class:id===117?0:7,subclass:5,quality:1,slot:0,name:id===117?' Tough Jerky ':null})),ids.filter(id=>id===999)));
 const result=await fetchForeverItems([117,2589,117,999],{fetcher,batchSize:2,requestIntervalMs:0});
 assert.deepEqual(result,{dataset,build,items:{117:{classId:0,subclassId:5,quality:1,slot:0,name:'Tough Jerky'},2589:{classId:7,subclassId:5,quality:1,slot:0}},missingIds:[999]});
 assert.equal(calls.length,3);
 assert.match(calls[1],/ids=117%2C2589/);
 assert.match(calls[2],/ids=999/);
});

test('empty input checks the current dataset without requesting item batches',async()=>{
 const {fetcher,calls}=fetcherFor(()=>{throw Error('unexpected batch');});
 assert.deepEqual(await fetchForeverItems([],{fetcher,requestIntervalMs:0}),{dataset,build,items:{},missingIds:[]});
 assert.equal(calls.length,1);
});

test('rejects incomplete, duplicate, foreign, and mismatched source records',async()=>{
 for(const value of [
  envelope([]),
  envelope([{id:117,class:0,subclass:5}],[117]),
  envelope([{id:118,class:0,subclass:5}]),
  {...envelope([{id:117,class:0,subclass:5}]),dataset:'wrong'},
  {...envelope([{id:117,class:0,subclass:5}]),source:{product:'wowf',build:'other'}},
  envelope([{id:117,class:0,subclass:null}]),
 ]){
  const {fetcher}=fetcherFor(()=>value);
  await assert.rejects(fetchForeverItems([117],{fetcher,requestIntervalMs:0}),/Invalid|Incomplete/);
 }
});

test('rejects malformed manifest, errors and later batch failure without returning partial data',async()=>{
 const badManifest:typeof fetch=async()=>response({...manifest,channels:{latest:{product:'classic',build,datasets:{items:dataset}}}});
 await assert.rejects(fetchForeverItems([117],{fetcher:badManifest,requestIntervalMs:0}),/manifest/);
 const {fetcher}=fetcherFor((ids,index)=>index===0?envelope(ids.map(id=>({id,class:0,subclass:5}))):envelope([]));
 await assert.rejects(fetchForeverItems([117,2589],{fetcher,batchSize:1,requestIntervalMs:0}),/Incomplete/);
 const failed:typeof fetch=async()=>new Response('nope',{status:429});
 await assert.rejects(fetchForeverItems([117],{fetcher:failed,requestIntervalMs:0}),/HTTP 429/);
 const oversized:typeof fetch=async()=>new Response('x'.repeat(2_000_001));
 await assert.rejects(fetchForeverItems([117],{fetcher:oversized,requestIntervalMs:0}),/too large/);
});

test('validates inputs and observes cancellation',async()=>{
 await assert.rejects(fetchForeverItems([0],{requestIntervalMs:0}),/IDs/);
 await assert.rejects(fetchForeverItems([117],{batchSize:51}),/batch size/);
 const abort=new AbortController();abort.abort();
 await assert.rejects(fetchForeverItems([117],{signal:abort.signal}),{name:'AbortError'});
});
