import assert from 'node:assert/strict';
import test from 'node:test';
import {applyItemUse,itemUseFor,validateItemUse} from '../src/item-use.ts';
import type {BlizzardItemMetadataMap,ItemUseMap,RecipeUseMap} from '../src/item-use.ts';
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
