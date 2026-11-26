import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {extname, resolve} from 'node:path';
import {Blizzard} from './blizzard.ts';
import {demoSnapshots, names} from './demo.ts';
import {backtest, compactSnapshot, portfolio, scan, scanFlips, validInt} from './engine.ts';
import {parseJournal, validateTrade} from './journal.ts';
import {openStore} from './store.ts';
import type {Alert, CompactSnapshot, Opportunity, Settings} from './types.ts';
import {Sessions} from './auth.ts';
import {applyItemUse,itemCategoryFor,itemUseFor,validateItemUse} from './item-use.ts';
import {fetchForeverItems} from './forever-item-catalog.ts';
import {ItemNameResolver} from './item-names.ts';
import {ItemMetadataResolver} from './item-metadata-resolver.ts';
import {fetchRecipeIndex} from './recipe-index.ts';
import type {BlizzardItemMetadata,BlizzardItemMetadataMap,RecipeUseMap} from './item-use.ts';
import type {ItemMetadata} from './blizzard.ts';
import {defaultOpportunitySort,opportunitySortKeys,sortOpportunities} from './opportunity-sort.ts';
import type {OpportunitySort,OpportunitySortKey} from './opportunity-sort.ts';

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
const collectSchedule=process.env.COLLECT_SCHEDULE||'interval';
if(!['interval','cron'].includes(collectSchedule))throw Error('COLLECT_SCHEDULE must be interval or cron');
const demo=mode==='demo';
const house=Number(process.env.HOUSE_ID);
const houseVerified=!demo&&process.env.HOUSE_VERIFIED==='true';
const provisional=!demo&&!houseVerified;
const blizzard=new Blizzard();
if(!demo&&(!validInt(house)||(!houseVerified&&process.env.ALLOW_UNVERIFIED_HOUSE!=='true')))throw Error('Live mode requires HOUSE_ID and either HOUSE_VERIFIED=true after confirmation or ALLOW_UNVERIFIED_HOUSE=true for provisional data');

const market=demo?'demo-us-pvp-horde':`${blizzard.region}:${blizzard.ruleset}:${house}`;
const defaultSettings:Settings={
 bankroll:Math.round(Number(process.env.BANKROLL_GOLD||35)*10_000),
 exposure:Number(process.env.MAX_EXPOSURE||.35),
 minROI:Number(process.env.MIN_ROI||.3),
 minProfit:Math.round(Number(process.env.MIN_PROFIT_GOLD||0)*10_000),
 fee:Number(process.env.AH_FEE||.05),
 minHistory:Number(process.env.MIN_HISTORY||6)
};

function validSettings(value:Settings){
 if(!validInt(value.bankroll)||!Number.isFinite(value.exposure)||value.exposure<=0||value.exposure>1||!Number.isFinite(value.minROI)||value.minROI<0||value.minROI>10||!Number.isSafeInteger(value.minProfit)||value.minProfit<0||!Number.isFinite(value.fee)||value.fee<0||value.fee>=1||!validInt(value.minHistory)||value.minHistory>24)throw Error('Invalid strategy settings');
 return value;
}

