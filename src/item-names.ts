import type {ItemNameDetails} from './blizzard.ts';

export type ItemNameResolverOptions={
 lookup:(itemId:number)=>Promise<ItemNameDetails|null>;
 isKnown:(itemId:number)=>boolean;
 onName:(itemId:number,name:ItemNameDetails)=>Promise<void>|void;
 maxConcurrent?:number;
 maxPerWindow?:number;
 windowMs?:number;
 maxQueued?:number;
 missingTtlMs?:number;
 retryTtlMs?:number;
};

// Resolves only items requested by the caller. A bounded queue, concurrency
// limit and rolling request budget prevent a large book or repeated UI polls
// from turning into thousands of simultaneous upstream requests.
export class ItemNameResolver{
 private readonly options:Required<ItemNameResolverOptions>;
 private readonly waiting:number[]=[];
 private readonly queued=new Set<number>();
 private readonly active=new Set<number>();
 private readonly retryAfter=new Map<number,number>();
 private readonly starts:number[]=[];
 private timer:ReturnType<typeof setTimeout>|undefined;
 private closed=false;

 constructor(options:ItemNameResolverOptions){
  this.options={maxConcurrent:2,maxPerWindow:30,windowMs:60_000,maxQueued:100,missingTtlMs:24*60*60_000,retryTtlMs:5*60_000,...options};
  for(const value of [this.options.maxConcurrent,this.options.maxPerWindow,this.options.windowMs,this.options.maxQueued,this.options.missingTtlMs,this.options.retryTtlMs]){
   if(!Number.isSafeInteger(value)||value<1)throw Error('Name resolver limits must be positive integers');
  }
 }

 enqueue(itemIds:readonly number[]):void{
  if(this.closed)return;
  const now=Date.now();
  for(const [id,until] of this.retryAfter)if(until<=now)this.retryAfter.delete(id);
  for(const id of itemIds){
   if(this.waiting.length>=this.options.maxQueued)break;
   if(!Number.isSafeInteger(id)||id<1||this.options.isKnown(id)||this.queued.has(id)||this.active.has(id)||this.retryAfter.has(id))continue;
   this.waiting.push(id);
   this.queued.add(id);
  }
  this.pump();
 }

 private pump():void{
  if(this.closed)return;
  const now=Date.now();
  while(this.starts.length&&this.starts[0]<=now-this.options.windowMs)this.starts.shift();
  while(this.waiting.length&&this.active.size<this.options.maxConcurrent){
   if(this.starts.length>=this.options.maxPerWindow){
    if(!this.timer){
     this.timer=setTimeout(()=>{this.timer=undefined;this.pump();},Math.max(1,this.starts[0]+this.options.windowMs-Date.now()));
     this.timer.unref();
    }
    return;
   }
   const id=this.waiting.shift()!;
   this.queued.delete(id);
   if(this.options.isKnown(id))continue;
   this.active.add(id);
   this.starts.push(Date.now());
   void this.resolve(id);
  }
 }

 private async resolve(id:number):Promise<void>{
  try{
   const raw=await this.options.lookup(id);
   if(this.closed)return;
   const name=typeof raw?.name==='string'?raw.name.trim():'';
   if(!name||name===`Item #${id}`){this.defer(id,this.options.missingTtlMs);return;}
   // Another source may have resolved this item while the lookup was in flight.
   if(!this.options.isKnown(id))await this.options.onName(id,{name,source:raw!.source});
  }catch{
   if(!this.closed)this.defer(id,this.options.retryTtlMs);
  }finally{
   this.active.delete(id);
   this.pump();
  }
 }

 private defer(id:number,duration:number):void{
  // Bound negative caching even if many distinct IDs are researched over time.
  if(this.retryAfter.size>=2_000)this.retryAfter.delete(this.retryAfter.keys().next().value!);
  this.retryAfter.set(id,Date.now()+duration);
 }

 close():void{
  this.closed=true;
  if(this.timer)clearTimeout(this.timer);
  this.timer=undefined;
  this.waiting.length=0;
  this.queued.clear();
 }
}
