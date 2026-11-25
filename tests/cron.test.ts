import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {request} from 'node:http';
import {createServer} from 'node:net';
import {networkInterfaces,tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

async function withServer(failCollection:boolean,run:(origin:string,port:number,dir:string)=>Promise<void>,seed?:unknown,requireAuth=true){
 const dir=await mkdtemp(join(tmpdir(),'ah-cron-test-'));
 if(seed!==undefined){
  await mkdir(join(dir,'us_1_113'),{recursive:true});
  await writeFile(join(dir,'us_1_113','state.json'),JSON.stringify(seed));
 }
 const probe=createServer();
 probe.listen(0,'127.0.0.1');
 await once(probe,'listening');
 const port=(probe.address() as {port:number}).port;
 await new Promise<void>(resolve=>probe.close(()=>resolve()));
 const origin=`http://127.0.0.1:${port}`;
 const child=spawn(process.execPath,['--experimental-strip-types','--import','./tests/mock-cron-blizzard.ts','src/server.ts'],{
  env:{...process.env,NODE_ENV:'test',MODE:'live',HOUSE_ID:'113',HOUSE_VERIFIED:'true',BLIZZARD_CLIENT_ID:'mock',BLIZZARD_CLIENT_SECRET:'mock',REQUIRE_AUTH:String(requireAuth),DATABASE_URL:'',REQUIRE_DATABASE:'false',DATA_DIR:dir,PORT:String(port),HOST:'0.0.0.0',APP_TRUSTED_HOSTS:`ah.muzzle.lol,127.0.0.1:${port}`,COLLECT_SCHEDULE:'cron',CRON_TEST_FAILURE:String(failCollection),CRON_TEST_CONTROL:dir},
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
  // The live server makes an immediate initial refresh; wait for it to finish.
  await new Promise(resolve=>setTimeout(resolve,700));
  await run(origin,port,dir);
 }finally{
  child.kill('SIGTERM');
  if(child.exitCode===null)await once(child,'exit');
  await rm(dir,{recursive:true,force:true});
 }
}

async function rawPost(hostname:string,port:number,headers:Record<string,string>):Promise<number|undefined>{
 return new Promise((resolve,reject)=>{
  const req=request({hostname,port,path:'/internal/collect',method:'POST',headers:{'Content-Type':'application/json',...headers}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});
  req.on('error',reject);
  req.end('{}');
 });
}

test('cron endpoint requires direct loopback and awaits a single successful collection',async()=>{
 await withServer(false,async(origin,port)=>{
  const endpoint=`${origin}/internal/collect`;
  const post={method:'POST',headers:{'Content-Type':'application/json'},body:'{}'};
  assert.equal((await fetch(endpoint)).status,405);
  assert.equal((await fetch(endpoint,{...post,headers:{...post.headers,Origin:origin}})).status,404);
  assert.equal((await fetch(endpoint,{...post,headers:{...post.headers,'X-Forwarded-For':'127.0.0.1'}})).status,404);
  assert.equal(await rawPost('127.0.0.1',port,{Host:'ah.muzzle.lol'}),404);
  assert.equal((await fetch(endpoint,{method:'POST'})).status,415);
  const external=Object.values(networkInterfaces()).flat().find(item=>item?.family==='IPv4'&&!item.internal);
  if(external){
   assert.equal(await rawPost(external.address,port,{Host:`127.0.0.1:${port}`,'X-Forwarded-For':'127.0.0.1'}),404,'forwarded header cannot spoof a loopback connection');
  }
  const first=fetch(endpoint,post);
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal((await fetch(endpoint,post)).status,409,'overlapping refresh is rejected');
  const result=await first;
  assert.equal(result.status,200);
  const payload=await result.json();
  assert.equal(payload.status,'completed');
  assert.ok(payload.lastSuccess>=payload.lastChecked);
 });
});

test('cron endpoint reports collection failure rather than succeeding',async()=>{
 await withServer(true,async(origin)=>{
  const response=await fetch(`${origin}/internal/collect`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  assert.equal(response.status,503);
  const payload=await response.json();
  assert.equal(payload.error.code,'BLIZZARD_AUTH');
  assert.doesNotMatch(JSON.stringify(payload),/mock/);
 });
});

test('legacy names and old generated alerts expire without deleting user records',async()=>{
 const now=Date.now();
 const trade={id:'user-trade',itemId:999,side:'buy',quantity:1,total:1,fee:0,at:now,note:'keep'};
 const recent={key:'recent',at:now-1_000,itemId:999,target:3,cost:2,profit:1,score:1};
 const expired={...recent,key:'expired',at:now-31*24*60*60*1_000};
 await withServer(false,async(_origin,_port,dir)=>{
  const state=JSON.parse(await readFile(join(dir,'us_1_113','state.json'),'utf8'));
  assert.notEqual(state.names['999'],'Legacy cached name');
  assert.ok(state.namesFetchedAt>now);
  assert.deepEqual(state.watch,[999]);
  assert.deepEqual(state.trades,[trade]);
  assert.deepEqual(state.alerts,[recent]);
 },{names:{999:'Legacy cached name'},watch:[999],trades:[trade],alerts:[recent,expired]});
});

test('expired in-memory live books disappear from API responses and after failed collection',async()=>{
 await withServer(false,async(origin,_port,dir)=>{
  const status=async()=>await (await fetch(`${origin}/api/status`)).json();
  assert.equal((await status()).snapshots,1);
  await writeFile(join(dir,'clock-offset'),String(31*24*60*60*1_000));
  const expired=await status();
  assert.equal(expired.snapshots,0,'API removes expired raw book from memory');
  assert.equal(expired.at,null);
  const opportunities=await (await fetch(`${origin}/api/opportunities`)).json();
  assert.deepEqual(opportunities.rows,[],'cached opportunities do not survive raw book expiry');

  await writeFile(join(dir,'clock-offset'),'0');
  const post={method:'POST',headers:{'Content-Type':'application/json'},body:'{}'};
  assert.equal((await fetch(`${origin}/internal/collect`,post)).status,200);
  assert.equal((await status()).snapshots,1);
  await writeFile(join(dir,'clock-offset'),String(31*24*60*60*1_000));
  await writeFile(join(dir,'fail-collection'),'1');
  assert.equal((await fetch(`${origin}/internal/collect`,post)).status,503);
  assert.equal((await status()).snapshots,0,'failed collection does not leave expired data in memory');
 },undefined,false);
});

test('manual refresh tracks an unchanged book and reports a later failure',async()=>{
 await withServer(false,async(origin,_port,dir)=>{
  const endpoint=`${origin}/api/collect`;
  const post={method:'POST',headers:{'Content-Type':'application/json'},body:'{}'};
  const progress=async()=>(await fetch(endpoint)).json();
  const finish=async(started:number)=>{
   for(let attempt=0;attempt<80;attempt++){
    const result=await progress();
    if(!result.busy&&result.lastChecked>=started)return result;
    await new Promise(resolve=>setTimeout(resolve,25));
   }
   assert.fail('Manual refresh did not finish');
  };
  const initial=(await (await fetch(`${origin}/api/status`)).json()).at;
  const response=await fetch(endpoint,post);
  assert.equal(response.status,202);
  const {lastChecked}=await response.json();
  const duplicate=await fetch(endpoint,post);
  assert.equal(duplicate.status,202);
  assert.equal((await duplicate.json()).lastChecked,lastChecked,'joins the active collection');
  const completed=await finish(lastChecked);
  assert.ok(completed.lastSuccess>=lastChecked);
  assert.equal(completed.lastError,null);
  assert.equal(completed.changed,false);
  assert.ok((await (await fetch(`${origin}/api/status`)).json()).at>initial,'unchanged book gets a fresh observation');
  await writeFile(join(dir,'fail-collection'),'1');
  const failedStart=await (await fetch(endpoint,post)).json();
  const failure=await finish(failedStart.lastChecked);
  assert.equal(failure.lastError.code,'COLLECTION_FAILED');
  assert.equal(failure.lastSuccess,completed.lastSuccess);
 },undefined,false);
});