validSettings(defaultSettings);
const store=await openStore(market);
await store.prune();
let state=await store.load();
let settings=validSettings({...defaultSettings,...state.strategy});
const liveDataRetentionMs=30*24*60*60*1_000;
const missingMetadataRetryMs=24*60*60*1_000;
function metadataFresh(record:BlizzardItemMetadata|undefined,now=Date.now()){
 if(!record||record.source!=='blizzard-forever'||!Number.isFinite(record.checkedAt)||record.checkedAt>now||!Number.isFinite(record.updatedAt)||record.updatedAt<=0||record.updatedAt>record.checkedAt)return false;
 const complete=Number.isSafeInteger(record.classId)&&Number(record.classId)>=0&&Number.isSafeInteger(record.subclassId)&&Number(record.subclassId)>=0;
 return now-record.checkedAt<(complete?liveDataRetentionMs:missingMetadataRetryMs);
}
function expireLiveState(){
 if(demo)return false;
 const now=Date.now();
 let changed=false;
 if(Object.keys(state.names).length&&!(typeof state.namesFetchedAt==='number'&&Number.isFinite(state.namesFetchedAt)&&state.namesFetchedAt<=now&&now-state.namesFetchedAt<liveDataRetentionMs)){
  state.names={};
  delete state.nameSources;
  delete state.namesFetchedAt;
  changed=true;
 }
 if(state.blizzardMetadata){
  const entries=Object.entries(state.blizzardMetadata);
  const retained=entries.filter(([,value])=>metadataFresh(value,now));
  if(retained.length!==entries.length){state.blizzardMetadata=Object.fromEntries(retained);changed=true;}
 }
 const alerts=state.alerts.filter(alert=>Number.isFinite(alert.at)&&alert.at<=now&&now-alert.at<liveDataRetentionMs);
 if(alerts.length!==state.alerts.length){state.alerts=alerts;changed=true;}
 return changed;
}
if(expireLiveState())await store.save(state);
async function loadSnapshots():Promise<CompactSnapshot[]>{
 const result:CompactSnapshot[]=[];
 for await(const snapshot of store.iterSnapshots()){
  result.push(compactSnapshot(snapshot));
  // The previous parsed book is no longer needed. Keep startup peak memory
  // bounded even when V8 would otherwise retain several large dead books.
  global.gc?.();
 }
 global.gc?.();
 return result;
}
let snapshots=await loadSnapshots();
let busy=false;
let lastChecked=0;
let lastSuccess=0;
let lastRefreshChanged=false;
let lastCollectionError:PublicProblem|undefined;
let cached:Opportunity[]=[];
let cachedBase:Opportunity[]=[];
let cachedFresh:boolean|undefined;
const strategyScans=new Map<string,{base:Opportunity[];rows:Opportunity[]}>();
let saveQueue=Promise.resolve();
let recipeBusy=false;
let recipeError:string|null=null;
let catalogBusy=false;
let catalogError:string|null=null;
let catalogTimer:ReturnType<typeof setTimeout>|undefined;
let metadataError:string|null=null;
let useRefreshTimer:ReturnType<typeof setTimeout>|undefined;
const recipeAbort=new AbortController();

function save(){
 // Capture at the start of the queued write so a concurrent user-strategy
 // commit cannot be overwritten by an older snapshot of the shared state.
 saveQueue=saveQueue.catch(()=>{}).then(()=>store.save(structuredClone(state)));
 return saveQueue;
}

function saveUserStrategy(key:string,next:Settings){
 const write=saveQueue.catch(()=>{}).then(async()=>{
  const updated={...state.userStrategies,[key]:next};
  await store.save(structuredClone({...state,userStrategies:updated}));
  state.userStrategies=updated;
 });
 saveQueue=write;
 return write;
}

const nameResolver=new ItemNameResolver({
 lookup:id=>blizzard.nameDetails(id),
 isKnown:id=>!!catalogName(id)||!!state.names[id]&&state.names[id]!==`Item #${id}`,
 async onName(id,{name,source,metadata}){
  state.namesFetchedAt??=Date.now();
  state.names[id]=name;
  (state.nameSources??={})[id]=source;
  const previous=state.blizzardMetadata;
  setMetadata(id,source==='forever'?metadata||null:null);
  const updated=state.blizzardMetadata;
  try{await save();}catch(error){if(state.blizzardMetadata===updated)state.blizzardMetadata=previous;throw error;}
  scheduleUseRefresh();
 }
});

function setMetadata(id:number,metadata:ItemMetadata|null){
 const now=Date.now();
 const classId=metadata?.itemClassId??null,subclassId=metadata?.itemSubclassId??null;
 const old=state.blizzardMetadata?.[id];
 const updatedAt=old&&old.source==='blizzard-forever'&&old.classId===classId&&old.subclassId===subclassId&&Number.isFinite(old.updatedAt)&&old.updatedAt>0&&old.updatedAt<=now?old.updatedAt:now;
 const updated:BlizzardItemMetadataMap={...state.blizzardMetadata,[id]:{source:'blizzard-forever',checkedAt:now,updatedAt,classId,subclassId}};
 // Bound the cache on long-running large markets. The oldest records can be
 // fetched again if needed; negative results have a shorter lifetime.
 const keys=Object.keys(updated);
 if(keys.length>10_000){const oldest=keys.reduce((a,b)=>updated[a].checkedAt<=updated[b].checkedAt?a:b);delete updated[oldest];}
 state.blizzardMetadata=updated;
}

