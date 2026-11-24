import {randomBytes} from 'node:crypto';

const cookieName='__Host-ah_corner_session';
const maximumLifetime=24*60*60*1_000;
const maxSessions=1_000;
type Identity={userId:string;teamId:string;expiresAt:number};

export class Sessions{
 private sessions=new Map<string,Identity>();
 private exchangeUrl:string;
 private fetcher:typeof fetch;
 constructor(exchangeUrl='https://api.muzzle.lol/auth/ah/exchange',fetcher:typeof fetch=fetch){this.exchangeUrl=exchangeUrl;this.fetcher=fetcher;}

 async exchange(code:unknown,verifier:unknown):Promise<{cookie:string}|null>{
  if(typeof code!=='string'||!/^[A-Za-z0-9_-]{32,128}$/.test(code)||typeof verifier!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(verifier))return null;
  const response=await this.fetcher(this.exchangeUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code,verifier}),signal:AbortSignal.timeout(10_000),redirect:'error'});
  if(!response.ok)return null;
  const identity=await response.json() as Partial<Identity>;
  const now=Date.now();
  if(typeof identity.userId!=='string'||!identity.userId||typeof identity.teamId!=='string'||!identity.teamId||typeof identity.expiresAt!=='number'||!Number.isFinite(identity.expiresAt)||identity.expiresAt<=now)return null;
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
 valid(cookie:string|undefined):boolean{
  const token=this.token(cookie);
  if(!token)return false;
  const identity=this.sessions.get(token);
  if(!identity)return false;
  if(identity.expiresAt<=Date.now()){this.sessions.delete(token);return false;}
  return true;
 }
 logout(cookie:string|undefined):string{
  const token=this.token(cookie);
  if(token)this.sessions.delete(token);
  return `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
 }
}
