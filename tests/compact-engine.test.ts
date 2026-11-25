import assert from 'node:assert/strict';
import test from 'node:test';
import {backtest,compactSnapshot,defaults,scan} from '../src/engine.ts';
import {backtest as referenceBacktest,scan as referenceScan} from './reference-engine.ts';
import {demoSnapshots} from '../src/demo.ts';
import type {Snapshot,Listing} from '../src/types.ts';

test('compact scan and backtest exactly match the previous implementation for demo books',()=>{
 const books=demoSnapshots();
 const packed=books.map(compactSnapshot);
 assert.deepEqual(scan(packed.at(-1)!,packed,defaults),referenceScan(books.at(-1)!,books,defaults));
 assert.deepEqual(backtest(packed,defaults),referenceBacktest(books,defaults));
});

test('compact scans preserve identity, insertion order, floors and turnover over irregular books',()=>{
 let seed=541921;
 const random=()=>{seed=(seed*48271)%2147483647;return seed/2147483647;};
 const int=(n:number)=>Math.floor(random()*n);
 const now=Date.now();
 for(let run=0;run<12;run++){
  const books:Snapshot[]=[];
  let at=now-30*3_600_000;
  for(let book=0;book<16;book++){
   at+=[0,15,30,45,60,120,240][int(7)]*60_000;
   const listings:Listing[]=[];
   for(let item=1;item<=10;item++){
    const itemId=item===10?50_000_000_000:item;
    const kind=item%2===0?'commodity':'auction';
    for(let row=0;row<int(9);row++){
     const number=1+int(8);
     const id=[`${kind}:${number}`,`${kind}:00${number}`,`opaque-${number}`,`${kind}:9007199254740991`][int(4)];
     const quantity=1+int(20);
     const price=(1+int(6))*[10,2_500_000_000][item===9?1:0];
     listings.push({id,itemId,quantity,total:price*quantity+int(quantity),kind,timeLeft:'LONG'});
    }
   }
   // Exercise mixed listing kinds and repeated identities within the same item.
   if(book%3===0&&listings.length)listings.push({...listings[0],quantity:listings[0].quantity+1,kind:'commodity'});
   books.push({key:`r${run}-${book}`,market:book===1?'other':'test',source:book===2?'blizzard':'demo',at,listings});
  }
  const settings={...defaults,bankroll:90_000_000_000,exposure:1,minROI:0,minHistory:2};
  const packed=books.map(compactSnapshot);
  const current=books.at(-1)!;
  assert.deepEqual(scan(packed.at(-1)!,packed,settings),referenceScan(current,books,settings),`scan round ${run}`);
  assert.deepEqual(backtest(packed,settings),referenceBacktest(books,settings),`backtest round ${run}`);
 }
});

test('compaction preserves arbitrary IDs and does not retain mutable listing objects',()=>{
 const source:Snapshot={key:'ids',at:1,market:'x',source:'demo',listings:[
  {id:'auction:0001',itemId:1,quantity:2,total:40,kind:'auction',timeLeft:'LONG'},
  {id:'auction:9007199254740991',itemId:1,quantity:3,total:60,kind:'auction',timeLeft:'LONG'},
  {id:'arbitrary string',itemId:1,quantity:4,total:100,kind:'auction',timeLeft:'LONG'}
 ]};
 const packed=compactSnapshot(source);
 const before=scan(packed,[],{...defaults,minROI:0});
 source.listings[0].total=999_999;
 source.listings.length=0;
 assert.equal(packed.listingCount,3);
 assert.deepEqual(scan(packed,[],{...defaults,minROI:0}),before);
 const group=packed.items.get(1)!;
 assert.equal(group.ids[group.start+1],Number.MAX_SAFE_INTEGER);
 assert.equal(packed.items.get(1)?.opaqueIds?.get(0),'auction:0001');
});