const metadataResolver=new ItemMetadataResolver({
 lookup:async id=>(await blizzard.foreverItemDetails(id))?.metadata??null,
 onError:()=>{metadataError='Some item categories could not be checked. Saved categories remain available; the app will retry.';},
 shouldLookup:id=>{
  const name=state.names[id];
  return !!name&&name!==`Item #${id}`&&!itemUseFor(state.itemUses||{},id)&&!itemCategoryFor(id,state.blizzardMetadata||{},state.itemCatalog)&&!metadataFresh(state.blizzardMetadata?.[id]);
 },
 async onResult(id,metadata){
  const previous=state.blizzardMetadata;
  setMetadata(id,metadata);
  const updated=state.blizzardMetadata;
  try{await save();}catch(error){if(state.blizzardMetadata===updated)state.blizzardMetadata=previous;throw error;}
  metadataError=null;
  scheduleUseRefresh();
 }
});

function latest(){return snapshots.at(-1);}

function catalogName(id:number){
 const item=state.itemCatalog?.items?.[String(id)];
 return itemCategoryFor(id,{},state.itemCatalog)&&typeof item?.name==='string'&&item.name.trim()?item.name:undefined;
}

function knownItemName(id:number){
 const stored=state.names[id];
 const known=stored&&stored!==`Item #${id}`?stored:undefined;
 return state.nameSources?.[id]==='forever'&&known?known:catalogName(id)||known;
}

function decorateScan(base:Opportunity[]){
 const rows=applyItemUse(base,state.itemUses||{},state.recipeUses||{},state.blizzardMetadata||{},state.itemCatalog);
 return provisional?rows.map(row=>({...row,confidence:'watch' as const,reasons:['Auction house mapping is unverified; compare in-game prices before acting.',...row.reasons]})):rows;
}

function refreshUseViews(){
 if(useRefreshTimer)clearTimeout(useRefreshTimer);
 useRefreshTimer=undefined;
 cached=decorateScan(cachedBase);
 for(const entry of strategyScans.values())entry.rows=decorateScan(entry.base);
}

function scheduleUseRefresh(){
 if(useRefreshTimer)return;
 useRefreshTimer=setTimeout(refreshUseViews,1_000);
 useRefreshTimer.unref();
}

function refresh(){
 strategyScans.clear();
 const snapshot=latest();
 cachedFresh=snapshot? snapshot.source==='demo'||Date.now()-snapshot.at<=2*3_600_000:undefined;
 cachedBase=snapshot?scan(snapshot,snapshots,settings):[];
 cached=decorateScan(cachedBase);
 if(!demo){const ids=[...cached.slice(0,100).map(row=>row.itemId),...state.watch];nameResolver.enqueue(ids);metadataResolver.enqueue(ids);}
}

// Keep a compact, version-pinned category catalog for every item in the
// current book. A batch is committed only after the complete request succeeds.
function scheduleItemCatalog(delay=3_000){
 if(demo||catalogTimer)return;
 catalogTimer=setTimeout(()=>{catalogTimer=undefined;void updateItemCatalog();},delay);
 catalogTimer.unref();
}

