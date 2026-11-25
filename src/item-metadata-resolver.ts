export type ItemMetadata={itemClassId:number;itemSubclassId:number};

export type ItemMetadataResolverOptions={
 lookup:(itemId:number)=>Promise<ItemMetadata|null>;
 shouldLookup:(itemId:number)=>boolean;
 onResult:(itemId:number,metadata:ItemMetadata|null)=>Promise<void>|void;
 onError?:(itemId:number)=>void;
 maxQueued?:number;
 maxPerWindow?:number;
 windowMs?:number;
 retryTtlMs?:number;
};

// One request at a time. The bounded queue and rolling budget keep a large
// auction book from overwhelming the upstream service. Successful lookups,
// including misses, are persisted by the caller; failures are only backed off.
export class ItemMetadataResolver{
 private readonly options:Required<ItemMetadataResolverOptions>;
 private readonly waiting:number[]=[];
 private readonly queued=new Set<number>();
 private readonly retryAfter=new Map<number,number>();
 private readonly starts:number[]=[];
 private active:number|undefined;
 private timer:ReturnType<typeof setTimeout>|undefined;
 private closed=false;

 constructor(options:ItemMetadataResolverOptions){
  this.options={maxQueued:100,maxPerWindow:20,windowMs:60_000,retryTtlMs:5*60_000,onError:()=>{},...options};
  for(const limit of [this.options.maxQueued,this.options.maxPerWindow,this.options.windowMs,this.options.retryTtlMs]){
   if(!Number.isSafeInteger(limit)||limit<1)throw Error('Metadata resolver limits must be positive integers');
  }
 }

 enqueue(itemIds:readonly number[]):void{
  if(this.closed)return;
  const now=Date.now();
  for(const [id,until] of this.retryAfter)if(until<=now)this.retryAfter.delete(id);
  for(const id of itemIds){
   if(this.waiting.length>=this.options.maxQueued)break;
   if(!Number.isSafeInteger(id)||id<1||id===this.active||this.queued.has(id)||this.retryAfter.has(id)||!this.options.shouldLookup(id))continue;
   this.waiting.push(id);
   this.queued.add(id);
  }
  this.pump();
 }

 private pump():void{
  if(this.closed||this.active!==undefined)return;
  const now=Date.now();
  while(this.starts.length&&this.starts[0]<=now-this.options.windowMs)this.starts.shift();
  while(this.waiting.length){
   if(this.starts.length>=this.options.maxPerWindow){
    if(!this.timer){
     this.timer=setTimeout(()=>{this.timer=undefined;this.pump();},Math.max(1,this.starts[0]+this.options.windowMs-Date.now()));
     this.timer.unref();
    }
    return;
   }
   const id=this.waiting.shift()!;
   this.queued.delete(id);
   if(!this.options.shouldLookup(id))continue;
   this.active=id;
   this.starts.push(Date.now());
   void this.resolve(id);
   return;
  }
 }

 private async resolve(id:number):Promise<void>{
  try{
   const value=await this.options.lookup(id);
   if(this.closed)return;
   if(value!==null&&(!value||!Number.isSafeInteger(value.itemClassId)||value.itemClassId<0||!Number.isSafeInteger(value.itemSubclassId)||value.itemSubclassId<0))throw Error('Invalid item metadata');
   // A persisted or manually supplied result may have won the race.
   if(this.options.shouldLookup(id))await this.options.onResult(id,value);
  }catch{
   if(!this.closed){
    this.options.onError(id);
    if(this.retryAfter.size>=2_000)this.retryAfter.delete(this.retryAfter.keys().next().value!);
    this.retryAfter.set(id,Date.now()+this.options.retryTtlMs);
   }
  }finally{
   this.active=undefined;
   this.pump();
  }
 }

 close():void{
  this.closed=true;
  if(this.timer)clearTimeout(this.timer);
  this.timer=undefined;
  this.waiting.length=0;
  this.queued.clear();
 }
}
