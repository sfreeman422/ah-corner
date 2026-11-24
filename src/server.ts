import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {extname, resolve} from 'node:path';
import {Blizzard} from './blizzard.ts';
import {demoSnapshots, names} from './demo.ts';
import {backtest, historyFor, portfolio, scan, validInt} from './engine.ts';
import {parseJournal, validateTrade} from './journal.ts';
import {openStore} from './store.ts';
import type {Alert, Opportunity, Settings} from './types.ts';
import {Sessions} from './auth.ts';

type PublicProblem={code:string;message:string;action?:string};

class RequestProblem extends Error{
 readonly status:number;
 readonly problem:PublicProblem;
 constructor(status:number,problem:PublicProblem){
  super(problem.message);
  this.status=status;
  this.problem=problem;
 }
}

function fail(status:number,code:string,message:string,action?:string):never{
 throw new RequestProblem(status,{code,message,action});
}

function positiveInteger(name:string,fallback:number){
 const raw=process.env[name];
 if(raw===undefined||raw==='')return fallback;
 const value=Number(raw);
 if(!Number.isSafeInteger(value)||value<1)throw Error(`${name} must be a positive integer`);
 return value;
}

function csv(name:string,defaults:string[]){
 const raw=process.env[name];
 const values=(raw===undefined||raw==='')?defaults:raw.split(',').map(value=>value.trim()).filter(Boolean);
 if(!values.length)throw Error(`${name} must contain at least one value`);
 return new Set(values.map(value=>value.toLowerCase()));
}

function origins(name:string,defaults:string[]){
 const raw=process.env[name];
 const values=(raw===undefined||raw==='')?defaults:raw.split(',').map(value=>value.trim()).filter(Boolean);
 if(!values.length)throw Error(`${name} must contain at least one origin`);
 return new Set(values.map(value=>{
  try{return new URL(value).origin.toLowerCase();}
  catch{throw Error(`${name} must contain full origins such as https://ah.example.com`);}
 }));
}

function errorMessage(error:unknown){return error instanceof Error?error.message:'Unknown error';}

function databaseProblem(error:unknown){
 const code=(error as {code?:string}).code||'';
 return code.startsWith('ER_')||code.startsWith('08')||['3D000','53300','57P01','57P02','57P03','ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENETUNREACH','EHOSTUNREACH','ENOTFOUND'].includes(code);
}

function responseProblem(error:unknown):RequestProblem{
 if(error instanceof RequestProblem)return error;
 if(databaseProblem(error))return new RequestProblem(503,{code:'DATABASE_UNAVAILABLE',message:'Saved data is temporarily unavailable. No changes were made.',action:'Try again shortly. If this continues, check the MySQL service.'});
 console.error('Request failed:',error);
 return new RequestProblem(500,{code:'INTERNAL_ERROR',message:'AH Corner could not complete that request.',action:'Try again. If the problem continues, check the server logs.'});
}

function collectorProblem(error:unknown):PublicProblem{
 const message=errorMessage(error);
 if(databaseProblem(error))return {code:'DATABASE_UNAVAILABLE',message:'The database is unavailable, so the market refresh could not be saved.',action:'The app will retry on its next scheduled refresh. Check MySQL if this persists.'};
 if(/credentials|oauth http 401|oauth http 403/i.test(message))return {code:'BLIZZARD_AUTH',message:'Blizzard sign-in failed.',action:'Check the Battle.net client ID and secret, then restart the service.'};
 if(/http 429|rate.?limit/i.test(message))return {code:'BLIZZARD_RATE_LIMIT',message:'Blizzard is rate-limiting market updates.',action:'The app will retry automatically. The most recent successful snapshot remains available.'};
 if(/abort|timeout|timed out|fetch failed/i.test(message))return {code:'BLIZZARD_NETWORK',message:'AH Corner could not reach Blizzard.',action:'The app will retry automatically. Check the server connection if this continues.'};
 if(/house mismatch|missing commodity|empty priced book|unexpected house/i.test(message))return {code:'BLIZZARD_DATA',message:'Blizzard returned an incomplete or unexpected auction snapshot.',action:'No partial data was saved. Verify the selected auction house and try again later.'};
 return {code:'COLLECTION_FAILED',message:'The market refresh failed.',action:'The app will retry automatically. Check the server logs if this continues.'};
}

