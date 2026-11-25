import {setTimeout as delay} from 'node:timers/promises';

const origin='https://warcraftforever.com';
const manifestPath='/api/data/v1/manifest';
const maxBodyBytes=2_000_000;

export type RecipeUse={recipeId:number;name:string;profession:number;quantity:number;productId?:number};
export type RecipeIndex={dataset:string;build:string;uses:Record<string,RecipeUse>};
export type RecipeIndexOptions={
 fetcher?:typeof fetch;
 signal?:AbortSignal;
 /** Defaults to one request per second. Exposed for deterministic tests. */
 requestIntervalMs?:number;
 /** Hard bound on pagination; a partial index is never returned. */
 maxPages?:number;
};

const positive=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
const object=(value:unknown):value is Record<string,any>=>!!value&&typeof value==='object'&&!Array.isArray(value);

/** Build a compact reverse recipe index from one pinned Forever dataset.
 * A result is returned only after every page has been received and validated.
 * Missing items are not evidence that they have no use.
 */
export async function fetchRecipeIndex(options:RecipeIndexOptions={}):Promise<RecipeIndex>{
 const {fetcher=fetch,signal,requestIntervalMs=1_000,maxPages=200}=options;
 if(!Number.isSafeInteger(requestIntervalMs)||requestIntervalMs<0||requestIntervalMs>60_000)throw Error('Invalid recipe index request interval');
 if(!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>1_000)throw Error('Invalid recipe index page limit');
 let lastStart=0;
 async function read(path:string):Promise<any>{
  signal?.throwIfAborted();
  const wait=Math.max(0,lastStart+requestIntervalMs-Date.now());
  if(wait)await delay(wait,undefined,{signal});
  signal?.throwIfAborted();
  lastStart=Date.now();
  const timeout=AbortSignal.timeout(15_000);
  const response=await fetcher(new URL(path,origin),{signal:signal?AbortSignal.any([signal,timeout]):timeout,headers:{Accept:'application/json'}});
  if(!response.ok)throw Error(`Warcraft Forever data HTTP ${response.status}`);
  const text=await response.text();
  if(Buffer.byteLength(text,'utf8')>maxBodyBytes)throw Error('Warcraft Forever response too large');
  try{return JSON.parse(text);}catch{throw Error('Warcraft Forever returned invalid JSON');}
 }
 const manifest=await read(manifestPath);
 const channel=object(manifest)&&typeof manifest.defaultChannel==='string'&&object(manifest.channels)?manifest.channels[manifest.defaultChannel]:undefined;
 const dataset=channel?.datasets?.recipes,build=channel?.build;
 if(manifest?.schemaVersion!==1||channel?.product!=='wowf'||typeof dataset!=='string'||!/^[A-Za-z0-9._-]{1,100}$/.test(dataset)||typeof build!=='string'||!build||build.length>100)throw Error('Invalid Warcraft Forever recipe manifest');
 const uses:Record<string,RecipeUse>={};
 const seenCursors=new Set<string>();
 let cursor:string|undefined;
 for(let page=0;page<maxPages;page++){
  const query=new URLSearchParams({query:'',limit:'100'});
  if(cursor)query.set('cursor',cursor);
  const result=await read(`/api/data/v1/${dataset}/enUS/recipes?${query}`);
  if(!object(result)||result.schemaVersion!==1||result.dataset!==dataset||result.locale!=='enUS'||result.resource!=='recipes'||result.source?.product!=='wowf'||result.source?.build!==build||!Array.isArray(result.data)||result.data.length>100||!(result.nextCursor===null||typeof result.nextCursor==='string'))throw Error('Invalid Warcraft Forever recipe page');
  for(const recipe of result.data){
   if(!object(recipe)||!positive(recipe.id)||!positive(recipe.profession)||!Array.isArray(recipe.reagents))throw Error('Invalid Warcraft Forever recipe record');
   // Undiscovered or untranslated names cannot provide a useful reference.
   if(recipe.name!==null&&typeof recipe.name!=='string')throw Error('Invalid Warcraft Forever recipe name');
   const name=typeof recipe.name==='string'?recipe.name.trim():'';
   if(name.length>300)throw Error('Invalid Warcraft Forever recipe name');
   for(const reagent of recipe.reagents){
    if(!Array.isArray(reagent)||reagent.length!==2||!positive(reagent[0])||!positive(reagent[1]))throw Error('Invalid Warcraft Forever recipe reagent');
    if(!name)continue;
    const [itemId,quantity]=reagent;
    // One concrete relationship is enough to explain a use. Keep the first
    // so repeated ingredients do not make persistence grow with recipe count.
    uses[String(itemId)]??={recipeId:recipe.id,name,profession:recipe.profession,quantity,...(positive(recipe.product?.item)?{productId:recipe.product.item}:{})};
   }
  }
  if(result.nextCursor===null)return {dataset,build,uses};
  const next=result.nextCursor;
  if(!next||next.length>2048||!/^[A-Za-z0-9_-]+$/.test(next)||seenCursors.has(next)||result.data.length===0)throw Error('Invalid Warcraft Forever recipe cursor');
  seenCursors.add(next);
  cursor=next;
 }
 throw Error('Warcraft Forever recipe index exceeded the page limit');
}