async function updateItemCatalog(){
 if(demo||catalogBusy)return;
 if(busy){scheduleItemCatalog(30_000);return;}
 const snapshot=latest();
 if(!snapshot)return;
 const ids=[...snapshot.items.keys()];
 if(!ids.length)return;
 const previous=state.itemCatalog;
 const now=Date.now();
 const lastCheck=previous?.checkedAt||0;
 const lastFull=previous?.fetchedAt||0;
 const full=!previous||lastFull>now||now-lastFull>=liveDataRetentionMs;
 const missing=new Set(previous?.missingIds||[]);
 const unseen=ids.filter(id=>!previous?.items?.[String(id)]&&!missing.has(id));
 if(!full&&!unseen.length&&lastCheck<=now&&now-lastCheck<24*3_600_000)return;
 catalogBusy=true;
 try{
  let result=await fetchForeverItems(full?ids:unseen,{signal:recipeAbort.signal});
  let replace=full||!previous||previous.dataset!==result.dataset||previous.build!==result.build;
  if(replace&&!full&&previous){
   // A changed dataset cannot be merged with records from the previous build.
   result=await fetchForeverItems(ids,{signal:recipeAbort.signal});
   replace=true;
  }
  const recordedAt=Date.now();
  const items=replace?{}:{...previous?.items};
  const misses=new Set(replace?[]:previous?.missingIds||[]);
  for(const [id,item] of Object.entries(result.items)){
   const old=previous?.items?.[id];
   const updatedAt=old&&old.classId===item.classId&&old.subclassId===item.subclassId&&old.quality===item.quality&&old.slot===item.slot&&Number.isFinite(old.updatedAt)&&old.updatedAt>0&&old.updatedAt<=recordedAt?old.updatedAt:recordedAt;
   items[id]={classId:item.classId,subclassId:item.subclassId,updatedAt,...(item.name?{name:item.name}:{}),...(item.quality!==undefined?{quality:item.quality}:{}),...(item.slot!==undefined?{slot:item.slot}:{})};
   misses.delete(Number(id));
  }
  for(const id of result.missingIds)misses.add(id);
  // Current items take priority if long-lived markets accumulate many IDs.
  const keep=new Set(ids.map(String));
  const extra=Object.keys(items).filter(id=>!keep.has(id)).sort((a,b)=>items[b].updatedAt-items[a].updatedAt);
  for(const id of extra.slice(Math.max(0,10_000-keep.size)))delete items[id];
  const next={dataset:result.dataset,build:result.build,checkedAt:recordedAt,fetchedAt:replace?recordedAt:previous!.fetchedAt,items,missingIds:[...misses].filter(id=>keep.has(String(id))).slice(0,10_000)};
  state.itemCatalog=next;
  try{await save();}catch(error){if(state.itemCatalog===next)state.itemCatalog=previous;throw error;}
  catalogError=null;
  refreshUseViews();
 }catch(error){
  if(!recipeAbort.signal.aborted){catalogError='Item categories are temporarily unavailable. Saved classifications remain available; the app will retry.';console.warn('Item catalog refresh failed:',errorMessage(error));scheduleItemCatalog(5*60_000);}
 }finally{
  catalogBusy=false;
  if(latest()?.key!==snapshot.key)scheduleItemCatalog(2_000);
 }
}

function scanFor(configured:Settings,strategy:'monopolization'|'flipping'='monopolization'){
 const snapshot=latest();
 if(!snapshot)return [];
 const key=JSON.stringify([strategy,configured]);
 if(strategy==='monopolization'&&JSON.stringify(configured)===JSON.stringify(settings))return cached;
 const found=strategyScans.get(key);
 if(found){strategyScans.delete(key);strategyScans.set(key,found);return found.rows;}
 const base=strategy==='flipping'?scanFlips(snapshot,snapshots,configured):scan(snapshot,snapshots,configured);
 const rows=decorateScan(base);
 strategyScans.set(key,{base,rows});
 if(strategyScans.size>4)strategyScans.delete(strategyScans.keys().next().value!);
 return rows;
}

// Keep a compact reverse index in the same MySQL-backed state as player notes.
// A failed or interrupted refresh never replaces the last complete index.
async function updateRecipes(){
 if(demo||recipeBusy)return;
 const last=state.recipeIndex?.fetchedAt;
 if(typeof last==='number'&&Number.isFinite(last)&&last<=Date.now()&&Date.now()-last<24*3_600_000)return;
 recipeBusy=true;
 try{
  const result=await fetchRecipeIndex({signal:recipeAbort.signal});
  const now=Date.now();
  const professions:Record<number,string>={164:'Blacksmithing',165:'Leatherworking',171:'Alchemy',182:'Herbalism',185:'Cooking',186:'Mining',197:'Tailoring',202:'Engineering',333:'Enchanting',356:'Fishing',393:'Skinning',755:'Jewelcrafting',129:'First Aid'};
  const uses:RecipeUseMap={};
  for(const [id,recipe] of Object.entries(result.uses)){
   const note=`${recipe.quantity} required for ${recipe.name}`.slice(0,300);
   const profession=professions[recipe.profession]||`Profession #${recipe.profession}`;
   const old=state.recipeUses?.[id];
   const updatedAt=old&&old.recipeId===recipe.recipeId&&old.note===note&&old.profession===profession?old.updatedAt:now;
   uses[id]={kind:'profession',note,source:'warcraftforever-recipe',updatedAt,recipeId:recipe.recipeId,profession,dataset:result.dataset};
  }
  const previousUses=state.recipeUses,previousIndex=state.recipeIndex;
  state.recipeUses=uses;
  state.recipeIndex={dataset:result.dataset,build:result.build,fetchedAt:now};
  try{await save();}catch(error){if(state.recipeUses===uses){state.recipeUses=previousUses;state.recipeIndex=previousIndex;}throw error;}
  recipeError=null;
  refresh();
 }catch(error){
  if(!recipeAbort.signal.aborted){recipeError='Recipe data is temporarily unavailable. The app will retry; saved research remains available.';console.warn('Recipe index refresh failed:',errorMessage(error));}
 }finally{recipeBusy=false;}
}

