import test from 'node:test';import assert from 'node:assert/strict';import {normalize,scan,defaults,portfolio,backtest} from '../src/engine.ts';import {demoSnapshots} from '../src/demo.ts';import {parseJournal,validateTrade} from '../src/journal.ts';import type {Snapshot,Trade} from '../src/types.ts';
test('normalizes stack buyouts and commodity unit prices, excludes bids, variants and duplicates',()=>{const a={id:1,item:{id:4402},quantity:3,buyout:1000};assert.deepEqual(normalize([a,a,{...a,id:2,buyout:undefined},{...a,id:3,item:{id:4402,modifiers:[1]}}],'auction').map(x=>x.total),[1000]);assert.equal(normalize([{id:2,item:{id:4402},quantity:3,unit_price:1000}],'commodity')[0].total,3000);});
test('reset respects whole-stack price, copper fee and budget',()=>{const s:Snapshot={key:'x',at:Date.now(),market:'test',source:'demo',listings:[{id:'a',itemId:1,quantity:10,total:1000,kind:'auction',timeLeft:'LONG'},{id:'b',itemId:1,quantity:1,total:300,kind:'auction',timeLeft:'LONG'}]};const x=scan(s,[],{...defaults,bankroll:4000})[0];assert.equal(x.quantity,10);assert.equal(x.cost,1000);assert.equal(x.target,299);assert.equal(x.profit,10*Math.floor(299*.95)-1000);assert.equal(x.confidence,'watch');assert.equal(scan(s,[],{...defaults,bankroll:1000}).length,0);});
test('minimum absolute profit filters high-ROI trades that are not worth the configured amount',()=>{
 const s:Snapshot={key:'profit',at:Date.now(),market:'test',source:'demo',listings:[{id:'a',itemId:1,quantity:2,total:100,kind:'auction',timeLeft:'LONG'},{id:'b',itemId:1,quantity:1,total:300,kind:'auction',timeLeft:'LONG'}]};
 const settings={...defaults,bankroll:10_000,exposure:1,minROI:0};
 const [result]=scan(s,[],settings);
 assert.equal(result.profit,468);
 assert.equal(scan(s,[],{...settings,minProfit:468}).length,1);
 assert.equal(scan(s,[],{...settings,minProfit:469}).length,0);
});
test('purchase listing count reflects acquired book entries rather than units',()=>{
 const s:Snapshot={key:'effort',at:Date.now(),market:'test',source:'demo',listings:[{id:'a',itemId:1,quantity:4,total:400,kind:'auction',timeLeft:'LONG'},{id:'b',itemId:1,quantity:6,total:600,kind:'auction',timeLeft:'LONG'},{id:'c',itemId:1,quantity:1,total:300,kind:'auction',timeLeft:'LONG'}]};
 const [result]=scan(s,[],{...defaults,bankroll:10_000,exposure:1});
 assert.equal(result.quantity,10);
 assert.equal(result.purchaseListings,2);
 assert.ok(result.reasons.some(reason=>/NOT verified sales/.test(reason)));
});
test('demo yields candidates and backtest is forward only',()=>{const ss=demoSnapshots();const rows=scan(ss.at(-1)!,ss,defaults);assert.ok(rows.length>0);assert.ok(rows.every(x=>x.cost<=defaults.bankroll*defaults.exposure));assert.ok(rows.some(x=>x.confidence==='candidate'));const checks=backtest(ss,defaults);assert.ok(checks.every(x=>x.at<ss.at(-1)!.at));});
test('mixed listing types are not merged into reset opportunities',()=>{const ss=demoSnapshots();const s=ss.at(-1)!;const id=s.listings[0].itemId;s.listings.push({...s.listings[0],id:'regular',kind:'auction'});assert.ok(!scan(s,ss,defaults).some(x=>x.itemId===id));});
test('portfolio records realized profit, unmatched inventory and fees',()=>{const base={itemId:1,at:1000,note:''};const ts:Trade[]=[{...base,id:'a',side:'buy',quantity:10,total:1000,fee:0},{...base,id:'b',side:'sell',quantity:4,total:800,fee:40,at:2000}];assert.deepEqual(portfolio(ts),[{itemId:1,quantity:6,basis:600,realized:360,unmatched:0}]);});
test('addon parsing is data-only and validates fees',()=>{const now=Math.floor(Date.now()/1000);const text=`AHCornerJournal = { records = { "AHC1|abc-1|buy|4402|3|1200|0|${now}", } }`;assert.equal(parseJournal(text)[0].total,1200);assert.deepEqual(parseJournal('os.execute("danger")'),[]);assert.throws(()=>validateTrade({id:'a',itemId:1,side:'sell',quantity:1,total:100,fee:101,at:Date.now(),note:''}));});
