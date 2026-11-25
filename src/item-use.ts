import type {Opportunity} from './types.ts';

export type ItemUseKind='profession'|'quest'|'consumable'|'equipment'|'other'|'exclude';
export type ItemUseEvidence={kind:ItemUseKind;note:string;source:'player';updatedAt:number};
export type ItemUseMap=Record<string,ItemUseEvidence>;

const kinds:readonly string[]=['profession','quest','consumable','equipment','other','exclude'];

export function itemUseFor(evidence:ItemUseMap,itemId:number):ItemUseEvidence|undefined{
 const item=evidence[String(itemId)];
 if(!item||!kinds.includes(item.kind)||item.source!=='player'||typeof item.note!=='string'||item.note.trim().length<3||item.note.length>300||!Number.isFinite(item.updatedAt))return undefined;
 return item;
}

// Evidence is a player's explicit assessment, not proof of demand or sales.
export function validateItemUse(value:unknown,now=Date.now()):{itemId:number;evidence:ItemUseEvidence|null}{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Choose an item and an evidence category.');
 const input=value as Record<string,unknown>;
 if(!Number.isSafeInteger(input.itemId)||Number(input.itemId)<1)throw Error('Choose a valid positive item ID.');
 if(input.kind==='unknown')return {itemId:Number(input.itemId),evidence:null};
 if(typeof input.kind!=='string'||!kinds.includes(input.kind))throw Error('Choose a valid item-use category.');
 if(typeof input.note!=='string'||input.note.trim().length<3||input.note.trim().length>300)throw Error('Describe the item use or reason in 3–300 characters.');
 return {itemId:Number(input.itemId),evidence:{kind:input.kind as ItemUseKind,note:input.note.trim(),source:'player',updatedAt:now}};
}

export function applyItemUse(rows:Opportunity[],evidence:ItemUseMap):Opportunity[]{
 const result:Opportunity[]=[];
 for(const row of rows){
  const item=itemUseFor(evidence,row.itemId);
  if(item?.kind==='exclude')continue;
  if(!item){
   result.push({...row,confidence:'watch',reasons:['Item use is unknown; research quest, crafting or other player demand before trading.',...row.reasons]});
   continue;
  }
  result.push({...row,reasons:[`Player-noted ${item.kind} use: ${item.note}. This is not evidence of sales.`,...row.reasons]});
 }
 return result.sort((a,b)=>Number(b.confidence==='candidate')-Number(a.confidence==='candidate')||b.score-a.score||b.profit-a.profit);
}
