import {appendFileSync} from 'node:fs';
import {join} from 'node:path';

const directory=process.env.METADATA_TEST_CONTROL;
if(!directory)throw Error('METADATA_TEST_CONTROL is required');

globalThis.fetch=async(input)=>{
 const url=new URL(String(input));
 if(url.hostname==='oauth.battle.net')return Response.json({access_token:'test',expires_in:3600});
 if(url.hostname.endsWith('.api.blizzard.com')){
  if(url.pathname.includes('/auctions/'))return new Response(null,{status:403});
  const id=Number(url.pathname.match(/\/item\/(\d+)$/)?.[1]);
  if(Number.isSafeInteger(id)&&id>0){
   appendFileSync(join(directory,'metadata-calls'),`${id}\n`);
   if(id===3182)return new Response(null,{status:404});
   if(id===10938)return new Response(null,{status:403});
   if(id===4402)return Response.json({name:'Already named food',item_class:{id:0},item_subclass:{id:5}});
   return Response.json({name:`Known item ${id}`,item_class:{id:7},item_subclass:{id:5}});
  }
 }
 return new Response(null,{status:503});
};
