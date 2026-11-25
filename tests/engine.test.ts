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

test('scanner diagnostics use the same historical and turnover evidence as candidate gating',()=>{
 const at=Date.now();
 const listing=(id:string,price:number,quantity:number)=>({id,itemId:1,quantity,total:price*quantity,kind:'commodity' as const,timeLeft:'LONG'});
 const book=(key:string,time:number,listings:Snapshot['listings']):Snapshot=>({key,at:time,market:'test',source:'blizzard',listings});
 const previous=book('previous',at-3_600_000,[listing('previous-low',299,20)]);
 const current=book('current',at,[listing('current-low',100,10),listing('current-high',300,1)]);
 const settings={...defaults,bankroll:10_000,exposure:1,minHistory:1};
 const [result]=scan(current,[previous,current],settings);
 assert.equal(result.confidence,'candidate');
 assert.deepEqual(result.checks,{minimumHistory:1,minimumSupport:.25,priorFloor75thPercentile:299,turnoverIntervals:1,historySufficient:true,supportSufficient:true,targetSupported:true,removalObserved:true,replenishmentControlled:true,fresh:true});
 assert.equal(result.removedUnits,20);
 assert.equal(result.replenish,10);

 const stale={...current,at:at-3*3_600_000};
 const [old]=scan(stale,[{...previous,at:stale.at-3_600_000},stale],settings);
 assert.equal(old.confidence,'watch');
 assert.equal(old.checks.fresh,false);
});

test('scanner diagnostics distinguish missing evidence, measured zero, and insufficient price support',()=>{
 const at=Date.now();
 const listing=(id:string,price:number,quantity:number)=>({id,itemId:1,quantity,total:price*quantity,kind:'commodity' as const,timeLeft:'LONG'});
 const book=(key:string,time:number,listings:Snapshot['listings']):Snapshot=>({key,at:time,market:'test',source:'demo',listings});
 const current=book('current',at,[listing('current-low',100,10),listing('current-high',300,1)]);
 const settings={...defaults,bankroll:10_000,exposure:1,minHistory:2};
 const [missing]=scan(current,[],settings);
 assert.equal(missing.checks.priorFloor75thPercentile,null);
 assert.equal(missing.checks.supportSufficient,null);
 assert.equal(missing.checks.targetSupported,null);
 assert.equal(missing.checks.removalObserved,null);
 assert.equal(missing.checks.replenishmentControlled,null);
 assert.equal(missing.checks.turnoverIntervals,0);

 const recent=book('recent',at-10*60_000,[listing('recent-low',400,1)]);
 const [tooClose]=scan(current,[recent,current],settings);
 assert.equal(tooClose.checks.priorFloor75thPercentile,400);
 assert.equal(tooClose.checks.historySufficient,false);
 assert.equal(tooClose.checks.turnoverIntervals,0);
 assert.equal(tooClose.checks.removalObserved,null);

 const unchanged=book('unchanged',at-3_600_000,current.listings);
 const [zero]=scan(current,[unchanged,current],settings);
 assert.equal(zero.removedUnits,0);
 assert.equal(zero.replenish,0);
 assert.equal(zero.checks.removalObserved,false);
 assert.equal(zero.checks.replenishmentControlled,true);

 const first=book('first',at-2*3_600_000,[listing('old-low',100,1)]);
 const second=book('second',at-3_600_000,[listing('old-high',400,1)]);
 const [unsupported]=scan(current,[first,second,current],settings);
 assert.equal(unsupported.support,.5);
 assert.equal(unsupported.checks.supportSufficient,true);
 assert.equal(unsupported.checks.priorFloor75thPercentile,100);
 assert.equal(unsupported.checks.targetSupported,false);
 assert.equal(unsupported.confidence,'watch');
});
