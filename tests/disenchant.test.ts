import assert from 'node:assert/strict';
import test from 'node:test';
import {compactSnapshot,defaults} from '../src/engine.ts';
import {scanDisenchant} from '../src/disenchant.ts';
import type {DisenchantData,DisenchantItem} from '../src/disenchant.ts';
import type {Listing} from '../src/types.ts';

const now=Date.now(),hour=3_600_000;
const listing=(itemId:number,total:number,quantity=1):Listing=>({id:`auction:${itemId}0`,itemId,total,quantity,kind:'auction',timeLeft:'LONG'});
const book=(at:number,listings:Listing[])=>compactSnapshot({key:String(at),at,market:'test',source:'blizzard',listings});
const items:Record<string,DisenchantItem>={1:{classId:4,quality:2,slot:7,itemLevel:10}};
const data:DisenchantData={build:'1.60.1.71139',asOf:now,fetchedAt:now,bands:[{
 itemClass:'armor',quality:'uncommon',minLevel:5,maxLevel:15,windows:60,installs:4,last:new Date(now).toISOString(),
 materials:[{itemId:2,chance:.8,min:2,max:3},{itemId:3,chance:.2,min:1,max:2}]
}]};
const settings={...defaults,minHistory:3,minROI:.1};
const history=[3,2,1].map((offset,index)=>book(now-offset*hour,[listing(2,150*(10-index*2),10-index*2),listing(3,75*(10-index*2),10-index*2)]));
const current=(gearPrice:number)=>book(now,[listing(1,gearPrice),listing(2,600,4),listing(3,400,4)]);

test('uses the cheapest observed minimum roll and lower of snapshot and historical prices',()=>{
 const result=scanDisenchant(current(60),history,items,data,settings,now);
 assert.deepEqual(result.counts,{gear:1,supported:1,priced:1});
 const [row]=result.rows;
 assert.equal(row.cost,60);
 assert.equal(row.materials[1].currentFloor,100);
 assert.equal(row.materials[1].price,75);
 assert.equal(row.minProfit,11);
 assert.equal(row.maxBuy,64);
 assert.deepEqual(scanDisenchant(current(80),history,items,data,settings,now).rows,[]);
});

test('withholds deals for unknown material prices, insufficient observations, and unknown item levels',()=>{
 const noEssence=book(now,[listing(1,60),listing(2,600,4)]);
 assert.deepEqual(scanDisenchant(noEssence,history,items,data,settings,now).rows,[]);
 assert.deepEqual(scanDisenchant(current(60),history,items,{...data,bands:[{...data.bands[0],windows:3}]},settings,now).rows,[]);
 assert.deepEqual(scanDisenchant(current(60),history,{1:{...items[1],itemLevel:undefined}},data,settings,now).rows,[]);
 assert.deepEqual(scanDisenchant(current(60),history,{1:{...items[1],quality:3}},data,settings,now).rows,[]);
});
