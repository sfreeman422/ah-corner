import type {Listing,Snapshot,Stats,Settings,Opportunity,Trade} from './types.ts';
export const defaults:Settings={bankroll:350000,exposure:.35,minROI:.30,fee:.05,minHistory:6};
export const validInt=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0;
export function normalize(raw:unknown, kind:Listing['kind']):Listing[]{
 if(!Array.isArray(raw))throw Error('Invalid auction array'); const out:Listing[]=[];const seen=new Set<string>();
 for(const a of raw){const itemId=a?.item?.id,quantity=a?.quantity,price=kind==='commodity'?a?.unit_price:a?.buyout;
  // Exclude gear variants rather than pool materially different items. No bids or zero prices.
  if(!validInt(itemId)||!validInt(quantity)||!validInt(price)||!validInt(a?.id))continue;
  if(kind==='auction'&&(a.item.bonus_lists?.length||a.item.modifiers?.length||a.item.pet_species_id||a.item.context>0))continue;
  const total=kind==='commodity'?price*quantity:price; if(!validInt(total))continue;
  const id=kind+':'+a.id;if(seen.has(id))continue;seen.add(id);out.push({id,itemId,quantity,total,kind,timeLeft:String(a.time_left??'UNKNOWN')});
 }return out;
}
export function groups(s:Snapshot){const m=new Map<number,Listing[]>();for(const l of s.listings){const a=m.get(l.itemId);if(a)a.push(l);else m.set(l.itemId,[l]);}return m;}
export function stats(rows:Listing[],at:number):Stats|null{if(!rows.length)return null;const sorted=[...rows].sort((a,b)=>a.total/a.quantity-b.total/b.quantity);const units=sorted.reduce((n,x)=>n+x.quantity,0);let count=0,median=0;for(const x of sorted){count+=x.quantity;if(count>=units/2){median=Math.ceil(x.total/x.quantity);break;}}return {at,floor:Math.ceil(sorted[0].total/sorted[0].quantity),units,listings:rows.length,median};}
const clamp=(x:number)=>Math.max(0,Math.min(1,x));
function quantile(a:number[],p:number){if(!a.length)return 0;const x=[...a].sort((a,b)=>a-b);return x[Math.floor((x.length-1)*p)];}
export function scan(current:Snapshot,history:Snapshot[],settings:Settings=defaults):Opportunity[]{
 const prior=history.filter(x=>x.market===current.market&&x.source===current.source&&x.at<current.at).sort((a,b)=>a.at-b.at).slice(-24);
 const maps=prior.map(groups),cur=groups(current),out:Opportunity[]=[];
 for(const [itemId,rows] of cur){
  // Commodity and noncommodity books with the same item ID are ambiguous: exclude.
  if(new Set(rows.map(x=>x.kind)).size!==1)continue;
  const tiersMap=new Map<number,{price:number;units:number;cost:number}>();
  for(const l of rows){const price=Math.ceil(l.total/l.quantity);const t=tiersMap.get(price)||{price,units:0,cost:0};t.units+=l.quantity;t.cost+=l.total;tiersMap.set(price,t);}
  const tiers=[...tiersMap.values()].sort((a,b)=>a.price-b.price);if(tiers.length<2)continue;
  const hs=maps.map((m,i)=>stats(m.get(itemId)||[],prior[i].at)).filter((x):x is Stats=>!!x);
  const floors=hs.map(x=>x.floor);const supportPrice=quantile(floors,.75);
  let best:Opportunity|undefined,cost=0,quantity=0;
  for(let i=0;i<tiers.length-1;i++){cost+=tiers[i].cost;quantity+=tiers[i].units;if(cost>Math.floor(settings.bankroll*settings.exposure))break;
   const target=tiers[i+1].price-1;if(target<=0||target<tiers[i].price)continue;
   const net=quantity*Math.floor(target*(1-settings.fee));const profit=net-cost,roi=profit/cost;if(roi<settings.minROI||quantity<2)continue;
   const support=floors.length?floors.filter(p=>p>=target).length/floors.length:0;
   let removed=0,replenished=0,intervals=0;
   const timeline=[...maps,cur];const times=[...prior.map(s=>s.at),current.at];
   for(let j=1;j<timeline.length;j++){const hours=(times[j]-times[j-1])/3600000;if(hours<.5||hours>3)continue;const prev=timeline[j-1].get(itemId)||[],next=timeline[j].get(itemId)||[];const n=new Map(next.map(l=>[l.id,l]));const p=new Map(prev.map(l=>[l.id,l]));
    for(const l of prev){if(l.total/l.quantity<=target){const now=n.get(l.id);removed+=Math.max(0,l.quantity-(now?.quantity||0))/hours;}}
    for(const l of next){if(l.total/l.quantity<target){const old=p.get(l.id);replenished+=Math.max(0,l.quantity-(old?.quantity||0))/hours;}}intervals++;
   }
   const r=intervals?replenished/intervals:null, d=intervals?removed/intervals:null;
   const fresh=current.source==='demo'||Date.now()-current.at<=2*3600000;
   const confidence=hs.length>=settings.minHistory&&support>=.25&&target<=supportPrice&&d!==null&&d>0&&r!==null&&r<=d&&fresh?'candidate':'watch';
   const score=Math.round(100*(.25*clamp((d??0)/quantity)+.25*clamp(roi/1.5)+.20*(1-cost/(settings.bankroll*settings.exposure))+.15*(intervals?clamp(1-(r??0)/Math.max(1,d??0)):0)+.10*support+.05*(fresh?1:0)));
   const o:Opportunity={itemId,floor:tiers[0].price,target,buyMax:tiers[i].price,quantity,cost,profit,roi,breakEvenUnits:Math.ceil(cost/Math.max(1,Math.floor(target*(1-settings.fee)))),score,historyCount:hs.length,support,replenish:r,removedUnits:d,confidence,tiers:tiers.slice(0,20),reasons:[confidence==='candidate'?'Historical price support and observed supply turnover':'Insufficient support, turnover, or freshness', 'Removed units are NOT verified sales','Buy entire regular auctions; verify live depth and deposits']};
   if(!best||(o.confidence==='candidate'&&best.confidence==='watch')||(o.confidence===best.confidence&&o.score>best.score))best=o;
  }if(best)out.push(best);
 }return out.sort((a,b)=>Number(b.confidence==='candidate')-Number(a.confidence==='candidate')||b.score-a.score||b.profit-a.profit);
}
export function historyFor(snapshots:Snapshot[],itemId:number){return snapshots.map(s=>stats(s.listings.filter(l=>l.itemId===itemId),s.at)).filter((s):s is Stats=>!!s).sort((a,b)=>a.at-b.at);}
// No inferred sales. A forward test reports whether target remained available and how much competing supply appeared.
export function backtest(snapshots:Snapshot[],settings:Settings){const ss=[...snapshots].sort((a,b)=>a.at-b.at).slice(-48);const results=[];for(let i=settings.minHistory;i<ss.length-1;i++){const s=ss[i],next=ss[i+1];if(next.at-s.at>3*3600000||s.market!==next.market||s.source!==next.source)continue;const o=scan(s,ss.slice(0,i),settings).filter(x=>x.historyCount>=settings.minHistory&&x.support>=.25).slice(0,3);const n=groups(next);for(const x of o){const future=n.get(x.itemId)||[];const below=future.filter(l=>l.total/l.quantity<x.target).reduce((sum,l)=>sum+l.quantity,0);results.push({at:s.at,itemId:x.itemId,target:x.target,cost:x.cost,potentialProfit:x.profit,competingUnits:below,held:future.length>0&&below===0});}}return results;}
export function portfolio(trades:Trade[]){const positions=new Map<number,{itemId:number;quantity:number;basis:number;realized:number;unmatched:number}>();for(const t of [...trades].sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id))){const p=positions.get(t.itemId)||{itemId:t.itemId,quantity:0,basis:0,realized:0,unmatched:0};if(t.side==='buy'){p.quantity+=t.quantity;p.basis+=t.total+t.fee;}else{const matched=Math.min(p.quantity,t.quantity),basis=matched===p.quantity?p.basis:Math.round(p.basis*matched/Math.max(1,p.quantity));p.realized+=Math.round((t.total-t.fee)*matched/t.quantity)-basis;p.basis-=basis;p.quantity-=matched;p.unmatched+=t.quantity-matched;}positions.set(t.itemId,p);}return [...positions.values()];}
