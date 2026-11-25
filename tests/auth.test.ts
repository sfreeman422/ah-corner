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
 assert.deepEqual(sessions.identity(cookie),{userId:'U1',teamId:'T1'});
 const identity=sessions.identity(cookie)!;
 identity.userId='changed';
 assert.deepEqual(sessions.identity(cookie),{userId:'U1',teamId:'T1'},'callers cannot mutate the stored identity');
 assert.equal(sessions.valid(cookie+'tampered'),false);
 assert.equal(sessions.identity(cookie+'tampered'),null);
 sessions.logout(cookie);
 assert.equal(sessions.valid(cookie),false);
 assert.equal(sessions.identity(cookie),null);
});

test('invalid, expired and rejected exchanges do not create sessions',async()=>{
 const rejected=new Sessions('https://example.test/auth',async()=>new Response('',{status:401}));
 assert.equal(await rejected.exchange('x'.repeat(43),'v'.repeat(43)),null);
 const expired=new Sessions('https://example.test/auth',async()=>new Response(JSON.stringify({userId:'U1',teamId:'T1',expiresAt:Date.now()-1})));
 assert.equal(await expired.exchange('x'.repeat(43),'v'.repeat(43)),null);
 const malformed=new Sessions('https://example.test/auth',async()=>new Response(JSON.stringify({userId:'U1',expiresAt:Date.now()+1000})));
 assert.equal(await malformed.exchange('x'.repeat(43),'v'.repeat(43)),null);
});

test('sessions expose only the authenticated unexpired user and workspace',async()=>{
 let userId='U1',teamId='T1';
 const sessions=new Sessions('https://example.test/auth',async()=>Response.json({userId,teamId,expiresAt:Date.now()+60_000}));
 const first=await sessions.exchange('x'.repeat(43),'v'.repeat(43));
 userId='U2';teamId='T2';
 const second=await sessions.exchange('y'.repeat(43),'v'.repeat(43));
 assert.ok(first&&second);
 const firstCookie=first.cookie.split(';')[0],secondCookie=second.cookie.split(';')[0];
 assert.deepEqual(sessions.identity(firstCookie),{userId:'U1',teamId:'T1'});
 assert.deepEqual(sessions.identity(secondCookie),{userId:'U2',teamId:'T2'});
 sessions.logout(firstCookie);
 assert.equal(sessions.identity(firstCookie),null);
 assert.deepEqual(sessions.identity(secondCookie),{userId:'U2',teamId:'T2'});
});

test('session exchange rejects malformed or unbounded identity fields and invalid JSON',async()=>{
 const invalid:unknown[]=[null,[],{}, {userId:'',teamId:'T1'}, {userId:' ',teamId:'T1'}, {userId:'U\n1',teamId:'T1'}, {userId:'U'.repeat(257),teamId:'T1'}, {userId:'U1',teamId:'T\u0000'}, {userId:'U1',teamId:' T1'}];
 for(const body of invalid){
  const sessions=new Sessions('https://example.test/auth',async()=>Response.json(body&&typeof body==='object'&&!Array.isArray(body)?{...body,expiresAt:Date.now()+60_000}:body));
  assert.equal(await sessions.exchange('x'.repeat(43),'v'.repeat(43)),null);
 }
 const invalidJson=new Sessions('https://example.test/auth',async()=>new Response('not JSON'));
 assert.equal(await invalidJson.exchange('x'.repeat(43),'v'.repeat(43)),null);
});

test('expired sessions never return a user identity',async()=>{
 const original=Date.now;
 let now=original();
 Date.now=()=>now;
 try{
  const sessions=new Sessions('https://example.test/auth',async()=>Response.json({userId:'U1',teamId:'T1',expiresAt:now+60_000}));
  const session=await sessions.exchange('x'.repeat(43),'v'.repeat(43));
  assert.ok(session);
  const cookie=session.cookie.split(';')[0];
  assert.ok(sessions.identity(cookie));
  now+=60_001;
  assert.equal(sessions.identity(cookie),null);
  assert.equal(sessions.valid(cookie),false);
 }finally{Date.now=original;}
});
