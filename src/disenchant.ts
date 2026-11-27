import type {CompactGroup,CompactSnapshot,Settings} from './types.ts';

export const disenchantSource='https://everloot.app/tools/disenchanting';
export const disenchantLicence='https://creativecommons.org/licenses/by-sa/4.0/';
export type MaterialOutcome={itemId:number;chance:number;min:number;max:number};
export type DisenchantBand={
 itemClass:'armor'|'weapon';quality:'uncommon'|'rare';minLevel:number;maxLevel:number;
 windows:number;installs:number;last:string;materials:MaterialOutcome[];
};
export type DisenchantData={build:string;asOf:number;fetchedAt:number;bands:DisenchantBand[]};
export type DisenchantItem={classId:number;quality?:number;slot?:number;itemLevel?:number};
const hour=3_600_000;
const integer=(value:unknown,min:number,max=Number.MAX_SAFE_INTEGER):value is number=>
 typeof value==='number'&&Number.isSafeInteger(value)&&value>=min&&value<=max;

export async function fetchDisenchantData(signal:AbortSignal):Promise<DisenchantData>{
 const response=await fetch('https://everloot.app/api/rollups/disenchant',{
  signal:AbortSignal.any([signal,AbortSignal.timeout(12_000)])
 });
 if(!response.ok)throw Error(`Everloot returned HTTP ${response.status}`);
 const data=await response.json();
 const now=Date.now(),asOf=Date.parse(data?.dataAsOf);
 if(data?.unreachable!==false||typeof data.build!=='string'||!/^1\.60\.\d+\.\d+$/.test(data.build)
   ||!Number.isFinite(asOf)||asOf>now+5*60_000||!Array.isArray(data.bands)||data.bands.length>200)throw Error('Invalid Everloot disenchant feed');
 const bands:DisenchantBand[]=[];
 for(const band of data.bands){
  if(band?.state!=='rated'||!['armor','weapon'].includes(band.itemClass)||!['uncommon','rare'].includes(band.quality))continue;
  if(!integer(band.minLevel,1,999)||!integer(band.maxLevel,band.minLevel,999)||!integer(band.windows,1)
    ||!integer(band.installs,3,band.windows)||!Number.isFinite(Date.parse(band.last))
    ||!Array.isArray(band.materials)||!band.materials.length||band.materials.length>20)throw Error('Invalid Everloot disenchant band');
  const materials:MaterialOutcome[]=[];
  const ids=new Set<number>();
  for(const result of band.materials){
   if(!integer(result?.itemId,1)||ids.has(result.itemId)||!integer(result.withMaterial,1,band.windows)
     ||!integer(result.min,1,100)||!integer(result.max,result.min,100))throw Error('Invalid Everloot material outcome');
   ids.add(result.itemId);
   materials.push({itemId:result.itemId,chance:result.withMaterial/band.windows,min:result.min,max:result.max});
  }
  bands.push({itemClass:band.itemClass,quality:band.quality,minLevel:band.minLevel,maxLevel:band.maxLevel,
   windows:band.windows,installs:band.installs,last:band.last,materials});
 }
 return {build:data.build,asOf,fetchedAt:now,bands};
}

function floor(group:CompactGroup|undefined){
 if(!group?.length)return null;
 let value=Infinity;
 for(let i=group.start;i<group.start+group.length;i++)value=Math.min(value,Math.ceil(group.totals[i]/group.quantities[i]));
 return value;
}

