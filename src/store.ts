import {mkdir, readFile, readdir, rename, unlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {Pool, PoolConnection, PoolOptions, ResultSetHeader, RowDataPacket} from 'mysql2/promise';
import {groups,stats} from './engine.ts';
import type {ItemUseMap} from './item-use.ts';
import type {ItemNameDetails} from './blizzard.ts';
import type {Alert, Settings, Snapshot, Stats, Trade} from './types.ts';

export type State={names:Record<number,string>;nameSources?:Record<number,ItemNameDetails['source']>;namesFetchedAt?:number;trades:Trade[];alerts:Alert[];watch:number[];modified?:string;strategy?:Settings;itemUses?:ItemUseMap};
export type Store={
 load:()=>Promise<State>;
 save:(s:State)=>Promise<void>;
 snapshots:()=>Promise<Snapshot[]>;
 put:(s:Snapshot)=>Promise<boolean>;
 history:(itemId:number)=>Promise<Stats[]>;
 prune:()=>Promise<void>;
 health:()=>Promise<void>;
 close:()=>Promise<void>;
};

type Database=Pool|PoolConnection;
type Migration={version:string;file:URL};

const empty=():State=>({names:{},trades:[],alerts:[],watch:[]});
const migrations:Migration[]=[{version:'001',file:new URL('../migrations/001.sql',import.meta.url)},{version:'002',file:new URL('../migrations/002.sql',import.meta.url)}];
const latestMigration=migrations.at(-1)!.version;
const migrationLock='ah-corner:migrations';
const stateTable='ah_corner_state';
const snapshotsTable='ah_corner_snapshots';
const migrationsTable='ah_corner_schema_migrations';
const historyTable='ah_corner_price_history';
const retentionMs=30*24*60*60*1_000;
const historyLimit=720;
const batchSize=250;

type HistorySnapshot={key:string;at:number;source:Snapshot['source'];items:Record<number,Stats>};

function summary(snapshot:Snapshot):HistorySnapshot{
 const items:Record<number,Stats>={};
 for(const [itemId,rows] of groups(snapshot)){
  const itemStats=stats(rows,snapshot.at);
  if(itemStats)items[itemId]=itemStats;
 }
 return {key:snapshot.key,at:snapshot.at,source:snapshot.source,items};
}

function enabled(name:string){return process.env[name]==='true';}

function positiveInteger(name:string,fallback:number){
 const raw=process.env[name];
 if(raw===undefined||raw==='')return fallback;
 const value=Number(raw);
 if(!Number.isSafeInteger(value)||value<1)throw Error(`${name} must be a positive integer`);
 return value;
}

function queryTimeout(){return positiveInteger('DATABASE_QUERY_TIMEOUT_MS',15_000);}

async function sslConfig():Promise<PoolOptions['ssl']|undefined>{
 const mode=process.env.DATABASE_SSL||'disable';
 if(mode==='disable'){
  if(enabled('REQUIRE_DATABASE_SSL'))throw Error('DATABASE_SSL=verify-full is required for this deployment');
  return undefined;
 }
 if(mode!=='verify-full')throw Error('DATABASE_SSL must be disable or verify-full');
 const caFile=process.env.DATABASE_SSL_CA_FILE;
 const base={rejectUnauthorized:true,verifyIdentity:true};
 return caFile?{...base,ca:await readFile(caFile,'utf8')}:base;
}

function databaseOptions(connectionString:string):Omit<PoolOptions,'ssl'|'multipleStatements'>{
 let url:URL;
 try{url=new URL(connectionString);}catch{throw Error('DATABASE_URL must be a valid MySQL connection URL');}
 if(url.protocol!=='mysql:')throw Error('DATABASE_URL must use mysql://');
 if(!url.hostname||!url.username||url.pathname==='/'||!url.pathname)throw Error('DATABASE_URL must include a host, username, and database name');
 if([...url.searchParams.keys()].some(key=>{const normalized=key.toLowerCase();return normalized.includes('ssl')||normalized.startsWith('tls');}))throw Error('Configure MySQL TLS with DATABASE_SSL and DATABASE_SSL_CA_FILE, not SSL URL parameters');
 let port=3306;
 if(url.port){
  port=Number(url.port);
  if(!Number.isSafeInteger(port)||port<1||port>65_535)throw Error('DATABASE_URL has an invalid MySQL port');
 }
 let user:string;
 let password:string;
 let database:string;
 try{
  user=decodeURIComponent(url.username);
  password=decodeURIComponent(url.password);
  database=decodeURIComponent(url.pathname.slice(1));
 }catch{throw Error('DATABASE_URL must percent-encode reserved credentials characters');}
 if(!database||database.includes('/'))throw Error('DATABASE_URL must include one database name');
 return {
  host:url.hostname,
  port,
  user,
  password,
  database,
  charset:'utf8mb4',
  connectionLimit:positiveInteger('DATABASE_POOL_MAX',3),
  maxIdle:positiveInteger('DATABASE_POOL_MAX',3),
  idleTimeout:positiveInteger('DATABASE_IDLE_TIMEOUT_MS',30_000),
  connectTimeout:positiveInteger('DATABASE_CONNECTION_TIMEOUT_MS',5_000),
  waitForConnections:true,
  queueLimit:positiveInteger('DATABASE_QUEUE_LIMIT',10),
  jsonStrings:true,
  connectAttributes:{application_name:process.env.DATABASE_APPLICATION_NAME||'ah-corner'}
 };
}

async function poolFor(connectionString:string,migrationsMode=false):Promise<Pool>{
 const {createPool}=await import('mysql2/promise');
 return createPool({...databaseOptions(connectionString),ssl:await sslConfig(),multipleStatements:migrationsMode});
}

async function execute<T extends RowDataPacket[]|ResultSetHeader>(database:Database,sql:string,values:any[]=[]):Promise<T>{
 const [result]=await database.execute<T>({sql,timeout:queryTimeout()},values);
 return result;
}

function parseJson<T>(value:unknown):T{
 if(typeof value==='string')return JSON.parse(value) as T;
 if(Buffer.isBuffer(value))return JSON.parse(value.toString('utf8')) as T;
 return value as T;
}

async function assertSchema(pool:Pool){
 try{
  const rows=await execute<RowDataPacket[]>(pool,`SELECT version FROM ${migrationsTable} WHERE version=?`,[latestMigration]);
  if(!rows.length)throw Error('Database schema is not current. Run npm run migrate before starting AH Corner.');
 }catch(error){
  if((error as {code?:string}).code==='ER_NO_SUCH_TABLE')throw Error('Database is not initialized. Run npm run migrate before starting AH Corner.');
  throw error;
 }
}

async function trimSnapshots(pool:Pool,market:string){
 const rows=await execute<RowDataPacket[]>(pool,`SELECT snapshot_key FROM ${snapshotsTable} WHERE market=? ORDER BY recorded_at DESC LIMIT 25, 1000`,[market]);
 if(!rows.length)return;
 const keys=rows.map(row=>String(row.snapshot_key));
 const placeholders=keys.map(()=>'?').join(',');
 await execute<ResultSetHeader>(pool,`DELETE FROM ${snapshotsTable} WHERE market=? AND snapshot_key IN (${placeholders})`,[market,...keys]);
 if(rows.length===1000)await trimSnapshots(pool,market);
}

// A snapshot and all its compact history rows are committed together. A failed
// batch rolls back the raw book as well, allowing the collector to retry it.
export async function saveSnapshotTransaction(pool:Pick<Pool,'getConnection'>,market:string,snapshot:Snapshot):Promise<boolean>{
 if(snapshot.market!==market)throw Error('Snapshot market does not match store market');
 const history=summary(snapshot);
 const client=await pool.getConnection();
 try{
  await client.beginTransaction();
  try{
   let inserted=true;
   try{
    await execute<ResultSetHeader>(client,`INSERT INTO ${snapshotsTable}(market,snapshot_key,recorded_at,data) VALUES(?,?,?,?)`,[market,snapshot.key,snapshot.at,JSON.stringify(snapshot)]);
   }catch(error){
    if((error as {code?:string}).code!=='ER_DUP_ENTRY')throw error;
    inserted=false;
    await execute<ResultSetHeader>(client,`UPDATE ${snapshotsTable} SET recorded_at=?,data=? WHERE market=? AND snapshot_key=?`,[snapshot.at,JSON.stringify(snapshot),market,snapshot.key]);
   }
   const entries=Object.entries(history.items);
   for(let offset=0;offset<entries.length;offset+=batchSize){
    const batch=entries.slice(offset,offset+batchSize);
    const values:any[]=[];
    for(const [itemId,point] of batch)values.push(market,snapshot.key,Number(itemId),snapshot.source,Math.floor(snapshot.at/3_600_000),snapshot.at,point.floor,point.median,point.units,point.listings);
    // Keep the latest successful observation of each item per hour, even when
    // the raw book is identical to a previously retained snapshot.
    await execute<ResultSetHeader>(client,`INSERT INTO ${historyTable}(market,snapshot_key,item_id,source,hour_bucket,recorded_at,floor_price,median_price,units,listing_count) VALUES ${batch.map(()=>'(?,?,?,?,?,?,?,?,?,?)').join(',')} ON DUPLICATE KEY UPDATE snapshot_key=IF(VALUES(recorded_at)>=recorded_at,VALUES(snapshot_key),snapshot_key),source=IF(VALUES(recorded_at)>=recorded_at,VALUES(source),source),floor_price=IF(VALUES(recorded_at)>=recorded_at,VALUES(floor_price),floor_price),median_price=IF(VALUES(recorded_at)>=recorded_at,VALUES(median_price),median_price),units=IF(VALUES(recorded_at)>=recorded_at,VALUES(units),units),listing_count=IF(VALUES(recorded_at)>=recorded_at,VALUES(listing_count),listing_count),recorded_at=GREATEST(recorded_at,VALUES(recorded_at))`,values);
   }
   await client.commit();
   return inserted;
  }catch(error){
   await client.rollback();
   throw error;
  }
 }finally{client.release();}
}

export async function runMigrations(){
 const connectionString=process.env.DATABASE_MIGRATION_URL||process.env.DATABASE_URL;
 if(!connectionString)throw Error('DATABASE_MIGRATION_URL or DATABASE_URL is required to run migrations');
 const pool=await poolFor(connectionString,true);
 try{
  const client=await pool.getConnection();
  try{
   await client.query(`CREATE TABLE IF NOT EXISTS ${migrationsTable} (version varchar(64) NOT NULL PRIMARY KEY, applied_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
   // Keep MySQL's lock wait below the client query timeout so contention gets a clear error.
   const lockWaitSeconds=Math.max(0,Math.ceil(queryTimeout()/1_000)-1);
   const locks=await execute<RowDataPacket[]>(client,'SELECT GET_LOCK(?, ?) AS locked',[migrationLock,lockWaitSeconds]);
   if(Number(locks[0]?.locked)!==1)throw Error('Could not acquire the database migration lock. Try again shortly.');
   try{
    const applied=await execute<RowDataPacket[]>(client,`SELECT version FROM ${migrationsTable}`);
    const versions=new Set(applied.map(row=>String(row.version)));
    for(const migration of migrations){
     if(versions.has(migration.version))continue;
     const sql=await readFile(migration.file,'utf8');
     await client.beginTransaction();
     try{
      await client.query({sql,timeout:queryTimeout()});
      await execute<ResultSetHeader>(client,`INSERT INTO ${migrationsTable}(version) VALUES(?)`,[migration.version]);
      await client.commit();
     }catch(error){
      await client.rollback();
      throw error;
     }
    }
   }finally{
    await execute<RowDataPacket[]>(client,'SELECT RELEASE_LOCK(?) AS released',[migrationLock]);
   }
  }finally{
   client.release();
  }
 }finally{
  await pool.end();
 }
}

export async function openStore(market:string):Promise<Store>{
 const connectionString=process.env.DATABASE_URL;
 if(connectionString){
  const pool=await poolFor(connectionString);
  try{await assertSchema(pool);}catch(error){await pool.end();throw error;}
  return {
   async load(){
    const rows=await execute<RowDataPacket[]>(pool,`SELECT data FROM ${stateTable} WHERE market=?`,[market]);
    return rows[0]?parseJson<State>(rows[0].data):empty();
   },
   async save(state){
    const data=JSON.stringify(state);
    await execute<ResultSetHeader>(pool,`INSERT INTO ${stateTable}(market,data) VALUES(?,?) ON DUPLICATE KEY UPDATE data=?`,[market,data,data]);
   },
   async snapshots(){
    const rows=await execute<RowDataPacket[]>(pool,`SELECT data FROM ${snapshotsTable} WHERE market=? ORDER BY recorded_at DESC LIMIT 25`,[market]);
    return rows.map(row=>parseJson<Snapshot>(row.data)).reverse();
   },
   async put(snapshot){
    const inserted=await saveSnapshotTransaction(pool,market,snapshot);
    if(inserted){
     try{await trimSnapshots(pool,market);}
     catch(error){console.warn('Could not trim old raw snapshots:',error);}
    }
    return inserted;
   },
   async history(itemId){
    const rows=await execute<RowDataPacket[]>(pool,`SELECT recorded_at,floor_price,median_price,units,listing_count FROM ${historyTable} WHERE market=? AND item_id=? AND (source <> 'blizzard' OR recorded_at >= ?) ORDER BY recorded_at DESC,snapshot_key DESC LIMIT ${historyLimit}`,[market,itemId,Date.now()-retentionMs]);
    return rows.map(row=>({at:Number(row.recorded_at),floor:Number(row.floor_price),median:Number(row.median_price),units:Number(row.units),listings:Number(row.listing_count)})).reverse();
   },
   async prune(){
    const cutoff=Date.now()-retentionMs;
    // These tables are private to AH Corner. Preserve synthetic demo data and
    // other application tables while expiring Blizzard-derived records only.
    let deleted:number;
    do{
     const result=await execute<ResultSetHeader>(pool,`DELETE FROM ${historyTable} WHERE source='blizzard' AND recorded_at < ? LIMIT 1000`,[cutoff]);
     deleted=result.affectedRows;
    }while(deleted===1000);
    do{
     const result=await execute<ResultSetHeader>(pool,`DELETE FROM ${snapshotsTable} WHERE recorded_at < ? AND JSON_UNQUOTE(JSON_EXTRACT(data,'$.source'))='blizzard' LIMIT 1000`,[cutoff]);
     deleted=result.affectedRows;
    }while(deleted===1000);
   },
   async health(){await execute<RowDataPacket[]>(pool,'SELECT 1 AS ready');},
   async close(){await pool.end();}
  };
 }
 if(enabled('REQUIRE_DATABASE'))throw Error('DATABASE_URL is required for this deployment');
 const dir=join(process.env.DATA_DIR||'./data',market.replace(/[^a-zA-Z0-9-]/g,'_'));
 await mkdir(dir,{recursive:true});
 const state=join(dir,'state.json');
 async function atomic(path:string,value:unknown){await writeFile(path+'.tmp',JSON.stringify(value),{mode:0o600});await rename(path+'.tmp',path);}
 async function summaries(){
  const files=(await readdir(dir)).filter(file=>file.startsWith('history-')&&file.endsWith('.json'));
  return Promise.all(files.map(async file=>({file,entry:JSON.parse(await readFile(join(dir,file),'utf8')) as HistorySnapshot})));
 }
 return {
  async load(){try{return JSON.parse(await readFile(state,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return empty();throw error;}},
  async save(nextState){await atomic(state,nextState);},
  async snapshots(){const files=(await readdir(dir)).filter(file=>file.startsWith('snap-')&&file.endsWith('.json')).sort();return Promise.all(files.slice(-25).map(async file=>JSON.parse(await readFile(join(dir,file),'utf8'))));},
  async put(snapshot){
   if(snapshot.market!==market)throw Error('Snapshot market does not match store market');
   const key=snapshot.key.replace(/[^a-zA-Z0-9-]/g,'_');
   const files=(await readdir(dir)).filter(file=>file.startsWith('snap-')&&file.endsWith('.json'));
   const oldFile=files.find(file=>file.endsWith(`-${key}.json`));
   const duplicate=!!oldFile;
   const historyPath=join(dir,`history-${Math.floor(snapshot.at/3_600_000)}.json`);
   let previous:HistorySnapshot|undefined;
   try{previous=JSON.parse(await readFile(historyPath,'utf8')) as HistorySnapshot;}
   catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   const next=summary(snapshot);
   if(previous){
    for(const [itemId,point] of Object.entries(previous.items))if(!next.items[Number(itemId)]||point.at>next.items[Number(itemId)].at)next.items[Number(itemId)]=point;
    if(previous.at>next.at){next.at=previous.at;next.key=previous.key;next.source=previous.source;}
   }
   await atomic(historyPath,next);
   try{await atomic(join(dir,`snap-${snapshot.at}-${key}.json`),snapshot);}
   catch(error){if(previous)await atomic(historyPath,previous);else await unlink(historyPath).catch(()=>{});throw error;}
   if(oldFile&&oldFile!==`snap-${snapshot.at}-${key}.json`)await unlink(join(dir,oldFile));
   if(duplicate)return false;
   const sorted=(await readdir(dir)).filter(file=>file.startsWith('snap-')&&file.endsWith('.json')).sort();
   for(const file of sorted.slice(0,Math.max(0,sorted.length-25)))await unlink(join(dir,file));
   return true;
  },
  async history(itemId){
   const cutoff=Date.now()-retentionMs;
   return (await summaries()).map(({entry})=>({source:entry.source,point:entry.items[itemId]})).filter(({source,point})=>!!point&&(source!=='blizzard'||point.at>=cutoff)).map(({point})=>point).sort((a,b)=>a.at-b.at).slice(-historyLimit);
  },
  async prune(){
   const cutoff=Date.now()-retentionMs;
   for(const {file,entry} of await summaries())if(entry.source==='blizzard'){
    const items=Object.entries(entry.items).filter(([,point])=>point.at>=cutoff);
    if(!items.length)await unlink(join(dir,file));
    else if(items.length!==Object.keys(entry.items).length)await atomic(join(dir,file),{...entry,items:Object.fromEntries(items)});
   }
   const files=(await readdir(dir)).filter(file=>file.startsWith('snap-')&&file.endsWith('.json'));
   for(const file of files){
    const snapshot=JSON.parse(await readFile(join(dir,file),'utf8')) as Snapshot;
    if(snapshot.source==='blizzard'&&snapshot.at<cutoff)await unlink(join(dir,file));
   }
  },
  async health(){},
  async close(){}
 };
}
