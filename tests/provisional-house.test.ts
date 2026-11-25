import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {demoSnapshots} from '../src/demo.ts';
import {defaults,scan} from '../src/engine.ts';
import type {Snapshot} from '../src/types.ts';

test('live startup rejects an unverified house without explicit opt-in',()=>{
 const child=spawnSync(process.execPath,['--experimental-strip-types','src/server.ts'],{
  encoding:'utf8',timeout:5000,
  env:{...process.env,NODE_ENV:'test',MODE:'live',HOUSE_ID:'113',HOUSE_VERIFIED:'false',ALLOW_UNVERIFIED_HOUSE:'false',DATABASE_URL:'',REQUIRE_DATABASE:'false'}
 });
 assert.notEqual(child.status,0);
 assert.match(child.stderr,/ALLOW_UNVERIFIED_HOUSE=true/);
});

async function withHouse(verified:boolean,run:(origin:string)=>Promise<void>){
 const dir=await mkdtemp(join(tmpdir(),'ah-provisional-'));
 const marketDir=join(dir,'us_1_113');
 await mkdir(marketDir,{recursive:true});
 const snapshots:Snapshot[]=demoSnapshots().map((snapshot,index)=>({...snapshot,market:'us:1:113',source:'blizzard',key:`key-${index}`}));
 assert.ok(scan(snapshots.at(-1)!,snapshots,defaults).some(value=>value.confidence==='candidate'),'fixture must contain a qualifying candidate');
 for(const snapshot of snapshots)await writeFile(join(marketDir,`snap-${snapshot.at}-${snapshot.key}.json`),JSON.stringify(snapshot));
 const recentAlert={key:'recent',at:Date.now(),itemId:4402,target:20,cost:10,profit:5,score:1};
 const itemUses={'4402':{kind:'profession',note:'Fixture crafting use',source:'player',updatedAt:Date.now()-60_000}};
 await writeFile(join(marketDir,'state.json'),JSON.stringify({names:{},watch:[],trades:[],alerts:[recentAlert],itemUses}));
 const probe=createServer();
 probe.listen(0,'127.0.0.1');
 await once(probe,'listening');
 const port=(probe.address() as {port:number}).port;
 await new Promise<void>(resolve=>probe.close(()=>resolve()));
 const origin=`http://127.0.0.1:${port}`;
 const child=spawn(process.execPath,['--experimental-strip-types','--import','./tests/mock-cron-blizzard.ts','src/server.ts'],{
  env:{...process.env,NODE_ENV:'test',MODE:'live',HOUSE_ID:'113',HOUSE_VERIFIED:String(verified),ALLOW_UNVERIFIED_HOUSE:String(!verified),BLIZZARD_CLIENT_ID:'mock',BLIZZARD_CLIENT_SECRET:'mock',CRON_TEST_FAILURE:'true',REQUIRE_AUTH:'false',DATABASE_URL:'',REQUIRE_DATABASE:'false',DATA_DIR:dir,PORT:String(port),HOST:'127.0.0.1',COLLECT_SCHEDULE:'cron'},
  stdio:['ignore','pipe','pipe']
 });
 let stderr='';child.stderr?.on('data',(chunk:Buffer)=>{stderr+=chunk.toString();});
 try{
  let started=false;
  for(let i=0;i<100;i++){
   try{if((await fetch(`${origin}/readyz`)).ok){started=true;break;}}catch{}
   if(child.exitCode!==null)break;
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.equal(started,true,`server failed to start: ${stderr}`);
  await run(origin);
 }finally{
  child.kill('SIGTERM');
  if(child.exitCode===null)await once(child,'exit');
  await rm(dir,{recursive:true,force:true});
 }
}

test('provisional data remains viewable but actionable output is disabled',async()=>{
 await withHouse(false,async origin=>{
  const status=await (await fetch(`${origin}/api/status`)).json();
  assert.equal(status.mode,'live');
  assert.equal(status.market,'us:1:113');
  assert.equal(status.houseVerified,false);
  for(const query of ['bankroll=35&roi=30','bankroll=35&roi=20']){
   const {rows}=await (await fetch(`${origin}/api/opportunities?${query}`)).json();
   assert.ok(rows.length>0);
   assert.ok(rows.every((row:{confidence:string;reasons:string[]})=>row.confidence==='watch'&&row.reasons.some(reason=>/unverified/i.test(reason))));
  }
  assert.deepEqual(await (await fetch(`${origin}/api/alerts`)).json(),[]);
  assert.deepEqual(await (await fetch(`${origin}/api/backtest`)).json(),[]);
  const plan=await (await fetch(`${origin}/api/addon.lua`)).text();
  assert.match(plan,/unverified/);
  assert.match(plan,/rows=\{\n\n\}\}/);
 });
});

test('verified live houses retain candidates, alerts and plans',async()=>{
 await withHouse(true,async origin=>{
  const status=await (await fetch(`${origin}/api/status`)).json();
  assert.equal(status.houseVerified,true);
  const {rows}=await (await fetch(`${origin}/api/opportunities?bankroll=35&roi=30`)).json();
  assert.ok(rows.some((row:{confidence:string})=>row.confidence==='candidate'));
  assert.ok(rows.filter((row:{itemId:number})=>row.itemId!==4402).every((row:{confidence:string;reasons:string[]})=>row.confidence==='watch'&&row.reasons.some(reason=>/use is unknown/i.test(reason))));
  assert.equal((await (await fetch(`${origin}/api/alerts`)).json()).length,1);
  assert.match(await (await fetch(`${origin}/api/addon.lua`)).text(),/\{id=/);
 });
});
