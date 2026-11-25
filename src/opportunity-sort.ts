import type {Opportunity} from './types.ts';

export type OpportunitySortKey='name'|'cost'|'profit'|'roi'|'score';
export type OpportunitySort={key:OpportunitySortKey;direction:'asc'|'desc'};
export const defaultOpportunitySort:OpportunitySort={key:'score',direction:'desc'};

// The first click on a numeric column highlights its largest values; names
// start alphabetically. A second click reverses the current direction.
export function nextOpportunitySort(current:OpportunitySort,key:OpportunitySortKey):OpportunitySort{
 if(current.key===key)return {key,direction:current.direction==='asc'?'desc':'asc'};
 return {key,direction:key==='name'?'asc':'desc'};
}

type SortableOpportunity=Pick<Opportunity,'itemId'|'cost'|'profit'|'roi'|'score'>;
const collator=new Intl.Collator(undefined,{numeric:true,sensitivity:'base'});

export function sortOpportunities<T extends SortableOpportunity>(rows:readonly T[],sort:OpportunitySort,nameForId:(itemId:number)=>string):T[]{
 const direction=sort.direction==='asc'?1:-1;
 return [...rows].sort((a,b)=>{
  const comparison=sort.key==='name'
   ?collator.compare(nameForId(a.itemId),nameForId(b.itemId))
   :a[sort.key]-b[sort.key];
  // IDs provide a stable tie-break independent of API ordering.
  return comparison?direction*comparison:a.itemId-b.itemId;
 });
}
