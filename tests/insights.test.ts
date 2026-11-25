import assert from 'node:assert/strict';
import test from 'node:test';
import {formatMoney,opportunityInsights} from '../src/insights.ts';
import type {Opportunity,Settings} from '../src/types.ts';

const settings:Settings={bankroll:4_000,exposure:.35,minROI:.3,minProfit:0,fee:.05,minHistory:6};
const base:Opportunity={
 itemId:1,floor:100,target:299,buyMax:100,quantity:10,purchaseListings:2,cost:1_000,profit:1_840,roi:1.84,breakEvenUnits:4,score:40,historyCount:8,support:.5,replenish:2,removedUnits:5,confidence:'candidate',tiers:[],reasons:[],
 checks:{minimumHistory:6,minimumSupport:.25,priorFloor75thPercentile:400,turnoverIntervals:4,historySufficient:true,supportSufficient:true,targetSupported:true,removalObserved:true,replenishmentControlled:true,fresh:true}
};

test('calculates investment and proceeds using the scanner fee and whole-copper rounding',()=>{
 const result=opportunityInsights(base,settings);
 assert.equal(result.capitalFraction,.25);
 assert.equal(result.exposureLimit,1400);
 assert.equal(result.exposureFraction,1000/1400);
 assert.equal(result.averageCostPerUnit,100);
 assert.equal(result.grossRevenue,2990);
 assert.equal(result.netRevenue,2840);
 assert.equal(result.feeAmount,150);
 assert.equal(result.minimumBreakEvenPrice,106);
 assert.equal(result.profitPerPurchaseListing,920);
 assert.ok(result.minimumBreakEvenPrice!==null);
 assert.ok(Math.floor(result.minimumBreakEvenPrice*(1-settings.fee))*base.quantity>=base.cost);
 assert.ok(Math.floor((result.minimumBreakEvenPrice-1)*(1-settings.fee))*base.quantity<base.cost);
});

test('handles a target below break-even without inventing a feasible price',()=>{
 const result=opportunityInsights({...base,target:10},settings);
 assert.equal(result.minimumBreakEvenPrice,null);
});

test('explains the scanner checks without treating a disappearance as a sale',()=>{
 const result=opportunityInsights(base,settings);
 const checks=Object.fromEntries(result.checks.map(check=>[check.key,check]));
 assert.equal(checks.history.status,'pass');
 assert.match(checks.history.detail,/8 prior item observations/);
 assert.match(checks.support.detail,/50%/);
 assert.match(checks.target.detail,/4s/);
 assert.match(checks.removal.detail,/not a verified sale/i);
 assert.match(checks.replenishment.detail,/2\.0 units\/hour.*5\.0 removed/);
});

test('formats copper without rounding small values to zero',()=>{
 assert.equal(formatMoney(1),'1c');
 assert.equal(formatMoney(12_345),'1g 23s 45c');
 assert.equal(formatMoney(0),'0c');
});

test('reports missing data as unknown, and failed gates as cautions',()=>{
 const result=opportunityInsights({...base,historyCount:0,support:0,removedUnits:null,replenish:null,checks:{...base.checks,turnoverIntervals:0,historySufficient:false,supportSufficient:null,priorFloor75thPercentile:null,targetSupported:null,removalObserved:null,replenishmentControlled:null,fresh:false}},settings);
 const checks=Object.fromEntries(result.checks.map(check=>[check.key,check]));
 assert.equal(checks.history.status,'caution');
 assert.equal(checks.support.status,'unknown');
 assert.equal(checks.target.status,'unknown');
 assert.equal(checks.removal.status,'unknown');
 assert.equal(checks.replenishment.status,'unknown');
 assert.equal(checks.freshness.status,'caution');
});
