import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {Alert,Opportunity,Settings,Stats,Trade} from '../src/types.ts';
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

const money=(c:number)=>`${(c/10_000).toFixed(2)}g`;
const unit=(c:number)=>c>=10_000?`${(c/10_000).toFixed(4)}g`:`${(c/100).toFixed(2)}s`;
const pct=(n:number)=>`${Math.round(n*100)}%`;

type Collector={busy:boolean;lastChecked:number;lastSuccess:number;lastError:PublicProblem|null;nextScheduledAt:number|null};
type Status={mode:string;market:string;at:number|null;listingCount:number;snapshots:number;collector:Collector;settings:Settings;watch:number[];names:Record<number,string>;stale:boolean};
type Position={itemId:number;quantity:number;basis:number;realized:number;unmatched:number};
type Backtest={at:number;itemId:number;target:number;cost:number;potentialProfit:number;competingUnits:number;held:boolean};

function App({onLogout}:{onLogout?:()=>void}){
 const [status,setStatus]=useState<Status>();
 const [rows,setRows]=useState<Opportunity[]>([]);
 const [bank,setBank]=useState(35);
 const [roi,setRoi]=useState(30);
 const [tab,setTab]=useState('Scanner');
 const [id,setId]=useState<number>();
 const [history,setHistory]=useState<Stats[]>([]);
 const [portfolio,setPortfolio]=useState<{trades:Trade[];positions:Position[]}>({trades:[],positions:[]});
 const [alerts,setAlerts]=useState<Alert[]>([]);
 const [backtests,setBacktests]=useState<Backtest[]>([]);
 const [error,setError]=useState<PublicProblem>();
 const [notice,setNotice]=useState('');
 const [onlyWatch,setOnlyWatch]=useState(false);
 const [query,setQuery]=useState('');
 const [form,setForm]=useState({side:'buy',itemId:'',quantity:'',total:'',fee:'0'});
 const name=(itemId:number)=>status?.names[itemId]||`Item #${itemId}`;
 const active=rows.find(row=>row.itemId===id)||rows[0];

 async function load(){
  try{
   const [nextStatus,opportunities,nextAlerts,nextPortfolio]=await Promise.all([
    api<Status>('status'),
    api<{rows:Opportunity[]}>(`opportunities?bankroll=${bank}&roi=${roi}`),
    api<Alert[]>('alerts'),
    api<typeof portfolio>('portfolio')
   ]);
   setStatus(nextStatus);
   setRows(opportunities.rows);
   setAlerts(nextAlerts);
   setPortfolio(nextPortfolio);
   setError(undefined);
  }catch(cause){setError(problemFrom(cause));}
 }

 useEffect(()=>{
  void load();
  const timer=setInterval(()=>void load(),30_000);
  return()=>clearInterval(timer);
 },[bank,roi]);

 useEffect(()=>{
  let live=true;
  if(active){
   api<Stats[]>(`history?id=${active.itemId}`).then(value=>{if(live)setHistory(value);}).catch(cause=>setError(problemFrom(cause)));
  }else setHistory([]);
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

 const filtered=rows.filter(row=>(!onlyWatch||status?.watch.includes(row.itemId))&&name(row.itemId).toLowerCase().includes(query.toLowerCase()));
 const max=Math.max(1,...history.map(stat=>stat.floor));
 const sourceLabel=status?.mode==='demo'?'SIMULATED DATA':status?.stale?'STALE DATA':status?.collector.lastError?'REFRESH ISSUE':'LIVE SOURCE';

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
   {status?.collector.lastError&&<div className="banner bad" role="alert"><strong>{status.collector.lastError.message}</strong>{status.collector.lastError.action&&<span> {status.collector.lastError.action}</span>}</div>}
   {error&&<div className="banner bad" role="alert"><strong>{error.message}</strong>{error.action&&<span> {error.action}</span>}</div>}
   {notice&&<div className="banner" role="status">{notice} <button onClick={()=>setNotice('')}>Dismiss</button></div>}
   <section className="metrics">
    <div><small>STRATEGY BANKROLL</small><strong>{bank}g</strong><label>Maximum exposure: {money(bank*10_000*(status?.settings.exposure||.35))}</label></div>
    <div><small>QUALIFYING BOOKS</small><strong>{rows.length}</strong><label>{rows.filter(row=>row.confidence==='candidate').length} historical candidates</label></div>
    <div><small>SNAPSHOTS STORED</small><strong>{status?.snapshots??'—'}</strong><label>{status?.listingCount.toLocaleString()||'—'} priced listings</label></div>
    <div><small>LAST SNAPSHOT</small><strong className="date">{status?.at?new Date(status.at).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):'—'}</strong><label>{status?.at?new Date(status.at).toLocaleDateString():''}</label></div>
   </section>
   <nav>{['Scanner','Portfolio','Backtest','Alerts','Setup'].map(value=><button key={value} className={value===tab?'selected':''} onClick={()=>setTab(value)}>{value}</button>)}</nav>
   {tab==='Scanner'&&<>
    <section className="filters">
     <label>Bankroll (gold)<input type="number" min="1" max="10000" value={bank} onChange={event=>setBank(Math.max(1,Number(event.target.value)))}/></label>
     <label>Min. ROI (%)<input type="number" min="0" max="1000" value={roi} onChange={event=>setRoi(Math.max(0,Number(event.target.value)))}/></label>
     <label>Search<input placeholder="Item name" value={query} onChange={event=>setQuery(event.target.value)}/></label>
     <label className="check"><input type="checkbox" checked={onlyWatch} onChange={event=>setOnlyWatch(event.target.checked)}/> Watchlist only</label>
    </section>
    <div className="split">
     <section className="panel">
      <h3>Opportunity queue <span>{filtered.length}</span></h3>
      <div className="scroll"><table><thead><tr><th>Item / confidence</th><th>Buyout</th><th>Net upside</th><th>ROI</th><th>Score</th></tr></thead><tbody>{filtered.map(row=><tr key={row.itemId} onClick={()=>setId(row.itemId)} className={active?.itemId===row.itemId?'chosen':''}><td><button className="link" onClick={()=>setId(row.itemId)}>{name(row.itemId)}</button><small className={row.confidence==='candidate'?'green':'muted'}>{row.confidence}</small></td><td>{money(row.cost)}</td><td className="green">+{money(row.profit)}</td><td>{pct(row.roi)}</td><td>{row.score}</td></tr>)}</tbody></table>{!filtered.length&&<p className="empty">No opportunities match your filters. Try a lower ROI or collect more history.</p>}</div>
     </section>
     <section className="panel detail">
      {active?<>
       <div className="between"><h3>{name(active.itemId)}</h3><button onClick={()=>action(()=>api('watch',{itemId:active.itemId}),'Watchlist updated.')}>{status?.watch.includes(active.itemId)?'★ Watching':'☆ Watch'}</button></div>
       <div className="three"><div><small>BUY UNITS</small><strong>{active.quantity}</strong></div><div><small>TARGET / UNIT</small><strong>{unit(active.target)}</strong></div><div><small>BREAK-EVEN UNITS</small><strong>{active.breakEvenUnits}</strong></div></div>
       <h4>Order book · lowest tiers</h4>
       <div className="depth">{active.tiers.map(tier=><div className="tier" key={tier.price}><span>{unit(tier.price)}</span><div className="bar"><i className={tier.price<=active.buyMax?'buy':''} style={{width:`${tier.units/Math.max(...active.tiers.map(value=>value.units))*100}%`}}/></div><span>{tier.units}</span></div>)}</div>
       <small>Amber = acquisition tier; green = remaining competition. Max acquisition tier: {unit(active.buyMax)} per unit. Stack buyout total: {money(active.cost)}.</small>
       <h4>Observed floor history</h4>
       {history.length?<svg viewBox="0 0 300 80" role="img" aria-label="Historical floor price chart"><path d="M0 75H300 M0 5H300" stroke="#36454b"/><polyline points={history.map((stat,index)=>`${index*300/Math.max(1,history.length-1)},${75-stat.floor/max*70}`).join(' ')} fill="none" stroke="#67c7ad" strokeWidth="2.5"/></svg>:<p>No history yet.</p>}
       <div className="three"><div><small>PRICE SUPPORT</small><strong>{pct(active.support)}</strong></div><div><small>REMOVED / HR*</small><strong>{active.removedUnits?.toFixed(1)??'—'}</strong></div><div><small>NEW / HR*</small><strong>{active.replenish?.toFixed(1)??'—'}</strong></div></div>
       <p className="muted">* Auction disappearance is not a sale. {active.historyCount} prior observations. Profit excludes failed deposits; verify exact in-game listings.</p>
       <button onClick={()=>{if(!navigator.clipboard){setError({code:'CLIPBOARD_UNAVAILABLE',message:'Clipboard access is unavailable in this browser.',action:'Copy the item name manually.'});return;}void navigator.clipboard.writeText(name(active.itemId)).then(()=>setNotice('Item name copied.')).catch(()=>setError({code:'CLIPBOARD_UNAVAILABLE',message:'Clipboard access was blocked.',action:'Copy the item name manually.'}));}}>Copy item name</button> <a className="button" href="/api/addon.lua" download="Plan.lua">Export plan</a>
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
    <table><thead><tr><th>Item</th><th>Units</th><th>Basis</th><th>Realized P/L</th><th>Unmatched sales</th></tr></thead><tbody>{portfolio.positions.map(position=><tr key={position.itemId}><td>{name(position.itemId)}</td><td>{position.quantity}</td><td>{money(position.basis)}</td><td>{money(position.realized)}</td><td>{position.unmatched}</td></tr>)}</tbody></table>
    <h4>Recent trades</h4>
    <table><thead><tr><th>Time</th><th>Item</th><th>Side</th><th>Qty</th><th>Total / fee</th></tr></thead><tbody>{[...portfolio.trades].reverse().slice(0,50).map(trade=><tr key={trade.id}><td>{new Date(trade.at).toLocaleString()}</td><td>{name(trade.itemId)}</td><td>{trade.side}</td><td>{trade.quantity}</td><td>{money(trade.total)} / {money(trade.fee)}</td></tr>)}</tbody></table>
   </section>}
   {tab==='Backtest'&&<section className="panel"><h3>Historical forward check</h3><p>Evaluates candidates using only data available at the decision time, then checks competing supply in the next snapshot. No simulated sales or claimed profit. Uses server-configured bankroll and ROI.</p><div className="three"><div><small>OBSERVATIONS</small><strong>{backtests.length}</strong></div><div><small>NO LOWER COMPETING SUPPLY</small><strong>{backtests.length?pct(backtests.filter(value=>value.held).length/backtests.length):'—'}</strong></div></div><table><thead><tr><th>Decision time</th><th>Item</th><th>Target</th><th>Next snapshot below target</th><th>Held</th></tr></thead><tbody>{backtests.slice(-100).reverse().map((value,index)=><tr key={index}><td>{new Date(value.at).toLocaleString()}</td><td>{name(value.itemId)}</td><td>{unit(value.target)}</td><td>{value.competingUnits}</td><td>{value.held?'Yes':'No'}</td></tr>)}</tbody></table></section>}
   {tab==='Alerts'&&<section className="panel"><h3>Candidate alerts</h3><p>Deduplicated live candidates, stored locally. Optional webhook configured in .env. Demo mode never sends alerts.</p><table><thead><tr><th>Time</th><th>Item</th><th>Buyout</th><th>Target</th><th>Potential profit</th></tr></thead><tbody>{alerts.map((alert,index)=><tr key={index}><td>{new Date(alert.at).toLocaleString()}</td><td>{name(alert.itemId)}</td><td>{money(alert.cost)}</td><td>{unit(alert.target)}</td><td>{money(alert.profit)}</td></tr>)}</tbody></table>{!alerts.length&&<p>No live alerts recorded.</p>}</section>}
   {tab==='Setup'&&<section className="panel"><h3>Connect your auction house</h3><p>Read README.md for server and local setup. Create a Battle.net API client, enter credentials in .env, discover and compare two in-game items, then pin the verified HOUSE_ID. Restart in live mode. Never share secrets.</p><p>Install addon/AHCorner into the Forever client Interface/AddOns folder. Download Plan.lua below and replace the addon file while logged out, then log in. Use /ahc help. Journal entries are manual and importable after logout or /reload.</p><a href="/api/addon.lua" className="button" download="Plan.lua">Download advisory plan</a><p>Market data is delayed. All in-game execution remains manual.</p></section>}
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
