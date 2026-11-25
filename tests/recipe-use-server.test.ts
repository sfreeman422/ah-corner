import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

test('saved recipe evidence persists and player exclusion overrides and restores it',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ah-recipe-use-'));
 const marketDir=join(dir,'demo-us-pvp-horde');
 await mkdir(marketDir,{recursive:true});
 const recipe={kind:'profession',source:'warcraftforever-recipe',note:'1 required for Example Recipe',updatedAt:Date.now()-60_000,recipeId:3915,profession:'Tailoring',dataset:'gamedata-example'};
 await writeFile(join(marketDir,'state.json'),JSON.stringify({names:{},trades:[],alerts:[],watch:[],recipeUses:{4402:recipe},recipeIndex:{dataset:recipe.dataset,build:'fixture',fetchedAt:recipe.updatedAt}}));
 const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
 const port=(probe.address() as {port:number}).port;
 await new Promise<void>(resolve=>probe.close(()=>resolve()));
 const origin=`http://127.0.0.1:${port}`;
 let child:ReturnType<typeof spawn>|undefined;
 async function stop(){if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}child=undefined;}
 async function start(){
  child=spawn(process.execPath,['--experimental-strip-types','src/server.ts'],{env:{...process.env,NODE_ENV:'test',MODE:'demo',DATABASE_URL:'',REQUIRE_DATABASE:'false',REQUIRE_AUTH:'false',DATA_DIR:dir,PORT:String(port),HOST:'127.0.0.1',COLLECT_SCHEDULE:'interval'},stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr?.on('data',(chunk:Buffer)=>{stderr+=chunk.toString();});
  for(let i=0;i<100;i++){
   try{if((await fetch(`${origin}/readyz`)).ok)return;}catch{}
   if(child.exitCode!==null)break;
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw Error(`server failed to start: ${stderr}`);
 }
 async function status(){return (await fetch(`${origin}/api/status`)).json();}
 async function opportunities(){return (await (await fetch(`${origin}/api/opportunities`)).json()).rows as {itemId:number;confidence:string;reasons:string[]}[];}
 async function post(value:unknown){return fetch(`${origin}/api/item-use`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});}
 try{
  await start();
  assert.deepEqual((await status()).recipeUses['4402'],recipe);
  let row=(await opportunities()).find(value=>value.itemId===4402);
  assert.equal(row?.confidence,'candidate');
  assert.match(row!.reasons[0],/Warcraft Forever recipe data/);
  assert.equal((await post({itemId:4402,kind:'exclude',note:'Not worth trading'})).status,200);
  assert.equal((await opportunities()).find(value=>value.itemId===4402),undefined);
  await stop();await start();
  assert.deepEqual((await status()).recipeUses['4402'],recipe);
  assert.equal((await status()).itemUses['4402'].kind,'exclude');
  assert.equal((await opportunities()).find(value=>value.itemId===4402),undefined);
  assert.equal((await post({itemId:4402,kind:'unknown'})).status,200);
  row=(await opportunities()).find(value=>value.itemId===4402);
  assert.equal(row?.confidence,'candidate');
  assert.match(row!.reasons[0],/Warcraft Forever recipe data/);
  await stop();await start();
  assert.deepEqual((await status()).recipeUses['4402'],recipe);
  assert.equal((await status()).itemUses['4402'],undefined);
  assert.equal((await opportunities()).find(value=>value.itemId===4402)?.confidence,'candidate');
 }finally{await stop();await rm(dir,{recursive:true,force:true});}
});
