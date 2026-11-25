import test from 'node:test';
import assert from 'node:assert/strict';
import {Blizzard} from '../src/blizzard.ts';

test('collector checks independently changing commodities even when regular auctions are unchanged',async()=>{
 const previous=globalThis.fetch;
 const oldId=process.env.BLIZZARD_CLIENT_ID,oldSecret=process.env.BLIZZARD_CLIENT_SECRET;
 process.env.BLIZZARD_CLIENT_ID='mock';process.env.BLIZZARD_CLIENT_SECRET='mock';
 let tokens=0,commodityRequests=0,commodityPrice=700;
 const regularModified='Tue, 24 Nov 2026 16:00:00 GMT';
 try{
  globalThis.fetch=async(input,init)=>{
   const url=String(input);
   if(url.includes('oauth.battle.net')){tokens++;return Response.json({access_token:'test',expires_in:3600});}
   if(url.includes('/auctions/?'))return Response.json({auctions:[{id:113,name:'Horde Auction House'}]});
   if(url.includes('/commodities?')){commodityRequests++;return Response.json({auctions:[{id:2,item:{id:4402},quantity:5,unit_price:commodityPrice}]});}
   // A conditional request would let the regular feed hide a changed commodity book.
   if(new Headers(init?.headers).has('If-Modified-Since'))return new Response(null,{status:304});
   return Response.json({id:113,auctions:[{id:1,item:{id:3182},quantity:3,buyout:1800}]},{headers:{'Last-Modified':regularModified}});
  };
  const client=new Blizzard();
  assert.equal((await client.houses())[0].id,113);
  const before=Date.now();
  const first=await client.snapshot(113);
  assert.ok(first.snapshot);
  assert.equal(first.modified,regularModified);
  assert.equal(first.snapshot.listings.length,2);
  assert.equal(first.snapshot.listings[1].total,3500);
  assert.ok(first.snapshot.at>=before&&first.snapshot.at<=Date.now(),'timestamp is the composite observation time');

  const unchanged=await client.snapshot(113,first.modified);
  assert.ok(unchanged.snapshot);
  assert.equal(unchanged.snapshot.key,first.snapshot.key,'unchanged combined books retain the same deduplication key');

  commodityPrice=710;
  const changed=await client.snapshot(113,first.modified);
  assert.ok(changed.snapshot);
  assert.equal(changed.snapshot.listings[1].total,3550);
  assert.notEqual(changed.snapshot.key,first.snapshot.key,'commodity-only changes produce a distinct snapshot');
  assert.equal(commodityRequests,3);
  assert.equal(tokens,1);
 }finally{
  globalThis.fetch=previous;
  if(oldId===undefined)delete process.env.BLIZZARD_CLIENT_ID;else process.env.BLIZZARD_CLIENT_ID=oldId;
  if(oldSecret===undefined)delete process.env.BLIZZARD_CLIENT_SECRET;else process.env.BLIZZARD_CLIENT_SECRET=oldSecret;
 }
});

test('unexpected not-modified responses fail instead of marking collection successful',async()=>{
 const previous=globalThis.fetch;
 const oldId=process.env.BLIZZARD_CLIENT_ID,oldSecret=process.env.BLIZZARD_CLIENT_SECRET;
 process.env.BLIZZARD_CLIENT_ID='mock';process.env.BLIZZARD_CLIENT_SECRET='mock';
 try{
  globalThis.fetch=async(input)=>String(input).includes('oauth.battle.net')
   ?Response.json({access_token:'test',expires_in:3600})
   :new Response(null,{status:304});
  await assert.rejects(()=>new Blizzard().snapshot(113,'Tue, 24 Nov 2026 16:00:00 GMT'),/House HTTP 304/);
 }finally{
  globalThis.fetch=previous;
  if(oldId===undefined)delete process.env.BLIZZARD_CLIENT_ID;else process.env.BLIZZARD_CLIENT_ID=oldId;
  if(oldSecret===undefined)delete process.env.BLIZZARD_CLIENT_SECRET;else process.env.BLIZZARD_CLIENT_SECRET=oldSecret;
 }
});

