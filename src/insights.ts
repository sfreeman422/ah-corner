import type {Opportunity,Settings} from './types.ts';

export type InsightCheck={key:string;label:string;status:'pass'|'caution'|'unknown';detail:string};
export type OpportunityInsights={
 capitalFraction:number;
 exposureLimit:number;
 exposureFraction:number;
 averageCostPerUnit:number;
 grossRevenue:number;
 feeAmount:number;
 netRevenue:number;
 minimumBreakEvenPrice:number|null;
 profitPerPurchaseListing:number;
 checks:InsightCheck[];
};

export const formatMoney=(value:number)=>{
 const copper=Math.round(Math.abs(value));
 const gold=Math.floor(copper/10_000),silver=Math.floor(copper%10_000/100),remainder=copper%100;
 return `${value<0?'−':''}${[gold?`${gold.toLocaleString()}g`:'',silver?`${silver}s`:'',remainder?`${remainder}c`:''].filter(Boolean).join(' ')||'0c'}`;
};
const status=(value:boolean|null):InsightCheck['status']=>value===null?'unknown':value?'pass':'caution';

/** Interpret the exact plan selected by the scanner. Currency values are copper.
 * Revenue and break-even use the scanner's per-unit fee rounding and exclude
 * deposits, reposting costs, market changes, and any guarantee of a sale.
 */
export function opportunityInsights(row:Opportunity,settings:Settings):OpportunityInsights{
 const exposureLimit=Math.floor(settings.bankroll*settings.exposure);
 const netUnit=Math.floor(row.target*(1-settings.fee));
 const grossRevenue=row.quantity*row.target;
 const netRevenue=row.quantity*netUnit;
 const neededNetUnit=Math.ceil(row.cost/row.quantity);
 let minimumBreakEvenPrice:number|null=null;
 // Search the known target range so the result follows the engine's exact
 // rounding, without exceeding safe integers when a fee is close to 100%.
 if(netUnit>=neededNetUnit){
  let low=0,high=row.target;
  while(low<high){
   const mid=low+Math.floor((high-low)/2);
   if(Math.floor(mid*(1-settings.fee))>=neededNetUnit)high=mid;
   else low=mid+1;
  }
  minimumBreakEvenPrice=low;
 }

 const c=row.checks;
 const checks:InsightCheck[]=[
  {key:'history',label:'History',status:status(c.historySufficient),detail:`${row.historyCount} prior item observations; the strategy requires ${c.minimumHistory}.`},
  {key:'support',label:'Price support',status:status(c.supportSufficient),detail:c.supportSufficient===null?'No prior item floors are available to evaluate the target.':`${Math.round(row.support*100)}% of prior floors were at or above the target; the model requires at least ${Math.round(c.minimumSupport*100)}%.`},
  {key:'target',label:'Target price',status:status(c.targetSupported),detail:c.priorFloor75thPercentile===null?'No historical floor ceiling is available.':`Target ${formatMoney(row.target)} per unit; the model's historical price ceiling is ${formatMoney(c.priorFloor75thPercentile)} (the 75th-percentile floor).`},
  {key:'removal',label:'Observed removals',status:status(c.removalObserved),detail:row.removedUnits===null?'No comparable snapshot intervals are available.':`${row.removedUnits.toFixed(1)} units/hour disappeared at or below the target across ${c.turnoverIntervals} comparable intervals. Disappearance is not a verified sale.`},
  {key:'replenishment',label:'Competing supply',status:status(c.replenishmentControlled),detail:row.replenish===null||row.removedUnits===null?'No comparable snapshot intervals are available.':`${row.replenish.toFixed(1)} units/hour appeared below target versus ${row.removedUnits.toFixed(1)} removed at or below it. New competing listings can undercut the plan.`},
  {key:'freshness',label:'Snapshot freshness',status:status(c.fresh),detail:c.fresh?'The snapshot meets the scanner’s freshness requirement.':'The snapshot is too old for the scanner to classify this as a candidate.'}
 ];
 return {
  capitalFraction:row.cost/settings.bankroll,
  exposureLimit,
  exposureFraction:row.cost/exposureLimit,
  averageCostPerUnit:row.cost/row.quantity,
  grossRevenue,
  feeAmount:grossRevenue-netRevenue,
  netRevenue,
  minimumBreakEvenPrice,
  profitPerPurchaseListing:row.profit/row.purchaseListings,
  checks
 };
}
