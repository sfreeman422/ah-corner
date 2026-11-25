import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

test('strategy settings validate and persist across server restarts',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ah-strategy-'));
 const probe=createServer();
 probe.listen(0,'127.0.0.1');
 await once(probe,'listening');
 const port=(probe.address() as {port:number}).port;
 await new Promise<void>(resolve=>probe.close(()=>resolve()));
 const origin=`http://127.0.0.1:${port}`;
 let child:ReturnType<typeof spawn>|undefined;
 async function stop(){
  if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}
  child=undefined;
 }
 async function start(){
  child=spawn(process.execPath,['--experimental-strip-types','src/server.ts'],{
   env:{...process.env,NODE_ENV:'test',MODE:'demo',DATABASE_URL:'',REQUIRE_DATABASE:'false',REQUIRE_AUTH:'false',DATA_DIR:dir,PORT:String(port),HOST:'127.0.0.1',COLLECT_SCHEDULE:'interval'},
   stdio:['ignore','pipe','pipe']
  });
  let stderr='';child.stderr?.on('data',(chunk:Buffer)=>{stderr+=chunk.toString();});
  for(let i=0;i<100;i++){
   try{if((await fetch(`${origin}/readyz`)).ok)return;}catch{}
   if(child.exitCode!==null)break;
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw Error(`server failed to start: ${stderr}`);
 }
 async function save(strategy:unknown){return fetch(`${origin}/api/settings`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(strategy)});}
 try{
  await start();
  const old=(await (await fetch(`${origin}/api/status`)).json()).settings;
  const next={bankroll:1_234_500,exposure:.27,minROI:.45,minProfit:25_000,fee:.05,minHistory:8};
  assert.equal((await save({...next,bankroll:0})).status,422);
  assert.equal((await save({...next,minProfit:-1})).status,422);
  assert.equal((await save({...next,exposure:1.1})).status,422);
  assert.deepEqual((await (await fetch(`${origin}/api/status`)).json()).settings,old);
  const response=await save(next);
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),next);
  assert.deepEqual((await (await fetch(`${origin}/api/status`)).json()).settings,next);
  const postUse=(data:unknown)=>fetch(`${origin}/api/item-use`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  assert.equal((await postUse({itemId:4402,kind:'profession',note:''})).status,422);
  assert.equal((await postUse({itemId:4402,kind:'profession',note:'Player checked crafting recipe'})).status,200);
  assert.equal((await (await fetch(`${origin}/api/status`)).json()).itemUses['4402'].note,'Player checked crafting recipe');
  await stop();
  await start();
  assert.deepEqual((await (await fetch(`${origin}/api/status`)).json()).settings,next);
  assert.equal((await (await fetch(`${origin}/api/status`)).json()).itemUses['4402'].kind,'profession');
  assert.equal((await postUse({itemId:4402,kind:'unknown'})).status,200);
  assert.equal((await (await fetch(`${origin}/api/status`)).json()).itemUses['4402'],undefined);
 }finally{
  await stop();
  await rm(dir,{recursive:true,force:true});
 }
});
