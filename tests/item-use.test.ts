import assert from 'node:assert/strict';
import test from 'node:test';
import {applyItemUse,itemUseFor,validateItemUse} from '../src/item-use.ts';
import type {ItemUseMap,RecipeUseMap} from '../src/item-use.ts';
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
