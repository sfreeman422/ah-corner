import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {Alert,Opportunity,Settings,Stats,Trade} from '../src/types.ts';
import type {ItemUseKind,ItemUseMap,RecipeUseMap} from '../src/item-use.ts';
import {itemUseFor} from '../src/item-use.ts';
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
type Status={mode:string;market:string;houseVerified:boolean;at:number|null;listingCount:number;snapshots:number;collector:Collector;settings:Settings;watch:number[];names:Record<number,string>;nameSources:Record<number,ItemNameDetails['source']>;itemUses:ItemUseMap;recipeUses:RecipeUseMap;recipeIndex:{dataset:string;build:string;fetchedAt:number}|null;recipeLookup:{busy:boolean;error:string|null};stale:boolean};
type Position={itemId:number;quantity:number;basis:number;realized:number;unmatched:number};
type Backtest={at:number;itemId:number;target:number;cost:number;potentialProfit:number;competingUnits:number;held:boolean};

function App({onLogout}:{onLogout?:()=>void}){
 const [status,setStatus]=useState<Status>();
 const [rows,setRows]=useState<Opportunity[]>([]);
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
 const [onlyWatch,setOnlyWatch]=useState(false);
 const [showUnnamed,setShowUnnamed]=useState(false);
 const [query,setQuery]=useState('');
 const [researchId,setResearchId]=useState('');
 const [researchKind,setResearchKind]=useState<ItemUseKind|'unknown'>('unknown');
 const [researchNote,setResearchNote]=useState('');
 const [form,setForm]=useState({side:'buy',itemId:'',quantity:'',total:'',fee:'0'});
 const resolvedName=(itemId:number)=>{const value=status?.names[itemId];return value&&value!==`Item #${itemId}`?value:undefined;};
 const name=(itemId:number)=>resolvedName(itemId)||`Item #${itemId} (name unavailable)`;
 const use=(itemId:number)=>itemUseFor(status?.itemUses||{},itemId,status?.recipeUses||{});
 const filtered=sortOpportunities(rows.filter(row=>(showUnnamed||!!resolvedName(row.itemId))&&(!onlyWatch||status?.watch.includes(row.itemId))&&name(row.itemId).toLowerCase().includes(query.toLowerCase())),sort,name);
 const active=filtered.find(row=>row.itemId===id)||filtered[0];
 const changeSort=(key:OpportunitySortKey)=>{
  if(active)setId(active.itemId);
  const next=nextOpportunitySort(sortRef.current,key);
  sortRef.current=next;
  setSort(next);
 };
 const selectOpportunity=(itemId:number)=>{
  setId(itemId);
  if(window.matchMedia('(max-width: 900px)').matches)detailRef.current?.scrollIntoView({behavior:'smooth',block:'start'});
 };

 useEffect(()=>{
  if(!active)return;
  const evidence=status?.itemUses?.[active.itemId];
  setResearchId(String(active.itemId));
  setResearchKind(evidence?.kind||'unknown');
  setResearchNote(evidence?.note||'');
 },[active?.itemId,status?.market]);

 async function load(requestedSort=sortRef.current){
  try{
   const [nextStatus,opportunities,nextAlerts,nextPortfolio]=await Promise.all([
    api<Status>('status'),
    api<{rows:Opportunity[]}>(`opportunities?sort=${requestedSort.key}&direction=${requestedSort.direction}`),
    api<Alert[]>('alerts'),
    api<typeof portfolio>('portfolio')
   ]);
   if(sortRef.current.key!==requestedSort.key||sortRef.current.direction!==requestedSort.direction)return;
   setStatus(nextStatus);
   if(!strategyDirty.current){
    setBank(nextStatus.settings.bankroll/10_000);
    setRoi(Number((nextStatus.settings.minROI*100).toFixed(2)));
    setExposure(Number((nextStatus.settings.exposure*100).toFixed(2)));
    setMinProfit(nextStatus.settings.minProfit/10_000);
    setFee(Number((nextStatus.settings.fee*100).toFixed(2)));
    setMinHistory(nextStatus.settings.minHistory);
   }
   setRows(opportunities.rows);
   setAlerts(nextAlerts);
   setPortfolio(nextPortfolio);
   setError(undefined);
  }catch(cause){if(sortRef.current.key===requestedSort.key&&sortRef.current.direction===requestedSort.direction)setError(problemFrom(cause));}
 }

 useEffect(()=>{
  void load();
  const timer=setInterval(()=>void load(),30_000);
  return()=>clearInterval(timer);
 },[sort.key,sort.direction]);

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

 const sourceLabel=status?.mode==='demo'?'SIMULATED DATA':status?.stale?'STALE DATA':status?.collector.lastError?'REFRESH ISSUE':'LIVE SOURCE';
 const provisional=status?.mode==='live'&&!status.houseVerified;
 const insights=active&&status?opportunityInsights(active,status.settings):undefined;
 const activeUse=active?use(active.itemId):undefined;

 return <>
  <header>
   <div className="brand"><span className="mark">◈</span><div><h1>AH Corner</h1><small>FOREVER MARKET INTELLIGENCE</small></div></div>
   <div className="status"><span className={`dot ${status?.mode==='live'&&!status?.stale&&!status?.collector.lastError?'live':''}`}/>{sourceLabel}<small>{status?.market||'Connecting'}</small>{onLogout&&<button onClick={onLogout}>Sign out</button>}</div>
  </header>
  <main>
   <div className="intro">
    <div><p className="eyebrow">MARKET OPERATIONS</p><h2>Find the gap. Price the risk.</h2><p>Rank affordable resets, verify live listings, and track actual returns.</p></div>
    <button disabled={status?.collector.busy} onClick={()=>action(()=>api('collect',{}),'Market refresh started. The status panel will update when it finishes.')}>{status?.collector.busy?'Refreshing source…':'↻ Refresh source'}</button>
   </div>
   {status?.mode==='demo'&&<div className="banner">Demo mode — all market snapshots are synthetic. No live trade recommendations or outbound alerts.</div>}
   {provisional&&<div className="banner bad" role="alert"><strong>Unverified auction house.</strong> These are live prices from house {status?.market.split(':').at(-1)}, but its US PvP Horde mapping has not been verified in-game. Opportunities are watch-only; alerts, backtesting and addon plans are disabled until verification.</div>}
   {status?.collector.lastError&&<div className="banner bad" role="alert"><strong>{status.collector.lastError.message}</strong>{status.collector.lastError.action&&<span> {status.collector.lastError.action}</span>}</div>}
   {error&&<div className="banner bad" role="alert"><strong>{error.message}</strong>{error.action&&<span> {error.action}</span>}</div>}
   {notice&&<div className="banner" role="status">{notice} <button onClick={()=>setNotice('')}>Dismiss</button></div>}
   <section className="metrics">
    <div><small>STRATEGY BANKROLL</small><strong>{status?money(status.settings.bankroll):'—'}</strong><label>Maximum exposure: {status?money(Math.floor(status.settings.bankroll*status.settings.exposure)):'—'}</label></div>
    <div><small>OPPORTUNITIES SHOWN</small><strong>{rows.length}</strong><label>{rows.filter(row=>row.confidence==='candidate').length} candidates · up to 100 shown</label></div>
    <div><small>RECENT BOOKS ANALYZED</small><strong>{status?.snapshots??'—'}</strong><label>{status?.listingCount.toLocaleString()||'—'} priced listings in latest book</label></div>
    <div><small>LAST SNAPSHOT</small><strong className="date">{status?.at?new Date(status.at).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):'—'}</strong><label>{status?.at?new Date(status.at).toLocaleDateString():''}</label></div>
   </section>
   <nav>{['Scanner','Portfolio','Backtest','Alerts','Setup'].map(value=><button key={value} className={value===tab?'selected':''} onClick={()=>setTab(value)}>{value}</button>)}</nav>
   {tab==='Scanner'&&<>
    <form className="filters" onSubmit={event=>{event.preventDefault();void action(async()=>{
     await api<Settings>('settings',{bankroll:Math.round(bank*10_000),exposure:exposure/100,minROI:roi/100,minProfit:Math.round(minProfit*10_000),fee:fee/100,minHistory});
     strategyDirty.current=false;
    },'Strategy saved for this market.');}}>
     <label>Bankroll (gold)<input required type="number" min="0.0001" step="0.0001" value={bank} onChange={event=>{strategyDirty.current=true;setBank(Number(event.target.value));}}/></label>
     <label>Max exposure (%)<input required type="number" min="0.01" max="100" step="0.01" value={exposure} onChange={event=>{strategyDirty.current=true;setExposure(Number(event.target.value));}}/></label>
     <label>Min. ROI (%)<input required type="number" min="0" max="1000" step="0.01" value={roi} onChange={event=>{strategyDirty.current=true;setRoi(Number(event.target.value));}}/></label>
     <label>Min. profit (gold)<input required type="number" min="0" step="0.0001" value={minProfit} onChange={event=>{strategyDirty.current=true;setMinProfit(Number(event.target.value));}}/></label>
     <label>AH fee (%)<input required type="number" min="0" max="99.99" step="0.01" value={fee} onChange={event=>{strategyDirty.current=true;setFee(Number(event.target.value));}}/></label>
     <label>Min. observations<input required type="number" min="1" max="24" step="1" value={minHistory} onChange={event=>{strategyDirty.current=true;setMinHistory(Number(event.target.value));}}/></label>
     <button type="submit" disabled={!status}>Save strategy</button>
    </form>
    <p className="muted">Saved strategy applies to this market's scanner, alerts, backtests, and addon plans. Exposure is a per-opportunity limit, not a reservation.</p>
    <section className="filters">
     <label>Search<input placeholder="Item name" value={query} onChange={event=>setQuery(event.target.value)}/></label>
     <label className="check"><input type="checkbox" checked={onlyWatch} onChange={event=>setOnlyWatch(event.target.checked)}/> Watchlist only</label>
     <label className="check"><input type="checkbox" checked={showUnnamed} onChange={event=>setShowUnnamed(event.target.checked)}/> Include items without names</label>
    </section>
    <details className="panel">
     <summary>Record item-use research</summary>
     <p className="muted">Recipe uses are supplied by <a href="https://warcraftforever.com/developers/data/" target="_blank" rel="noopener noreferrer">Warcraft Forever</a>. Unresearched items are watch-only. Your research overrides automatic evidence; choose Unknown to clear your override. Excluded items are hidden.</p>
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
    <div className="split">
     <section className="panel">
      <div className="queue-heading"><div><h3>Opportunity queue <span>{filtered.length}</span></h3><p className="metric-explainer">Select a column heading to sort; search and watchlist filters apply to the first 100 results. Profit assumes every purchased unit sells at the target.</p></div></div>
      <div className="scroll"><table><thead><tr><SortHeader label="Item / confidence" column="name" sort={sort} onSort={changeSort}/><SortHeader label="Buyout" column="cost" sort={sort} onSort={changeSort}/><SortHeader label="Potential profit" column="profit" sort={sort} onSort={changeSort}/><SortHeader label="ROI" column="roi" sort={sort} onSort={changeSort}/><SortHeader label="Score" column="score" sort={sort} onSort={changeSort}/></tr></thead><tbody>{filtered.map(row=><tr key={row.itemId} onClick={()=>selectOpportunity(row.itemId)} className={active?.itemId===row.itemId?'chosen':''}><td><ItemLink id={row.itemId} name={name(row.itemId)} source={status?.nameSources?.[row.itemId]}/> <button className="link" onClick={event=>{event.stopPropagation();selectOpportunity(row.itemId);}} aria-label={`View details for ${name(row.itemId)}`}>Details</button><small className={row.confidence==='candidate'?'green':'muted'}>{row.confidence} · {use(row.itemId)?.kind||'use unknown'}</small></td><td>{money(row.cost)}</td><td className="green">+{money(row.profit)}</td><td>{pct(row.roi)}</td><td>{row.score}</td></tr>)}</tbody></table>{!filtered.length&&<p className="empty">No named opportunities match your filters yet. Names may still be loading; use “Include items without names” to inspect missing names.</p>}</div>
     </section>
     <section className="panel detail" ref={detailRef}>
      {active&&insights&&status?<>
       <div className="between"><h3><ItemLink id={active.itemId} name={name(active.itemId)} source={status?.nameSources?.[active.itemId]}/></h3><button onClick={()=>action(()=>api('watch',{itemId:active.itemId}),'Watchlist updated.')}>{status?.watch.includes(active.itemId)?'★ Watching':'☆ Watch'}</button></div>
       <div className={`decision-summary ${active.confidence}`}>
        <small className="detail-kicker">Decision</small>
        <strong>{active.confidence==='candidate'?'Candidate · verify in game':provisional?'Watch only · auction house unverified':!activeUse?'Watch only · item use unconfirmed':'Watch only · review the checks below'}</strong>
        <p>{active.confidence==='candidate'?'The current model checks passed. Confirm the listings and player demand before buying.':'This is a hypothetical reset to research, not a recommendation to buy.'}</p>
       </div>
       <section className="insight-section">
        <h4>What the plan would require</h4>
        <p className="metric-explainer">Buy the lowest listed tiers, then try to relist at the target. Regular auctions must be purchased in full stacks.</p>
        <div className="plan-grid">
         <div className="plan-card"><small>BUYOUT COST</small><strong>{money(active.cost)}</strong><small>{active.quantity.toLocaleString()} units across {active.purchaseListings.toLocaleString()} listings</small></div>
         <div className="plan-card"><small>CAPITAL AT RISK</small><strong>{pct(insights.capitalFraction)} of bankroll</strong><small>{money(insights.exposureLimit)} per-item exposure limit</small></div>
         <div className="plan-card"><small>HIGHEST BUY PRICE</small><strong>{unit(active.buyMax)} / unit</strong><small>Approx. {unit(insights.averageCostPerUnit)} average per unit</small></div>
         <div className="plan-card"><small>PROPOSED RESELL PRICE</small><strong>{unit(active.target)} / unit</strong><small>One copper below the next listed tier</small></div>
         <div className="plan-card"><small>POTENTIAL PROFIT</small><strong>{money(active.profit)}</strong><small>{pct(active.roi)} return if all units sell at target</small></div>
         <div className="plan-card"><small>BREAK EVEN AT TARGET</small><strong>{active.breakEvenUnits.toLocaleString()} of {active.quantity.toLocaleString()} units</strong><small>Assumes the configured AH fee</small></div>
        </div>
        <p className="plan-note">If every unit sells at the target: {money(insights.grossRevenue)} gross, about {money(insights.feeAmount)} in AH fees, and {money(insights.netRevenue)} after fees. Profit excludes deposits, reposts and price changes; sales are not guaranteed.</p>
       </section>
       <section className="insight-section">
        <h4>Why this is {active.confidence==='candidate'?'a candidate':'watch only'}</h4>
        <ul className="check-list">
         <li className={`check-row ${provisional?'warning':'pass'}`}><span className="check-icon" aria-hidden="true">{provisional?'!':'✓'}</span><div className="check-copy"><strong>Auction house · {provisional?'unverified':status.mode==='demo'?'demo':'verified'}</strong><small>{provisional?'Compare prices with your in-game US PvP Horde auction house before relying on this market.':status.mode==='demo'?'Synthetic data for testing only.':'The selected auction house has been marked verified.'}</small></div></li>
         <li className={`check-row ${activeUse?'pass':'unknown'}`}><span className="check-icon" aria-hidden="true">{activeUse?'✓':'?'}</span><div className="check-copy"><strong>Item use · {activeUse?activeUse.kind:'unknown'}</strong><small>{activeUse?`${activeUse.source==='player'?'Player research':'Recipe evidence'}: ${activeUse.note}. A use does not prove demand or sales.`:'No quest, recipe or other use has been recorded. Research the item before trading.'}</small>{activeUse?.source==='warcraftforever-recipe'&&<a href={`https://warcraftforever.com/spells/${activeUse.recipeId}`} target="_blank" rel="noopener noreferrer">View source recipe</a>}</div></li>
         {insights.checks.map(check=><li className={`check-row ${check.status==='caution'?'warning':check.status}`} key={check.key}><span className="check-icon" aria-hidden="true">{check.status==='pass'?'✓':check.status==='caution'?'!':'?'}</span><div className="check-copy"><strong>{check.label} · {check.status==='pass'?'meets model check':check.status==='caution'?'needs attention':'not enough data'}</strong><small>{check.detail}</small></div></li>)}
        </ul>
        <p className="metric-explainer">Score {active.score}/100 is a ranking heuristic, not a probability or an estimate of sales. Removed listings may have sold, expired, or been cancelled.</p>
       </section>
       <section className="insight-section">
        <h4>Order book · up to 20 lowest price tiers</h4>
        <div className="depth">{active.tiers.map(tier=><div className="tier" key={tier.price}><span>{unit(tier.price)}</span><div className="bar"><i className={tier.price<=active.buyMax?'buy':''} style={{width:`${tier.units/Math.max(...active.tiers.map(value=>value.units))*100}%`}}/></div><span>{tier.units}</span></div>)}</div>
        <p className="metric-explainer">Amber tiers are included in this buyout; green tiers are remaining listings. Bar length represents units at each price.</p>
       </section>
       <section className="insight-section"><h4>Observed floor history · per unit</h4><HistoryChart history={history} loading={historyLoading}/></section>
       <div className="detail-actions"><button onClick={()=>{if(!navigator.clipboard){setError({code:'CLIPBOARD_UNAVAILABLE',message:'Clipboard access is unavailable in this browser.',action:'Copy the item name manually.'});return;}void navigator.clipboard.writeText(name(active.itemId)).then(()=>setNotice('Item name copied.')).catch(()=>setError({code:'CLIPBOARD_UNAVAILABLE',message:'Clipboard access was blocked.',action:'Copy the item name manually.'}));}}>Copy item name</button> {provisional?<button disabled title="Verify the auction house before exporting a plan">Export plan</button>:<a className="button" href="/api/addon.lua" download="Plan.lua">Export plan</a>}</div>
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
   {tab==='Backtest'&&<section className="panel"><h3>Historical forward check</h3><p>Evaluates candidates using only data available at the decision time, then checks competing supply in the next snapshot. No simulated sales or claimed profit. Uses server-configured bankroll and ROI.</p><div className="three"><div><small>OBSERVATIONS</small><strong>{backtests.length}</strong></div><div><small>NO LOWER COMPETING SUPPLY</small><strong>{backtests.length?pct(backtests.filter(value=>value.held).length/backtests.length):'—'}</strong></div></div><table><thead><tr><th>Decision time</th><th>Item</th><th>Target</th><th>Next snapshot below target</th><th>Held</th></tr></thead><tbody>{backtests.slice(-100).reverse().map((value,index)=><tr key={index}><td>{new Date(value.at).toLocaleString()}</td><td><ItemLink id={value.itemId} name={name(value.itemId)} source={status?.nameSources?.[value.itemId]}/></td><td>{unit(value.target)}</td><td>{value.competingUnits}</td><td>{value.held?'Yes':'No'}</td></tr>)}</tbody></table></section>}
   {tab==='Alerts'&&<section className="panel"><h3>Candidate alerts</h3><p>Deduplicated live candidates, stored locally. Optional webhook configured in .env. Demo mode never sends alerts.</p><table><thead><tr><th>Time</th><th>Item</th><th>Buyout</th><th>Target</th><th>Potential profit</th></tr></thead><tbody>{alerts.map((alert,index)=><tr key={index}><td>{new Date(alert.at).toLocaleString()}</td><td><ItemLink id={alert.itemId} name={name(alert.itemId)} source={status?.nameSources?.[alert.itemId]}/></td><td>{money(alert.cost)}</td><td>{unit(alert.target)}</td><td>{money(alert.profit)}</td></tr>)}</tbody></table>{!alerts.length&&<p>No live alerts recorded.</p>}</section>}
   {tab==='Setup'&&<section className="panel"><h3>Connect your auction house</h3><p>Read README.md for server and local setup. Create a Battle.net API client, enter credentials in .env, discover and compare two in-game items, then pin the verified HOUSE_ID. Restart in live mode. Never share secrets.</p><p>Install addon/AHCorner into the Forever client Interface/AddOns folder. Download Plan.lua below and replace the addon file while logged out, then log in. Use /ahc help. Journal entries are manual and importable after logout or /reload.</p>{provisional?<button disabled title="Verify the auction house before downloading a plan">Download advisory plan</button>:<a href="/api/addon.lua" className="button" download="Plan.lua">Download advisory plan</a>}<p>Market data is delayed. All in-game execution remains manual.</p></section>}
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
