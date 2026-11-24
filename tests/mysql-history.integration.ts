// Opt-in integration test against the configured, already migrated AH schema.
// Run: node --experimental-strip-types --test tests/mysql-history.integration.ts
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {createPool} from 'mysql2/promise';
import type {PoolOptions,RowDataPacket} from 'mysql2/promise';
import {openStore} from '../src/store.ts';
import type {Snapshot} from '../src/types.ts';

const hour=3_600_000;

function book(market:string,key:string,at:number,total=200):Snapshot{
 return {market,key,at,source:'demo',listings:[{id:'auction:1',itemId:42,quantity:2,total,kind:'auction',timeLeft:'LONG'}]};
}

async function cleanupOptions():Promise<PoolOptions>{
 const raw=process.env.DATABASE_URL;
 if(!raw)throw Error('DATABASE_URL is required for the opt-in MySQL integration test');
 let url:URL;
 try{url=new URL(raw);}catch{throw Error('DATABASE_URL must be a valid MySQL connection URL');}
 if(url.protocol!=='mysql:'||!url.hostname||!url.username||!url.pathname.slice(1))throw Error('DATABASE_URL must specify a MySQL host, user, and database');
 let user:string,password:string,database:string;
 try{user=decodeURIComponent(url.username);password=decodeURIComponent(url.password);database=decodeURIComponent(url.pathname.slice(1));}
 catch{throw Error('DATABASE_URL contains invalid percent encoding');}
 const options:PoolOptions={host:url.hostname,port:url.port?Number(url.port):3306,user,password,database,connectionLimit:1,connectTimeout:5000};
 const sslMode=process.env.DATABASE_SSL||'disable';
 if(sslMode==='verify-full'){
  const caFile=process.env.DATABASE_SSL_CA_FILE;
  options.ssl=caFile?{rejectUnauthorized:true,verifyIdentity:true,ca:await readFile(caFile,'utf8')}:{rejectUnauthorized:true,verifyIdentity:true};
 }else if(sslMode!=='disable'||process.env.REQUIRE_DATABASE_SSL==='true')throw Error('Invalid MySQL TLS configuration');
 return options;
}

test('MySQL stores hourly history past the raw-book limit and isolates markets',{timeout:120_000},async()=>{
 const market=`integration-${randomUUID()}`;
 const otherMarket=`integration-${randomUUID()}`;
 const pool=createPool(await cleanupOptions());
 let store:Awaited<ReturnType<typeof openStore>>|undefined;
 let other:Awaited<ReturnType<typeof openStore>>|undefined;
 let cleanupNeeded=false;
 try{
  // Never clean up a market that might have existed before this test.
  for(const table of ['ah_corner_price_history','ah_corner_snapshots']){
   const [rows]=await pool.execute<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM ${table} WHERE market=?`,[market]);
   assert.equal(Number(rows[0].total),0,'random test market must be unused');
  }
  store=await openStore(market);
  other=await openStore(otherMarket);
  assert.deepEqual(await other.history(42),[]);
  assert.deepEqual(await other.snapshots(),[]);
  const start=Math.floor(Date.now()/hour)*hour-27*hour;
  cleanupNeeded=true;
  for(let i=0;i<27;i++)assert.equal(await store.put(book(market,`key-${i}`,start+i*hour,200+i*2)),true);
  assert.equal((await store.snapshots()).length,25);
  let points=await store.history(42);
  assert.equal(points.length,27);
  assert.deepEqual(points.map(point=>point.at),Array.from({length:27},(_,i)=>start+i*hour));
  assert.deepEqual(points.map(point=>point.floor),Array.from({length:27},(_,i)=>100+i));

  const recent=start+26*hour;
  assert.equal(await store.put(book(market,'key-26',recent+5*60_000,252)),false);
  points=await store.history(42);
  assert.equal(points.length,27);
  assert.equal(points.at(-1)?.at,recent+5*60_000);
  assert.equal((await store.snapshots()).at(-1)?.at,recent+5*60_000);

  // A newer changed snapshot in the same hour replaces that hour's point.
  assert.equal(await store.put(book(market,'key-update',recent+10*60_000,998)),true);
  points=await store.history(42);
  assert.equal(points.length,27);
  assert.equal(points.at(-1)?.at,recent+10*60_000);
  assert.equal(points.at(-1)?.floor,499);

  // Once the first raw book has been trimmed, a later reversion is a new observation.
  assert.equal(await store.put(book(market,'key-0',recent+hour,200)),true);
  points=await store.history(42);
  assert.equal(points.length,28);
  assert.equal(points.at(-1)?.at,recent+hour);
  assert.equal(points.at(-1)?.floor,100);
  assert.ok(points.every((point,i)=>i===0||points[i-1].at<point.at));
  assert.equal((await store.snapshots()).length,25);
  assert.deepEqual(await other.history(42),[]);
  assert.deepEqual(await other.snapshots(),[]);
 }finally{
  try{
   if(store)await store.close();
   if(other)await other.close();
  }finally{
   try{
    if(cleanupNeeded){
     // The bound UUID market is generated above; never delete any other market or state.
     await pool.execute('DELETE FROM ah_corner_price_history WHERE market=?',[market]);
     await pool.execute('DELETE FROM ah_corner_snapshots WHERE market=?',[market]);
    }
   }finally{await pool.end();}
  }
 }
});