function expireInMemorySnapshots(){
 const cutoff=Date.now()-liveDataRetentionMs;
 const retained=snapshots.filter(snapshot=>snapshot.source!=='blizzard'||(Number.isFinite(snapshot.at)&&snapshot.at>cutoff));
 if(retained.length!==snapshots.length){snapshots=retained;refresh();return;}
 // The cached scan is otherwise stable, but its freshness gate changes with
 // the clock even if collection fails or no new book arrives. Re-scan once
 // on that transition so status, explanations, and candidates agree.
 const snapshot=latest();
 if(snapshot){
  const fresh=snapshot.source==='demo'||Date.now()-snapshot.at<=2*3_600_000;
  if(cachedFresh!==fresh)refresh();
 }
}

async function alerts(){
 if(demo||provisional)return;
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
    const response=await fetch(process.env.ALERT_WEBHOOK_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:`AH Corner candidate: ${knownItemName(opportunity.itemId)||`Item #${opportunity.itemId}`} | buyout ${(opportunity.cost/10_000).toFixed(2)}g | target ${(opportunity.target/10_000).toFixed(4)}g/unit | potential profit ${(opportunity.profit/10_000).toFixed(2)}g. Verify live AH; no verified sales.`}),signal:AbortSignal.timeout(10_000)});
    if(!response.ok)console.warn('Webhook HTTP',response.status);
   }catch{console.warn('Webhook delivery failed');}
  }
 }
}

async function collect(){
 if(busy)return false;
 busy=true;
 lastChecked=Date.now();
 const previousBook=latest()?.key;
 try{
  expireInMemorySnapshots();
  await store.prune();
  if(expireLiveState()){await save();refreshUseViews();}
  if(demo){
   if(!snapshots.length||Date.now()-(latest()?.at||0)>=3_600_000){
    for(const snapshot of demoSnapshots())await store.put(snapshot);
    snapshots=await loadSnapshots();
   }
   Object.assign(state.names,names);
  }else{
   const result=await blizzard.snapshot(house,state.modified);
   if(result.snapshot){
    await store.put(result.snapshot);
    const packed=compactSnapshot(result.snapshot);
    // Release the large raw book before rescanning the retained history.
    result.snapshot=null;
    global.gc?.();
    // A complete unchanged book is a fresh observation too; replace the
    // in-memory copy so freshness checks do not expire unchanged prices.
    snapshots=snapshots.filter(snapshot=>snapshot.key!==packed.key);
    snapshots.push(packed);
    snapshots.sort((a,b)=>a.at-b.at);
    snapshots=snapshots.slice(-25);
   }
   state.modified=result.modified||state.modified;
  }
  refresh();
  await save();
  await alerts();
  lastRefreshChanged=latest()?.key!==previousBook;
  lastSuccess=Date.now();
  lastCollectionError=undefined;
  return true;
 }catch(error){
  lastCollectionError=collectorProblem(error);
  console.error('Collection failed:',error);
  return false;
 }finally{
  busy=false;
  if(!demo)scheduleItemCatalog(2_000);
 }
}

if(demo)await collect();
else{
 refresh();
 void collect();
}

