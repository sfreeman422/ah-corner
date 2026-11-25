import type {Opportunity} from './types.ts';

export type ItemUseKind='profession'|'quest'|'consumable'|'equipment'|'other'|'exclude';
export type ItemUseEvidence={kind:ItemUseKind;note:string;source:'player';updatedAt:number};
export type ItemUseMap=Record<string,ItemUseEvidence>;
export type RecipeUseEvidence={kind:'profession';note:string;source:'warcraftforever-recipe';updatedAt:number;recipeId:number;profession:string;dataset:string};
export type RecipeUseMap=Record<string,RecipeUseEvidence>;
// A successful but inconclusive lookup is retained with null IDs so callers
// can avoid repeated requests. checkedAt controls refresh; updatedAt records
// when this particular classification first became known.
export type BlizzardItemMetadata={source:'blizzard-forever';checkedAt:number;updatedAt:number;classId:number|null;subclassId:number|null};
export type BlizzardItemMetadataMap=Record<string,BlizzardItemMetadata>;
export type BlizzardUseEvidence={kind:'consumable';note:string;source:'blizzard-forever';updatedAt:number;checkedAt:number;classId:number;subclassId:number};
export type ResolvedItemUse=ItemUseEvidence|RecipeUseEvidence|BlizzardUseEvidence;

const kinds:readonly string[]=['profession','quest','consumable','equipment','other','exclude'];
const consumableSubclasses:Readonly<Record<number,string>>={0:'Explosive',1:'Potion',2:'Elixir',3:'Flask',4:'Scroll',5:'Food or drink',7:'Bandage'};

export function itemUseFor(evidence:ItemUseMap,itemId:number,automatic:RecipeUseMap={},metadata:BlizzardItemMetadataMap={}):ResolvedItemUse|undefined{
 const item=evidence[String(itemId)];
 if(item&&kinds.includes(item.kind)&&item.source==='player'&&typeof item.note==='string'&&item.note.trim().length>=3&&item.note.length<=300&&Number.isFinite(item.updatedAt))return item;
 const recipe=automatic[String(itemId)];
 if(recipe&&recipe.kind==='profession'&&recipe.source==='warcraftforever-recipe'&&typeof recipe.note==='string'&&recipe.note.trim().length>=3&&recipe.note.length<=300&&Number.isFinite(recipe.updatedAt)&&Number.isSafeInteger(recipe.recipeId)&&recipe.recipeId>0&&typeof recipe.profession==='string'&&recipe.profession.trim().length>=1&&recipe.profession.length<=100&&typeof recipe.dataset==='string'&&recipe.dataset.trim().length>=1&&recipe.dataset.length<=100)return recipe;
 const data=metadata[String(itemId)];
 const now=Date.now();
 if(!data||data.source!=='blizzard-forever'||!Number.isFinite(data.checkedAt)||!Number.isFinite(data.updatedAt)||data.updatedAt<=0||data.checkedAt<data.updatedAt||data.checkedAt>now||now-data.checkedAt>=30*24*60*60_000||data.classId!==0||!Number.isSafeInteger(data.subclassId))return undefined;
 // Match both numeric IDs: for example, trade goods also have subclass 5.
 const description=data.subclassId===null?undefined:consumableSubclasses[data.subclassId];
 if(!description)return undefined;
 return {kind:'consumable',note:description,source:'blizzard-forever',updatedAt:data.updatedAt,checkedAt:data.checkedAt,classId:0,subclassId:data.subclassId!};
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

export function applyItemUse(rows:Opportunity[],evidence:ItemUseMap,automatic:RecipeUseMap={},metadata:BlizzardItemMetadataMap={}):Opportunity[]{
 const result:Opportunity[]=[];
 for(const row of rows){
  const item=itemUseFor(evidence,row.itemId,automatic,metadata);
  if(item?.kind==='exclude')continue;
  if(!item){
   result.push({...row,confidence:'watch',reasons:['Item use is unknown; research quest, crafting or other player demand before trading.',...row.reasons]});
   continue;
  }
  const reason=item.source==='player'
   ?`Player-noted ${item.kind} use: ${item.note}. This is not evidence of sales.`
   :item.source==='warcraftforever-recipe'
    ?`Warcraft Forever recipe data (${item.profession}, recipe #${item.recipeId}): ${item.note}. This is not evidence of sales.`
    :`Blizzard Forever item data identifies this as ${item.note.toLowerCase()}. This is not evidence of sales.`;
  result.push({...row,reasons:[reason,...row.reasons]});
 }
 return result.sort((a,b)=>Number(b.confidence==='candidate')-Number(a.confidence==='candidate')||b.score-a.score||b.profit-a.profit);
}