const mode=process.env.MODE||'demo';
if(!['demo','live'].includes(mode))throw Error('MODE must be demo or live');
const demo=mode==='demo';
const house=Number(process.env.HOUSE_ID);
const blizzard=new Blizzard();
if(!demo&&(!validInt(house)||process.env.HOUSE_VERIFIED!=='true'))throw Error('Live mode requires HOUSE_ID and HOUSE_VERIFIED=true after discovery and manual confirmation');

const market=demo?'demo-us-pvp-horde':`${blizzard.region}:${blizzard.ruleset}:${house}`;
const settings:Settings={
 bankroll:Math.round(Number(process.env.BANKROLL_GOLD||35)*10_000),
 exposure:Number(process.env.MAX_EXPOSURE||.35),
 minROI:Number(process.env.MIN_ROI||.3),
 fee:Number(process.env.AH_FEE||.05),
 minHistory:Number(process.env.MIN_HISTORY||6)
};

function validSettings(value:Settings){
 if(!validInt(value.bankroll)||!Number.isFinite(value.exposure)||value.exposure<=0||value.exposure>1||!Number.isFinite(value.minROI)||value.minROI<0||value.minROI>10||!Number.isFinite(value.fee)||value.fee<0||value.fee>=1||!validInt(value.minHistory)||value.minHistory>24)throw Error('Invalid strategy settings');
 return value;
}

validSettings(settings);
const store=await openStore(market);
let state=await store.load();
let snapshots=await store.snapshots();
let busy=false;
let lastChecked=0;
let lastSuccess=0;
let lastCollectionError:PublicProblem|undefined;
let cached:Opportunity[]=[];
let saveQueue=Promise.resolve();

function save(){
 const copy=structuredClone(state);
 saveQueue=saveQueue.catch(()=>{}).then(()=>store.save(copy));
 return saveQueue;
}

function latest(){return snapshots.at(-1);}

function refresh(){
 const snapshot=latest();
 cached=snapshot?scan(snapshot,snapshots,settings):[];
}

