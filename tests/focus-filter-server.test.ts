import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import type {Snapshot} from '../src/types.ts';

test('focused search, watchlist and named filters apply before the opportunity limit for each strategy',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ah-focus-'));
 const market='demo-us-pvp-horde';
 const marketDir=join(dir,market);
 await mkdir(marketDir,{recursive:true});
 const at=Date.now();
 const snapshot:Snapshot={key:'focus-test',at,market,source:'demo',listings:[]};
 const names:Record<number,string>={};
 for(let i=1;i<=120;i++){
  const itemId=700_000+i,price=10+i;
  if(i!==2)names[itemId]=`Test Item ${String(121-i).padStart(3,'0')}`;
  snapshot.listings.push({id:`auction:${2*i}`,itemId,quantity:2,total:2*price,kind:'auction',timeLeft:'LONG'});
  snapshot.listings.push({id:`auction:${2*i+1}`,itemId,quantity:2,total:2*(3*price+1),kind:'auction',timeLeft:'LONG'});
 }
 await writeFile(join(marketDir,`snap-${at}-focus-test.json`),JSON.stringify(snapshot));
 await writeFile(join(marketDir,'state.json'),JSON.stringify({names,watch:[700_001,700_002],trades:[],alerts:[]}));
 const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
 const port=(probe.address() as {port:number}).port;
 await new Promise<void>(resolve=>probe.close(()=>resolve()));
 const origin=`http://127.0.0.1:${port}`;
 const child=spawn(process.execPath,['--experimental-strip-types','src/server.ts'],{env:{...process.env,NODE_ENV:'test',MODE:'demo',DATABASE_URL:'',REQUIRE_DATABASE:'false',REQUIRE_AUTH:'false',DATA_DIR:dir,PORT:String(port),HOST:'127.0.0.1',COLLECT_SCHEDULE:'interval'},stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr?.on('data',(chunk:Buffer)=>{stderr+=chunk.toString();});
 try{
  let started=false;
  for(let i=0;i<100;i++){
   try{if((await fetch(`${origin}/readyz`)).ok){started=true;break;}}catch{}
   if(child.exitCode!==null)break;
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.equal(started,true,`server failed to start: ${stderr}`);
  const get=async(query:string)=>{const response=await fetch(`${origin}/api/opportunities?${query}`);assert.equal(response.status,200);return (await response.json()).rows as {itemId:number}[];};
  for(const strategy of ['monopolization','flipping']){
   const base=`strategy=${strategy}&sort=cost&direction=desc`;
   assert.equal((await get(base)).length,100);
   assert.ok(!(await get(base)).some(row=>row.itemId===700_001),'focused item initially lies beyond the limit');
   assert.deepEqual((await get(`${base}&q=TeSt%20ItEm%20120`)).map(row=>row.itemId),[700_001]);
   assert.deepEqual((await get(`${base}&q=700001`)).map(row=>row.itemId),[700_001]);
   assert.deepEqual((await get(`${base}&watch=1`)).map(row=>row.itemId),[700_002,700_001]);
   assert.deepEqual((await get(`${base}&watch=1&named=1`)).map(row=>row.itemId),[700_001]);
   assert.deepEqual((await get(`${base}&watch=1&q=700002`)).map(row=>row.itemId),[700_002]);
   assert.deepEqual((await get(`${base}&watch=1&named=1&q=700002`)).map(row=>row.itemId),[700_002], 'an exact item ID remains discoverable before its name is cached');
   assert.deepEqual((await get(`${base}&watch=1&named=1&q=70000`)).map(row=>row.itemId),[700_001], 'a partial ID does not bypass the named-only filter');
   assert.equal((await get(`${base}&named=1`)).length,100,'unnamed results do not consume named slots');
  }
  assert.equal((await fetch(`${origin}/api/opportunities?watch=true`)).status,422);
  assert.equal((await fetch(`${origin}/api/opportunities?named=yes`)).status,422);
  assert.equal((await fetch(`${origin}/api/opportunities?q=${'x'.repeat(121)}`)).status,422);
 }finally{
  child.kill('SIGTERM');if(child.exitCode===null)await once(child,'exit');
  await rm(dir,{recursive:true,force:true});
 }
});
