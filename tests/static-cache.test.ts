import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import test from 'node:test';

test('frontend HTML and static assets are not stored in browser caches',async()=>{
 const work=await mkdtemp(join(tmpdir(),'ah-static-cache-'));
 const probe=createServer();
 probe.listen(0,'127.0.0.1');
 await once(probe,'listening');
 const port=(probe.address() as {port:number}).port;
 await new Promise<void>(done=>probe.close(()=>done()));
 await mkdir(join(work,'dist','assets'),{recursive:true});
 await writeFile(join(work,'dist','index.html'),'<title>AH Corner</title>');
 await writeFile(join(work,'dist','assets','app-abcdef12.js'),'console.log("AH Corner");');
 await writeFile(join(work,'dist','plain.css'),'body{}');
 const child=spawn(process.execPath,['--experimental-strip-types',resolve('src/server.ts')],{
  cwd:work,
  env:{...process.env,NODE_ENV:'test',MODE:'demo',REQUIRE_AUTH:'false',DATABASE_URL:'',REQUIRE_DATABASE:'false',DATA_DIR:join(work,'data'),PORT:String(port),HOST:'127.0.0.1'},
  stdio:['ignore','pipe','pipe']
 });
 let stderr='';
 child.stderr?.on('data',(chunk:Buffer)=>{stderr+=chunk.toString();});
 try{
  const origin=`http://127.0.0.1:${port}`;
  let started=false;
  for(let i=0;i<40;i++){
   try{if((await fetch(`${origin}/readyz`)).ok){started=true;break;}}catch{}
   if(child.exitCode!==null)break;
   await new Promise(done=>setTimeout(done,50));
  }
  assert.equal(started,true,`server failed to start: ${stderr}`);
  for(const path of ['/','/index.html','/assets/app-abcdef12.js','/plain.css']){
   const response=await fetch(`${origin}${path}`);
   assert.equal(response.status,200,path);
   assert.equal(response.headers.get('cache-control'),'no-store',path);
  }
 }finally{
  child.kill('SIGTERM');
  if(child.exitCode===null)await once(child,'exit');
  await rm(work,{recursive:true,force:true});
 }
});
