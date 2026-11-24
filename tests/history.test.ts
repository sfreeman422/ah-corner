import assert from 'node:assert/strict';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import type {Pool} from 'mysql2/promise';
import {openStore,saveSnapshotTransaction} from '../src/store.ts';
import type {Snapshot} from '../src/types.ts';

const hour=3_600_000;
const retention=30*24*hour;

function snapshot(market:string,key:string,at:number,source:Snapshot['source']='blizzard',count=1):Snapshot{
 return {market,key,at,source,listings:Array.from({length:count},(_,i)=>({id:`auction:${i+1}`,itemId:i+1,quantity:2,total:200+i,kind:'auction',timeLeft:'LONG'}))};
}

test('file store retains hourly history beyond 25 raw books and refreshes duplicate books',async()=>{
 const work=await mkdtemp(join(tmpdir(),'ah-history-'));
 const env={url:process.env.DATABASE_URL,dir:process.env.DATA_DIR,required:process.env.REQUIRE_DATABASE};
 delete process.env.DATABASE_URL;
 delete process.env.REQUIRE_DATABASE;
 process.env.DATA_DIR=work;
 try{
  const market='test-market';
  const store=await openStore(market);
  const start=Math.floor(Date.now()/hour)*hour-28*hour;
  for(let i=0;i<28;i++)assert.equal(await store.put(snapshot(market,`key-${i}`,start+i*hour)),true);
  assert.equal((await store.snapshots()).length,25);
  assert.equal((await store.history(1)).length,28);
  const nextAt=start+28*hour;
  assert.equal(await store.put(snapshot(market,'key-27',nextAt)),false);
  assert.equal((await store.history(1)).length,29);
  assert.equal((await store.snapshots()).at(-1)?.at,nextAt);
  // Another update in the same hour replaces the observation rather than doubling it.
  assert.equal(await store.put(snapshot(market,'key-27',nextAt+1000)),false);
  assert.equal((await store.history(1)).length,29);
  assert.equal((await store.history(1)).at(-1)?.at,nextAt+1000);
  // A previous book can return after its raw entry was trimmed.
  assert.equal(await store.put(snapshot(market,'key-0',nextAt+hour)),true);
  assert.equal((await store.history(1)).length,30);
  const other=await openStore('another-market');
  assert.deepEqual(await other.history(1),[]);
  await other.close();
  await store.close();
 }finally{
  if(env.url===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=env.url;
  if(env.dir===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=env.dir;
  if(env.required===undefined)delete process.env.REQUIRE_DATABASE;else process.env.REQUIRE_DATABASE=env.required;
  await rm(work,{recursive:true,force:true});
 }
});

test('file retention removes old live observations and raw snapshots but preserves demo data',async()=>{
 const work=await mkdtemp(join(tmpdir(),'ah-retention-'));
 const env={url:process.env.DATABASE_URL,dir:process.env.DATA_DIR,required:process.env.REQUIRE_DATABASE};
 delete process.env.DATABASE_URL;
 delete process.env.REQUIRE_DATABASE;
 process.env.DATA_DIR=work;
 try{
  const market='retention-market';
  const store=await openStore(market);
  const old=Date.now()-retention-hour;
  await store.put(snapshot(market,'old-live',old));
  await store.put(snapshot(market,'old-demo',old-hour,'demo'));
  await store.put(snapshot(market,'new-live',Date.now()));
  await store.prune();
  const raw=await store.snapshots();
  assert.deepEqual(raw.map(item=>item.key).sort(),['new-live','old-demo']);
  const history=await store.history(1);
  assert.equal(history.length,2);
  assert.ok(history.some(item=>item.at===old-hour));
  assert.equal((await readdir(join(work,market))).filter(file=>file.startsWith('history-')).length,2);
  await store.close();
 }finally{
  if(env.url===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=env.url;
  if(env.dir===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=env.dir;
  if(env.required===undefined)delete process.env.REQUIRE_DATABASE;else process.env.REQUIRE_DATABASE=env.required;
  await rm(work,{recursive:true,force:true});
 }
});

function fakePool(options:{duplicate?:boolean;failBatch?:number}={}){
 const calls:{sql:string;values:any[]}[]=[];
 let commits=0,rollbacks=0,released=0,batches=0;
 const client={
  async beginTransaction(){},
  async execute(query:{sql:string},values:any[]){
   calls.push({sql:query.sql,values});
   if(query.sql.startsWith('INSERT INTO ah_corner_snapshots')&&options.duplicate)throw Object.assign(Error('duplicate'),{code:'ER_DUP_ENTRY'});
   if(query.sql.startsWith('INSERT INTO ah_corner_price_history')&&++batches===options.failBatch)throw Error('history insert failed');
   return [{affectedRows:1}];
  },
  async commit(){commits++;},async rollback(){rollbacks++;},release(){released++;}
 };
 return {pool:{async getConnection(){return client;}} as unknown as Pick<Pool,'getConnection'>,calls,counts:()=>({commits,rollbacks,released})};
}

test('MySQL snapshot and batched hourly history commit together and roll back failures',async()=>{
 const market='test-market';
 const book=snapshot(market,'key-1',Date.now(),'blizzard',251);
 const success=fakePool();
 assert.equal(await saveSnapshotTransaction(success.pool,market,book),true);
 const batches=success.calls.filter(call=>call.sql.startsWith('INSERT INTO ah_corner_price_history'));
 assert.equal(batches.length,2);
 assert.equal(batches[0].values.length,2500);
 assert.equal(batches[1].values.length,10);
 assert.deepEqual(success.counts(),{commits:1,rollbacks:0,released:1});

 const failure=fakePool({failBatch:2});
 await assert.rejects(()=>saveSnapshotTransaction(failure.pool,market,book),/history insert failed/);
 assert.deepEqual(failure.counts(),{commits:0,rollbacks:1,released:1});
});

test('duplicate MySQL raw books are refreshed and hourly observations still commit',async()=>{
 const market='test-market';
 const book=snapshot(market,'same-hash',Date.now());
 const duplicate=fakePool({duplicate:true});
 assert.equal(await saveSnapshotTransaction(duplicate.pool,market,book),false);
 assert.ok(duplicate.calls.some(call=>call.sql.startsWith('UPDATE ah_corner_snapshots')));
 const history=duplicate.calls.find(call=>call.sql.startsWith('INSERT INTO ah_corner_price_history'));
 assert.ok(history);
 assert.equal(history.values[4],Math.floor(book.at/hour));
 assert.equal(history.values[5],book.at);
 assert.deepEqual(duplicate.counts(),{commits:1,rollbacks:0,released:1});

 const failure=fakePool({duplicate:true,failBatch:1});
 await assert.rejects(()=>saveSnapshotTransaction(failure.pool,market,book),/history insert failed/);
 assert.deepEqual(failure.counts(),{commits:0,rollbacks:1,released:1});
});