async function alerts(){
 if(demo)return;
 const snapshot=latest();
 if(!snapshot||Date.now()-snapshot.at>2*3_600_000)return;
 for(const opportunity of cached.filter(value=>value.confidence==='candidate').slice(0,5)){
  const key=`${opportunity.itemId}:${opportunity.target}:${Math.round(opportunity.cost/1_000)}`;
  if(state.alerts.some(alert=>alert.key===key&&Date.now()-alert.at<12*3_600_000))continue;
  const alert:Alert={key,at:Date.now(),itemId:opportunity.itemId,target:opportunity.target,cost:opportunity.cost,profit:opportunity.profit,score:opportunity.score};
  state.alerts.unshift(alert);
  state.alerts=state.alerts.slice(0,200);
  await save();
  if(process.env.ALERT_WEBHOOK_URL){
   try{
    const response=await fetch(process.env.ALERT_WEBHOOK_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:`AH Corner candidate: ${state.names[opportunity.itemId]||`Item #${opportunity.itemId}`} | buyout ${(opportunity.cost/10_000).toFixed(2)}g | target ${(opportunity.target/10_000).toFixed(4)}g/unit | potential profit ${(opportunity.profit/10_000).toFixed(2)}g. Verify live AH; no verified sales.`}),signal:AbortSignal.timeout(10_000)});
    if(!response.ok)console.warn('Webhook HTTP',response.status);
   }catch{console.warn('Webhook delivery failed');}
  }
 }
}

async function collect(){
 if(busy)return false;
 busy=true;
 lastChecked=Date.now();
 try{
  if(demo){
   if(!snapshots.length||Date.now()-(latest()?.at||0)>=3_600_000){
    for(const snapshot of demoSnapshots())await store.put(snapshot);
    snapshots=await store.snapshots();
   }
   Object.assign(state.names,names);
  }else{
   const result=await blizzard.snapshot(house,state.modified);
   if(result.snapshot&&await store.put(result.snapshot)){
    snapshots.push(result.snapshot);
    snapshots.sort((a,b)=>a.at-b.at);
    snapshots=snapshots.slice(-25);
   }
   state.modified=result.modified||state.modified;
  }
  refresh();
  if(!demo){
   const ids=[...new Set([...cached.slice(0,30).map(value=>value.itemId),...state.watch])].filter(id=>!state.names[id]).slice(0,30);
   for(const id of ids){
    try{state.names[id]=await blizzard.name(id);}
    catch{break;}
   }
  }
  await save();
  await alerts();
  lastSuccess=Date.now();
  lastCollectionError=undefined;
  return true;
 }catch(error){
  lastCollectionError=collectorProblem(error);
  console.error('Collection failed:',error);
  return false;
 }finally{
  busy=false;
 }
}

if(demo)await collect();
else{
 refresh();
 void collect();
}

const pollMinutes=Math.max(5,positiveInteger('POLL_MINUTES',15));
const interval=setInterval(()=>void collect(),pollMinutes*60_000);
const port=positiveInteger('PORT',3000);
const host=process.env.HOST||'127.0.0.1';
const allowedHosts=csv('APP_TRUSTED_HOSTS',[`localhost:${port}`,`127.0.0.1:${port}`,'localhost:5173','127.0.0.1:5173']);
allowedHosts.add(`localhost:${port}`);
allowedHosts.add(`127.0.0.1:${port}`);
const allowedOrigins=origins('APP_TRUSTED_ORIGINS',[`http://localhost:${port}`,`http://127.0.0.1:${port}`,'http://localhost:5173','http://127.0.0.1:5173']);
const requireAuth=process.env.REQUIRE_AUTH==='true';
if(process.env.NODE_ENV==='production'&&!requireAuth)throw Error('REQUIRE_AUTH=true is required in production');
const sessions=new Sessions();
const dist=resolve('dist');
const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.json':'application/json'};

function json(response:ServerResponse,data:unknown,status=200,headers:Record<string,string>={}){
 response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY',...headers});
 response.end(JSON.stringify(data));
}

function sendProblem(response:ServerResponse,error:unknown){
 const problem=responseProblem(error);
 json(response,{error:problem.problem},problem.status);
}

async function body(request:IncomingMessage){
 const chunks:Buffer[]=[];
 let bytes=0;
 for await(const chunk of request){
  const value=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
  bytes+=value.length;
  if(bytes>2_100_000)fail(413,'REQUEST_TOO_LARGE','The request is too large.', 'Choose a journal file smaller than 2 MB.');
  chunks.push(value);
 }
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}
 catch{fail(400,'INVALID_JSON','The request could not be read.', 'Try again. If importing a journal, choose the SavedVariables file without editing it.');}
}

function requireMethod(actual:string,expected:string){
 if(actual!==expected)fail(405,'METHOD_NOT_ALLOWED','That action is not available with this request method.');
}

function luaString(value:string){return `"${value.replace(/[\\"\x00-\x1f\x7f]/g,character=>character==='\\'?'\\\\':character==='"'?'\\"':' ')}"`;}

