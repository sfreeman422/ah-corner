import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {demoSnapshots,names} from '../src/demo.ts';

test('live catalog classifications persist across restart without treating missing or generic categories as trade evidence',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ah-catalog-server-'));
 const marketDir=join(dir,'us_1_113');await mkdir(marketDir,{recursive:true});
 const now=Date.now();
 const snapshots=demoSnapshots(now).map((snapshot,index)=>({...snapshot,market:'us:1:113',source:'blizzard' as const,key:`catalog-${index}`}));
 for(const snapshot of snapshots)await writeFile(join(marketDir,`snap-${snapshot.at}-${snapshot.key}.json`),JSON.stringify(snapshot));
 await writeFile(join(marketDir,'state.json'),JSON.stringify({names,namesFetchedAt:now,watch:[],trades:[],alerts:[],recipeIndex:{dataset:'fixture',build:'fixture',fetchedAt:now}}));
 const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
 const port=(probe.address() as {port:number}).port;await new Promise<void>(resolve=>probe.close(()=>resolve()));
 const origin=`http://127.0.0.1:${port}`;
 let child:ReturnType<typeof spawn>|undefined;
 async function stop(){if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}child=undefined;}
 async function start(){
  child=spawn(process.execPath,['--experimental-strip-types','--import','./tests/mock-catalog-fetch.ts','src/server.ts'],{env:{...process.env,NODE_ENV:'test',MODE:'live',HOUSE_ID:'113',HOUSE_VERIFIED:'true',REGION:'us',RULESET_ID:'1',BLIZZARD_CLIENT_ID:'mock',BLIZZARD_CLIENT_SECRET:'mock',REQUIRE_AUTH:'false',DATABASE_URL:'',REQUIRE_DATABASE:'false',DATA_DIR:dir,CATALOG_TEST_CONTROL:dir,PORT:String(port),HOST:'127.0.0.1',COLLECT_SCHEDULE:'cron'},stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr?.on('data',(chunk:Buffer)=>{stderr+=chunk.toString();});
  for(let i=0;i<160;i++){
   try{if((await fetch(`${origin}/readyz`)).ok)return;}catch{}
   if(child.exitCode!==null)break;
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw Error(`server failed to start: ${stderr}`);
 }
 async function status(){return (await (await fetch(`${origin}/api/status`)).json()) as {itemCatalog?:{dataset:string;items:Record<string,{classId:number;subclassId:number;updatedAt:number}>;missingIds?:number[]}};}
 async function rows(){return (await (await fetch(`${origin}/api/opportunities`)).json()).rows as {itemId:number;confidence:string;reasons:string[]}[];}
 async function post(value:unknown){return fetch(`${origin}/api/item-use`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});}
 async function calls(){try{return (await readFile(join(dir,'catalog-calls'),'utf8')).trim().split('\n').filter(Boolean);}catch{return [];}}
 async function waitFor(predicate:()=>Promise<boolean>){for(let i=0;i<200;i++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,50));}assert.fail('Timed out waiting for the catalog update');}
 try{
  await start();
  await waitFor(async()=>!!(await status()).itemCatalog?.items?.['4402']);
  const catalog=(await status()).itemCatalog!;
  assert.equal(catalog.dataset,'gamedata-catalog-fixture');
  assert.equal(catalog.items['4402'].classId,0);
  assert.equal(catalog.items['4402'].subclassId,5);
  assert.equal(catalog.items['3182'].classId,7);
  assert.equal(catalog.items['9144'].classId,2);
  assert.equal(catalog.items['10938'],undefined,'a missing record is not positive metadata');
  assert.ok(catalog.missingIds?.includes(10938),'successful missing results are recorded');
  await waitFor(async()=>(await rows()).find(row=>row.itemId===4402)?.confidence==='candidate');
  const visible=await rows();
  assert.equal(visible.find(row=>row.itemId===3182)?.confidence,'watch','generic trade-goods class alone does not prove useful demand');
  assert.equal(visible.find(row=>row.itemId===10561)?.confidence,'watch','miscellaneous class alone does not promote junk');
  assert.equal(visible.find(row=>row.itemId===10938)?.confidence,'watch','a missing catalog item is unknown');
  assert.ok(!(await (await fetch(`${origin}/api/backtest`)).json()).some((row:{itemId:number})=>row.itemId===4402),'a later catalog observation cannot prove a historical decision');
  assert.equal((await post({itemId:4402,kind:'exclude',note:'Not worth trading'})).status,200);
  assert.equal((await rows()).find(row=>row.itemId===4402),undefined,'player exclusions override catalog evidence');
  assert.equal((await post({itemId:4402,kind:'unknown'})).status,200);
  assert.equal((await rows()).find(row=>row.itemId===4402)?.confidence,'candidate','clearing an override restores the saved category');
  const firstSeen=catalog.items['4402'].updatedAt;
  const disk=JSON.parse(await readFile(join(marketDir,'state.json'),'utf8'));
  assert.equal(disk.itemCatalog.items['4402'].updatedAt,firstSeen);
  const firstCalls=await calls();assert.ok(firstCalls.some(value=>value.startsWith('items:')));
  for(let i=0;i<3;i++){await status();await rows();}
  assert.deepEqual(await calls(),firstCalls,'ordinary reads reuse persisted catalog data');
  await stop();await start();
  await new Promise(resolve=>setTimeout(resolve,3_500));
  assert.deepEqual(await calls(),firstCalls,'fresh catalog entries and misses survive restart without refetch');
  assert.equal((await status()).itemCatalog?.items['4402'].updatedAt,firstSeen);
  // Force a manifest refresh and simulate an upstream outage. A failed read
  // must preserve both the last valid classifications and the prior misses.
  await stop();
  const oldState=JSON.parse(await readFile(join(marketDir,'state.json'),'utf8'));
  oldState.itemCatalog.checkedAt=Date.now()-25*3_600_000;
  await writeFile(join(marketDir,'state.json'),JSON.stringify(oldState));
  await writeFile(join(dir,'catalog-fail'),'1');
  await start();
  await waitFor(async()=>(await calls()).length>firstCalls.length);
  const afterFailure=(await status()).itemCatalog!;
  assert.equal(afterFailure.items['4402'].updatedAt,firstSeen,'outage does not erase saved category');
  assert.equal(afterFailure.items['10938'],undefined,'outage does not invent category for missing item');
  assert.ok(afterFailure.missingIds?.includes(10938),'outage preserves previous successful miss');
 }finally{await stop();await rm(dir,{recursive:true,force:true});}
});
