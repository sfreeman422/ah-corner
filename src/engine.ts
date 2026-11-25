import type {Listing,Snapshot,CompactSnapshot,CompactGroup,Stats,Settings,Opportunity,Trade} from './types.ts';
export const defaults:Settings={bankroll:350000,exposure:.35,minROI:.30,minProfit:0,fee:.05,minHistory:6};
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
type AnalysisSnapshot=Snapshot|CompactSnapshot;
export function compactSnapshot(snapshot:Snapshot):CompactSnapshot{
 const counts=new Map<number,number>();
 for(const listing of snapshot.listings)counts.set(listing.itemId,(counts.get(listing.itemId)||0)+1);
 const items=new Map<number,CompactGroup>();
 // One shared backing buffer per column avoids thousands of tiny backing
 // allocations per book, which otherwise fragment the process's RSS.
 const ids=new Float64Array(snapshot.listings.length),quantities=new Float64Array(snapshot.listings.length),totals=new Float64Array(snapshot.listings.length),kinds=new Uint8Array(snapshot.listings.length);
 let offset=0;
 for(const [itemId,count] of counts){items.set(itemId,{ids,quantities,totals,kinds,start:offset,length:count});offset+=count;}
 const positions=new Map<number,number>();
 for(const listing of snapshot.listings){
  const group=items.get(listing.itemId)!;
  const index=positions.get(listing.itemId)||0;
  const absolute=group.start+index;
  positions.set(listing.itemId,index+1);
  const prefix=`${listing.kind}:`;
  const suffix=listing.id.startsWith(prefix)?listing.id.slice(prefix.length):'';
  const id=Number(suffix);
  if(suffix&&validInt(id)&&String(id)===suffix)group.ids[absolute]=id;
  else (group.opaqueIds??=new Map()).set(index,listing.id);
  group.quantities[absolute]=listing.quantity;
  group.totals[absolute]=listing.total;
  group.kinds[absolute]=listing.kind==='commodity'?1:0;
 }
 return {representation:'compact',key:snapshot.key,at:snapshot.at,source:snapshot.source,market:snapshot.market,listingCount:snapshot.listings.length,items};
}
function compact(snapshot:AnalysisSnapshot):CompactSnapshot{return 'representation' in snapshot?snapshot:compactSnapshot(snapshot);}
function expandGroup(group:CompactGroup|undefined,itemId:number):Listing[]{
 if(!group)return [];
 const rows:Listing[]=[];
 for(let i=0;i<group.length;i++){
  const absolute=group.start+i;
  const kind=group.kinds[absolute]?'commodity':'auction';
  rows.push({id:group.ids[absolute]?`${kind}:${group.ids[absolute]}`:group.opaqueIds!.get(i)!,itemId,quantity:group.quantities[absolute],total:group.totals[absolute],kind,timeLeft:''});
 }
 return rows;
}
// Canonical numeric IDs use signed numbers as map keys, avoiding one string
// allocation per listing per comparison. Opaque IDs remain strings. An
// opaque value may still be canonical for the other listing kind, so parse
// it too: the original scanner compares only ID strings, not the kind field.
function groupId(group:CompactGroup,index:number):string|number{
 const absolute=group.start+index;
 const numeric=group.ids[absolute];
 if(numeric)return group.kinds[absolute]?numeric:-numeric;
 const value=group.opaqueIds!.get(index)!;
 const match=/^(auction|commodity):([1-9]\d*)$/.exec(value);
 if(match){const id=Number(match[2]);if(validInt(id)&&String(id)===match[2])return match[1]==='commodity'?id:-id;}
 return value;
}
function floorOf(group:CompactGroup|undefined,itemId:number):number|undefined{
 if(!group||!group.length)return undefined;
 let floor=Infinity;
 for(let i=group.start;i<group.start+group.length;i++){
  const price=group.totals[i]/group.quantities[i];
  // Preserve the previous sort behavior for malformed/non-finite records.
  if(!Number.isFinite(price))return stats(expandGroup(group,itemId),0)?.floor;
  if(price<floor)floor=price;
 }
 return Math.ceil(floor);
}
export function stats(rows:Listing[],at:number):Stats|null{if(!rows.length)return null;const sorted=[...rows].sort((a,b)=>a.total/a.quantity-b.total/b.quantity);const units=sorted.reduce((n,x)=>n+x.quantity,0);let count=0,median=0;for(const x of sorted){count+=x.quantity;if(count>=units/2){median=Math.ceil(x.total/x.quantity);break;}}return {at,floor:Math.ceil(sorted[0].total/sorted[0].quantity),units,listings:rows.length,median};}
const clamp=(x:number)=>Math.max(0,Math.min(1,x));
function quantile(a:number[],p:number){if(!a.length)return 0;const x=[...a].sort((a,b)=>a-b);return x[Math.floor((x.length-1)*p)];}
export function scan(current:AnalysisSnapshot,history:AnalysisSnapshot[],settings:Settings=defaults):Opportunity[]{
 const prior=history.filter(x=>x.market===current.market&&x.source===current.source&&x.at<current.at).sort((a,b)=>a.at-b.at).slice(-24);
 const books=prior.map(compact),cur=compact(current),out:Opportunity[]=[];
 for(const [itemId,group] of cur.items){
  const rows=expandGroup(group,itemId);
  // Commodity and noncommodity books with the same item ID are ambiguous: exclude.
  if(new Set(rows.map(x=>x.kind)).size!==1)continue;
  const tiersMap=new Map<number,{price:number;units:number;cost:number;listingCount:number}>();
  for(const l of rows){const price=Math.ceil(l.total/l.quantity);const t=tiersMap.get(price)||{price,units:0,cost:0,listingCount:0};t.units+=l.quantity;t.cost+=l.total;t.listingCount++;tiersMap.set(price,t);}
  const tiers=[...tiersMap.values()].sort((a,b)=>a.price-b.price);if(tiers.length<2)continue;
  const floors=books.map(book=>floorOf(book.items.get(itemId),itemId)).filter((value):value is number=>value!==undefined);
  const supportPrice=quantile(floors,.75);
  let best:Opportunity|undefined,cost=0,quantity=0,purchaseListings=0;
  for(let i=0;i<tiers.length-1;i++){cost+=tiers[i].cost;quantity+=tiers[i].units;purchaseListings+=tiers[i].listingCount;if(cost>Math.floor(settings.bankroll*settings.exposure))break;
   const target=tiers[i+1].price-1;if(target<=0||target<tiers[i].price)continue;
   const net=quantity*Math.floor(target*(1-settings.fee));const profit=net-cost,roi=profit/cost;if(roi<settings.minROI||profit<settings.minProfit||quantity<2)continue;
   const support=floors.length?floors.filter(p=>p>=target).length/floors.length:0;
   let removed=0,replenished=0,intervals=0;
   const timeline=[...books,cur];const times=[...prior.map(s=>s.at),current.at];
   for(let j=1;j<timeline.length;j++){const hours=(times[j]-times[j-1])/3600000;if(hours<.5||hours>3)continue;const prev=timeline[j-1].items.get(itemId),next=timeline[j].items.get(itemId);const n=new Map<string|number,number>(),p=new Map<string|number,number>();
    if(next)for(let k=0;k<next.length;k++)n.set(groupId(next,k),k);
    if(prev)for(let k=0;k<prev.length;k++)p.set(groupId(prev,k),k);
    if(prev)for(let k=0;k<prev.length;k++){const pos=prev.start+k;if(prev.totals[pos]/prev.quantities[pos]<=target){const index=n.get(groupId(prev,k));removed+=Math.max(0,prev.quantities[pos]-(index===undefined?0:next!.quantities[next!.start+index]||0))/hours;}}
    if(next)for(let k=0;k<next.length;k++){const pos=next.start+k;if(next.totals[pos]/next.quantities[pos]<target){const index=p.get(groupId(next,k));replenished+=Math.max(0,next.quantities[pos]-(index===undefined?0:prev!.quantities[prev!.start+index]||0))/hours;}}intervals++;
   }
   const r=intervals?replenished/intervals:null, d=intervals?removed/intervals:null;
   const fresh=current.source==='demo'||Date.now()-current.at<=2*3600000;
   const confidence=floors.length>=settings.minHistory&&support>=.25&&target<=supportPrice&&d!==null&&d>0&&r!==null&&r<=d&&fresh?'candidate':'watch';
   // Preserve missing evidence as null: no observations is different from a
   // measured zero, and these checks use the same raw-book window as the scan.
   const checks={minimumHistory:settings.minHistory,minimumSupport:.25,priorFloor75thPercentile:floors.length?supportPrice:null,turnoverIntervals:intervals,historySufficient:floors.length>=settings.minHistory,supportSufficient:floors.length?support>=.25:null,targetSupported:floors.length?target<=supportPrice:null,removalObserved:d===null?null:d>0,replenishmentControlled:r===null||d===null?null:r<=d,fresh};
   const score=Math.round(100*(.25*clamp((d??0)/quantity)+.25*clamp(roi/1.5)+.20*(1-cost/(settings.bankroll*settings.exposure))+.15*(intervals?clamp(1-(r??0)/Math.max(1,d??0)):0)+.10*support+.05*(fresh?1:0)));
   const o:Opportunity={itemId,floor:tiers[0].price,target,buyMax:tiers[i].price,quantity,purchaseListings,cost,profit,roi,breakEvenUnits:Math.ceil(cost/Math.max(1,Math.floor(target*(1-settings.fee)))),score,historyCount:floors.length,support,replenish:r,removedUnits:d,confidence,checks,tiers:tiers.slice(0,20),reasons:[confidence==='candidate'?'Historical price support and observed supply turnover':'Insufficient support, turnover, or freshness', 'Removed units are NOT verified sales','Buy entire regular auctions; verify live depth and deposits']};
   if(!best||(o.confidence==='candidate'&&best.confidence==='watch')||(o.confidence===best.confidence&&o.score>best.score))best=o;
  }if(best)out.push(best);
 }return out.sort((a,b)=>Number(b.confidence==='candidate')-Number(a.confidence==='candidate')||b.score-a.score||b.profit-a.profit);
}
/** A flip buys one complete lowest-priced listing, leaving the rest of the
 * market intact. Historical removals are a liquidity signal, not actual sales. */
