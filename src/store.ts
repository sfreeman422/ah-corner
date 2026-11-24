import {mkdir, readFile, readdir, rename, unlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {Pool, PoolConnection, PoolOptions, ResultSetHeader, RowDataPacket} from 'mysql2/promise';
import type {Alert, Snapshot, Trade} from './types.ts';

export type State={names:Record<number,string>;trades:Trade[];alerts:Alert[];watch:number[];modified?:string};
export type Store={
 load:()=>Promise<State>;
 save:(s:State)=>Promise<void>;
 snapshots:()=>Promise<Snapshot[]>;
 put:(s:Snapshot)=>Promise<boolean>;
 health:()=>Promise<void>;
 close:()=>Promise<void>;
};

type Database=Pool|PoolConnection;
type Migration={version:string;file:URL};

const empty=():State=>({names:{},trades:[],alerts:[],watch:[]});
const migrations:Migration[]=[{version:'001',file:new URL('../migrations/001.sql',import.meta.url)}];
const latestMigration=migrations.at(-1)!.version;
const migrationLock='ah-corner:migrations';
const stateTable='ah_corner_state';
const snapshotsTable='ah_corner_snapshots';
const migrationsTable='ah_corner_schema_migrations';

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
    const result=await execute<ResultSetHeader>(pool,`INSERT IGNORE INTO ${snapshotsTable}(market,snapshot_key,recorded_at,data) VALUES(?,?,?,?)`,[market,snapshot.key,snapshot.at,JSON.stringify(snapshot)]);
    await trimSnapshots(pool,market);
    return result.affectedRows===1;
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
 return {
  async load(){try{return JSON.parse(await readFile(state,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return empty();throw error;}},
  async save(nextState){await atomic(state,nextState);},
  async snapshots(){const files=(await readdir(dir)).filter(file=>file.startsWith('snap-')&&file.endsWith('.json')).sort();return Promise.all(files.slice(-25).map(async file=>JSON.parse(await readFile(join(dir,file),'utf8'))));},
  async put(snapshot){const key=snapshot.key.replace(/[^a-zA-Z0-9-]/g,'_');const files=(await readdir(dir)).filter(file=>file.startsWith('snap-')&&file.endsWith('.json'));if(files.some(file=>file.endsWith(`-${key}.json`)))return false;await atomic(join(dir,`snap-${snapshot.at}-${key}.json`),snapshot);const sorted=(await readdir(dir)).filter(file=>file.startsWith('snap-')&&file.endsWith('.json')).sort();for(const file of sorted.slice(0,Math.max(0,sorted.length-25)))await unlink(join(dir,file));return true;},
  async health(){},
  async close(){}
 };
}
