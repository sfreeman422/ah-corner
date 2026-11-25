import assert from 'node:assert/strict';
import test from 'node:test';
import {applyItemUse,itemCategoryFor,itemUseFor,validateItemUse} from '../src/item-use.ts';
import type {BlizzardItemMetadataMap,ItemCategoryIndex,ItemUseMap,RecipeUseMap} from '../src/item-use.ts';
import {defaults,scan} from '../src/engine.ts';
import {demoSnapshots} from '../src/demo.ts';

test('unknown usefulness is watch-only, player evidence does not fabricate sales, and excluded items are hidden',()=>{
 const snapshots=demoSnapshots();
 const original=scan(snapshots.at(-1)!,snapshots,defaults);
 const candidate=original.find(row=>row.confidence==='candidate');
 assert.ok(candidate);
 const unknown=applyItemUse([candidate],{});
 assert.equal(unknown[0].confidence,'watch');
 assert.match(unknown[0].reasons[0],/unknown/i);
 const evidence=validateItemUse({itemId:candidate.itemId,kind:'profession',note:'Used in a crafting recipe'},123);
 assert.ok(evidence.evidence);
 const known=applyItemUse([candidate],{[candidate.itemId]:evidence.evidence});
 assert.equal(known[0].confidence,'candidate');
 assert.match(known[0].reasons[0],/not evidence of sales/i);
 const watch={...candidate,confidence:'watch' as const};
 assert.equal(applyItemUse([watch],{[candidate.itemId]:evidence.evidence})[0].confidence,'watch');
 const excluded=validateItemUse({itemId:candidate.itemId,kind:'exclude',note:'Not worth trading'},123);
 assert.ok(excluded.evidence);
 assert.deepEqual(applyItemUse([candidate],{[candidate.itemId]:excluded.evidence}),[]);
});

test('item evidence requires an explicit category and useful explanation',()=>{
 assert.throws(()=>validateItemUse({itemId:-1,kind:'quest',note:'quest item'}));
 assert.throws(()=>validateItemUse({itemId:1,kind:'invented',note:'some use'}));
 assert.throws(()=>validateItemUse({itemId:1,kind:'profession',note:' '}));
 assert.throws(()=>validateItemUse({itemId:1,kind:'profession',note:'x'.repeat(301)}));
 assert.equal(validateItemUse({itemId:1,kind:'unknown'}).evidence,null);
});

test('recipe evidence supplies profession use while player assessments take precedence',()=>{
 const snapshots=demoSnapshots();
 const candidate=scan(snapshots.at(-1)!,snapshots,defaults).find(row=>row.confidence==='candidate');
 assert.ok(candidate);
 const id=candidate.itemId;
 const recipe:RecipeUseMap={[id]:{kind:'profession',source:'warcraftforever-recipe',note:'Used to craft Linen Shirt',updatedAt:100,recipeId:3915,profession:'Tailoring',dataset:'gamedata-example'}};
 const automatic=applyItemUse([candidate],{},recipe);
 assert.equal(automatic[0].confidence,'candidate');
 assert.match(automatic[0].reasons[0],/Warcraft Forever recipe data.*Tailoring.*3915/);
 assert.match(automatic[0].reasons[0],/not evidence of sales/);
 const player=validateItemUse({itemId:id,kind:'quest',note:'Player verified quest use'},200).evidence!;
 assert.equal(itemUseFor({[id]:player},id,recipe),player);
 assert.match(applyItemUse([candidate],{[id]:player},recipe)[0].reasons[0],/Player-noted quest/);
 const excluded=validateItemUse({itemId:id,kind:'exclude',note:'Player excluded this'},200).evidence!;
 assert.deepEqual(applyItemUse([candidate],{[id]:excluded},recipe),[]);
});

test('invalid stored recipe evidence is ignored and does not suppress valid player evidence',()=>{
 const valid={kind:'profession',source:'warcraftforever-recipe',note:'Used in a recipe',updatedAt:100,recipeId:3915,profession:'Tailoring',dataset:'gamedata-example'} as const;
 for(const change of [{recipeId:0},{updatedAt:NaN},{note:' '},{profession:''},{dataset:''},{source:'player'},{kind:'quest'}]){
  const bad={1:{...valid,...change}} as unknown as RecipeUseMap;
  assert.equal(itemUseFor({},1,bad),undefined);
  const manual:ItemUseMap={1:{kind:'other',source:'player',note:'Verified in game',updatedAt:100}};
  assert.equal(itemUseFor(manual,1,bad),manual[1]);
 }
});

