import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {scan,defaults} from '../src/engine.ts';
import type {Snapshot} from '../src/types.ts';

test('API sorts all opportunities before applying its 100-row limit',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ah-sort-'));
 const market='demo-us-pvp-horde';
 const marketDir=join(dir,market);
 await mkdir(marketDir,{recursive:true});
 const at=Date.now();
 const snapshot:Snapshot={key:'sort-test',at,market,source:'demo',listings:[]};
 const names:Record<number,string>={};
 for(let i=1;i<=120;i++){
  const itemId=700_000+i,price=10+i;
  names[itemId]=`Test Item ${String(121-i).padStart(3,'0')}`;
  snapshot.listings.push({id:`auction:${2*i}`,itemId,quantity:2,total:2*price,kind:'auction',timeLeft:'LONG'});
  snapshot.listings.push({id:`auction:${2*i+1}`,itemId,quantity:2,total:2*(3*price+1),kind:'auction',timeLeft:'LONG'});
 }
 const all=scan(snapshot,[snapshot],defaults);
 assert.equal(all.length,120);
 await writeFile(join(marketDir,`snap-${at}-sort-test.json`),JSON.stringify(snapshot));
 await writeFile(join(marketDir,'state.json'),JSON.stringify({names,watch:[],trades:[],alerts:[]}));
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
  const get=async(query='')=>{const response=await fetch(`${origin}/api/opportunities${query}`);assert.equal(response.status,200);return (await response.json()).rows as {itemId:number;score:number;cost:number;profit:number}[];};
  const byScore=await get();
  assert.equal(byScore.length,100);
  assert.deepEqual(byScore.map(row=>row.itemId),[...all].sort((a,b)=>b.score-a.score||a.itemId-b.itemId).slice(0,100).map(row=>row.itemId));
  const byCost=await get('?sort=cost&direction=asc');
  assert.deepEqual(byCost.map(row=>row.itemId),[...all].sort((a,b)=>a.cost-b.cost||a.itemId-b.itemId).slice(0,100).map(row=>row.itemId));
  assert.equal(byCost[0].itemId,700_001);
  const byName=await get('?sort=name&direction=asc');
  assert.equal(byName[0].itemId,700_120);
  assert.equal((await fetch(`${origin}/api/opportunities?sort=unknown`)).status,422);
  assert.equal((await fetch(`${origin}/api/opportunities?direction=sideways`)).status,422);
 }finally{
  child.kill('SIGTERM');if(child.exitCode===null)await once(child,'exit');
  await rm(dir,{recursive:true,force:true});
 }
});