test('item names prefer Forever and fall back to Classic namespaces only on 404',async()=>{
 const previous=globalThis.fetch;
 const oldId=process.env.BLIZZARD_CLIENT_ID,oldSecret=process.env.BLIZZARD_CLIENT_SECRET,oldRegion=process.env.REGION;
 process.env.BLIZZARD_CLIENT_ID='mock';process.env.BLIZZARD_CLIENT_SECRET='mock';process.env.REGION='us';
 const requests:string[]=[];
 let responses:Record<string,Response>={};
 try{
  globalThis.fetch=async(input)=>{
   const url=new URL(String(input));
   if(url.hostname==='oauth.battle.net')return Response.json({access_token:'test',expires_in:3600});
   const namespace=url.searchParams.get('namespace')!;
   requests.push(namespace);
   assert.ok(responses[namespace],`unexpected namespace ${namespace}`);
   return responses[namespace].clone();
  };
  const client=new Blizzard();
  const missing=()=>new Response(null,{status:404});
  responses={'static-forever-us':Response.json({name:'Forever Linen'})};
  assert.deepEqual(await client.nameDetails(2589),{name:'Forever Linen',source:'forever'});
  assert.deepEqual(requests.splice(0),['static-forever-us']);

  responses={'static-forever-us':missing(),'static-classic1x-us':Response.json({name:{en_US:'Era Linen'},item_class:{id:0},item_subclass:{id:5}})};
  assert.deepEqual(await client.nameDetails(2589),{name:'Era Linen',source:'classic-era'});
  assert.deepEqual(requests.splice(0),['static-forever-us','static-classic1x-us']);

  responses={'static-forever-us':missing(),'static-classic1x-us':missing(),'static-classic-us':Response.json({name:"Advisor's Pack"})};
  assert.deepEqual(await client.nameDetails(23658),{name:"Advisor's Pack",source:'classic-progression'});
  assert.deepEqual(requests.splice(0),['static-forever-us','static-classic1x-us','static-classic-us']);
  assert.equal(await client.name(23658),"Advisor's Pack");
  requests.length=0;

  responses={'static-forever-us':missing(),'static-classic1x-us':missing(),'static-classic-us':missing()};
  assert.equal(await client.nameDetails(999999),null);
  assert.equal(await client.name(999999),'Item #999999');
  requests.length=0;

  responses={'static-forever-us':new Response(null,{status:403})};
  await assert.rejects(()=>client.nameDetails(2589),/Item HTTP 403 \(forever\)/);
  assert.deepEqual(requests.splice(0),['static-forever-us']);

  responses={'static-forever-us':missing(),'static-classic1x-us':new Response(null,{status:403})};
  await assert.rejects(()=>client.nameDetails(2589),/Item HTTP 403 \(classic-era\)/);
  assert.deepEqual(requests.splice(0),['static-forever-us','static-classic1x-us']);

  responses={'static-forever-us':Response.json({name:{}})};
  await assert.rejects(()=>client.nameDetails(2589),/Item name missing \(forever\)/);
  assert.deepEqual(requests.splice(0),['static-forever-us']);

  // The public get() has already exhausted retries when it returns a 429.
  client.get=async()=>new Response(null,{status:429});
  await assert.rejects(()=>client.nameDetails(2589),/Item HTTP 429 \(forever\)/);
  assert.deepEqual(requests,[]);
 }finally{
  globalThis.fetch=previous;
  if(oldId===undefined)delete process.env.BLIZZARD_CLIENT_ID;else process.env.BLIZZARD_CLIENT_ID=oldId;
  if(oldSecret===undefined)delete process.env.BLIZZARD_CLIENT_SECRET;else process.env.BLIZZARD_CLIENT_SECRET=oldSecret;
  if(oldRegion===undefined)delete process.env.REGION;else process.env.REGION=oldRegion;
 }
});

