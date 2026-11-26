import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {Alert,Opportunity,Settings,Stats,Trade} from '../src/types.ts';
import type {BlizzardItemMetadataMap,ItemCategoryIndex,ItemUseKind,ItemUseMap,RecipeUseMap,ResolvedItemUse} from '../src/item-use.ts';
import {itemCategoryFor,itemUseFor} from '../src/item-use.ts';
import type {ItemNameDetails} from '../src/blizzard.ts';
import {formatMoney as money,opportunityInsights} from '../src/insights.ts';
import {defaultOpportunitySort,nextOpportunitySort,sortOpportunities} from '../src/opportunity-sort.ts';
import type {OpportunitySort,OpportunitySortKey} from '../src/opportunity-sort.ts';
import './style.css';

type PublicProblem={code:string;message:string;action?:string};

class ApiFailure extends Error{
 constructor(readonly problem:PublicProblem){super(problem.message);}
}

function problemFrom(error:unknown):PublicProblem{
 if(error instanceof ApiFailure)return error.problem;
 if(error instanceof Error&&error.name==='AbortError')return {code:'REQUEST_TIMEOUT',message:'AH Corner took too long to respond.',action:'Try again in a moment.'};
 return {code:'NETWORK_ERROR',message:'AH Corner could not be reached.',action:'Check your connection and that the service is running, then try again.'};
}

function isProblem(value:unknown):value is PublicProblem{
 return !!value&&typeof value==='object'&&typeof (value as PublicProblem).code==='string'&&typeof (value as PublicProblem).message==='string';
}

