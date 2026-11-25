import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {defaults} from '../src/engine.ts';

test('a failed strategy write does not leak into a later user save',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ah-user-write-failure-'));
 const marketDir=join(dir,'demo-us-pvp-horde');
 const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=(probe.address() as {port:number}).port;
 await new Promise<void>(resolve=>probe.close(()=>resolve()));const origin=`http://127.0.0.1:${port}`;
 let child:ReturnType<typeof spawn>|undefined;
 async function stop(){if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}child=undefined;}
 async function start(){
  child=spawn(process.execPath,['--experimental-strip-types','--import','./tests/mock-strategy-exchange.ts','src/server.ts'],{
   env:{...process.env,NODE_ENV:'test',MODE:'demo',REQUIRE_AUTH:'true',DATABASE_URL:'',REQUIRE_DATABASE:'false',DATA_DIR:dir,PORT:String(port),HOST:'127.0.0.1',COLLECT_SCHEDULE:'interval'},stdio:['ignore','pipe','pipe']
  });
  let stderr='';child.stderr?.on('data',(chunk:Buffer)=>{stderr+=chunk.toString();});
  for(let i=0;i<100;i++){
   try{if((await fetch(`${origin}/readyz`)).ok)return;}catch{}
   if(child.exitCode!==null)break;
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw Error(`server failed to start: ${stderr}`);
 }
 async function login(code:'A'|'B'){
  const response=await fetch(`${origin}/auth/session`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({code:code.repeat(43),verifier:'v'.repeat(43)})});
  assert.equal(response.status,200);const cookie=response.headers.get('set-cookie');assert.ok(cookie);return cookie.split(';')[0];
 }
 const get=async(cookie:string)=>(await (await fetch(`${origin}/api/status`,{headers:{Cookie:cookie}})).json()).settings;
 const save=(cookie:string,value:unknown)=>fetch(`${origin}/api/settings`,{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(value)});
 try{
  await start();let alice=await login('A'),bob=await login('B');
  const aliceStrategy={...defaults,bankroll:100_000};
  const bobStrategy={...defaults,bankroll:200_000};
  // The file store atomically writes to this path. A directory forces a
  // deterministic EISDIR failure without affecting any non-test data.
  const temporaryPath=join(marketDir,'state.json.tmp');
  await mkdir(temporaryPath);
  assert.equal((await save(alice,aliceStrategy)).status,500);
  assert.deepEqual(await get(alice),defaults);
  assert.deepEqual(await get(bob),defaults);
  await rm(temporaryPath,{recursive:true});
  assert.equal((await save(bob,bobStrategy)).status,200);
  assert.deepEqual(await get(alice),defaults);
  assert.deepEqual(await get(bob),bobStrategy);
  assert.equal((await save(alice,aliceStrategy)).status,200);
  assert.deepEqual(await get(alice),aliceStrategy);
  assert.deepEqual(await get(bob),bobStrategy);
  await stop();await start();alice=await login('A');bob=await login('B');
  assert.deepEqual(await get(alice),aliceStrategy);
  assert.deepEqual(await get(bob),bobStrategy);
 }finally{await stop();await rm(dir,{recursive:true,force:true});}
});