const pollMinutes=Math.max(5,positiveInteger('POLL_MINUTES',60));
const interval=collectSchedule==='interval'?setInterval(()=>void collect(),pollMinutes*60_000):undefined;
const recipeStart=!demo?setTimeout(()=>void updateRecipes(),3_000):undefined;
const recipeInterval=!demo?setInterval(()=>void updateRecipes(),3_600_000):undefined;
if(!demo)scheduleItemCatalog();
const catalogInterval=!demo?setInterval(()=>scheduleItemCatalog(),3_600_000):undefined;
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
  if(path==='/internal/collect'){
   const address=request.socket.remoteAddress;
   const loopback=address==='127.0.0.1'||address==='::ffff:127.0.0.1'||address==='::1';
   const localHost=requestHost===`127.0.0.1:${port}`||requestHost===`localhost:${port}`||requestHost===`[::1]:${port}`;
   const proxied=Object.keys(request.headers).some(name=>name==='forwarded'||name==='via'||name==='x-real-ip'||name.startsWith('x-forwarded-'));
   if(!loopback||!localHost||request.headers.origin!==undefined||proxied)fail(404,'NOT_FOUND','That AH Corner route does not exist.');
   requireMethod(method,'POST');
   if(collectSchedule!=='cron')fail(409,'CRON_NOT_ENABLED','Cron collection is not enabled.','Set COLLECT_SCHEDULE=cron before using the hourly job.');
   if(!request.headers['content-type']?.startsWith('application/json'))fail(415,'JSON_REQUIRED','AH Corner expected a JSON request.');
   await body(request);
   if(busy)fail(409,'COLLECTION_IN_PROGRESS','A market refresh is already in progress.','The next hourly job will retry.');
   if(!await collect())throw new RequestProblem(503,lastCollectionError||{code:'COLLECTION_FAILED',message:'The market refresh failed.',action:'Check the server logs.'});
   json(response,{status:'completed',lastChecked,lastSuccess});
   return;
  }
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
  const identity=path.startsWith('/api/')&&requireAuth?sessions.identity(request.headers.cookie):null;
  if(path.startsWith('/api/')&&requireAuth&&!identity)fail(401,'SIGN_IN_REQUIRED','Please sign in with Slack.','Your session may have expired.');
  // Workspace and Slack user are both necessary: IDs are not global across
  // workspaces. Only the server-side Mocker exchange may supply these values.
  const userKey=identity?createHash('sha256').update(JSON.stringify([identity.teamId,identity.userId])).digest('hex'):null;
  const userSettings=userKey&&state.userStrategies?.[userKey]?validSettings({...defaultSettings,...state.userStrategies[userKey]}):settings;
  if(path.startsWith('/api/')){
   expireInMemorySnapshots();
   if(expireLiveState()){await save();refreshUseViews();}
  }
  if(path==='/api/status'){
   requireMethod(method,'GET');
   if(!demo){const ids=[...state.watch,...state.trades.map(trade=>trade.itemId),...state.alerts.map(alert=>alert.itemId)];nameResolver.enqueue(ids);metadataResolver.enqueue(ids);}
   const snapshot=latest();
   const catalogNames:Record<number,string>={};
   for(const id of Object.keys(state.itemCatalog?.items||{})){const name=catalogName(Number(id));if(name)catalogNames[Number(id)]=name;}
   const names={...catalogNames},nameSources={...state.nameSources};
   for(const id of Object.keys(catalogNames))if(nameSources[Number(id)]!=='forever')delete nameSources[Number(id)];
   for(const [id,name] of Object.entries(state.names))if(name&&name!==`Item #${id}`&&(!catalogNames[Number(id)]||state.nameSources?.[Number(id)]==='forever'))names[Number(id)]=name;
   let classified=0,knownUses=0;
   if(snapshot)for(const id of snapshot.items.keys()){
    const use=itemUseFor(state.itemUses||{},id,state.recipeUses||{},state.blizzardMetadata||{},state.itemCatalog);
    if(use&&use.kind!=='exclude')knownUses++;
    if(itemCategoryFor(id,state.blizzardMetadata||{},state.itemCatalog))classified++;
   }
   json(response,{mode,market,houseVerified,at:snapshot?.at||null,listingCount:snapshot?.listingCount||0,snapshots:snapshots.length,collector:{busy,lastChecked,lastSuccess,lastError:lastCollectionError||null,nextScheduledAt:collectSchedule==='interval'&&lastChecked?lastChecked+pollMinutes*60_000:null},settings:userSettings,watch:state.watch,names,nameSources,itemUses:state.itemUses||{},recipeUses:state.recipeUses||{},blizzardMetadata:state.blizzardMetadata||{},itemCatalog:state.itemCatalog||null,catalogLookup:{busy:catalogBusy,error:catalogError,classified,knownUses,total:snapshot?.items.size||0},metadataError,recipeIndex:state.recipeIndex||null,recipeLookup:{busy:recipeBusy,error:recipeError},stale:!snapshot||Date.now()-snapshot.at>7_200_000});
   return;
  }
  if(path==='/api/settings'){
   requireMethod(method,'POST');
   const input=await body(request);
   let next:Settings;
   try{
    next=validSettings({bankroll:input.bankroll,exposure:input.exposure,minROI:input.minROI,minProfit:input.minProfit,fee:input.fee,minHistory:input.minHistory});
   }catch{
    fail(422,'INVALID_STRATEGY','Check the strategy settings before saving.', 'Use a positive bankroll, exposure between 0% and 100%, nonnegative minimum profit and ROI, a fee below 100%, and 1–24 history observations.');
   }
   if(userKey)await saveUserStrategy(userKey,next);
   else{
    const previous=state.strategy;
    state.strategy=next;
    try{await save();}
    catch(error){if(state.strategy===next)state.strategy=previous;throw error;}
    settings=next;
    refresh();
   }
   json(response,next);
   return;
  }
  if(path==='/api/item-use'){
   requireMethod(method,'POST');
   const input=await body(request);
   let value:ReturnType<typeof validateItemUse>;
   try{value=validateItemUse(input);}
   catch(error){fail(422,'INVALID_ITEM_USE','Check the item-use details.',errorMessage(error));}
   const previous=state.itemUses;
   const updated={...previous};
   if(value.evidence)updated[String(value.itemId)]=value.evidence;
   else delete updated[String(value.itemId)];
   state.itemUses=updated;
   try{await save();}
   catch(error){if(state.itemUses===updated)state.itemUses=previous;throw error;}
   refresh();
   json(response,{itemId:value.itemId,evidence:value.evidence});
   return;
  }
  if(path==='/api/opportunities'){
   requireMethod(method,'GET');
   const requestedStrategy=url.searchParams.get('strategy')??'monopolization';
   if(requestedStrategy!=='monopolization'&&requestedStrategy!=='flipping')fail(422,'INVALID_STRATEGY','Choose a valid trading strategy.','Select monopolization or flipping.');
   const search=(url.searchParams.get('q')??'').trim().toLowerCase();
   const watch=url.searchParams.get('watch');
   const named=url.searchParams.get('named');
   if(search.length>120||(watch!==null&&watch!=='0'&&watch!=='1')||(named!==null&&named!=='0'&&named!=='1'))fail(422,'INVALID_FILTERS','The opportunity filters are invalid.','Use a search of at most 120 characters and choose valid watchlist and name filters.');
   const requestedSort=url.searchParams.get('sort');
   const requestedDirection=url.searchParams.get('direction');
   const sortKeys:readonly string[]=opportunitySortKeys;
   if((requestedSort!==null&&!sortKeys.includes(requestedSort))||(requestedDirection!==null&&requestedDirection!=='asc'&&requestedDirection!=='desc'))fail(422,'INVALID_SORT','Choose a valid opportunity sort.','Sort by item name, suggested action, purchase price, total cost, potential profit, ROI or score.');
   const key=(requestedSort??defaultOpportunitySort.key) as OpportunitySortKey;
   const sort:OpportunitySort={key,direction:(requestedDirection??(key==='name'?'asc':'desc')) as OpportunitySort['direction']};
   const bankroll=url.searchParams.has('bankroll')?Math.round(Number(url.searchParams.get('bankroll'))*10_000):userSettings.bankroll;
   const minROI=url.searchParams.has('roi')?Number(url.searchParams.get('roi'))/100:userSettings.minROI;
   let configured:Settings;
   try{configured=validSettings({...userSettings,bankroll,minROI});}
   catch{fail(422,'INVALID_FILTERS','The bankroll or ROI filter is invalid.', 'Enter a positive bankroll and an ROI between 0% and 1000%.');}
   const snapshot=latest();
   const unsorted=snapshot?scanFor(configured,requestedStrategy):[];
   const nameForId=knownItemName;
   const watched=watch==='1'?new Set(state.watch):undefined;
   const filtered=unsorted.filter(row=>{
    const name=nameForId(row.itemId);
    const itemId=String(row.itemId);
    // An exact ID can still be found and queued for name resolution even when
    // the UI normally hides unnamed items.
    return (!watched||watched.has(row.itemId))&&(named!=='1'||!!name||itemId===search)&&(!search||!!name?.toLowerCase().includes(search)||itemId.includes(search));
   });
   const rows=sortOpportunities(filtered,sort,id=>nameForId(id)||`Item #${id}`);
   if(!demo){const ids=rows.slice(0,100).map(row=>row.itemId);nameResolver.enqueue(ids);metadataResolver.enqueue(ids);}
   const visible=rows.slice(0,100).map(row=>{
    if(requestedStrategy!=='monopolization'||!snapshot)return row;
    const group=snapshot.items.get(row.itemId);
    if(!group)return row;
    let snapshotUnits=0;for(let i=group.start;i<group.start+group.length;i++)snapshotUnits+=group.quantities[i];
    return {...row,monopoly:{snapshotUnits,plannedShare:snapshotUnits?row.quantity/snapshotUnits:0}};
   });
   json(response,{rows:visible,mode,at:snapshot?.at,strategy:requestedStrategy});
   return;
  }
  if(path==='/api/history'){
   requireMethod(method,'GET');
   const id=Number(url.searchParams.get('id'));
   if(!validInt(id))fail(422,'INVALID_ITEM_ID','Choose a valid positive item ID.');
   json(response,await store.history(id));
   return;
  }
  if(path==='/api/backtest'){
   requireMethod(method,'GET');
   json(response,provisional?[]:backtest(snapshots,userSettings).filter(result=>{const evidence=itemUseFor(state.itemUses||{},result.itemId,state.recipeUses||{},state.blizzardMetadata||{},state.itemCatalog);return !!evidence&&evidence.kind!=='exclude'&&evidence.updatedAt<=result.at;}));
   return;
  }
  if(path==='/api/alerts'){
   requireMethod(method,'GET');
   json(response,provisional?[]:state.alerts.filter(alert=>{const evidence=itemUseFor(state.itemUses||{},alert.itemId,state.recipeUses||{},state.blizzardMetadata||{},state.itemCatalog);return !!evidence&&evidence.kind!=='exclude'&&evidence.updatedAt<=alert.at;}));
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
   if(method==='GET'){
    json(response,{busy,lastChecked,lastSuccess,lastError:lastCollectionError||null,changed:lastRefreshChanged});
    return;
   }
   requireMethod(method,'POST');
   await body(request);
   if(!busy)void collect();
   json(response,{status:'started',lastChecked},202);
   return;
  }
  if(path==='/api/addon.lua'){
   requireMethod(method,'GET');
   const snapshot=latest();
   const rows=(!demo&&!provisional&&snapshot&&Date.now()-snapshot.at<7_200_000?scanFor(userSettings).filter(value=>value.confidence==='candidate'):[]).slice(0,20);
   const code=`-- Generated advisory data. No game actions.\n${provisional?'-- Auction house mapping is unverified; no actionable entries.\n':''}AHCornerPlan = { market=${luaString(market)}, timestamp=${Math.floor((snapshot?.at||0)/1_000)}, rows={\n${rows.map(value=>`{id=${value.itemId}, name=${luaString(knownItemName(value.itemId)||`Item #${value.itemId}`)}, quantity=${value.quantity}, cost=${value.cost}, buyMax=${value.buyMax}, target=${value.target}},`).join('\n')}\n}}\n`;
   response.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Disposition':'attachment; filename="Plan.lua"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'});
   response.end(code);
   return;
  }
  if(path.startsWith('/api/'))fail(404,'NOT_FOUND','That AH Corner API route does not exist.');

  const file=resolve(dist,`.${path==='/'?'/index.html':path}`);
  if(!file.startsWith(`${dist}/`))fail(404,'NOT_FOUND','That page does not exist.');
  try{
   const data=await readFile(file);
   response.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'});
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
 clearInterval(recipeInterval);
 clearInterval(catalogInterval);
 clearTimeout(recipeStart);
 if(catalogTimer)clearTimeout(catalogTimer);
 recipeAbort.abort();
 nameResolver.close();
 metadataResolver.close();
 if(useRefreshTimer)clearTimeout(useRefreshTimer);
 server.close(()=>void store.close());
}

process.on('SIGTERM',shutdown);
process.on('SIGINT',shutdown);
