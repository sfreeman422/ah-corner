import assert from 'node:assert/strict';
import test from 'node:test';
import {Sessions} from '../src/auth.ts';

test('a valid exchanged code creates an isolated, revocable secure cookie session',async()=>{
 let exchanges=0;
 const fetcher:typeof fetch=async(_url,options)=>{
  exchanges++;
  assert.equal(options?.method,'POST');
  assert.deepEqual(JSON.parse(String(options?.body)),{code:'x'.repeat(43),verifier:'v'.repeat(43)});
  return new Response(JSON.stringify({userId:'U1',teamId:'T1',expiresAt:Date.now()+60_000}),{status:200});
 };
 const sessions=new Sessions('https://example.test/auth',fetcher);
 assert.equal(await sessions.exchange('invalid','v'.repeat(43)),null);
 assert.equal(await sessions.exchange('x'.repeat(43),'bad'),null);
 assert.equal(exchanges,0);
 const session=await sessions.exchange('x'.repeat(43),'v'.repeat(43));
 assert.ok(session);
 assert.match(session.cookie,/HttpOnly; Secure; SameSite=Lax/);
 const cookie=session.cookie.split(';')[0];
 assert.equal(sessions.valid(cookie),true);
 assert.equal(sessions.valid(cookie+'tampered'),false);
 sessions.logout(cookie);
 assert.equal(sessions.valid(cookie),false);
});

test('invalid, expired and rejected exchanges do not create sessions',async()=>{
 const rejected=new Sessions('https://example.test/auth',async()=>new Response('',{status:401}));
 assert.equal(await rejected.exchange('x'.repeat(43),'v'.repeat(43)),null);
 const expired=new Sessions('https://example.test/auth',async()=>new Response(JSON.stringify({userId:'U1',teamId:'T1',expiresAt:Date.now()-1})));
 assert.equal(await expired.exchange('x'.repeat(43),'v'.repeat(43)),null);
 const malformed=new Sessions('https://example.test/auth',async()=>new Response(JSON.stringify({userId:'U1',expiresAt:Date.now()+1000})));
 assert.equal(await malformed.exchange('x'.repeat(43),'v'.repeat(43)),null);
});
