import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {once} from 'node:events';

test('hosted API requires a session, enforces origins and rejects replay',async()=>{
 const dataDir=await mkdtemp(join(tmpdir(),'ah-auth-test-'));
 const probe=createServer();
 probe.listen(0,'127.0.0.1');
 await once(probe,'listening');
 const port=(probe.address() as {port:number}).port;
 await new Promise<void>(resolve=>probe.close(()=>resolve()));
 const origin=`http://127.0.0.1:${port}`;
 const child=spawn(process.execPath,['--experimental-strip-types','--import','./tests/mock-auth-upstream.ts','src/server.ts'],{
  env:{...process.env,NODE_ENV:'test',MODE:'demo',REQUIRE_AUTH:'true',DATABASE_URL:'',REQUIRE_DATABASE:'false',DATA_DIR:dataDir,PORT:String(port),HOST:'127.0.0.1',APP_TRUSTED_ORIGINS:origin},
  stdio:['ignore','pipe','pipe']
 });
 let stderr='';child.stderr?.on('data',(chunk:Buffer)=>{stderr+=chunk.toString();});
 try{
  let started=false;
  for(let i=0;i<40;i++){
   try{const response=await fetch(`${origin}/readyz`);if(response.ok){started=true;break;}}catch{}
   if(child.exitCode!==null)break;
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.equal(started,true,`server failed to start: ${stderr}`);
  assert.equal((await fetch(`${origin}/readyz`)).status,200);
  assert.equal((await fetch(`${origin}/api/status`)).status,401);
  assert.equal((await fetch(`${origin}/api/settings`,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:'{}'})).status,401);
  assert.equal((await fetch(`${origin}/api/item-use`,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:'{}'})).status,401);
  const code='x'.repeat(43);
  const payload=JSON.stringify({code,verifier:'v'.repeat(43)});
  assert.equal((await fetch(`${origin}/auth/session`,{method:'POST',headers:{'Content-Type':'application/json'},body:payload})).status,403);
  assert.equal((await fetch(`${origin}/auth/session`,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.example'},body:payload})).status,403);
  const login=await fetch(`${origin}/auth/session`,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:payload});
  assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  assert.equal((await fetch(`${origin}/auth/session`,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:payload})).status,401);
  assert.equal((await fetch(`${origin}/api/status`,{headers:{Cookie:cookie}})).status,200);
  assert.equal((await fetch(`${origin}/api/watch`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:'{"itemId":1}'})).status,403);
  const logout=await fetch(`${origin}/auth/session`,{method:'DELETE',headers:{'Content-Type':'application/json',Origin:origin,Cookie:cookie},body:'{}'});
  assert.equal(logout.status,200);
  assert.equal((await fetch(`${origin}/api/status`,{headers:{Cookie:cookie}})).status,401);
 }finally{
  child.kill('SIGTERM');
  if(child.exitCode===null)await once(child,'exit');
  await rm(dataDir,{recursive:true,force:true});
 }
});
