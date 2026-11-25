import assert from 'node:assert/strict';
import test from 'node:test';
import {scanFlips,compactSnapshot} from '../src/engine.ts';
import type {Listing,Settings,Snapshot} from '../src/types.ts';

const settings:Settings={bankroll:10_000,exposure:1,minROI:.3,minProfit:0,fee:.05,minHistory:2};
const hour=3_600_000;
const listing=(id:string,quantity:number,total:number):Listing=>({id:`auction:${id}`,itemId:123,quantity,total,kind:'auction',timeLeft:'LONG'});
function book(at:number,listings:Listing[]):Snapshot{return {key:String(at),market:'us:1:113',source:'demo',at,listings};}
function fixture(quantity=1){
 const now=Date.now();
 const history=[3,2,1].map((h,i)=>book(now-h*hour,[listing(`old${i}`,1,100)]));
 const current=book(now,[listing('cheap',quantity,20*quantity),listing('other',2,220)]);
 return {history,current};
}

test('flip buys one whole bargain listing and undercuts remaining competition',()=>{
 const {history,current}=fixture();
 const [row]=scanFlips(current,history,settings);
 assert.equal(row.quantity,1);
 assert.equal(row.purchaseListings,1);
 assert.equal(row.cost,20);
 assert.equal(row.target,100);
 assert.equal(row.profit,75);
 assert.equal(row.flip?.remainingFloor,110);
 assert.equal(row.flip?.historicalMedian,100);
 assert.equal(row.flip?.enoughMovement,true);
 assert.equal(row.confidence,'candidate');
 assert.deepEqual(scanFlips(compactSnapshot(current),history.map(compactSnapshot),settings),[row]);
});

test('flip remains watch-only without history or enough observed movement',()=>{
 const {history,current}=fixture(40);
 const [thin]=scanFlips(current,history,settings);
 assert.equal(thin.flip?.enoughMovement,false);
 assert.equal(thin.confidence,'watch');
 assert.equal(thin.quantity,40);
 assert.equal(thin.cost,800);
 const [unknown]=scanFlips(current,[],settings);
 assert.equal(unknown.confidence,'watch');
 assert.equal(unknown.flip?.historicalMedian,null);
 assert.equal(unknown.flip?.observedRemovalsPerDay,null);
});

test('flip respects budget, minimum returns, full stacks and market isolation',()=>{
 const {history,current}=fixture(40);
 assert.deepEqual(scanFlips(current,history,{...settings,bankroll:799}),[]);
 assert.deepEqual(scanFlips(current,history,{...settings,minROI:10}),[]);
 const [row]=scanFlips(current,history.map(x=>({...x,market:'other'})),settings);
 assert.equal(row.confidence,'watch');
 assert.equal(row.historyCount,0);
 const mixed={...current,listings:[current.listings[0],{...current.listings[1],kind:'commodity' as const}]};
 assert.deepEqual(scanFlips(mixed,history,settings),[]);
});
