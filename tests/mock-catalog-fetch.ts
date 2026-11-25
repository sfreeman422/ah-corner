import {appendFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';

const directory=process.env.CATALOG_TEST_CONTROL;
if(!directory)throw Error('CATALOG_TEST_CONTROL is required');
const dataset='gamedata-catalog-fixture',build='1.60.1.12345';
const records:Record<number,{name:string;class:number;subclass:number}>={
 4402:{name:'Sample food',class:0,subclass:5},
 3182:{name:'Sample trade good',class:7,subclass:5},
 9144:{name:'Sample weapon',class:2,subclass:7},
 10561:{name:'Sample miscellaneous item',class:15,subclass:0},
 3823:{name:'Sample recipe',class:9,subclass:1}
};

globalThis.fetch=async input=>{
 const url=new URL(String(input));
 if(url.hostname==='oauth.battle.net')return Response.json({access_token:'test',expires_in:3600});
 // Isolate the catalog; Blizzard failures must not be mistaken for negative data.
 if(url.hostname.endsWith('.api.blizzard.com'))return new Response(null,{status:403});
 if(url.hostname==='warcraftforever.com'){
  if(url.pathname==='/api/data/v1/manifest'){
   appendFileSync(join(directory,'catalog-calls'),'manifest\n');
   if(existsSync(join(directory,'catalog-fail')))return new Response(null,{status:503});
   return Response.json({schemaVersion:1,defaultChannel:'live',channels:{live:{product:'wowf',build,datasets:{items:dataset}}}});
  }
  if(url.pathname===`/api/data/v1/${dataset}/enUS/items`){
   const ids=(url.searchParams.get('ids')||'').split(',').filter(Boolean).map(Number);
   appendFileSync(join(directory,'catalog-calls'),`items:${ids.join(',')}\n`);
   return Response.json({schemaVersion:1,dataset,locale:'enUS',resource:'items',source:{product:'wowf',build},coverage:'fixture',data:ids.filter(id=>records[id]).map(id=>({id,...records[id]})),missingIds:ids.filter(id=>!records[id])});
  }
 }
 return new Response(null,{status:503});
};