test('Forever item metadata is returned with names and fetched without Classic fallbacks',async()=>{
 const previous=globalThis.fetch;
 const oldId=process.env.BLIZZARD_CLIENT_ID,oldSecret=process.env.BLIZZARD_CLIENT_SECRET,oldRegion=process.env.REGION;
 process.env.BLIZZARD_CLIENT_ID='mock';process.env.BLIZZARD_CLIENT_SECRET='mock';process.env.REGION='us';
 let item:Response=Response.json({name:'Tough Jerky',item_class:{id:0},item_subclass:{id:5}});
 const requests:string[]=[];
 try{
  globalThis.fetch=async(input)=>{
   const url=new URL(String(input));
   if(url.hostname==='oauth.battle.net')return Response.json({access_token:'test',expires_in:3600});
   requests.push(url.searchParams.get('namespace')!);
   return item.clone();
  };
  const client=new Blizzard();
  assert.deepEqual(await client.foreverItemDetails(117),{name:'Tough Jerky',metadata:{itemClassId:0,itemSubclassId:5}});
  assert.deepEqual(await client.nameDetails(117),{name:'Tough Jerky',source:'forever',metadata:{itemClassId:0,itemSubclassId:5}});
  assert.deepEqual(requests.splice(0),['static-forever-us','static-forever-us']);

  item=Response.json({name:'Unknown class',item_class:{id:0},item_subclass:{id:-1}});
  assert.deepEqual(await client.foreverItemDetails(999),{name:'Unknown class',metadata:null});
  item=Response.json({name:'Unknown class',item_class:{id:'0'},item_subclass:{id:5}});
  assert.deepEqual(await client.foreverItemDetails(999),{name:'Unknown class',metadata:null});
  item=new Response(null,{status:404});
  assert.equal(await client.foreverItemDetails(999),null);
  assert.deepEqual(requests.splice(0),['static-forever-us','static-forever-us','static-forever-us']);
  item=new Response(null,{status:403});
  await assert.rejects(()=>client.foreverItemDetails(999),/Item HTTP 403 \(forever\)/);
  assert.deepEqual(requests,['static-forever-us']);
 }finally{
  globalThis.fetch=previous;
  if(oldId===undefined)delete process.env.BLIZZARD_CLIENT_ID;else process.env.BLIZZARD_CLIENT_ID=oldId;
  if(oldSecret===undefined)delete process.env.BLIZZARD_CLIENT_SECRET;else process.env.BLIZZARD_CLIENT_SECRET=oldSecret;
  if(oldRegion===undefined)delete process.env.REGION;else process.env.REGION=oldRegion;
 }
});

test('concurrent name and metadata requests share one Forever fetch and clear it afterwards',async()=>{
 const previous=globalThis.fetch;
 const oldId=process.env.BLIZZARD_CLIENT_ID,oldSecret=process.env.BLIZZARD_CLIENT_SECRET;
 process.env.BLIZZARD_CLIENT_ID='mock';process.env.BLIZZARD_CLIENT_SECRET='mock';
 let itemRequests=0,release:()=>void=()=>{};
 const gate=new Promise<void>(resolve=>{release=resolve;});
 try{
  globalThis.fetch=async(input)=>{
   const url=new URL(String(input));
   if(url.hostname==='oauth.battle.net')return Response.json({access_token:'test',expires_in:3600});
   itemRequests++;
   await gate;
   return Response.json({name:'Tough Jerky',item_class:{id:0},item_subclass:{id:5}});
  };
  const client=new Blizzard();
  const metadata=client.foreverItemDetails(117);
  const name=client.nameDetails(117);
  release();
  const [found,named]=await Promise.all([metadata,name]);
  assert.equal(itemRequests,1);
  assert.deepEqual(found?.metadata,{itemClassId:0,itemSubclassId:5});
  assert.deepEqual(named?.metadata,found?.metadata);
  await client.foreverItemDetails(117);
  assert.equal(itemRequests,2,'the completed request is not a permanent in-memory cache');
 }finally{
  globalThis.fetch=previous;
  if(oldId===undefined)delete process.env.BLIZZARD_CLIENT_ID;else process.env.BLIZZARD_CLIENT_ID=oldId;
  if(oldSecret===undefined)delete process.env.BLIZZARD_CLIENT_SECRET;else process.env.BLIZZARD_CLIENT_SECRET=oldSecret;
 }
});
