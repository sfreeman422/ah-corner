import {randomBytes} from 'node:crypto';

const cookieName='__Host-ah_corner_session';
const maximumLifetime=24*60*60*1_000;
const maxSessions=1_000;
export type SessionIdentity={userId:string;teamId:string};
type Identity=SessionIdentity&{expiresAt:number};

// Treat Muzzle's Slack identifiers as opaque. Bound their size and reject
// invalid control characters without assuming a particular Slack ID format.
function validIdentityPart(value:unknown):value is string{
 return typeof value==='string'&&value.length>0&&value.length<=256&&value.trim()===value&&!/[\u0000-\u001f\u007f]/.test(value);
}

export class Sessions{
 private sessions=new Map<string,Identity>();
 private exchangeUrl:string;
 private fetcher:typeof fetch;
 constructor(exchangeUrl='https://api.muzzle.lol/auth/ah/exchange',fetcher:typeof fetch=fetch){this.exchangeUrl=exchangeUrl;this.fetcher=fetcher;}

 async exchange(code:unknown,verifier:unknown):Promise<{cookie:string}|null>{
  if(typeof code!=='string'||!/^[A-Za-z0-9_-]{32,128}$/.test(code)||typeof verifier!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(verifier))return null;
  const response=await this.fetcher(this.exchangeUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code,verifier}),signal:AbortSignal.timeout(10_000),redirect:'error'});
  if(!response.ok)return null;
  let identity:Partial<Identity>;
  try{const body:unknown=await response.json();if(!body||typeof body!=='object'||Array.isArray(body))return null;identity=body as Partial<Identity>;}
  catch{return null;}
  const now=Date.now();
  if(!validIdentityPart(identity.userId)||!validIdentityPart(identity.teamId)||typeof identity.expiresAt!=='number'||!Number.isFinite(identity.expiresAt)||identity.expiresAt<=now)return null;
  const expiresAt=Math.min(identity.expiresAt,now+maximumLifetime);
  for(const [key,value] of this.sessions)if(value.expiresAt<=now)this.sessions.delete(key);
  if(this.sessions.size>=maxSessions)this.sessions.delete(this.sessions.keys().next().value!);
  const token=randomBytes(32).toString('base64url');
  this.sessions.set(token,{userId:identity.userId,teamId:identity.teamId,expiresAt});
  return {cookie:`${cookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(0,Math.floor((expiresAt-now)/1_000))}`};
 }

 private token(cookie:string|undefined):string|undefined{
  return cookie?.split(';').map(value=>value.trim()).find(value=>value.startsWith(`${cookieName}=`))?.slice(cookieName.length+1);
 }
 identity(cookie:string|undefined):SessionIdentity|null{
  const token=this.token(cookie);
  if(!token)return null;
  const identity=this.sessions.get(token);
  if(!identity)return null;
  if(identity.expiresAt<=Date.now()){this.sessions.delete(token);return null;}
  return {userId:identity.userId,teamId:identity.teamId};
 }
 valid(cookie:string|undefined):boolean{return this.identity(cookie)!==null;}
 logout(cookie:string|undefined):string{
  const token=this.token(cookie);
  if(token)this.sessions.delete(token);
  return `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
 }
}