test('Forever item class identifies known consumables without treating trade goods as food',()=>{
 const names:Record<number,string>={0:'Explosive',1:'Potion',2:'Elixir',3:'Flask',4:'Scroll',5:'Food or drink',7:'Bandage'};
 const checkedAt=Date.now(),updatedAt=checkedAt-1_000;
 for(const [subclass,description] of Object.entries(names)){
  const metadata:BlizzardItemMetadataMap={1:{source:'blizzard-forever',classId:0,subclassId:Number(subclass),updatedAt,checkedAt}};
  const use=itemUseFor({},1,{},metadata);
  assert.equal(use?.kind,'consumable');
  assert.equal(use?.source,'blizzard-forever');
  assert.equal(use?.note,description);
  assert.equal(use?.updatedAt,updatedAt);
 }
 const tradeGood:BlizzardItemMetadataMap={1:{source:'blizzard-forever',classId:7,subclassId:5,updatedAt,checkedAt}};
 assert.equal(itemUseFor({},1,{},tradeGood),undefined,'subclass 5 only means food for consumable class 0');
 for(const subclassId of [6,8,13,14,15,4294967295]){
  const ambiguous:BlizzardItemMetadataMap={1:{source:'blizzard-forever',classId:0,subclassId,updatedAt,checkedAt}};
  assert.equal(itemUseFor({},1,{},ambiguous),undefined,'ambiguous classes remain unknown');
 }
});

test('player and recipe assessments override automatic metadata, including explicit exclusions',()=>{
 const rows=scan(demoSnapshots().at(-1)!,demoSnapshots(),defaults);
 const row=rows.find(value=>value.confidence==='candidate');assert.ok(row);
 const id=row.itemId;
 const checkedAt=Date.now(),updatedAt=checkedAt-1_000;
 const metadata:BlizzardItemMetadataMap={[id]:{source:'blizzard-forever',classId:0,subclassId:5,updatedAt,checkedAt}};
 const indexed=applyItemUse([row],{},{},metadata);
 assert.equal(indexed[0].confidence,'candidate');
 assert.match(indexed[0].reasons[0],/Blizzard Forever.*food or drink.*not evidence of sales/i);
 const recipe:RecipeUseMap={[id]:{kind:'profession',source:'warcraftforever-recipe',note:'Used in a recipe',updatedAt:150,recipeId:3915,profession:'Tailoring',dataset:'example'}};
 assert.equal(itemUseFor({},id,recipe,metadata),recipe[id]);
 const manual=validateItemUse({itemId:id,kind:'quest',note:'Player checked quest'},250).evidence!;
 assert.equal(itemUseFor({[id]:manual},id,recipe,metadata),manual);
 const excluded=validateItemUse({itemId:id,kind:'exclude',note:'Exclude this item'},250).evidence!;
 assert.deepEqual(applyItemUse([row],{[id]:excluded},recipe,metadata),[]);
 assert.equal(itemUseFor({},id,{},metadata)?.kind,'consumable','clearing a manual override restores classification');
});

test('missing, malformed or non-Forever metadata remains unknown',()=>{
 const now=Date.now();
 const valid={source:'blizzard-forever',classId:0,subclassId:5,updatedAt:now-1_000,checkedAt:now};
 for(const change of [{classId:null,subclassId:null},{source:'classic'},{updatedAt:NaN},{checkedAt:NaN},{updatedAt:now+1},{checkedAt:now+60_000},{updatedAt:now-31*24*60*60_000,checkedAt:now-30*24*60*60_000},{subclassId:8}]){
  const metadata={1:{...valid,...change}} as unknown as BlizzardItemMetadataMap;
  assert.equal(itemUseFor({},1,{},metadata),undefined);
 }
});

test('item categories describe the recorded Forever classes without inventing item uses',()=>{
 const now=Date.now();
 const cases:[number,number,string,boolean][]=[
  [1,2,'Container · Herb Bag',true],
  [2,7,'Weapon · Sword',false],
  [4,2,'Armor · Leather',false],
  [5,0,'Reagent',false],
  [6,2,'Projectile · Arrow',false],
  [7,5,'Trade Goods · Cloth',false],
  [7,9,'Trade Goods · Herb',false],
  [7,11,'Trade Goods · Other',false],
  [9,6,'Recipe · Alchemy',true],
  [11,3,'Quiver · Ammo Pouch',true],
  [12,0,'Quest',false],
  [13,0,'Key',false],
  [15,0,'Miscellaneous · Junk',false],
  [15,2,'Miscellaneous · Pet',false],
  [0,8,'Consumable · Other',false]
 ];
 const candidate=scan(demoSnapshots().at(-1)!,demoSnapshots(),defaults).find(row=>row.confidence==='candidate')!;
 for(const [classId,subclassId,label,eligible] of cases){
  const metadata:BlizzardItemMetadataMap={[candidate.itemId]:{source:'blizzard-forever',classId,subclassId,updatedAt:now-1,checkedAt:now}};
  assert.equal(itemCategoryFor(candidate.itemId,metadata)?.label,label);
  const use=itemUseFor({},candidate.itemId,{},metadata);
  assert.equal(!!use,eligible,`${label} evidence`);
  assert.equal(applyItemUse([candidate],{},{},metadata)[0].confidence,eligible?'candidate':'watch',`${label} gating`);
 }
});

