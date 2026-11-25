import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {iterateMysqlSnapshots,openStore} from '../src/store.ts';
import type {Snapshot} from '../src/types.ts';

const book=(key:string,at:number):Snapshot=>({key,at,market:'us:1:113',source:'blizzard',listings:[{id:`auction:${key}`,itemId:2589,quantity:2,total:100,kind:'auction',timeLeft:'LONG'}]});

test('MySQL iterator fetches one book at a time, in chronological order',async()=>{
 const calls:string[]=[];
 const books:Record<string,Snapshot>={one:book('one',1),two:book('two',2),three:book('three',3)};
 const database={execute:async(query:{sql:string},values:unknown[])=>{
  calls.push(query.sql);
  assert.equal(values[0],'us:1:113');
  if(query.sql.includes('SELECT snapshot_key'))return [[{snapshot_key:'three'},{snapshot_key:'two'},{snapshot_key:'one'}],[]];
  assert.match(query.sql,/WHERE market=\? AND snapshot_key=\?/);
  return [[{data:JSON.stringify(books[String(values[1])])}],[]];
 }};
 const iterator=iterateMysqlSnapshots(database as never,'us:1:113');
 assert.equal((await iterator.next()).value?.key,'one');
 assert.equal(calls.length,2,'requesting one result must not fetch later books');
 assert.equal((await iterator.next()).value?.key,'two');
 assert.equal(calls.length,3);
 await iterator.return(undefined);
 assert.equal(calls.length,3,'stopping must not fetch the remaining books');
});

test('MySQL iterator rejects a book removed between metadata and data reads',async()=>{
 const database={execute:async(query:{sql:string},values:unknown[])=>{
  if(query.sql.includes('SELECT snapshot_key'))return [[{snapshot_key:'two'},{snapshot_key:'one'}],[]];
  return [values[1]==='one'?[]:[{data:JSON.stringify(book('two',2))}],[]];
 }};
 const entries:Snapshot[]=[];
 await assert.rejects(async()=>{for await(const snapshot of iterateMysqlSnapshots(database as never,'us:1:113'))entries.push(snapshot);},/snapshot disappeared/i);
 assert.deepEqual(entries,[]);
});

test('file snapshots can be iterated and loaded by exact key after an overwrite',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ah-snapshot-read-'));
 const previousUrl=process.env.DATABASE_URL,previousRequired=process.env.REQUIRE_DATABASE,previousDir=process.env.DATA_DIR;
 delete process.env.DATABASE_URL;process.env.REQUIRE_DATABASE='false';process.env.DATA_DIR=dir;
 try{
  const store=await openStore('us:1:113');
  const now=Date.now();
  await store.put(book('alpha:one',now-2_000));
  await store.put(book('other-one',now-1_000));
  await store.put(book('alpha:one',now));
  const entries:Snapshot[]=[];
  for await(const snapshot of store.iterSnapshots())entries.push(snapshot);
  assert.deepEqual(entries.map(entry=>entry.key),['other-one','alpha:one']);
  assert.equal((await store.getSnapshot('alpha:one'))?.at,now);
  assert.equal(await store.getSnapshot('one'),null,'a suffix must not match a different key');
  assert.equal(await store.getSnapshot('missing'),null);
  await store.close();
 }finally{
  if(previousUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previousUrl;
  if(previousRequired===undefined)delete process.env.REQUIRE_DATABASE;else process.env.REQUIRE_DATABASE=previousRequired;
  if(previousDir===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=previousDir;
  await rm(dir,{recursive:true,force:true});
 }
});