const server=createServer(async(request,response)=>{
 try{
  const url=new URL(request.url||'/',`http://localhost:${port}`);
  const path=url.pathname;
  const method=request.method||'GET';
  const requestHost=request.headers.host?.toLowerCase();
  if(requestHost&&!allowedHosts.has(requestHost))fail(403,'HOST_REJECTED','This host is not approved for AH Corner.', 'Check APP_TRUSTED_HOSTS on the server.');
  if(method!=='GET'&&method!=='HEAD'){
   const origin=request.headers.origin?.toLowerCase();
   if(requireAuth&&!origin)fail(403,'ORIGIN_REQUIRED','This request could not be verified.', 'Reload the page and try again.');
   if(origin&&!allowedOrigins.has(origin))fail(403,'ORIGIN_REJECTED','This browser origin is not approved for AH Corner.', 'Check APP_TRUSTED_ORIGINS on the server.');
   if(!request.headers['content-type']?.startsWith('application/json'))fail(415,'JSON_REQUIRED','AH Corner expected a JSON request.', 'Reload the page and try again.');
  }

  if(path==='/livez'){
   requireMethod(method,'GET');
   json(response,{status:'ok'});
   return;
  }
  if(path==='/readyz'){
   requireMethod(method,'GET');
   await store.health();
   json(response,{status:'ready'});
   return;
  }
  if(path==='/auth/session'){
   if(method==='GET'){
    json(response,{required:requireAuth,authenticated:!requireAuth||sessions.valid(request.headers.cookie)});
    return;
   }
   if(method==='POST'){
    if(!requireAuth)fail(400,'AUTH_DISABLED','Sign-in is not enabled on this server.');
    const input=await body(request);
    let session:{cookie:string}|null;
    try{session=await sessions.exchange(input.code,input.verifier);}
    catch{fail(503,'AUTH_UNAVAILABLE','Slack sign-in is temporarily unavailable.','Try signing in again shortly.');}
    if(!session)fail(401,'AUTH_EXPIRED','Your sign-in link expired or was already used.','Sign in with Slack again.');
    json(response,{authenticated:true},200,{'Set-Cookie':session.cookie});
    return;
   }
   if(method==='DELETE'){
    json(response,{authenticated:false},200,{'Set-Cookie':sessions.logout(request.headers.cookie)});
    return;
   }
   fail(405,'METHOD_NOT_ALLOWED','That action is not available with this request method.');
  }
  if(path.startsWith('/api/')&&requireAuth&&!sessions.valid(request.headers.cookie))fail(401,'SIGN_IN_REQUIRED','Please sign in with Slack.','Your session may have expired.');
  if(path==='/api/status'){
   requireMethod(method,'GET');
   const snapshot=latest();
   json(response,{mode,market,at:snapshot?.at||null,listingCount:snapshot?.listings.length||0,snapshots:snapshots.length,collector:{busy,lastChecked,lastSuccess,lastError:lastCollectionError||null,nextScheduledAt:lastChecked?lastChecked+pollMinutes*60_000:null},settings,watch:state.watch,names:state.names,stale:!snapshot||Date.now()-snapshot.at>7_200_000});
   return;
  }
  if(path==='/api/opportunities'){
   requireMethod(method,'GET');
   const bankroll=url.searchParams.has('bankroll')?Math.round(Number(url.searchParams.get('bankroll'))*10_000):settings.bankroll;
   const minROI=url.searchParams.has('roi')?Number(url.searchParams.get('roi'))/100:settings.minROI;
   let configured:Settings;
   try{configured=validSettings({...settings,bankroll,minROI});}
   catch{fail(422,'INVALID_FILTERS','The bankroll or ROI filter is invalid.', 'Enter a positive bankroll and an ROI between 0% and 1000%.');}
   const snapshot=latest();
   const rows=snapshot?(configured.bankroll===settings.bankroll&&configured.minROI===settings.minROI?cached:scan(snapshot,snapshots,configured)):[];
   json(response,{rows:rows.slice(0,100),mode,at:snapshot?.at});
   return;
  }
  if(path==='/api/history'){
   requireMethod(method,'GET');
   const id=Number(url.searchParams.get('id'));
   if(!validInt(id))fail(422,'INVALID_ITEM_ID','Choose a valid positive item ID.');
   json(response,historyFor(snapshots,id));
   return;
  }
  if(path==='/api/backtest'){
   requireMethod(method,'GET');
   json(response,backtest(snapshots,settings));
   return;
  }
  if(path==='/api/alerts'){
   requireMethod(method,'GET');
   json(response,state.alerts);
   return;
  }
  if(path==='/api/portfolio'){
   requireMethod(method,'GET');
   json(response,{trades:state.trades,positions:portfolio(state.trades)});
   return;
  }
  if(path==='/api/trade'){
   requireMethod(method,'POST');
   let trade;
   try{trade=validateTrade({...await body(request),id:randomUUID()});}
   catch(error){
    if(error instanceof RequestProblem)throw error;
    fail(422,'INVALID_TRADE','Check the trade details before saving.', 'Item ID and quantity must be positive. Amounts entered in the form are gold, and the fee cannot exceed a sale total.');
   }
   state.trades.push(trade);
   await save();
   json(response,trade,201);
   return;
  }
  if(path==='/api/journal'){
   requireMethod(method,'POST');
   const requestBody=await body(request);
   if(typeof requestBody.text!=='string')fail(422,'JOURNAL_TEXT_REQUIRED','Choose an AH Corner journal file to import.', 'Export SavedVariables after /reload or logging out, then try again.');
   let trades;
   try{trades=parseJournal(requestBody.text);}
   catch(error){
    if(error instanceof RequestProblem)throw error;
    fail(422,'JOURNAL_INVALID','The selected file is not a valid AH Corner journal.', 'Choose AHCorner.lua from SavedVariables after /reload or logging out.');
   }
   if(!trades.length)fail(422,'JOURNAL_EMPTY','No AH Corner records were found in that file.', 'Choose AHCorner.lua from SavedVariables after /reload or logging out.');
   const seen=new Set(state.trades.map(trade=>trade.id));
   let imported=0;
   for(const trade of trades){
    if(seen.has(trade.id))continue;
    state.trades.push(trade);
    seen.add(trade.id);
    imported++;
   }
   await save();
   json(response,{imported});
   return;
  }
  if(path==='/api/watch'){
   requireMethod(method,'POST');
   const requestBody=await body(request);
   if(!validInt(requestBody.itemId))fail(422,'INVALID_ITEM_ID','Choose a valid positive item ID.');
   state.watch=state.watch.includes(requestBody.itemId)?state.watch.filter(id=>id!==requestBody.itemId):[...state.watch,requestBody.itemId];
   await save();
   json(response,state.watch);
   return;
  }
  if(path==='/api/collect'){
   requireMethod(method,'POST');
   if(busy)fail(409,'COLLECTION_IN_PROGRESS','A market refresh is already in progress.', 'Wait for it to finish; the status panel will update automatically.');
   void collect();
   json(response,{status:'started',message:'Market refresh started. The status panel will update when it finishes.'},202);
   return;
  }
  if(path==='/api/addon.lua'){
   requireMethod(method,'GET');
   const snapshot=latest();
   const rows=(!demo&&snapshot&&Date.now()-snapshot.at<7_200_000?cached.filter(value=>value.confidence==='candidate'):[]).slice(0,20);
   const code=`-- Generated advisory data. No game actions.\nAHCornerPlan = { market=${luaString(market)}, timestamp=${Math.floor((snapshot?.at||0)/1_000)}, rows={\n${rows.map(value=>`{id=${value.itemId}, name=${luaString(state.names[value.itemId]||`Item #${value.itemId}`)}, quantity=${value.quantity}, cost=${value.cost}, buyMax=${value.buyMax}, target=${value.target}},`).join('\n')}\n}}\n`;
   response.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Disposition':'attachment; filename="Plan.lua"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'});
   response.end(code);
   return;
  }
  if(path.startsWith('/api/'))fail(404,'NOT_FOUND','That AH Corner API route does not exist.');

  const file=resolve(dist,`.${path==='/'?'/index.html':path}`);
  if(!file.startsWith(`${dist}/`))fail(404,'NOT_FOUND','That page does not exist.');
  try{
   const data=await readFile(file);
   response.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'});
   response.end(data);
  }catch{
   sendProblem(response,new RequestProblem(503,{code:'FRONTEND_NOT_BUILT',message:'The AH Corner frontend has not been built.',action:'Run npm run build before starting the production server.'}));
  }
 }catch(error){
  sendProblem(response,error);
 }
});

server.listen(port,host,()=>console.log(`AH Corner ${mode}: http://${host}:${port}`));

function shutdown(){
 clearInterval(interval);
 server.close(()=>void store.close());
}

process.on('SIGTERM',shutdown);
process.on('SIGINT',shutdown);
