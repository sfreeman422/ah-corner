import assert from 'node:assert/strict';
import test from 'node:test';
import {applyItemUse,validateItemUse} from '../src/item-use.ts';
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
