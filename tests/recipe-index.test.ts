import assert from 'node:assert/strict';
import test from 'node:test';
import {fetchRecipeIndex} from '../src/recipe-index.ts';

const dataset='gamedata-0123456789abcdef0123',build='1.60.1.12345';
const manifest={schemaVersion:1,defaultChannel:'live',channels:{live:{product:'wowf',build,datasets:{recipes:dataset}}}};
const page=(data:unknown[],nextCursor:string|null=null)=>({schemaVersion:1,dataset,locale:'enUS',resource:'recipes',source:{product:'wowf',build},data,nextCursor});
const recipe={id:1378,name:'Elixir of Minor Strength',profession:171,product:{item:2454,count:1},reagents:[[2449,1],[765,2]]};
const options={requestIntervalMs:0};

test('indexes a pinned complete Forever recipe corpus with concrete reagent evidence',async()=>{
 const urls:URL[]=[];
 const fetcher:typeof fetch=async input=>{
  const url=new URL(String(input));urls.push(url);
  if(url.pathname.endsWith('/manifest'))return Response.json(manifest);
  return Response.json(url.searchParams.has('cursor')?page([{...recipe,id:1380,name:'Another recipe',reagents:[[765,1],[3371,1]]}]):page([recipe],'cursor_1'));
 };
 const result=await fetchRecipeIndex({...options,fetcher});
 assert.deepEqual(result,{dataset,build,uses:{'2449':{recipeId:1378,name:'Elixir of Minor Strength',profession:171,quantity:1,productId:2454},'765':{recipeId:1378,name:'Elixir of Minor Strength',profession:171,quantity:2,productId:2454},'3371':{recipeId:1380,name:'Another recipe',profession:171,quantity:1,productId:2454}}});
 assert.equal(urls.length,3);
 assert.equal(urls[1].pathname,`/api/data/v1/${dataset}/enUS/recipes`);
 assert.equal(urls[1].searchParams.get('limit'),'100');
 assert.equal(urls[1].searchParams.has('includeUnknown'),false);
 assert.equal(urls[2].searchParams.get('cursor'),'cursor_1');
});

test('does not return partial data for request failure, malformed pages or missing pagination',async()=>{
 const fixtures=[
  new Response('error',{status:503}),
  Response.json({...page([recipe]),dataset:'other'}),
  Response.json({...page([recipe]),source:{product:'classic',build}}),
  Response.json(page([{...recipe,reagents:[[2449,0]]}])),
  Response.json({...page([recipe]),nextCursor:undefined}),
  new Response('not json')
 ];
 for(const invalid of fixtures){
  const fetcher:typeof fetch=async input=>String(input).endsWith('/manifest')?Response.json(manifest):invalid;
  await assert.rejects(fetchRecipeIndex({...options,fetcher}));
 }
});

test('fails closed on looping cursors and page limits',async()=>{
 const fetcher:typeof fetch=async input=>String(input).endsWith('/manifest')?Response.json(manifest):Response.json(page([recipe],'repeat'));
 await assert.rejects(fetchRecipeIndex({...options,fetcher}),/cursor/);
 await assert.rejects(fetchRecipeIndex({...options,fetcher,maxPages:1}),/page limit/);
});

test('validates the manifest and honors cancellation',async()=>{
 const fetcher:typeof fetch=async()=>Response.json({...manifest,channels:{live:{...manifest.channels.live,product:'wow'}}});
 await assert.rejects(fetchRecipeIndex({...options,fetcher}),/manifest/);
 const controller=new AbortController();controller.abort();
 await assert.rejects(fetchRecipeIndex({...options,signal:controller.signal,fetcher}),{name:'AbortError'});
});
