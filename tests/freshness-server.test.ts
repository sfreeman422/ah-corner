import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {demoSnapshots} from '../src/demo.ts';
import {defaults,scan} from '../src/engine.ts';

test('cached opportunities and addon plans become watch-only when the latest book goes stale',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ah-freshness-'));
 const marketDir=join(dir,'us_1_113');
 await mkdir(marketDir,{recursive:true});
 const snapshots=demoSnapshots().map((snapshot,index)=>({...snapshot,market:'us:1:113',source:'blizzard' as const,key:`fresh-${index}`}));
 assert.ok(scan(snapshots.at(-1)!,snapshots,defaults).some(row=>row.itemId===4402&&row.confidence==='candidate'));
 for(const snapshot of snapshots)await writeFile(join(marketDir,`snap-${snapshot.at}-${snapshot.key}.json`),JSON.stringify(snapshot));
 await writeFile(join(marketDir,'state.json'),JSON.stringify({names:{},watch:[],trades:[],alerts:[],itemUses:{4402:{kind:'profession',note:'Fixture recipe use',source:'player',updatedAt:Date.now()}}}));

 const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
 const port=(probe.address() as {port:number}).port;
 await new Promise<void>(resolve=>probe.close(()=>resolve()));
 const origin=`http://127.0.0.1:${port}`;
 const child=spawn(process.execPath,['--experimental-strip-types','--import','./tests/mock-cron-blizzard.ts','src/server.ts'],{
  env:{...process.env,NODE_ENV:'test',MODE:'live',HOUSE_ID:'113',HOUSE_VERIFIED:'true',BLIZZARD_CLIENT_ID:'mock',BLIZZARD_CLIENT_SECRET:'mock',CRON_TEST_FAILURE:'true',CRON_TEST_CONTROL:dir,REQUIRE_AUTH:'false',DATABASE_URL:'',REQUIRE_DATABASE:'false',DATA_DIR:dir,PORT:String(port),HOST:'127.0.0.1',COLLECT_SCHEDULE:'cron'},
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
  const rows=async()=>((await (await fetch(`${origin}/api/opportunities`)).json()).rows as {itemId:number;confidence:string;checks:{fresh:boolean}}[]);
  const before=(await rows()).find(row=>row.itemId===4402);
  assert.equal(before?.confidence,'candidate');
  assert.equal(before?.checks.fresh,true);
  assert.match(await (await fetch(`${origin}/api/addon.lua`)).text(),/\{id=4402,/);

  await writeFile(join(dir,'clock-offset'),String(3*3_600_000));
  const after=(await rows()).find(row=>row.itemId===4402);
  assert.equal(after?.confidence,'watch');
  assert.equal(after?.checks.fresh,false);
  const status=await (await fetch(`${origin}/api/status`)).json();
  assert.equal(status.stale,true);
  assert.doesNotMatch(await (await fetch(`${origin}/api/addon.lua`)).text(),/\{id=4402,/);
 }finally{
  child.kill('SIGTERM');
  if(child.exitCode===null)await once(child,'exit');
  await rm(dir,{recursive:true,force:true});
 }
});
