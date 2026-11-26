import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {demoSnapshots} from '../src/demo.ts';
import {defaults,stats} from '../src/engine.ts';

test('authenticated strategies are isolated by Slack user and workspace and survive re-login and restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ah-user-strategy-'));
 const marketDir=join(dir,'us_1_113');
 await mkdir(marketDir,{recursive:true});
 const snapshots=demoSnapshots().map((snapshot,index)=>({...snapshot,market:'us:1:113',source:'blizzard',key:`user-fixture-${index}`}));
 for(const snapshot of snapshots){
  await writeFile(join(marketDir,`snap-${snapshot.at}-${snapshot.key}.json`),JSON.stringify(snapshot));
  const point=stats(snapshot.listings.filter(listing=>listing.itemId===4402),snapshot.at);
  await writeFile(join(marketDir,`history-${Math.floor(snapshot.at/3_600_000)}.json`),JSON.stringify({at:snapshot.at,key:snapshot.key,source:snapshot.source,items:{4402:point}}));
 }
 const legacy={...defaults,bankroll:350_000};
 await writeFile(join(marketDir,'state.json'),JSON.stringify({names:{},watch:[],trades:[],alerts:[],strategy:legacy,itemUses:{4402:{kind:'profession',note:'Fixture recipe use',source:'player',updatedAt:Date.now()-15*3_600_000}}}));
 const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
 const port=(probe.address() as {port:number}).port;
 await new Promise<void>(resolve=>probe.close(()=>resolve()));
 const origin=`http://127.0.0.1:${port}`;
 let child:ReturnType<typeof spawn>|undefined;
 async function stop(){if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}child=undefined;}
 async function start(){
  child=spawn(process.execPath,['--experimental-strip-types','--import','./tests/mock-cron-blizzard.ts','--import','./tests/mock-strategy-exchange.ts','src/server.ts'],{
   env:{...process.env,NODE_ENV:'test',MODE:'live',HOUSE_ID:'113',HOUSE_VERIFIED:'true',BLIZZARD_CLIENT_ID:'mock',BLIZZARD_CLIENT_SECRET:'mock',CRON_TEST_FAILURE:'true',REQUIRE_AUTH:'true',DATABASE_URL:'',REQUIRE_DATABASE:'false',DATA_DIR:dir,PORT:String(port),HOST:'127.0.0.1',COLLECT_SCHEDULE:'cron'},stdio:['ignore','pipe','pipe']
  });
  let stderr='';child.stderr?.on('data',(chunk:Buffer)=>{stderr+=chunk.toString();});
  for(let i=0;i<100;i++){
   try{if((await fetch(`${origin}/readyz`)).ok)return;}catch{}
   if(child.exitCode!==null)break;
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw Error(`server failed to start: ${stderr}`);
 }
 async function signIn(code:'A'|'B'|'C'){
  const response=await fetch(`${origin}/auth/session`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({code:code.repeat(43),verifier:'v'.repeat(43)})});
  assert.equal(response.status,200);
  const cookie=response.headers.get('set-cookie');assert.ok(cookie);return cookie.split(';')[0];
 }
 const get=(cookie:string,path:string)=>fetch(`${origin}${path}`,{headers:{Cookie:cookie}});
 const post=(cookie:string,path:string,body:unknown)=>fetch(`${origin}${path}`,{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(body)});
 const settings=async(cookie:string)=>(await (await get(cookie,'/api/status')).json()).settings;
 const rows=async(cookie:string)=>(await (await get(cookie,'/api/opportunities')).json()).rows as {itemId:number}[];
 try{
  await start();
  assert.equal((await fetch(`${origin}/api/status`)).status,401);
  assert.equal((await post('', '/api/settings',legacy)).status,401);
  let alice=await signIn('A'),bob=await signIn('B'),otherTeam=await signIn('C');
  assert.deepEqual(await settings(alice),legacy);
  assert.deepEqual(await settings(bob),legacy);
  assert.deepEqual(await settings(otherTeam),legacy);
  const aliceStrategy={...legacy,bankroll:100_000};
  const bobStrategy={...legacy,bankroll:350_000,minROI:.31};
  // Untrusted body fields cannot choose which user's strategy is saved.
  const [aliceSave,bobSave]=await Promise.all([
   post(alice,'/api/settings',{...aliceStrategy,userId:'U123ABC2',teamId:'T123ABC1'}),
   post(bob,'/api/settings',bobStrategy)
  ]);
  assert.equal(aliceSave.status,200);assert.deepEqual(await aliceSave.json(),aliceStrategy);
  assert.equal(bobSave.status,200);assert.deepEqual(await bobSave.json(),bobStrategy);
  const targetPath='/api/monopoly-target';
  assert.equal((await post('',targetPath,{itemId:4402})).status,401);
  assert.equal((await post(alice,targetPath,{itemId:-1})).status,422);
  assert.equal((await post(alice,targetPath,{itemId:4402,userId:'U123ABC2'})).status,200);
  assert.equal((await post(bob,targetPath,{itemId:999999})).status,200);
  const getTarget=async(cookie:string)=>(await get(cookie,targetPath)).json();
  const tracked=await getTarget(alice);
  assert.equal(tracked.itemId,4402);
  assert.equal(tracked.floor,700);
  assert.ok(tracked.units>0&&tracked.history.length>0);
  const unlisted=await getTarget(bob);
  assert.equal(unlisted.itemId,999999);
  assert.equal(unlisted.floor,null);
  assert.equal(unlisted.units,0);
  assert.deepEqual(unlisted.history,[]);
  assert.equal(await getTarget(otherTeam),null);
  assert.deepEqual(await settings(alice),aliceStrategy);
  assert.deepEqual(await settings(bob),bobStrategy);
  assert.deepEqual(await settings(otherTeam),legacy,'same Slack user ID in a different workspace must not share settings');
  assert.ok(!(await rows(alice)).some(row=>row.itemId===4402));
  assert.ok((await rows(bob)).some(row=>row.itemId===4402));
  const flipRows=async(cookie:string)=>(await (await get(cookie,'/api/opportunities?strategy=flipping&roi=0')).json()).rows as {itemId:number;flip?:unknown}[];
  assert.ok(!(await flipRows(alice)).some(row=>row.itemId===4402),'flip respects Alice’s smaller bankroll');
  assert.ok((await flipRows(bob)).some(row=>row.itemId===4402&&row.flip),'flip scan uses Bob’s bankroll');
  assert.ok(!(await flipRows(alice)).some(row=>row.itemId===4402),'cached Bob scan cannot leak into Alice’s results');
  assert.doesNotMatch(await (await get(alice,'/api/addon.lua')).text(),/\{id=4402,/);
  assert.match(await (await get(bob,'/api/addon.lua')).text(),/\{id=4402,/);
  assert.ok(!(await (await get(alice,'/api/backtest')).json()).some((row:{itemId:number})=>row.itemId===4402));
  assert.ok((await (await get(bob,'/api/backtest')).json()).some((row:{itemId:number})=>row.itemId===4402));
  // Query/body fields never select another account's strategy.
  assert.deepEqual((await (await get(alice,'/api/status?userId=U123ABC2&teamId=T123ABC1')).json()).settings,aliceStrategy);
  const aliceAgain=await signIn('A');
  assert.deepEqual(await settings(aliceAgain),aliceStrategy);
  await stop();await start();
  assert.equal((await get(alice,'/api/status')).status,401,'a restart must not turn a stale session into another user');
  alice=await signIn('A');bob=await signIn('B');otherTeam=await signIn('C');
  assert.equal((await getTarget(alice)).itemId,4402);
  assert.equal((await getTarget(bob)).itemId,999999);
  assert.equal((await post(bob,targetPath,{itemId:null})).status,200);
  assert.equal(await getTarget(bob),null);
  assert.equal((await getTarget(alice)).itemId,4402);

  assert.deepEqual(await settings(alice),aliceStrategy);
  assert.deepEqual(await settings(bob),bobStrategy);
  assert.deepEqual(await settings(otherTeam),legacy);
  assert.doesNotMatch(await (await get(alice,'/api/addon.lua')).text(),/\{id=4402,/);
  assert.match(await (await get(bob,'/api/addon.lua')).text(),/\{id=4402,/);
 }finally{await stop();await rm(dir,{recursive:true,force:true});}
});
