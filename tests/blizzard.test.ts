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
