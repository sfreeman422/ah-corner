import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {demoSnapshots,names} from '../src/demo.ts';
import {defaults,scan} from '../src/engine.ts';

test('live metadata backfills named items, persists misses, and respects research and time',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ah-metadata-server-'));
 const marketDir=join(dir,'us_1_113');await mkdir(marketDir,{recursive:true});
 const now=Date.now();
 const snapshots=demoSnapshots(now).map((snapshot,index)=>({...snapshot,market:'us:1:113',source:'blizzard' as const,key:`meta-${index}`}));
 assert.ok(scan(snapshots.at(-1)!,snapshots,defaults).some(row=>row.itemId===4402&&row.confidence==='candidate'));
 for(const snapshot of snapshots)await writeFile(join(marketDir,`snap-${snapshot.at}-${snapshot.key}.json`),JSON.stringify(snapshot));
 await writeFile(join(marketDir,'state.json'),JSON.stringify({names,namesFetchedAt:now,watch:[4402,3182,10938],trades:[],alerts:[],recipeIndex:{dataset:'fixture',build:'fixture',fetchedAt:now}}));
 const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
 const port=(probe.address() as {port:number}).port;await new Promise<void>(resolve=>probe.close(()=>resolve()));
 const origin=`http://127.0.0.1:${port}`;
 let child:ReturnType<typeof spawn>|undefined;
 async function stop(){if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}child=undefined;}
 async function start(){
  child=spawn(process.execPath,['--experimental-strip-types','--import','./tests/mock-metadata-fetch.ts','src/server.ts'],{env:{...process.env,NODE_ENV:'test',MODE:'live',HOUSE_ID:'113',HOUSE_VERIFIED:'true',REGION:'us',RULESET_ID:'1',BLIZZARD_CLIENT_ID:'mock',BLIZZARD_CLIENT_SECRET:'mock',REQUIRE_AUTH:'false',DATABASE_URL:'',REQUIRE_DATABASE:'false',DATA_DIR:dir,METADATA_TEST_CONTROL:dir,PORT:String(port),HOST:'127.0.0.1',COLLECT_SCHEDULE:'cron'},stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr?.on('data',(chunk:Buffer)=>{stderr+=chunk.toString();});
  for(let i=0;i<120;i++){
   try{if((await fetch(`${origin}/readyz`)).ok)return;}catch{}
   if(child.exitCode!==null)break;
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw Error(`server failed to start: ${stderr}`);
 }
 async function status(){return (await (await fetch(`${origin}/api/status`)).json()) as {blizzardMetadata:Record<string,{classId:number|null;subclassId:number|null;checkedAt:number;updatedAt:number}>};}
 async function rows(){return (await (await fetch(`${origin}/api/opportunities`)).json()).rows as {itemId:number;confidence:string;reasons:string[]}[];}
 async function post(body:unknown){return fetch(`${origin}/api/item-use`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});}
 async function calls(){try{return (await readFile(join(dir,'metadata-calls'),'utf8')).trim().split('\n').filter(Boolean);}catch{return [];}}
 async function waitFor(predicate:()=>Promise<boolean>){for(let i=0;i<150;i++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,25));}assert.fail('Timed out waiting for background metadata');}
 try{
  await start();
  await waitFor(async()=>{const s=await status();return s.blizzardMetadata?.['4402']?.subclassId===5&&s.blizzardMetadata?.['3182']?.classId===null&&(await calls()).includes('10938');});
  const saved=(await status()).blizzardMetadata;
  assert.equal(saved['4402'].classId,0);assert.equal(saved['4402'].subclassId,5);
  assert.equal(saved['3182'].classId,null,'404 is remembered as an inconclusive lookup');
  assert.equal(saved['10938'],undefined,'transient upstream errors must never become negative evidence');
  await waitFor(async()=>!!(await rows()).find(row=>row.itemId===4402&&row.confidence==='candidate'&&row.reasons.some(reason=>/Blizzard Forever.*food or drink/i.test(reason))));
  assert.ok(!(await (await fetch(`${origin}/api/backtest`)).json()).some((row:{itemId:number})=>row.itemId===4402),'a later metadata discovery cannot prove a historical decision');
  const disk=JSON.parse(await readFile(join(marketDir,'state.json'),'utf8'));
  assert.equal(disk.blizzardMetadata['4402'].subclassId,5);
  const before=await calls();
  for(let i=0;i<5;i++){await status();await rows();}
  const after=await calls();
  for(const id of ['4402','3182','10938'])assert.equal(after.filter(value=>value===id).length,before.filter(value=>value===id).length,`polls must not refetch ${id}`);
  assert.equal((await post({itemId:4402,kind:'quest',note:'Player checked quest'})).status,200);
  assert.match((await rows()).find(row=>row.itemId===4402)!.reasons[0],/Player-noted quest/);
  assert.equal((await post({itemId:4402,kind:'exclude',note:'Player excluded item'})).status,200);
  assert.equal((await rows()).find(row=>row.itemId===4402),undefined);
  assert.equal((await post({itemId:4402,kind:'unknown'})).status,200);
  assert.match((await rows()).find(row=>row.itemId===4402)!.reasons[0],/Blizzard Forever.*food or drink/i);
  await stop();await start();
  await waitFor(async()=>(await calls()).filter(value=>value==='10938').length>after.filter(value=>value==='10938').length);
  const restarted=await calls();
  for(const id of ['4402','3182'])assert.equal(restarted.filter(value=>value===id).length,before.filter(value=>value===id).length,`persisted metadata for ${id} survives restart`);
  assert.equal((await status()).blizzardMetadata['4402'].subclassId,5);
 }finally{await stop();await rm(dir,{recursive:true,force:true});}
});
