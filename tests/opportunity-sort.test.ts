import assert from 'node:assert/strict';
import test from 'node:test';
import {defaultOpportunitySort,nextOpportunitySort,sortOpportunities} from '../src/opportunity-sort.ts';

const rows=[
 {itemId:3,cost:200,profit:500,roi:2.5,score:10},
 {itemId:1,cost:100,profit:50,roi:.5,score:90},
 {itemId:2,cost:300,profit:600,roi:2,score:90},
];
const names:Record<number,string>={1:'Linen Cloth',2:'Copper Ore',3:'Silver Ore'};
const sorted=(key:'name'|'cost'|'profit'|'roi'|'score',direction:'asc'|'desc')=>sortOpportunities(rows,{key,direction},id=>names[id]).map(row=>row.itemId);

test('default order is highest score first with deterministic ties and does not mutate input',()=>{
 assert.deepEqual(sortOpportunities(rows,defaultOpportunitySort,id=>names[id]).map(row=>row.itemId),[1,2,3]);
 assert.deepEqual(rows.map(row=>row.itemId),[3,1,2]);
});

test('sorts all visible columns in both directions',()=>{
 assert.deepEqual(sorted('name','asc'),[2,1,3]);assert.deepEqual(sorted('name','desc'),[3,1,2]);
 assert.deepEqual(sorted('cost','asc'),[1,3,2]);assert.deepEqual(sorted('cost','desc'),[2,3,1]);
 assert.deepEqual(sorted('profit','asc'),[1,3,2]);assert.deepEqual(sorted('profit','desc'),[2,3,1]);
 assert.deepEqual(sorted('roi','asc'),[1,2,3]);assert.deepEqual(sorted('roi','desc'),[3,2,1]);
 assert.deepEqual(sorted('score','asc'),[3,1,2]);assert.deepEqual(sorted('score','desc'),[1,2,3]);
});

test('first click selects appropriate direction and repeated clicks reverse it',()=>{
 assert.deepEqual(nextOpportunitySort(defaultOpportunitySort,'name'),{key:'name',direction:'asc'});
 assert.deepEqual(nextOpportunitySort({key:'name',direction:'asc'},'name'),{key:'name',direction:'desc'});
 assert.deepEqual(nextOpportunitySort({key:'name',direction:'desc'},'cost'),{key:'cost',direction:'desc'});
 assert.deepEqual(nextOpportunitySort(defaultOpportunitySort,'score'),{key:'score',direction:'asc'});
});
