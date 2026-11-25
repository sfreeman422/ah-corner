import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {demoSnapshots} from '../src/demo.ts';
import {defaults} from '../src/engine.ts';

test('personal scan becomes stale even when the shared baseline has no opportunities',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ah-user-freshness-'));
 const marketDir=join(dir,'us_1_113');await mkdir(marketDir,{recursive:true});
 const snapshots=demoSnapshots().map((snapshot,index)=>({...snapshot,market:'us:1:113',source:'blizzard',key:`fresh-user-${index}`}));
 for(const snapshot of snapshots)await writeFile(join(marketDir,`snap-${snapshot.at}-${snapshot.key}.json`),JSON.stringify(snapshot));
 await writeFile(join(marketDir,'state.json'),JSON.stringify({names:{},watch:[],trades:[],alerts:[],strategy:{...defaults,bankroll:1},itemUses:{4402:{kind:'profession',note:'Fixture recipe use',source:'player',updatedAt:Date.now()-60_000}}}));
 const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=(probe.address() as {port:number}).port;
 await new Promise<void>(resolve=>probe.close(()=>resolve()));const origin=`http://127.0.0.1:${port}`;
 const child=spawn(process.execPath,['--experimental-strip-types','--import','./tests/mock-cron-blizzard.ts','--import','./tests/mock-strategy-exchange.ts','src/server.ts'],{
  env:{...process.env,NODE_ENV:'test',MODE:'live',HOUSE_ID:'113',HOUSE_VERIFIED:'true',BLIZZARD_CLIENT_ID:'mock',BLIZZARD_CLIENT_SECRET:'mock',CRON_TEST_FAILURE:'true',CRON_TEST_CONTROL:dir,REQUIRE_AUTH:'true',DATABASE_URL:'',REQUIRE_DATABASE:'false',DATA_DIR:dir,PORT:String(port),HOST:'127.0.0.1',COLLECT_SCHEDULE:'cron'},stdio:['ignore','pipe','pipe']
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
  const login=await fetch(`${origin}/auth/session`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({code:'A'.repeat(43),verifier:'v'.repeat(43)})});
  assert.equal(login.status,200);const setCookie=login.headers.get('set-cookie');assert.ok(setCookie);const cookie=setCookie.split(';')[0];
  const request=(path:string)=>fetch(`${origin}${path}`,{headers:{Cookie:cookie}});
  const response=await fetch(`${origin}/api/settings`,{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(defaults)});
  assert.equal(response.status,200);
  const rows=async()=>((await (await request('/api/opportunities')).json()).rows as {itemId:number;confidence:string;checks:{fresh:boolean}}[]);
  const fresh=(await rows()).find(row=>row.itemId===4402);
  assert.equal(fresh?.confidence,'candidate');assert.equal(fresh.checks.fresh,true);
  await writeFile(join(dir,'clock-offset'),String(3*3_600_000));
  const stale=(await rows()).find(row=>row.itemId===4402);
  assert.equal(stale?.confidence,'watch');assert.equal(stale.checks.fresh,false);
  assert.doesNotMatch(await (await request('/api/addon.lua')).text(),/\{id=4402,/);
 }finally{child.kill('SIGTERM');if(child.exitCode===null)await once(child,'exit');await rm(dir,{recursive:true,force:true});}
});
