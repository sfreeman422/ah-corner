import {setTimeout as delay} from 'node:timers/promises';

const origin='https://warcraftforever.com';
const maxBodyBytes=2_000_000;
const object=(value:unknown):value is Record<string,any>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const positive=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
const nonnegative=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;

export type ForeverCatalogItem={classId:number;subclassId:number;quality?:number;slot?:number;itemLevel?:number;name?:string};
export type ForeverItemCatalog={dataset:string;build:string;items:Record<string,ForeverCatalogItem>;missingIds:number[]};
export type ForeverCatalogOptions={fetcher?:typeof fetch;signal?:AbortSignal;requestIntervalMs?:number;batchSize?:number};

/** Read explicitly requested Forever items in bounded batches from one pinned
 * client-data dataset. Return only if every requested ID is accounted for.
 * A missing ID is not evidence that the item does not exist in game.
 */
export async function fetchForeverItems(itemIds:readonly number[],options:ForeverCatalogOptions={}):Promise<ForeverItemCatalog>{
 const {fetcher=fetch,signal,requestIntervalMs=1_000,batchSize=50}=options;
 if(!Array.isArray(itemIds)||itemIds.some(id=>!positive(id)))throw Error('Invalid Forever item IDs');
 if(!Number.isSafeInteger(requestIntervalMs)||requestIntervalMs<0||requestIntervalMs>60_000)throw Error('Invalid item catalog request interval');
 if(!Number.isSafeInteger(batchSize)||batchSize<1||batchSize>50)throw Error('Invalid item catalog batch size');
 const ids=[...new Set(itemIds)];
 if(ids.length>100_000)throw Error('Too many Forever item IDs');
 let lastStart=0;
 async function read(path:string):Promise<any>{
  signal?.throwIfAborted();
  const wait=Math.max(0,lastStart+requestIntervalMs-Date.now());
  if(wait)await delay(wait,undefined,{signal});
  signal?.throwIfAborted();
  lastStart=Date.now();
  const timeout=AbortSignal.timeout(15_000);
  const response=await fetcher(new URL(path,origin),{signal:signal?AbortSignal.any([signal,timeout]):timeout,headers:{Accept:'application/json'}});
  if(!response.ok)throw Error(`Warcraft Forever item catalog HTTP ${response.status}`);
  const length=Number(response.headers.get('content-length'));
  if(Number.isFinite(length)&&length>maxBodyBytes)throw Error('Warcraft Forever item catalog response too large');
  if(!response.body)throw Error('Warcraft Forever item catalog returned an empty response');
  const reader=response.body.getReader(),decoder=new TextDecoder();
  let text='',bytes=0;
  try{
   while(true){
    const {done,value}=await reader.read();
    if(done)break;
    bytes+=value.byteLength;
    if(bytes>maxBodyBytes){await reader.cancel();throw Error('Warcraft Forever item catalog response too large');}
    text+=decoder.decode(value,{stream:true});
   }
   text+=decoder.decode();
  }finally{reader.releaseLock();}
  try{return JSON.parse(text);}catch{throw Error('Warcraft Forever item catalog returned invalid JSON');}
 }
 const manifest=await read('/api/data/v1/manifest');
 const channel=object(manifest)&&typeof manifest.defaultChannel==='string'&&object(manifest.channels)?manifest.channels[manifest.defaultChannel]:undefined;
 const dataset=channel?.datasets?.items,build=channel?.build;
 if(manifest?.schemaVersion!==1||channel?.product!=='wowf'||typeof dataset!=='string'||!/^[A-Za-z0-9._-]{1,100}$/.test(dataset)||typeof build!=='string'||!build||build.length>100)throw Error('Invalid Warcraft Forever item manifest');
 const items:Record<string,ForeverCatalogItem>={};
 const missingIds:number[]=[];
 for(let offset=0;offset<ids.length;offset+=batchSize){
  const batch=ids.slice(offset,offset+batchSize),expected=new Set(batch),seen=new Set<number>();
  const query=new URLSearchParams({ids:batch.join(',')});
  const result=await read(`/api/data/v1/${dataset}/enUS/items?${query}`);
  if(!object(result)||result.schemaVersion!==1||result.dataset!==dataset||result.locale!=='enUS'||result.resource!=='items'||result.source?.product!=='wowf'||result.source?.build!==build||!Array.isArray(result.data)||!Array.isArray(result.missingIds)||result.data.length>batch.length||result.missingIds.length>batch.length)throw Error('Invalid Warcraft Forever item batch');
  for(const entry of result.data){
   if(!object(entry)||!positive(entry.id)||!expected.has(entry.id)||seen.has(entry.id)||!nonnegative(entry.class)||!nonnegative(entry.subclass))throw Error('Invalid Warcraft Forever item record');
   if(entry.quality!==undefined&&!nonnegative(entry.quality))throw Error('Invalid Warcraft Forever item quality');
   if(entry.slot!==undefined&&!nonnegative(entry.slot))throw Error('Invalid Warcraft Forever item slot');
   if(entry.name!==null&&entry.name!==undefined&&(typeof entry.name!=='string'||entry.name.length>300))throw Error('Invalid Warcraft Forever item name');
   seen.add(entry.id);
   const name=typeof entry.name==='string'?entry.name.trim():'';
   items[String(entry.id)]={classId:entry.class,subclassId:entry.subclass,...(entry.quality!==undefined?{quality:entry.quality}:{}),...(entry.slot!==undefined?{slot:entry.slot}:{}),...(positive(entry.level)?{itemLevel:entry.level}:{}),...(name?{name}:{})};
  }
  for(const id of result.missingIds){
   if(!positive(id)||!expected.has(id)||seen.has(id))throw Error('Invalid Warcraft Forever missing item ID');
   seen.add(id);missingIds.push(id);
  }
  if(seen.size!==expected.size)throw Error('Incomplete Warcraft Forever item batch');
 }
 return {dataset,build,items,missingIds};
}