function quoteMaterial(itemId:number,current:CompactSnapshot,prior:CompactSnapshot[],minimumHistory:number){
 const group=current.items.get(itemId);
 const currentFloor=floor(group);
 if(!group||currentFloor===null)return null;
 const floors=prior.map(book=>floor(book.items.get(itemId))).filter(value=>value!==null).sort((a,b)=>a-b);
 if(floors.length<minimumHistory)return null;
 const recentMedian=floors[Math.floor((floors.length-1)/2)];
 const price=Math.min(currentFloor,recentMedian);
 // Only count listed units at or below our sell-price reference that declined
 // between comparable books. Declines can be sales, cancellations or expiries.
 const timeline=[...prior,current];
 const unitsAtPrice=(book:CompactSnapshot)=>{
  const material=book.items.get(itemId);
  let units=0;
  if(material)for(let index=material.start;index<material.start+material.length;index++){
   if(material.totals[index]/material.quantities[index]<=price)units+=material.quantities[index];
  }
  return units;
 };
 let declinedUnits=0,previousUnits=unitsAtPrice(timeline[0]);
 for(let i=1;i<timeline.length;i++){
  const units=unitsAtPrice(timeline[i]),elapsed=timeline[i].at-timeline[i-1].at;
  if(elapsed>=hour/2&&elapsed<=3*hour)declinedUnits+=Math.max(0,previousUnits-units);
  previousUnits=units;
 }
 return {currentFloor,recentMedian,price,observations:floors.length,declinedUnits};
}

export type DisenchantOpportunity={
 itemId:number;quality:'uncommon'|'rare';itemLevel:number;cost:number;maxBuy:number;minProfit:number;
 windows:number;installs:number;materials:(MaterialOutcome&NonNullable<ReturnType<typeof quoteMaterial>>)[];
};

export function scanDisenchant(
 current:CompactSnapshot,history:CompactSnapshot[],items:Record<string,DisenchantItem>,
 data:DisenchantData,settings:Settings,now=Date.now()
){
 const prior=history.filter(book=>book.market===current.market&&book.source===current.source&&book.at<current.at&&book.at>=current.at-48*hour)
  .sort((a,b)=>a.at-b.at);
 const quotes=new Map<number,ReturnType<typeof quoteMaterial>>();
 const rows:DisenchantOpportunity[]=[];
 const counts={gear:0,supported:0,priced:0};
 for(const [itemId,group] of current.items){
  const item=items[itemId];
  if(!item||(item.quality!==2&&item.quality!==3)||(item.classId!==2&&item.classId!==4)||!item.slot||[4,19].includes(item.slot))continue;
  counts.gear++;
  if(!item.itemLevel)continue;
  const quality=item.quality===2?'uncommon':'rare',itemClass=item.classId===4?'armor':'weapon';
  const bands=data.bands.filter(band=>band.quality===quality&&band.itemClass===itemClass
   &&band.minLevel<=item.itemLevel!&&band.maxLevel>=item.itemLevel!);
  if(bands.length!==1)continue;
  const band=bands[0];
  if(band.windows<30||band.installs<3||now-Date.parse(band.last)>21*24*hour||!band.materials.length||band.materials.reduce((sum,material)=>sum+material.chance,0)<1-1e-9)continue;
  counts.supported++;
  let cost=Infinity;
  for(let i=group.start;i<group.start+group.length;i++){
   if(group.kinds[i]===0&&group.quantities[i]===1)cost=Math.min(cost,group.totals[i]);
  }
  if(!Number.isFinite(cost))continue;
  const materials=[];
  for(const outcome of band.materials){
   if(!quotes.has(outcome.itemId))quotes.set(outcome.itemId,quoteMaterial(outcome.itemId,current,prior,Math.max(3,settings.minHistory)));
   const quote=quotes.get(outcome.itemId);
   if(quote&&quote.declinedUnits>=outcome.max)materials.push({...outcome,...quote});
  }
  if(materials.length!==band.materials.length)continue;
  counts.priced++;
  const net=Math.min(...materials.map(material=>material.min*Math.floor(material.price*(1-settings.fee))));
  const maxBuy=Math.min(Math.floor(settings.bankroll*settings.exposure),net-Math.max(1,settings.minProfit),Math.floor(net/(1+settings.minROI)));
  if(cost>maxBuy)continue;
  rows.push({itemId,quality,itemLevel:item.itemLevel,cost,maxBuy,minProfit:net-cost,
   windows:band.windows,installs:band.installs,materials});
 }
 return {rows:rows.sort((a,b)=>b.minProfit-a.minProfit||a.itemId-b.itemId).slice(0,100),counts};
}
