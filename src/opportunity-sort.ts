import type {Opportunity} from './types.ts';

export const opportunitySortKeys=['name','action','purchasePrice','cost','profit','roi','score'] as const;
export type OpportunitySortKey=typeof opportunitySortKeys[number];
export type OpportunitySort={key:OpportunitySortKey;direction:'asc'|'desc'};
export const defaultOpportunitySort:OpportunitySort={key:'action',direction:'desc'};

// Names start alphabetically. Actions start with candidates, and numeric
// columns start with their highest values.
export function nextOpportunitySort(current:OpportunitySort,key:OpportunitySortKey):OpportunitySort{
 if(current.key===key)return {key,direction:current.direction==='asc'?'desc':'asc'};
 return {key,direction:key==='name'?'asc':'desc'};
}

type SortableOpportunity=Pick<Opportunity,'itemId'|'cost'|'quantity'|'profit'|'roi'|'score'|'confidence'>;
const collator=new Intl.Collator(undefined,{numeric:true,sensitivity:'base'});

export function sortOpportunities<T extends SortableOpportunity>(rows:readonly T[],sort:OpportunitySort,nameForId:(itemId:number)=>string):T[]{
 const direction=sort.direction==='asc'?1:-1;
 return [...rows].sort((a,b)=>{
  if(sort.key==='action'){
   const comparison=Number(a.confidence==='candidate')-Number(b.confidence==='candidate');
   return direction*comparison||b.score-a.score||a.itemId-b.itemId;
  }
  const comparison=sort.key==='name'
   ?collator.compare(nameForId(a.itemId),nameForId(b.itemId))
   :sort.key==='purchasePrice'
    ?a.cost/a.quantity-b.cost/b.quantity
    :a[sort.key]-b[sort.key];
  // IDs provide a stable tie-break independent of API ordering.
  return comparison?direction*comparison:a.itemId-b.itemId;
 });
}
