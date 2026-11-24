import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';

const control=process.env.CRON_TEST_CONTROL;
const realNow=Date.now;
Date.now=()=>realNow()+(control&&existsSync(join(control,'clock-offset'))?Number(readFileSync(join(control,'clock-offset'),'utf8')):0);
const originalFetch=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
 const url=String(input);
 if(url.startsWith('https://oauth.battle.net/')){
  if(process.env.CRON_TEST_FAILURE==='true'||(control&&existsSync(join(control,'fail-collection'))))return new Response(null,{status:403});
  return Response.json({access_token:'test',expires_in:3600});
 }
 if(url.includes('.api.blizzard.com')){
  if(url.includes('/auctions/')){
   if(control&&existsSync(join(control,'fail-collection')))return new Response(null,{status:403});
   await new Promise(resolve=>setTimeout(resolve,300));
   return Response.json({id:113,auctions:[{id:1,item:{id:3182},quantity:3,buyout:1800}],commodities:[]});
  }
  return Response.json({name:'Test item'});
 }
 return originalFetch(input,init);
};