test('catalog categories preserve source and per-item evidence time; validated Blizzard metadata takes precedence',()=>{
 const now=Date.now();
 const corpus:ItemCategoryIndex={dataset:'items-42',build:'1.2.3',fetchedAt:now,checkedAt:now,items:{
  1:{classId:7,subclassId:9,updatedAt:now-20},
  2:{classId:0,subclassId:5,updatedAt:now-10},
  3:{classId:2,subclassId:7,updatedAt:now-5,quality:2,slot:13}
 }};
 assert.deepEqual(itemCategoryFor(1,{},corpus),{label:'Trade Goods · Herb',classId:7,subclassId:9,source:'warcraftforever-item',dataset:'items-42',build:'1.2.3',updatedAt:now-20,checkedAt:now});
 assert.equal(itemUseFor({},1,{}, {},corpus),undefined,'trade category is not recipe evidence');
 assert.equal(itemUseFor({},2,{}, {},corpus)?.kind,'consumable');
 assert.equal(itemUseFor({},3,{}, {},corpus)?.kind,'equipment');
 assert.equal(itemUseFor({},3,{}, {},corpus)?.updatedAt,now-5,'evidence is not backdated to another item');
 const blizzard:BlizzardItemMetadataMap={2:{source:'blizzard-forever',classId:4,subclassId:1,checkedAt:now,updatedAt:now-1}};
 assert.equal(itemCategoryFor(2,blizzard,corpus)?.label,'Armor · Cloth');
 assert.equal(itemUseFor({},2,{},blizzard,corpus),undefined,'conflicting catalog category cannot establish gear quality');
 const expired:BlizzardItemMetadataMap={2:{source:'blizzard-forever',classId:4,subclassId:1,checkedAt:now-31*24*60*60_000,updatedAt:now-31*24*60*60_000}};
 assert.equal(itemCategoryFor(2,expired,corpus)?.source,'warcraftforever-item');
 for(const invalid of [{dataset:''},{build:''},{checkedAt:now+60_000},{items:{2:{...corpus.items[2],updatedAt:now+60_000}}}]){
  assert.equal(itemCategoryFor(2,{}, {...corpus,...invalid}),undefined);
 }
 assert.equal(itemCategoryFor(99,{},corpus),undefined);
});

test('equipment eligibility needs matching non-poor quality and is never backdated',()=>{
 const now=Date.now(),old=now-20_000,newer=now-1_000;
 const metadata:BlizzardItemMetadataMap={1:{source:'blizzard-forever',classId:4,subclassId:0,updatedAt:old,checkedAt:now}};
 const entry={classId:4,subclassId:0,updatedAt:newer,quality:1,slot:1};
 const corpus:ItemCategoryIndex={dataset:'items',build:'1',fetchedAt:now,checkedAt:now,items:{1:entry}};
 const use=itemUseFor({},1,{},metadata,corpus);
 assert.equal(itemCategoryFor(1,metadata,corpus)?.source,'blizzard-forever');
 assert.equal(use?.kind,'equipment');
 assert.equal(use?.source,'warcraftforever-item');
 assert.equal(use?.updatedAt,newer,'quality and slot were established after Blizzard class');
 for(const change of [{quality:0},{quality:undefined},{quality:-1},{quality:1.5},{slot:0},{slot:undefined},{subclassId:1},{updatedAt:now+60_000}]){
  const invalid={...corpus,items:{1:{...entry,...change}}};
  assert.equal(itemUseFor({},1,{},metadata,invalid),undefined,`ineligible gear: ${JSON.stringify(change)}`);
  assert.equal(itemCategoryFor(1,metadata,invalid)?.label,'Armor · Miscellaneous');
 }
 const weapon={...metadata,1:{...metadata[1],classId:2,subclassId:7}};
 const goodWeapon={...corpus,items:{1:{...entry,classId:2,subclassId:7,slot:undefined}}};
 assert.equal(itemUseFor({},1,{},weapon,goodWeapon)?.kind,'equipment');
});