export function scanFlips(current:AnalysisSnapshot,history:AnalysisSnapshot[],settings:Settings=defaults):Opportunity[]{
 const prior=history.filter(x=>x.market===current.market&&x.source===current.source&&x.at<current.at).sort((a,b)=>a.at-b.at).slice(-24);
 const books=prior.map(compact),cur=compact(current),out:Opportunity[]=[];
 const limit=Math.floor(settings.bankroll*settings.exposure);
 for(const [itemId,group] of cur.items){
  if(group.length<2)continue;
  const rows=expandGroup(group,itemId);
  if(new Set(rows.map(x=>x.kind)).size!==1)continue;
  rows.sort((a,b)=>a.total/a.quantity-b.total/b.quantity||a.total-b.total||a.id.localeCompare(b.id));
  const chosen=rows[0],cost=chosen.total,quantity=chosen.quantity;
  if(cost>limit)continue;
  const floors=books.map(book=>floorOf(book.items.get(itemId),itemId)).filter((v):v is number=>v!==undefined);
  const historicalMedian=floors.length?quantile(floors,.5):null;
  const remainingFloor=Math.ceil(rows[1].total/rows[1].quantity);
  const target=Math.min(remainingFloor-1,historicalMedian??remainingFloor-1);
  if(target<=0)continue;
  const net=quantity*Math.floor(target*(1-settings.fee)),profit=net-cost,roi=profit/cost;
  if(roi<settings.minROI||profit<settings.minProfit)continue;
  const support=floors.length?floors.filter(price=>price>=target).length/floors.length:0;
  let removed=0,replenished=0,intervals=0;
  const timeline=[...books,cur],times=[...prior.map(s=>s.at),current.at];
  for(let j=1;j<timeline.length;j++){
   const hours=(times[j]-times[j-1])/3_600_000;
   if(hours<.5||hours>3)continue;
   const prev=timeline[j-1].items.get(itemId),next=timeline[j].items.get(itemId),n=new Map<string|number,number>(),p=new Map<string|number,number>();
   if(next)for(let k=0;k<next.length;k++)n.set(groupId(next,k),k);
   if(prev)for(let k=0;k<prev.length;k++)p.set(groupId(prev,k),k);
   if(prev)for(let k=0;k<prev.length;k++){const pos=prev.start+k;if(prev.totals[pos]/prev.quantities[pos]<=target){const index=n.get(groupId(prev,k));removed+=Math.max(0,prev.quantities[pos]-(index===undefined?0:next!.quantities[next!.start+index]||0))/hours;}}
   if(next)for(let k=0;k<next.length;k++){const pos=next.start+k;if(next.totals[pos]/next.quantities[pos]<target){const index=p.get(groupId(next,k));replenished+=Math.max(0,next.quantities[pos]-(index===undefined?0:prev!.quantities[prev!.start+index]||0))/hours;}}
   intervals++;
  }
  const d=intervals?removed/intervals:null,r=intervals?replenished/intervals:null;
  const observedRemovalsPerDay=d===null?null:d*24,enoughMovement=observedRemovalsPerDay===null?null:observedRemovalsPerDay>=quantity;
  const fresh=current.source==='demo'||Date.now()-current.at<=2*3_600_000;
  const supportPrice=quantile(floors,.75);
  const confidence=floors.length>=settings.minHistory&&support>=.5&&target<=supportPrice&&d!==null&&d>0&&enoughMovement===true&&r!==null&&r<=d&&fresh?'candidate':'watch';
  const checks={minimumHistory:settings.minHistory,minimumSupport:.5,priorFloor75thPercentile:floors.length?supportPrice:null,turnoverIntervals:intervals,historySufficient:floors.length>=settings.minHistory,supportSufficient:floors.length?support>=.5:null,targetSupported:floors.length?target<=supportPrice:null,removalObserved:d===null?null:d>0,replenishmentControlled:r===null||d===null?null:r<=d,fresh};
  const tiersMap=new Map<number,{price:number;units:number;cost:number}>();
  for(const listing of rows){const price=Math.ceil(listing.total/listing.quantity),tier=tiersMap.get(price)||{price,units:0,cost:0};tier.units+=listing.quantity;tier.cost+=listing.total;tiersMap.set(price,tier);}
  const tiers=[...tiersMap.values()].sort((a,b)=>a.price-b.price).slice(0,20);
  const score=Math.round(100*(.25*clamp((d??0)*24/quantity)+.25*clamp(roi/1.5)+.2*(1-cost/limit)+.15*(intervals?clamp(1-(r??0)/Math.max(1,d??0)):0)+.1*support+.05*(fresh?1:0)));
  out.push({itemId,floor:Math.ceil(chosen.total/quantity),target,buyMax:Math.ceil(chosen.total/quantity),quantity,purchaseListings:1,cost,profit,roi,breakEvenUnits:Math.ceil(cost/Math.max(1,Math.floor(target*(1-settings.fee)))),score,historyCount:floors.length,support,replenish:r,removedUnits:d,confidence,checks,tiers,reasons:['Buys one complete listing, leaving competing supply in the market.','Listing removals may be cancellations or expirations, not sales; no sale time is guaranteed.'],flip:{historicalMedian,remainingFloor,observedRemovalsPerDay,enoughMovement,listingKind:chosen.kind}});
 }
 return out.sort((a,b)=>Number(b.confidence==='candidate')-Number(a.confidence==='candidate')||b.score-a.score||b.profit-a.profit);
}
export function historyFor(snapshots:Snapshot[],itemId:number){return snapshots.map(s=>stats(s.listings.filter(l=>l.itemId===itemId),s.at)).filter((s):s is Stats=>!!s).sort((a,b)=>a.at-b.at);}
// No inferred sales. A forward test reports whether target remained available and how much competing supply appeared.
export function backtest(snapshots:AnalysisSnapshot[],settings:Settings){const ss=[...snapshots].sort((a,b)=>a.at-b.at).slice(-48).map(compact);const results=[];for(let i=settings.minHistory;i<ss.length-1;i++){const s=ss[i],next=ss[i+1];if(next.at-s.at>3*3600000||s.market!==next.market||s.source!==next.source)continue;const o=scan(s,ss.slice(0,i),settings).filter(x=>x.historyCount>=settings.minHistory&&x.support>=.25).slice(0,3);for(const x of o){const future=expandGroup(next.items.get(x.itemId),x.itemId);const below=future.filter(l=>l.total/l.quantity<x.target).reduce((sum,l)=>sum+l.quantity,0);results.push({at:s.at,itemId:x.itemId,target:x.target,cost:x.cost,potentialProfit:x.profit,competingUnits:below,held:future.length>0&&below===0});}}return results;}
export function portfolio(trades:Trade[]){const positions=new Map<number,{itemId:number;quantity:number;basis:number;realized:number;unmatched:number}>();for(const t of [...trades].sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id))){const p=positions.get(t.itemId)||{itemId:t.itemId,quantity:0,basis:0,realized:0,unmatched:0};if(t.side==='buy'){p.quantity+=t.quantity;p.basis+=t.total+t.fee;}else{const matched=Math.min(p.quantity,t.quantity),basis=matched===p.quantity?p.basis:Math.round(p.basis*matched/Math.max(1,p.quantity));p.realized+=Math.round((t.total-t.fee)*matched/t.quantity)-basis;p.basis-=basis;p.quantity-=matched;p.unmatched+=t.quantity-matched;}positions.set(t.itemId,p);}return [...positions.values()];}
