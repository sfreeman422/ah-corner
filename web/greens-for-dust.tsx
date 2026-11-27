import React from 'react';
import {disenchantLicence,disenchantSource} from '../src/disenchant.ts';
import type {DisenchantOpportunity} from '../src/disenchant.ts';
import {formatMoney as money} from '../src/insights.ts';

export type DustResponse={
 rows:DisenchantOpportunity[];
 counts:{gear:number;supported:number;priced:number}|null;
 at:number|null;build:string|null;asOf:number|null;reason:string|null;
};
const pct=(chance:number)=>new Intl.NumberFormat(undefined,{style:'percent',maximumFractionDigits:1}).format(chance);

function GameItem({id,name}:{id:number;name:(id:number)=>string}){
 return <a href={`https://www.wowhead.com/forever/item=${id}`} target="_blank" rel="noopener noreferrer">{name(id)}</a>;
}

export function GreensForDust({scan,name}:{scan:DustResponse|undefined;name:(id:number)=>string}){
 const [query,setQuery]=React.useState('');
 const matching=scan?.rows.filter(row=>name(row.itemId).toLowerCase().includes(query.trim().toLowerCase())||String(row.itemId)===query.trim())||[];
 return <section className="panel dust-panel" aria-labelledby="dust-title">
  <h3 id="dust-title">Greens for Dust</h3>
  <p>Find a single green or blue weapon or piece of armor whose cheapest observed disenchant result covers the purchase, auction fees, and your profit thresholds.</p>
  {!scan?<p className="muted">Loading disenchant opportunities…</p>:scan.reason?<p role="status" className="muted">{scan.reason}</p>:<>
   <p className="metric-explainer">Auction snapshot {scan.at===null?'unavailable':new Date(scan.at).toLocaleString()}. Forever build {scan.build}. {scan.counts?.supported??0} of {scan.counts?.gear??0} listed gear types had enough observed disenchant evidence. {scan.counts?.priced??0} also had current prices, history and supply movement for every reported material.</p>
   {scan.rows.length===0?<p className="muted">No listings meet all checks at the current prices and strategy settings.</p>:<>
    <label className="dust-search">Filter results<input value={query} maxLength={120} placeholder="Item name or ID" onChange={event=>setQuery(event.target.value)}/></label>
    <div className="opportunity-scroll" role="region" aria-label="Disenchant opportunities" tabIndex={0}>
     <table className="opportunity-table dust-table">
      <thead><tr><th scope="col">Gear</th><th scope="col">Buyout</th><th scope="col">Max buy</th><th scope="col">Lowest observed profit</th><th scope="col">Material evidence</th></tr></thead>
      <tbody>{matching.map(row=><tr key={row.itemId}>
       <td><GameItem id={row.itemId} name={name}/><small>{row.quality==='rare'?'Blue':'Green'} · Item level {row.itemLevel}</small></td>
       <td>{money(row.cost)}</td><td>{money(row.maxBuy)}</td><td className="green">{money(row.minProfit)}</td>
       <td className="dust-evidence"><details><summary>{row.materials.length} observed {row.materials.length===1?'result':'results'}</summary>
        <p>{row.windows} disenchants from {row.installs} installs in this gear band.</p>
        <ul>{row.materials.map(material=><li key={material.itemId}>
         <GameItem id={material.itemId} name={name}/> · {material.min===material.max?material.min:`${material.min}–${material.max}`} units · {pct(material.chance)} observed
         <small>Current floor {money(material.currentFloor)} · recent median floor {money(material.recentMedian)} ({material.observations} checks) · valuation {money(material.price)} per unit</small>
        </li>)}</ul>
       </details></td>
      </tr>)}</tbody>
     </table>
    </div>
    {!matching.length&&<p className="muted">No results match this filter.</p>}
   </>}
  </>}
  <p className="metric-explainer">Verify the exact gear listing and material prices in game before buying. Recorded rolls can miss rare outcomes, and material listings can disappear through sales, expiry or cancellation. Profit estimates assume a sale at the shown valuation and exclude deposits and reposts.</p>
  <p className="metric-explainer">Roll observations from <a href={disenchantSource} target="_blank" rel="noopener noreferrer">Everloot</a> under <a href={disenchantLicence} target="_blank" rel="noopener noreferrer">CC BY-SA 4.0</a>. Item bands come from Blizzard client data. Material prices come from this auction house’s saved snapshots.</p>
 </section>;
}
