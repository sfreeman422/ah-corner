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
export type ItemCategoryIndex={items:Record<string,{classId:number;subclassId:number;updatedAt:number;name?:string;quality?:number;slot?:number;itemLevel?:number}>;dataset:string;build:string;fetchedAt:number;checkedAt:number;includesItemLevels?:true;missingIds?:number[]};
export type ItemCategory={label:string;source:'blizzard-forever'|'warcraftforever-item';updatedAt:number;checkedAt:number;classId:number;subclassId:number;dataset?:string;build?:string};
export type AutomaticItemUse=Omit<ItemCategory,'label'>&{kind:'consumable'|'equipment'|'profession'|'other';note:string};
export type BlizzardUseEvidence=AutomaticItemUse;
export type ResolvedItemUse=ItemUseEvidence|RecipeUseEvidence|AutomaticItemUse;

const kinds:readonly string[]=['profession','quest','consumable','equipment','other','exclude'];
const consumableSubclasses:Readonly<Record<number,string>>={0:'Explosive',1:'Potion',2:'Elixir',3:'Flask',4:'Scroll',5:'Food or drink',7:'Bandage'};

// These are item types, not evidence of quest use, crafting ingredients, or
// player demand. IDs and subclass labels come from Forever's item-class API.
const categoryClasses:Readonly<Record<number,{name:string;subclasses?:Readonly<Record<number,string>>}>>={
 0:{name:'Consumable',subclasses:{0:'Explosives',1:'Potions',2:'Elixirs',3:'Flasks',4:'Scrolls',5:'Food & Drink',6:'Permanent',7:'Bandages',8:'Other',13:'Draught',14:'Device',15:'Temporary'}},
 1:{name:'Container',subclasses:{0:'Bag',1:'Soul Bag',2:'Herb Bag',3:'Enchanting Bag',4:'Engineering Bag',6:'Mining Bag',7:'Leatherworking Bag',9:'Tackle Box',10:'Cooking Bag',11:'Reagent Bag',12:'Trinket Bag'}},
 2:{name:'Weapon',subclasses:{0:'Axe',1:'Axe',2:'Bow',3:'Gun',4:'Mace',5:'Mace',6:'Polearm',7:'Sword',8:'Sword',9:'Warglaives',10:'Staff',11:'Exotic',12:'Exotic',13:'Fist Weapon',14:'Miscellaneous',15:'Dagger',16:'Thrown',17:'Spear',18:'Crossbow',19:'Wand',20:'Fishing Pole'}},
 4:{name:'Armor',subclasses:{0:'Miscellaneous',1:'Cloth',2:'Leather',3:'Mail',4:'Plate',5:'Cosmetic',6:'Shield',7:'Libram',8:'Idol',9:'Totem'}},
 5:{name:'Reagent',subclasses:{0:'Reagent'}},
 6:{name:'Projectile',subclasses:{2:'Arrow',3:'Bullet'}},
 7:{name:'Trade Goods',subclasses:{1:'Parts',5:'Cloth',6:'Leather',7:'Metal & Stone',8:'Cooking',9:'Herb',10:'Elemental',11:'Other',12:'Enchanting'}},
 9:{name:'Recipe',subclasses:{0:'Book',1:'Leatherworking',2:'Tailoring',3:'Engineering',4:'Blacksmithing',5:'Cooking',6:'Alchemy',7:'First Aid',8:'Enchanting',9:'Fishing'}},
 11:{name:'Quiver',subclasses:{2:'Quiver',3:'Ammo Pouch'}},
 12:{name:'Quest',subclasses:{0:'Quest'}},
 13:{name:'Key',subclasses:{0:'Key',1:'Lockpick'}},
 15:{name:'Miscellaneous',subclasses:{0:'Junk',1:'Reagent',2:'Pet',3:'Holiday',4:'Other',5:'Mount'}}
};
const validCategoryId=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;

/** A broad item category can be displayed independently of viable-use evidence. */
export function itemCategoryFor(itemId:number,metadata:BlizzardItemMetadataMap={},corpus?:ItemCategoryIndex):ItemCategory|undefined{
 const now=Date.now(),data=metadata[String(itemId)];
 let record:Omit<ItemCategory,'label'>|undefined;
 if(data?.source==='blizzard-forever'&&Number.isFinite(data.checkedAt)&&Number.isFinite(data.updatedAt)&&data.updatedAt>0&&data.checkedAt>=data.updatedAt&&data.checkedAt<=now&&now-data.checkedAt<30*24*60*60_000&&validCategoryId(data.classId)&&validCategoryId(data.subclassId)){
  record={source:'blizzard-forever',classId:data.classId,subclassId:data.subclassId,checkedAt:data.checkedAt,updatedAt:data.updatedAt};
 }else{
  const item=corpus?.items?.[String(itemId)];
  if(corpus&&item&&validCategoryId(item.classId)&&validCategoryId(item.subclassId)&&typeof corpus.dataset==='string'&&corpus.dataset.length>0&&corpus.dataset.length<=100&&typeof corpus.build==='string'&&corpus.build.length>0&&corpus.build.length<=100&&Number.isFinite(item.updatedAt)&&Number.isFinite(corpus.fetchedAt)&&Number.isFinite(corpus.checkedAt)&&item.updatedAt>0&&corpus.fetchedAt>0&&corpus.checkedAt>=corpus.fetchedAt&&corpus.checkedAt>=item.updatedAt&&corpus.checkedAt<=now){
   record={source:'warcraftforever-item',classId:item.classId,subclassId:item.subclassId,checkedAt:corpus.checkedAt,updatedAt:item.updatedAt,dataset:corpus.dataset,build:corpus.build};
  }
 }
 if(!record)return undefined;
 const type=categoryClasses[record.classId];
 if(!type)return undefined;
 const subtype=type.subclasses?.[record.subclassId];
 return {...record,label:subtype&&subtype!==type.name?`${type.name} · ${subtype}`:type.name};
}