async function api<T>(path:string,body?:unknown):Promise<T>{
 let response:Response;
 try{
  response=await fetch(`/api/${path}`,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 }catch(error){throw new ApiFailure(problemFrom(error));}
 const text=await response.text();
 let payload:unknown;
 try{payload=text?JSON.parse(text):undefined;}
 catch{
  if(!response.ok)throw new ApiFailure({code:'SERVICE_RESPONSE_INVALID',message:'AH Corner returned an unexpected response.',action:'Try again. If this continues, check the server or reverse proxy.'});
  throw new ApiFailure({code:'RESPONSE_INVALID',message:'AH Corner returned unreadable data.',action:'Refresh the page and try again.'});
 }
 if(!response.ok){
  const error=isProblem((payload as {error?:unknown})?.error)?(payload as {error:PublicProblem}).error:undefined;
  if(response.status===401&&error?.code==='SIGN_IN_REQUIRED')window.dispatchEvent(new Event('ah-session-expired'));
  throw new ApiFailure(error||{code:`HTTP_${response.status}`,message:'AH Corner could not complete that request.',action:'Try again. If this continues, check the server logs.'});
 }
 return payload as T;
}

const unit=(c:number)=>money(c);
const pct=(n:number)=>`${Math.round(n*100)}%`;
const useSourceLabel=(source:ResolvedItemUse['source'])=>source==='player'?'player research':source==='blizzard-forever'?'Blizzard Forever item data':source==='warcraftforever-item'?'Warcraft Forever item data':'Warcraft Forever recipe data';

function ItemLink({id,name,source}:{id:number;name:string;source?:ItemNameDetails['source']}){
 return <><a href={`https://www.wowhead.com/forever/item=${id}`} target="_blank" rel="noopener noreferrer" onClick={event=>event.stopPropagation()}>{name}</a>{source&&source!=='forever'&&<small>{source==='classic-era'?'Classic Era':'Classic progression'} name · verify in Forever</small>}</>;
}

function SortHeader({label,column,sort,onSort}:{label:string;column:OpportunitySortKey;sort:OpportunitySort;onSort:(key:OpportunitySortKey)=>void}){
 const active=sort.key===column;
 return <th scope="col" aria-sort={active?(sort.direction==='asc'?'ascending':'descending'):undefined}><button type="button" className={`sort-header${active?' active':''}`} onClick={()=>onSort(column)}>{label}<span aria-hidden="true">{active?(sort.direction==='asc'?' ▲':' ▼'):' ↕'}</span></button></th>;
}

function HistoryChart({history,loading}:{history:Stats[];loading:boolean}){
 if(loading)return <p className="muted">Loading observed prices…</p>;
 if(!history.length)return <p className="muted">No saved price observations for this item yet.</p>;
 const ordered=[...history].sort((a,b)=>a.at-b.at);
 const first=ordered[0],last=ordered[ordered.length-1];
 const low=Math.min(...ordered.map(value=>value.floor)),high=Math.max(...ordered.map(value=>value.floor));
 const range=high-low;
 const point=(value:Stats)=>({x:first.at===last.at?150:8+(value.at-first.at)/(last.at-first.at)*284,y:range?68-(value.floor-low)/range*56:40});
 return <>
  <div className="timeline-meta"><span>Low {unit(low)}</span><span>High {unit(high)}</span><span>Latest {unit(last.floor)}</span></div>
  <svg viewBox="0 0 300 80" role="img" aria-label={`${ordered.length} observed floor prices, from ${unit(low)} to ${unit(high)} per unit`}>
   <path d="M8 12H292 M8 68H292" stroke="#36454b"/>
   {ordered.length===1?<circle cx={point(first).x} cy={point(first).y} r="3" fill="#76d2b4"/>:<polyline points={ordered.map(value=>{const p=point(value);return `${p.x},${p.y}`;}).join(' ')} fill="none" stroke="#76d2b4" strokeWidth="2.5"/>}
  </svg>
  <div className="timeline-meta"><span>{new Date(first.at).toLocaleString()}</span><span>{new Date(last.at).toLocaleString()}</span></div>
  <p className="metric-explainer">{ordered.length} saved hourly observations, when available. The decision checks use recent distinct auction books, so their count can differ.</p>
 </>;
}

type Collector={busy:boolean;lastChecked:number;lastSuccess:number;lastError:PublicProblem|null;nextScheduledAt:number|null};
type RefreshStatus=Pick<Collector,'busy'|'lastChecked'|'lastSuccess'|'lastError'>&{changed:boolean};
type Status={mode:string;market:string;houseVerified:boolean;at:number|null;listingCount:number;snapshots:number;collector:Collector;settings:Settings;monopolyTarget:number|null;watch:number[];names:Record<number,string>;nameSources:Record<number,ItemNameDetails['source']>;itemUses:ItemUseMap;recipeUses:RecipeUseMap;blizzardMetadata:BlizzardItemMetadataMap;itemCatalog?:ItemCategoryIndex;catalogLookup?:{busy:boolean;error:string|null;classified:number;knownUses?:number;total:number};metadataError:string|null;recipeIndex:{dataset:string;build:string;fetchedAt:number}|null;recipeLookup:{busy:boolean;error:string|null};stale:boolean};
type MonopolyTracking={itemId:number;at:number|null;floor:number|null;units:number;listings:number;history:Stats[]};
type Position={itemId:number;quantity:number;basis:number;realized:number;unmatched:number};
type Backtest={at:number;itemId:number;target:number;cost:number;potentialProfit:number;competingUnits:number;held:boolean};
type StrategyKind='monopolization'|'flipping';
type StrategyOpportunity=Opportunity;
const strategyOptions:{id:StrategyKind;title:string;description:string}[]=[
 {id:'monopolization',title:'Monopolization',description:'Focus on one good: buy out low-priced supply and test a higher floor.'},
 {id:'flipping',title:'Flipping',description:'Buy one underpriced listing and try to resell it without buying the market.'}
];

// Explain the same evidence used by the scanner without turning a missing
// check into a reason to trade. The snapshot may have aged since it was scored.
function blockers(row:StrategyOpportunity,status:Status,useKnown:boolean):string[]{
 const reasons:string[]=[];
 if(status.mode==='live'&&!status.houseVerified)reasons.push('Verify the auction house in game.');
 if(status.mode==='live'&&status.stale)reasons.push('Refresh the stale auction snapshot.');
 if(!useKnown)reasons.push('Research the item’s use and record it before trading.');
 if(!row.checks.historySufficient)reasons.push(`Wait for more price history (${row.historyCount} of ${row.checks.minimumHistory} observations).`);
 if(row.checks.supportSufficient!==true)reasons.push('The target does not have enough historical price support.');
 if(row.checks.targetSupported!==true)reasons.push('The target is above the historical price ceiling or cannot yet be evaluated.');
 if(row.checks.removalObserved!==true)reasons.push('There is not enough observed listing movement at the target.');
 if(row.checks.replenishmentControlled!==true)reasons.push('Competing supply is too high or cannot yet be evaluated.');
 if(row.flip&&row.flip.enoughMovement!==true)reasons.push('Observed listing movement is insufficient or unavailable for a 24-hour flip.');
 if(!row.checks.fresh&&!status.stale)reasons.push('Refresh the auction snapshot.');
 if(row.confidence==='watch'&&!reasons.length)reasons.push('Review the market checks before trading.');
 return reasons;
}

function App({onLogout}:{onLogout?:()=>void}){
 const [status,setStatus]=useState<Status>();
 const [rows,setRows]=useState<StrategyOpportunity[]>([]);
 const [loadingRows,setLoadingRows]=useState(true);
 const [strategy,setStrategy]=useState<StrategyKind>('monopolization');
 const strategyRef=useRef(strategy);
 strategyRef.current=strategy;
 const [sort,setSort]=useState<OpportunitySort>(defaultOpportunitySort);
 const sortRef=useRef(sort);
 sortRef.current=sort;
 const [bank,setBank]=useState(35);
 const [roi,setRoi]=useState(30);
 const [exposure,setExposure]=useState(35);
 const [minProfit,setMinProfit]=useState(0);
 const [fee,setFee]=useState(5);
 const [minHistory,setMinHistory]=useState(6);
 const strategyDirty=useRef(false);
 const detailRef=useRef<HTMLElement>(null);
 const [tab,setTab]=useState('Scanner');
 const [id,setId]=useState<number>();
 const [history,setHistory]=useState<Stats[]>([]);
 const [historyLoading,setHistoryLoading]=useState(false);
 const [portfolio,setPortfolio]=useState<{trades:Trade[];positions:Position[]}>({trades:[],positions:[]});
 const [alerts,setAlerts]=useState<Alert[]>([]);
 const [backtests,setBacktests]=useState<Backtest[]>([]);
 const [error,setError]=useState<PublicProblem>();
 const [notice,setNotice]=useState('');
 const [refreshing,setRefreshing]=useState(false);
 const [refreshError,setRefreshError]=useState<PublicProblem>();
 const refreshLock=useRef(false);
 const [onlyWatch,setOnlyWatch]=useState(false);
 const [showUnnamed,setShowUnnamed]=useState(false);
 const [query,setQuery]=useState('');
 const [targetQuery,setTargetQuery]=useState('');
 const [tracking,setTracking]=useState<MonopolyTracking>();
 const [trackingError,setTrackingError]=useState<PublicProblem>();
 const [targetPending,setTargetPending]=useState(false);
 const [settledQuery,setSettledQuery]=useState({value:'',revision:0});
 const queryMounted=useRef(false);
 const queryRef=useRef('');
 const settledQueryRef=useRef('');
 const onlyWatchRef=useRef(onlyWatch);
 const showUnnamedRef=useRef(showUnnamed);
 onlyWatchRef.current=onlyWatch;
 showUnnamedRef.current=showUnnamed;
 settledQueryRef.current=settledQuery.value;
 useEffect(()=>{
  if(!queryMounted.current){queryMounted.current=true;return;}
  const timer=setTimeout(()=>setSettledQuery(previous=>({value:query.trim(),revision:previous.revision+1})),300);
  return()=>clearTimeout(timer);
 },[query]);
 const [researchId,setResearchId]=useState('');
 const [researchKind,setResearchKind]=useState<ItemUseKind|'unknown'>('unknown');
 const [researchNote,setResearchNote]=useState('');
 const [form,setForm]=useState({side:'buy',itemId:'',quantity:'',total:'',fee:'0'});
 const targetId=status?.monopolyTarget;
 const targetText=targetQuery.trim();
 const exactTargetId=/^[1-9][0-9]*$/.test(targetText)&&Number.isSafeInteger(Number(targetText))?Number(targetText):null;
 const targetMatches=targetText&&!exactTargetId?Object.entries(status?.names||{})
  .filter(([,itemName])=>itemName.toLowerCase().includes(targetText.toLowerCase())).slice(0,8):[];
 const tracked=tracking&&tracking.itemId===targetId?tracking:undefined;

 useEffect(()=>{
  setTrackingError(undefined);
  if(!targetId||strategy!=='monopolization'||tab!=='Scanner')return;
  let active=true;
  api<MonopolyTracking|null>('monopoly-target').then(result=>{
   if(active)setTracking(result??undefined);
  }).catch(cause=>{if(active)setTrackingError(problemFrom(cause));});
  return()=>{active=false;};
 },[targetId,status?.at,strategy,tab]);

 async function trackItem(itemId:number|null){
  setTargetPending(true);
  setTrackingError(undefined);
  try{
   await api<{itemId:number|null}>('monopoly-target',{itemId});
   setStatus(previous=>previous?{...previous,monopolyTarget:itemId}:previous);
   setTargetQuery('');
  }catch(cause){setTrackingError(problemFrom(cause));}
  finally{setTargetPending(false);}
 }

 function updateSearch(value:string){
  if(queryRef.current!==value.trim()){
   queryRef.current=value.trim();
   setLoadingRows(true);
   setRows([]);
  }
  setQuery(value);
 }

 function filterForTarget(itemId:number){
  onlyWatchRef.current=false;
  setOnlyWatch(false);
  updateSearch(String(itemId));
 }

 const resolvedName=(itemId:number)=>{const value=status?.names[itemId];return value&&value!==`Item #${itemId}`?value:undefined;};
 const name=(itemId:number)=>resolvedName(itemId)||`Item #${itemId} (name unavailable)`;
 const use=(itemId:number)=>itemUseFor(status?.itemUses||{},itemId,status?.recipeUses||{},status?.blizzardMetadata||{},status?.itemCatalog);
 const consumableUse=(itemId:number)=>{const result=itemUseFor({},itemId,{},status?.blizzardMetadata||{},status?.itemCatalog);return result?.kind==='consumable'?result:undefined;};
 const category=(itemId:number)=>itemCategoryFor(itemId,status?.blizzardMetadata||{},status?.itemCatalog);
 const useLabel=(itemId:number)=>{
  const primary=use(itemId),secondary=consumableUse(itemId),itemCategory=category(itemId);
  const useName=primary?.source==='warcraftforever-recipe'&&secondary?`${primary.kind} · ${secondary.kind}`:primary?.kind;
  return itemCategory?`${itemCategory.label} · ${useName||'use unverified'}`:useName||'use unknown';
 };
 const filtered=sortOpportunities(rows,sort,name);
 const active=filtered.find(row=>row.itemId===id)||filtered[0];
 const changeSort=(key:OpportunitySortKey)=>{
  if(active)setId(active.itemId);
  const next=nextOpportunitySort(sortRef.current,key);
  sortRef.current=next;
  setSort(next);
 };
 const changeStrategy=(next:StrategyKind)=>{
  if(next===strategyRef.current)return;
  strategyRef.current=next;setLoadingRows(true);setRows([]);setId(undefined);setStrategy(next);
 };
 const selectOpportunity=(itemId:number)=>{
  setId(itemId);
  detailRef.current?.focus({preventScroll:true});
  detailRef.current?.scrollIntoView({block:'start',behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
 };

 useEffect(()=>{
  if(!active)return;
  const evidence=status?.itemUses?.[active.itemId];
  setResearchId(String(active.itemId));
  setResearchKind(evidence?.kind||'unknown');
  setResearchNote(evidence?.note||'');
 },[active?.itemId,status?.market]);

 async function load(requestedSort=sortRef.current,requestedStrategy=strategyRef.current,requestedQuery=settledQueryRef.current,requestedWatch=onlyWatchRef.current,requestedShowUnnamed=showUnnamedRef.current){
  const current=()=>sortRef.current.key===requestedSort.key&&sortRef.current.direction===requestedSort.direction&&strategyRef.current===requestedStrategy&&queryRef.current===requestedQuery&&settledQueryRef.current===requestedQuery&&onlyWatchRef.current===requestedWatch&&showUnnamedRef.current===requestedShowUnnamed;
  const params=new URLSearchParams({strategy:requestedStrategy,sort:requestedSort.key,direction:requestedSort.direction});
  if(requestedQuery)params.set('q',requestedQuery);
  if(requestedWatch)params.set('watch','1');
  if(!requestedShowUnnamed)params.set('named','1');
  try{
   const [nextStatus,opportunities,nextAlerts,nextPortfolio]=await Promise.all([
    api<Status>('status'),
    api<{rows:StrategyOpportunity[]}>(`opportunities?${params}`),
    api<Alert[]>('alerts'),
    api<typeof portfolio>('portfolio')
   ]);
   if(!current())return;
   setStatus(nextStatus);
   if(!strategyDirty.current){
    setBank(nextStatus.settings.bankroll/10_000);
    setRoi(Number((nextStatus.settings.minROI*100).toFixed(2)));
    setExposure(Number((nextStatus.settings.exposure*100).toFixed(2)));
    setMinProfit(nextStatus.settings.minProfit/10_000);
    setFee(Number((nextStatus.settings.fee*100).toFixed(2)));
    setMinHistory(nextStatus.settings.minHistory);
   }
   setRows(opportunities.rows);setLoadingRows(false);
   setAlerts(nextAlerts);
   setPortfolio(nextPortfolio);
   setError(undefined);
  }catch(cause){if(current()){setLoadingRows(false);setError(problemFrom(cause));}}
 }

 useEffect(()=>{
  void load();
  const timer=setInterval(()=>void load(),30_000);
  return()=>clearInterval(timer);
 },[sort.key,sort.direction,strategy,settledQuery,onlyWatch,showUnnamed]);

 useEffect(()=>{
  let live=true;
  if(active){
   setHistory([]);setHistoryLoading(true);
   api<Stats[]>(`history?id=${active.itemId}`).then(value=>{if(live)setHistory(value);}).catch(cause=>{if(live)setError(problemFrom(cause));}).finally(()=>{if(live)setHistoryLoading(false);});
  }else{setHistory([]);setHistoryLoading(false);}
  return()=>{live=false;};
 },[active?.itemId,status?.at]);

 useEffect(()=>{
  if(tab==='Backtest')api<Backtest[]>('backtest').then(setBacktests).catch(cause=>setError(problemFrom(cause)));
 },[tab,status?.at]);

 async function action<T>(fn:()=>Promise<T>,message:string|((result:T)=>string)){
  try{
   setError(undefined);
   const result=await fn();
   setNotice(typeof message==='function'?message(result):message);
   await load();
  }catch(cause){setError(problemFrom(cause));}
 }

 async function refreshSource(){
  if(refreshLock.current)return;
  refreshLock.current=true;
  setRefreshing(true);
  setRefreshError(undefined);
  setNotice('');
  try{
   const started=await api<{lastChecked:number}>('collect',{});
   const deadline=Date.now()+5*60_000;
   while(Date.now()<deadline){
    const result=await api<RefreshStatus>('collect');
    if(!result.busy&&result.lastChecked>=started.lastChecked){
     await load();
     if(result.lastError)throw new ApiFailure(result.lastError);
     if(result.lastSuccess<started.lastChecked)break;
     setNotice(result.changed?'Market refreshed. New auction prices and listings are loaded.':'Market checked successfully. The auction book is unchanged.');
     return;
    }
    await new Promise(resolve=>setTimeout(resolve,2_000));
   }
   setNotice('The refresh is taking longer than expected. Check the last snapshot time for updates.');
  }catch(cause){setRefreshError(problemFrom(cause));}
  finally{refreshLock.current=false;setRefreshing(false);}
 }

 const sourceLabel=status?.mode==='demo'?'SIMULATED DATA':status?.stale?'STALE DATA':status?.collector.lastError?'REFRESH ISSUE':'LIVE SOURCE';
 const provisional=status?.mode==='live'&&!status.houseVerified;
 const insights=active&&status?opportunityInsights(active,status.settings):undefined;
 const activeUse=active?use(active.itemId):undefined;
 const activeConsumable=active?consumableUse(active.itemId):undefined;
 const activeCategory=active?category(active.itemId):undefined;
 const activeBlockers=active&&status?blockers(active,status,!!activeUse):[];
 const canConsider=!!active&&!!status&&active.confidence==='candidate'&&!activeBlockers.length;

 return <>
  <header>
   <div className="brand"><span className="mark">◈</span><div><h1>AH Corner</h1><small>FOREVER MARKET INTELLIGENCE</small></div></div>
   <div className="status"><span className={`dot ${status?.mode==='live'&&!status?.stale&&!status?.collector.lastError?'live':''}`}/>{sourceLabel}<small>{status?.market||'Connecting'}</small>{onLogout&&<button onClick={onLogout}>Sign out</button>}</div>
  </header>
  <main>
   <div className="intro">
    <div><p className="eyebrow">MARKET OPERATIONS</p><h2>Find the gap. Price the risk.</h2><p>Choose a strategy, verify live listings, and track actual returns.</p></div>
    <button disabled={refreshing||status?.collector.busy} onClick={()=>void refreshSource()}>{refreshing||status?.collector.busy?'Refreshing source…':'↻ Refresh source'}</button>
   </div>
   {status?.mode==='demo'&&<div className="banner">Demo mode — all market snapshots are synthetic. No live trade recommendations or outbound alerts.</div>}
   {provisional&&<div className="banner bad" role="alert"><strong>Unverified auction house.</strong> These are live prices from house {status?.market.split(':').at(-1)}, but its US PvP Horde mapping has not been verified in-game. Opportunities are watch-only; alerts, backtesting and addon plans are disabled until verification.</div>}
   {(refreshError||status?.collector.lastError)&&<div className="banner bad" role="alert"><strong>{(refreshError||status?.collector.lastError)?.message}</strong> {(refreshError||status?.collector.lastError)?.action}</div>}
   {error&&<div className="banner bad" role="alert"><strong>{error.message}</strong>{error.action&&<span> {error.action}</span>}</div>}
   {notice&&<div className="banner" role="status">{notice} <button onClick={()=>setNotice('')}>Dismiss</button></div>}
   <section className="metrics">
    <div><small>STRATEGY BANKROLL</small><strong>{status?money(status.settings.bankroll):'—'}</strong><label>Maximum exposure: {status?money(Math.floor(status.settings.bankroll*status.settings.exposure)):'—'}</label></div>
    <div><small>OPPORTUNITIES SHOWN</small><strong>{rows.length}</strong><label>{rows.filter(row=>status&&row.confidence==='candidate'&&!blockers(row,status,!!use(row.itemId)).length).length} to review · up to 100 shown</label></div>
    <div><small>RECENT BOOKS ANALYZED</small><strong>{status?.snapshots??'—'}</strong><label>{status?.listingCount.toLocaleString()||'—'} priced listings in latest book</label></div>
    <div><small>LAST SNAPSHOT</small><strong className="date">{status?.at?new Date(status.at).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):'—'}</strong><label>{status?.at?new Date(status.at).toLocaleDateString():''}</label></div>
   </section>
   <nav>{['Scanner','Portfolio','Backtest','Alerts','Setup'].map(value=><button key={value} className={value===tab?'selected':''} onClick={()=>setTab(value)}>{value}</button>)}</nav>
   {tab==='Scanner'&&<>
    <section className="strategy-selector" aria-label="Choose a trading strategy">
     <div className="strategy-heading"><div><p className="eyebrow">YOUR APPROACH</p><h3>Choose a strategy</h3></div><span>More strategies can be added as we learn.</span></div>
     <div className="strategy-options" role="group" aria-label="Trading strategy">{strategyOptions.map(option=><button key={option.id} type="button" className={`strategy-option${strategy===option.id?' selected':''}`} aria-pressed={strategy===option.id} onClick={()=>changeStrategy(option.id)}><span className="strategy-name">{option.title}</span><span>{option.description}</span></button>)}</div>
     <p className="strategy-context">{strategy==='monopolization'?'Save one item as your monopolization target to monitor its price and supply. Each plan models one initial floor increase, not market control. Monitor new supply and actual results before repeating; stop if competitors overwhelm the market. Increase your bankroll in shared settings and sort by Buyout to explore larger opportunities as capital grows. The app does not automatically rotate your focus.':'Looks for an individual cheap listing against recent floors and the remaining market. A 24-hour resale is a goal, not a promise or verified sale.'}</p>
    </section>
    {strategy==='monopolization'&&<section className="panel monopoly-tracker" aria-labelledby="monopoly-tracker-title">
     <h3 id="monopoly-tracker-title">Monopolization target</h3>
     {targetId?<><div className="between">
      <strong><ItemLink id={targetId} name={name(targetId)} source={status?.nameSources?.[targetId]}/></strong>
      <div className="tracker-actions">
       <button type="button" onClick={()=>filterForTarget(targetId)}>Search scanner by ID</button>
       <button type="button" disabled={targetPending} onClick={()=>void trackItem(null)}>Stop tracking</button>
      </div>
     </div>
     {tracked?<><div className="three">
      <div><small>LOWEST PRICE PER UNIT</small><strong>{tracked.floor===null?'—':money(tracked.floor)}</strong></div>
      <div><small>UNITS LISTED</small><strong>{tracked.at===null?'—':tracked.units.toLocaleString()}</strong></div>
      <div><small>LISTINGS</small><strong>{tracked.at===null?'—':tracked.listings.toLocaleString()}</strong></div>
     </div>
     <p className="metric-explainer">{tracked.at===null?'Waiting for a market snapshot.':`As of ${new Date(tracked.at).toLocaleString()}.${tracked.floor===null?' This item had no priced listings in that snapshot.':''}`}</p>
     <details className="supporting-detail">
      <summary>Price and supply history</summary>
      <HistoryChart history={tracked.history} loading={false}/>
      {tracked.history.length>0&&<div className="tracker-history">
       <table><thead><tr><th scope="col">Observed</th><th scope="col">Floor per unit</th><th scope="col">Units listed</th><th scope="col">Listings</th></tr></thead>
       <tbody>{tracked.history.slice(-12).reverse().map(point=><tr key={point.at}><td>{new Date(point.at).toLocaleString()}</td><td>{money(point.floor)}</td><td>{point.units.toLocaleString()}</td><td>{point.listings.toLocaleString()}</td></tr>)}</tbody></table>
      </div>}
     </details></>:!trackingError&&<p className="muted">Loading target data…</p>}</>:<p className="muted">Choose one item to follow across auction snapshots. You can also select a target from any opportunity below.</p>}
     <form className="filters" onSubmit={event=>{event.preventDefault();if(exactTargetId)void trackItem(exactTargetId);}}>
      <label>{targetId?'Change target':'Find target'}<input placeholder="Item name or ID" maxLength={120} value={targetQuery} onChange={event=>setTargetQuery(event.target.value)}/></label>
      {exactTargetId!==null&&<button type="submit" disabled={!status||targetPending||exactTargetId===targetId}>Track {resolvedName(exactTargetId)||`item #${exactTargetId}`}</button>}
     </form>
     {targetMatches.length>0&&<ul className="target-matches">{targetMatches.map(([itemId,itemName])=><li key={itemId}><button type="button" disabled={targetPending||Number(itemId)===targetId} onClick={()=>void trackItem(Number(itemId))}>{itemName} <span>#{itemId}</span></button></li>)}</ul>}
     {targetText&&!exactTargetId&&!targetMatches.length&&<p className="muted">No saved names match. Try an exact item ID.</p>}
     {trackingError&&<p className="banner bad" role="alert">{trackingError.message} {trackingError.action}</p>}
    </section>}
    <details className="panel strategy-panel"><summary>Shared strategy settings <span>· {status?money(status.settings.bankroll):'—'} bankroll · {status?pct(status.settings.exposure):'—'} max per item</span></summary>
    <form className="filters" onSubmit={event=>{event.preventDefault();void action(async()=>{
     await api<Settings>('settings',{bankroll:Math.round(bank*10_000),exposure:exposure/100,minROI:roi/100,minProfit:Math.round(minProfit*10_000),fee:fee/100,minHistory});
     strategyDirty.current=false;
    },'Your strategy was saved for this market.');}}>
     <label>Bankroll (gold)<input required type="number" min="0.0001" step="0.0001" value={bank} onChange={event=>{strategyDirty.current=true;setBank(Number(event.target.value));}}/></label>
     <label>Max exposure (%)<input required type="number" min="0.01" max="100" step="0.01" value={exposure} onChange={event=>{strategyDirty.current=true;setExposure(Number(event.target.value));}}/></label>
     <label>Min. ROI (%)<input required type="number" min="0" max="1000" step="0.01" value={roi} onChange={event=>{strategyDirty.current=true;setRoi(Number(event.target.value));}}/></label>
     <label>Min. profit (gold)<input required type="number" min="0" step="0.0001" value={minProfit} onChange={event=>{strategyDirty.current=true;setMinProfit(Number(event.target.value));}}/></label>
     <label>AH fee (%)<input required type="number" min="0" max="99.99" step="0.01" value={fee} onChange={event=>{strategyDirty.current=true;setFee(Number(event.target.value));}}/></label>
     <label>Min. observations<input required type="number" min="1" max="24" step="1" value={minHistory} onChange={event=>{strategyDirty.current=true;setMinHistory(Number(event.target.value));}}/></label>
     <button type="submit" disabled={!status}>Save strategy</button>
    </form>
    <p className="muted">These personal settings apply to both strategies for this market. Exposure is a per-opportunity limit, not a reservation. Backtests and addon plans cover monopolization only; scheduled alerts use the shared market settings.</p>
    </details>
    <section className="filters">
     <label>Search<input placeholder="Item name or ID" maxLength={120} value={query} onChange={event=>updateSearch(event.target.value)}/></label>
     <label className="check"><input type="checkbox" checked={onlyWatch} onChange={event=>{onlyWatchRef.current=event.target.checked;setOnlyWatch(event.target.checked);setLoadingRows(true);setRows([]);}}/> Watchlist only</label>
     <label className="check"><input type="checkbox" checked={showUnnamed} onChange={event=>{showUnnamedRef.current=event.target.checked;setShowUnnamed(event.target.checked);setLoadingRows(true);setRows([]);}}/> Include items without names</label>
    </section>
    {status?.catalogLookup&&<p className="metric-explainer">Item types classified: {status.catalogLookup.classified.toLocaleString()} of {status.catalogLookup.total.toLocaleString()} distinct items in the latest market snapshot{status.catalogLookup.total?` (${(Math.floor(status.catalogLookup.classified/status.catalogLookup.total*1_000)/10).toFixed(1)}%)`:''}.{typeof status.catalogLookup.knownUses==='number'?` Specific uses identified: ${status.catalogLookup.knownUses.toLocaleString()} of ${status.catalogLookup.total.toLocaleString()}.`:''} Item type does not establish a specific use or player demand.{status.catalogLookup.busy?' Item catalog is refreshing.':''}{status.catalogLookup.error?` ${status.catalogLookup.error}`:''}</p>}
    <details className="panel">
     <summary>Record item-use research</summary>
     <p className="muted">Categories come from saved Blizzard and <a href="https://warcraftforever.com/developers/data/" target="_blank" rel="noopener noreferrer">Warcraft Forever item data</a>. A category such as trade goods does not prove a specific use; items without use evidence stay watch-only. Your research overrides automatic use evidence; choose Unknown to clear your override. Excluded items are hidden.</p>
     {status?.metadataError&&<p className="muted">{status.metadataError}</p>}
     {status?.mode==='live'&&status.recipeLookup?.error&&<p className="muted">{status.recipeLookup.error}</p>}
     {!status?.recipeIndex&&status?.mode==='live'&&!status.recipeLookup?.error&&<p className="muted">Loading the recipe index; items without research remain watch-only.</p>}
     {status?.recipeIndex&&<p className="muted">Recipe data: Forever build {status.recipeIndex.build}, checked {new Date(status.recipeIndex.fetchedAt).toLocaleString()}. A recipe relationship does not prove demand or sales.</p>}
     <form className="filters" onSubmit={event=>{event.preventDefault();void action(()=>api('item-use',{itemId:Number(researchId),kind:researchKind,note:researchNote}),'Item research saved.');}}>
      <label>Item ID<input required type="number" min="1" step="1" value={researchId} onChange={event=>{const next=event.target.value;const evidence=status?.itemUses?.[Number(next)];setResearchId(next);setResearchKind(evidence?.kind||'unknown');setResearchNote(evidence?.note||'');}}/></label>
      <label>Use or decision<select value={researchKind} onChange={event=>setResearchKind(event.target.value as ItemUseKind|'unknown')}><option value="unknown">Unknown</option><option value="profession">Profession / crafting</option><option value="quest">Quest</option><option value="consumable">Consumable</option><option value="equipment">Equipment</option><option value="other">Other use</option><option value="exclude">Exclude from queue</option></select></label>
      <label>Use and source<input maxLength={300} required={researchKind!=='unknown'} minLength={researchKind==='unknown'?undefined:3} value={researchNote} onChange={event=>setResearchNote(event.target.value)} placeholder="e.g. recipe or quest name"/></label>
      <button type="submit">Save research</button>
     </form>
    </details>
    <div className="scanner-results">
     <section className="panel opportunity-panel">
      <div className="queue-heading"><div><h3>{strategy==='monopolization'?'Monopolization':'Flipping'} opportunities <span>{filtered.length}</span></h3><p className="metric-explainer">Choose an item for its steps and evidence. Search and watchlist filters apply before the first 100 results; select a column heading to sort. Name searches use saved names; search an exact item ID even before its name is available.</p></div></div>
      <div className="opportunity-scroll" role="region" aria-label="Scrollable opportunities table" tabIndex={0}><table className="opportunity-table"><thead><tr><SortHeader label="Item" column="name" sort={sort} onSort={changeSort}/><SortHeader label="Suggested action" column="action" sort={sort} onSort={changeSort}/><SortHeader label="Avg. buy price" column="purchasePrice" sort={sort} onSort={changeSort}/><SortHeader label={strategy==='flipping'?'Listing cost':'Buyout'} column="cost" sort={sort} onSort={changeSort}/><SortHeader label="Potential profit" column="profit" sort={sort} onSort={changeSort}/><SortHeader label="ROI" column="roi" sort={sort} onSort={changeSort}/><SortHeader label="Score" column="score" sort={sort} onSort={changeSort}/></tr></thead><tbody>{filtered.map(row=>{
       const reasons=status?blockers(row,status,!!use(row.itemId)):['Loading market status.'];
       const candidate=row.confidence==='candidate'&&!reasons.length;
       return <tr key={row.itemId} onClick={()=>selectOpportunity(row.itemId)} className={active?.itemId===row.itemId?'chosen':''}><td><ItemLink id={row.itemId} name={name(row.itemId)} source={status?.nameSources?.[row.itemId]}/> <button className="link" onClick={event=>{event.stopPropagation();selectOpportunity(row.itemId);}} aria-label={`View details for ${name(row.itemId)}`}>Details</button><small>{useLabel(row.itemId)}</small></td><td className="queue-action"><strong className={candidate?'green':'warning-text'}>{candidate?(status?.mode==='demo'?'Example':strategy==='flipping'?'Consider flip':'Consider reset'):'Hold off'}</strong><small>{candidate?(strategy==='flipping'?`Buy one listing (${row.quantity.toLocaleString()} units); relist at ${unit(row.target)}/unit`:`Buy all listings through ${unit(row.buyMax)}/unit; relist at ${unit(row.target)}/unit`):reasons[0]}</small></td><td>{money(row.cost/row.quantity)}<small>per unit</small></td><td>{money(row.cost)}</td><td className="green">+{money(row.profit)}<small>if all sell</small></td><td>{pct(row.roi)}</td><td>{row.score}</td></tr>;
      })}</tbody></table>{!filtered.length&&<p className="empty">{loadingRows?'Loading opportunities…':rows.length?'No items match these filters. Names may still be loading; include items without names to inspect them.':'No opportunities match this strategy and filter. Try an exact item ID, adjust the shared settings, or check again after more snapshots.'}</p>}</div>
     </section>
     <section className="panel detail" ref={detailRef} tabIndex={-1} aria-label="Selected opportunity details">
      {active&&insights&&status?<>
       <div className="between"><h3><ItemLink id={active.itemId} name={name(active.itemId)} source={status?.nameSources?.[active.itemId]}/></h3><div className="tracker-actions">{strategy==='monopolization'&&<button type="button" disabled={!status||targetPending||targetId===active.itemId} onClick={()=>void trackItem(active.itemId)}>{targetId===active.itemId?'Tracked as target':'Track as target'}</button>}<button onClick={()=>action(()=>api('watch',{itemId:active.itemId}),'Watchlist updated.')}>{status?.watch.includes(active.itemId)?'★ Watching':'☆ Watch'}</button></div></div>
       <div className={`decision-summary ${canConsider?'candidate':'watch'}`}>
        <small className="detail-kicker">Suggested action {status.mode==='demo'?'· example only':''}</small>
        <strong>{canConsider?strategy==='flipping'?`Consider flipping one ${name(active.itemId)} listing`:`Consider a ${name(active.itemId)} buyout`:'Hold off — do not buy yet'}</strong>
        <p>{canConsider?`Estimated ${strategy==='flipping'?'listing cost':'buyout'} ${money(active.cost)}; try relisting at ${unit(active.target)} per unit. Verify the market in game first.`:'The plan below is hypothetical. Resolve the checks before considering a purchase.'}</p>
        {!canConsider&&<ul className="blocker-list">{activeBlockers.map(reason=><li key={reason}>{reason}</li>)}</ul>}
       </div>
       <section className="insight-section">
        <h4>{canConsider?'How to do it':'Hypothetical plan — do not buy yet'}</h4>
        <p className="metric-explainer">Based on the {status.at?new Date(status.at).toLocaleString():'latest'} snapshot. Prices and listings can change before you reach the auction house.</p>
        <ol className="action-steps">
         <li><strong>Check the live listings.</strong> Search for {name(active.itemId)} and compare the current prices, quantities and total cost with this plan. If they have changed, stop and refresh the source before reconsidering.</li>
         {strategy==='flipping'?<li><strong>Buy one matching listing.</strong> Find the listing of {active.quantity.toLocaleString()} units for {money(active.cost)} total (up to {unit(active.buyMax)} per unit). Buy only that listing; regular auction stacks must be bought in full. Other listings remain on the market.</li>:<li><strong>Buy all the lowest-priced listings at or below {unit(active.buyMax)} per unit.</strong> The snapshot includes {active.purchaseListings.toLocaleString()} such listings totalling {active.quantity.toLocaleString()} units, for {money(active.cost)} total. Regular auction stacks must be bought in full; the estimate assumes all of these listings are purchased.</li>}
         <li><strong>Try to relist at {unit(active.target)} per unit.</strong> {strategy==='flipping'?'The target uses recent observed prices and the next remaining listing.':'This target is one copper below the next price tier in the snapshot.'} If all units sell at the target, estimated profit is {money(active.profit)} after the configured AH fee.</li>
         {strategy==='monopolization'&&<li><strong>Monitor the market.</strong> New listings can immediately undercut the higher floor. After the next snapshot, check competing supply, actual sales and your remaining capital; repeat only if the market still supports it, or stop if competition overwhelms the plan. This covers just the initial step.</li>}
        </ol>
        <p className="plan-note">Sales are not guaranteed. The estimate excludes deposits, reposting costs and price changes.</p>
       </section>
       <details className="insight-section supporting-detail">
        <summary>Show plan breakdown</summary>
        {strategy==='monopolization'&&active.monopoly&&<p className="why-summary">The proposed purchase is {pct(active.monopoly.plannedShare)} of the {active.monopoly.snapshotUnits.toLocaleString()} units currently listed in this snapshot. This excludes inventory you already own and hidden or future supply; it is not proof of market control.</p>}
        <div className="plan-grid">
         <div className="plan-card"><small>{strategy==='flipping'?'LISTING COST':'BUYOUT COST'}</small><strong>{money(active.cost)}</strong><small>{active.quantity.toLocaleString()} units across {active.purchaseListings.toLocaleString()} listings</small></div>
         <div className="plan-card"><small>CAPITAL AT RISK</small><strong>{pct(insights.capitalFraction)} of bankroll</strong><small>{money(insights.exposureLimit)} per-item exposure limit</small></div>
         <div className="plan-card"><small>HIGHEST BUY PRICE</small><strong>{unit(active.buyMax)} / unit</strong><small>Approx. {unit(insights.averageCostPerUnit)} average per unit</small></div>
         <div className="plan-card"><small>PROPOSED RESELL PRICE</small><strong>{unit(active.target)} / unit</strong><small>{strategy==='flipping'?'Based on history and remaining listings':'One copper below the next listed tier'}</small></div>
         <div className="plan-card"><small>POTENTIAL PROFIT</small><strong>{money(active.profit)}</strong><small>{pct(active.roi)} return if all units sell at target</small></div>
         <div className="plan-card"><small>BREAK EVEN AT TARGET</small><strong>{active.breakEvenUnits.toLocaleString()} of {active.quantity.toLocaleString()} units</strong><small>Assumes the configured AH fee</small></div>
        </div>
        <p className="plan-note">If every unit sells at the target: {money(insights.grossRevenue)} gross, about {money(insights.feeAmount)} in AH fees, and {money(insights.netRevenue)} after fees. Profit excludes deposits, reposts and price changes; sales are not guaranteed.</p>
       </details>
       <section className="insight-section">
        <h4>Why {canConsider?'the app found this':'the app says to hold off'}</h4>
        <p className="why-summary">{activeCategory?`Item category: ${activeCategory.label} (${activeCategory.source==='blizzard-forever'?'Blizzard Forever item data':'Warcraft Forever item data'}). `:''}{activeUse?`Known use: ${activeUse.kind}, from ${useSourceLabel(activeUse.source)} (${activeUse.note}). A known use does not prove demand.`:'The item’s specific use is not yet known.'} {active.historyCount?`${pct(active.support)} of ${active.historyCount} prior observed price floors were at or above the proposed target.`:'There are no prior price floors to support the proposed target yet.'} {active.removedUnits===null?'No comparable listing intervals are available.':`About ${active.removedUnits.toFixed(1)} units/hour disappeared at or below the target${active.replenish===null?'.':`, while ${active.replenish.toFixed(1)} units/hour appeared below it.`}`} Disappearing listings may have sold, expired or been cancelled.</p>
        {strategy==='monopolization'&&active.monopoly&&<p className="why-summary">The buyout covers {pct(active.monopoly.plannedShare)} of the {active.monopoly.snapshotUnits.toLocaleString()} units listed in this snapshot. Existing inventory and hidden or future supply are not counted, so this does not measure market ownership or control.</p>}
        {strategy==='flipping'&&active.flip&&<p className="why-summary">Recent median floor: {active.flip.historicalMedian===null?'not available':`${unit(active.flip.historicalMedian)} per unit`}; cheapest remaining listing: {unit(active.flip.remainingFloor)} per unit. {active.flip.observedRemovalsPerDay===null?'Not enough comparable history to estimate listing movement.':`Historical listing removals averaged ${active.flip.observedRemovalsPerDay.toFixed(1)} units per day, extrapolated from comparable snapshots.`} Disappearances are not verified sales, and this does not predict when your listing will sell.</p>}
        <details className="supporting-detail"><summary>Show all market checks</summary>
        <ul className="check-list">
         <li className={`check-row ${provisional?'warning':'pass'}`}><span className="check-icon" aria-hidden="true">{provisional?'!':'✓'}</span><div className="check-copy"><strong>Auction house · {provisional?'unverified':status.mode==='demo'?'demo':'verified'}</strong><small>{provisional?'Compare prices with your in-game US PvP Horde auction house before relying on this market.':status.mode==='demo'?'Synthetic data for testing only.':'The selected auction house has been marked verified.'}</small></div></li>
         <li className={`check-row ${activeUse?'pass':'unknown'}`}><span className="check-icon" aria-hidden="true">{activeUse?'✓':'?'}</span><div className="check-copy"><strong>Item use · {activeUse?activeUse.kind:'unknown'}</strong><small>{activeUse?`${useSourceLabel(activeUse.source)}: ${activeUse.note}. A use does not prove demand or sales.`:'No specific use is known yet. The item category alone does not prove its use; research it before trading.'}</small>{activeUse?.source==='warcraftforever-recipe'&&activeConsumable&&<small>{useSourceLabel(activeConsumable.source)} also identifies this as {activeConsumable.note.toLowerCase()}.</small>}{activeUse?.source==='warcraftforever-recipe'&&<a href={`https://warcraftforever.com/spells/${activeUse.recipeId}`} target="_blank" rel="noopener noreferrer">View source recipe</a>}</div></li>
         {strategy==='flipping'&&active.flip&&<li className={`check-row ${active.flip.enoughMovement===true?'pass':active.flip.enoughMovement===false?'warning':'unknown'}`}><span className="check-icon" aria-hidden="true">{active.flip.enoughMovement===true?'✓':active.flip.enoughMovement===false?'!':'?'}</span><div className="check-copy"><strong>24-hour movement · {active.flip.enoughMovement===true?'meets model check':active.flip.enoughMovement===false?'needs attention':'not enough data'}</strong><small>Historical listing removals are compared with the proposed quantity as a rough signal only; they are not verified sales or a prediction of resale time.</small></div></li>}
         {insights.checks.map(check=><li className={`check-row ${check.status==='caution'?'warning':check.status}`} key={check.key}><span className="check-icon" aria-hidden="true">{check.status==='pass'?'✓':check.status==='caution'?'!':'?'}</span><div className="check-copy"><strong>{check.label} · {check.status==='pass'?'meets model check':check.status==='caution'?'needs attention':'not enough data'}</strong><small>{check.detail}</small></div></li>)}
        </ul>
        <p className="metric-explainer">Score {active.score}/100 is a ranking heuristic, not a probability or an estimate of sales. Removed listings may have sold, expired, or been cancelled.</p>
        </details>
       </section>
       <details className="insight-section supporting-detail">
        <summary>Order book · up to 20 lowest price tiers</summary>
        <div className="depth">{active.tiers.map(tier=><div className="tier" key={tier.price}><span>{unit(tier.price)}</span><div className="bar"><i className={strategy==='monopolization'&&tier.price<=active.buyMax?'buy':''} style={{width:`${tier.units/Math.max(...active.tiers.map(value=>value.units))*100}%`}}/></div><span>{tier.units}</span></div>)}</div>
        <p className="metric-explainer">{strategy==='flipping'?'The chart shows market price tiers, not the selected listing. The flip buys only one matching listing.':'Amber tiers are included in this buyout; green tiers are remaining listings.'} Bar length represents units at each price.</p>
       </details>
       <details className="insight-section supporting-detail"><summary>Observed floor history · per unit</summary><HistoryChart history={history} loading={historyLoading}/></details>
       <div className="detail-actions"><button onClick={()=>{if(!navigator.clipboard){setError({code:'CLIPBOARD_UNAVAILABLE',message:'Clipboard access is unavailable in this browser.',action:'Copy the item name manually.'});return;}void navigator.clipboard.writeText(name(active.itemId)).then(()=>setNotice('Item name copied.')).catch(()=>setError({code:'CLIPBOARD_UNAVAILABLE',message:'Clipboard access was blocked.',action:'Copy the item name manually.'}));}}>Copy item name</button> {strategy==='monopolization'&&(provisional?<button disabled title="Verify the auction house before exporting a plan">Export plan</button>:<a className="button" href="/api/addon.lua" download="Plan.lua">Export monopolization plans</a>)}</div>
      </>:<p>Select an item when opportunities are available.</p>}
     </section>
    </div>
   </>}
   {tab==='Portfolio'&&<section className="panel">
    <h3>Trading journal</h3>
    <form className="filters" onSubmit={event=>{event.preventDefault();void action(()=>api('trade',{side:form.side,itemId:Number(form.itemId),quantity:Number(form.quantity),total:Math.round(Number(form.total)*10_000),fee:Math.round(Number(form.fee)*10_000),at:Date.now(),note:'Manual entry'}),'Trade recorded.');}}>
     <label>Side<select value={form.side} onChange={event=>setForm({...form,side:event.target.value})}><option>buy</option><option>sell</option></select></label>
     {(['itemId','quantity','total','fee'] as const).map(key=><label key={key}>{({itemId:'Item ID',quantity:'Quantity',total:'Gross total (g)',fee:'Fee (g)'})[key]}<input required type="number" min={key==='fee'?0:key==='total'?.0001:1} step={key==='total'||key==='fee'?.0001:1} value={form[key]} onChange={event=>setForm({...form,[key]:event.target.value})}/></label>)}
     <button type="submit">Record trade</button>
    </form>
    <h4>Import addon journal</h4>
    <input type="file" accept=".lua,.txt" onChange={event=>{const file=event.target.files?.[0];if(file)void action(async()=>api<{imported:number}>('journal',{text:await file.text()}),result=>`Imported ${result.imported} records.`);}}/>
    <h4>Positions · weighted-average cost</h4>
    <table><thead><tr><th>Item</th><th>Units</th><th>Basis</th><th>Realized P/L</th><th>Unmatched sales</th></tr></thead><tbody>{portfolio.positions.map(position=><tr key={position.itemId}><td><ItemLink id={position.itemId} name={name(position.itemId)} source={status?.nameSources?.[position.itemId]}/></td><td>{position.quantity}</td><td>{money(position.basis)}</td><td>{money(position.realized)}</td><td>{position.unmatched}</td></tr>)}</tbody></table>
    <h4>Recent trades</h4>
    <table><thead><tr><th>Time</th><th>Item</th><th>Side</th><th>Qty</th><th>Total / fee</th></tr></thead><tbody>{[...portfolio.trades].reverse().slice(0,50).map(trade=><tr key={trade.id}><td>{new Date(trade.at).toLocaleString()}</td><td><ItemLink id={trade.itemId} name={name(trade.itemId)} source={status?.nameSources?.[trade.itemId]}/></td><td>{trade.side}</td><td>{trade.quantity}</td><td>{money(trade.total)} / {money(trade.fee)}</td></tr>)}</tbody></table>
   </section>}
   {tab==='Backtest'&&<section className="panel"><h3>Monopolization · historical forward check</h3><p>Evaluates monopolization candidates using only data available at the decision time, then checks competing supply in the next snapshot. No simulated sales or claimed profit. Uses your saved bankroll and ROI.</p><div className="three"><div><small>OBSERVATIONS</small><strong>{backtests.length}</strong></div><div><small>NO LOWER COMPETING SUPPLY</small><strong>{backtests.length?pct(backtests.filter(value=>value.held).length/backtests.length):'—'}</strong></div></div><table><thead><tr><th>Decision time</th><th>Item</th><th>Target</th><th>Next snapshot below target</th><th>Held</th></tr></thead><tbody>{backtests.slice(-100).reverse().map((value,index)=><tr key={index}><td>{new Date(value.at).toLocaleString()}</td><td><ItemLink id={value.itemId} name={name(value.itemId)} source={status?.nameSources?.[value.itemId]}/></td><td>{unit(value.target)}</td><td>{value.competingUnits}</td><td>{value.held?'Yes':'No'}</td></tr>)}</tbody></table></section>}
   {tab==='Alerts'&&<section className="panel"><h3>Monopolization · shared market alerts</h3><p>Scheduled monopolization alerts use the shared market strategy, not your personal settings. They are deduplicated and saved for this market; the optional webhook is configured in .env. Demo mode never sends alerts.</p><table><thead><tr><th>Time</th><th>Item</th><th>Buyout</th><th>Target</th><th>Potential profit</th></tr></thead><tbody>{alerts.map((alert,index)=><tr key={index}><td>{new Date(alert.at).toLocaleString()}</td><td><ItemLink id={alert.itemId} name={name(alert.itemId)} source={status?.nameSources?.[alert.itemId]}/></td><td>{money(alert.cost)}</td><td>{unit(alert.target)}</td><td>{money(alert.profit)}</td></tr>)}</tbody></table>{!alerts.length&&<p>No live alerts recorded.</p>}</section>}
   {tab==='Setup'&&<section className="panel"><h3>Connect your auction house</h3><p>Read README.md for server and local setup. Create a Battle.net API client, enter credentials in .env, discover and compare two in-game items, then pin the verified HOUSE_ID. Restart in live mode. Never share secrets.</p><p>Install addon/AHCorner into the Forever client Interface/AddOns folder. Download Plan.lua below and replace the addon file while logged out, then log in. Use /ahc help. Journal entries are manual and importable after logout or /reload.</p>{provisional?<button disabled title="Verify the auction house before downloading a plan">Download monopolization plan</button>:<a href="/api/addon.lua" className="button" download="Plan.lua">Download monopolization plan</a>}<p>Market data is delayed. All in-game execution remains manual.</p></section>}
   <footer>AH Corner · local-first · prices in copper internally · not affiliated with Blizzard</footer>
  </main>
 </>;
}

function AuthGate(){
 const [state,setState]=useState<'loading'|'signed-out'|'signed-in'|'local'|'error'>('loading');
 const [message,setMessage]=useState('');
 useEffect(()=>{
  let active=true;
  const expired=()=>{setMessage('Your session has expired. Please sign in again.');setState('signed-out');};
  window.addEventListener('ah-session-expired',expired);
  void (async()=>{
   try{
    const params=new URLSearchParams(window.location.hash.slice(1));
    const code=params.get('code');
    const authError=new URLSearchParams(window.location.search).get('auth_error');
    if(code||authError)window.history.replaceState({},'',window.location.pathname);
    if(authError){if(active){setMessage('Slack sign-in did not complete. Please try again.');setState('signed-out');}return;}
    if(code){
     const verifier=sessionStorage.getItem('ah-login-verifier');
     sessionStorage.removeItem('ah-login-verifier');
     if(!verifier){if(active){setMessage('This sign-in started in another tab or has expired. Please start again.');setState('signed-out');}return;}
     const response=await fetch('/auth/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code,verifier})});
     if(!response.ok){if(active){setMessage('Slack sign-in could not be completed. Please try again.');setState('signed-out');}return;}
    }
    const response=await fetch('/auth/session');
    if(!response.ok)throw Error('Session unavailable');
    const session=await response.json() as {required:boolean;authenticated:boolean};
    if(active)setState(!session.required?'local':session.authenticated?'signed-in':'signed-out');
   }catch{if(active){setMessage('AH Corner could not check your sign-in. Please refresh the page.');setState('error');}}
  })();
  return()=>{active=false;window.removeEventListener('ah-session-expired',expired);};
 },[]);
 async function logout(){
  try{
   const response=await fetch('/auth/session',{method:'DELETE',headers:{'Content-Type':'application/json'},body:'{}'});
   if(!response.ok)throw Error('Logout failed');
   setMessage('');setState('signed-out');
  }catch{setMessage('Could not sign out. Please try again.');}
 }
 async function login(){
  try{
   const bytes=crypto.getRandomValues(new Uint8Array(32));
   const encode=(value:Uint8Array)=>btoa(String.fromCharCode(...value)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
   const verifier=encode(bytes);
   const challenge=encode(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))));
   sessionStorage.setItem('ah-login-verifier',verifier);
   window.location.assign(`https://api.muzzle.lol/auth/slack?app=ah&challenge=${encodeURIComponent(challenge)}`);
  }catch{setMessage('Could not start Slack sign-in. Please try again in a secure browser.');}
 }
 if(state==='loading')return <main><p>Checking sign-in…</p></main>;
 if(state==='signed-in'||state==='local')return <><App onLogout={state==='signed-in'?()=>void logout():undefined}/>{message&&<div className="banner bad" role="alert">{message}</div>}</>;
 return <main><section className="panel"><h1>AH Corner</h1><p>Sign in with your Muzzle Slack workspace to continue.</p>{message&&<p role="alert">{message}</p>}{state==='signed-out'&&<button onClick={()=>void login()}>Sign in with Slack</button>}</section></main>;
}

createRoot(document.getElementById('root')!).render(<AuthGate/>);