export function itemUseFor(evidence:ItemUseMap,itemId:number,automatic:RecipeUseMap={},metadata:BlizzardItemMetadataMap={},corpus?:ItemCategoryIndex):ResolvedItemUse|undefined{
 const item=evidence[String(itemId)];
 if(item&&kinds.includes(item.kind)&&item.source==='player'&&typeof item.note==='string'&&item.note.trim().length>=3&&item.note.length<=300&&Number.isFinite(item.updatedAt))return item;
 const recipe=automatic[String(itemId)];
 if(recipe&&recipe.kind==='profession'&&recipe.source==='warcraftforever-recipe'&&typeof recipe.note==='string'&&recipe.note.trim().length>=3&&recipe.note.length<=300&&Number.isFinite(recipe.updatedAt)&&Number.isSafeInteger(recipe.recipeId)&&recipe.recipeId>0&&typeof recipe.profession==='string'&&recipe.profession.trim().length>=1&&recipe.profession.length<=100&&typeof recipe.dataset==='string'&&recipe.dataset.trim().length>=1&&recipe.dataset.length<=100)return recipe;
 const category=itemCategoryFor(itemId,metadata,corpus);
 if(!category)return undefined;
 const {label,...details}=category;
 // Match both numeric IDs: trade goods subclass 5 is cloth, not food.
 const consumable=category.classId===0?consumableSubclasses[category.subclassId]:undefined;
 if(consumable)return {...details,kind:'consumable',note:consumable};
 if([1,11].includes(category.classId))return {...details,kind:'equipment',note:label};
 if(category.classId===2||category.classId===4){
  // A class alone includes poor-quality vendor trash. Trust quality only from
  // a validated catalog record for the same Forever class and subclass.
  const catalogCategory=itemCategoryFor(itemId,{},corpus),item=corpus?.items[String(itemId)];
  const same=catalogCategory?.classId===category.classId&&catalogCategory.subclassId===category.subclassId;
  const usefulQuality=Number.isSafeInteger(item?.quality)&&Number(item?.quality)>=1;
  // Miscellaneous armor also contains objects that are not wearable.
  const wearable=category.classId!==4||category.subclassId!==0||(Number.isSafeInteger(item?.slot)&&Number(item?.slot)>0);
  if(same&&usefulQuality&&wearable&&catalogCategory){
   // Eligibility depends on both sources; do not backdate new quality/slot
   // evidence to the earlier date when the Blizzard category was observed.
   const {label:_catalogLabel,...catalogDetails}=catalogCategory;
   return {...catalogDetails,updatedAt:Math.max(category.updatedAt,catalogCategory.updatedAt),checkedAt:Math.max(category.checkedAt,catalogCategory.checkedAt),kind:'equipment',note:label};
  }
 }
 // Recipe books can teach class abilities rather than professions.
 if(category.classId===9)return {...details,kind:category.subclassId>=1&&category.subclassId<=9?'profession':'other',note:label};
 return undefined;
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

export function applyItemUse(rows:Opportunity[],evidence:ItemUseMap,automatic:RecipeUseMap={},metadata:BlizzardItemMetadataMap={},corpus?:ItemCategoryIndex):Opportunity[]{
 const result:Opportunity[]=[];
 for(const row of rows){
  const item=itemUseFor(evidence,row.itemId,automatic,metadata,corpus);
  if(item?.kind==='exclude')continue;
  if(!item){
   result.push({...row,confidence:'watch',reasons:['Item use is unknown; research quest, crafting or other player demand before trading.',...row.reasons]});
   continue;
  }
  const reason=item.source==='player'
   ?`Player-noted ${item.kind} use: ${item.note}. This is not evidence of sales.`
   :item.source==='warcraftforever-recipe'
    ?`Warcraft Forever recipe data (${item.profession}, recipe #${item.recipeId}): ${item.note}. This is not evidence of sales.`
    :`${item.source==='blizzard-forever'?'Blizzard Forever item data':'Warcraft Forever item data'} identifies this as ${item.note.toLowerCase()}. This is not evidence of sales.`;
  result.push({...row,reasons:[reason,...row.reasons]});
 }
 return result.sort((a,b)=>Number(b.confidence==='candidate')-Number(a.confidence==='candidate')||b.score-a.score||b.profit-a.profit);
}
