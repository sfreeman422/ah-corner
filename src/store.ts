import {mkdir, readFile, readdir, rename, unlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {Pool, PoolConfig} from 'pg';
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

const empty=():State=>({names:{},trades:[],alerts:[],watch:[]});
const migrations=[{version:'001',file:new URL('../migrations/001.sql',import.meta.url)}];
const latestMigration=migrations.at(-1)!.version;
const migrationLock=1487648162;

function enabled(name:string){return process.env[name]==='true';}

function positiveInteger(name:string,fallback:number){
 const raw=process.env[name];
 if(raw===undefined||raw==='')return fallback;
 const value=Number(raw);
 if(!Number.isSafeInteger(value)||value<1)throw Error(`${name} must be a positive integer`);
 return value;
}

async function sslConfig():Promise<PoolConfig['ssl']|undefined>{
 const mode=process.env.DATABASE_SSL||'disable';
 if(mode==='disable'){
  if(enabled('REQUIRE_DATABASE_SSL'))throw Error('DATABASE_SSL=verify-full is required for this deployment');
  return undefined;
 }
 if(mode!=='verify-full')throw Error('DATABASE_SSL must be disable or verify-full');
 const caFile=process.env.DATABASE_SSL_CA_FILE;
 return caFile?{rejectUnauthorized:true,ca:await readFile(caFile,'utf8')}:{rejectUnauthorized:true};
}

async function poolFor(connectionString:string):Promise<Pool>{
 let url:URL;
 try{url=new URL(connectionString);}catch{throw Error('DATABASE_URL must be a valid PostgreSQL connection URL');}
 if(!['postgres:','postgresql:'].includes(url.protocol))throw Error('DATABASE_URL must use postgres:// or postgresql://');
 if([...url.searchParams.keys()].some(key=>key.toLowerCase().startsWith('ssl')))throw Error('Configure PostgreSQL TLS with DATABASE_SSL and DATABASE_SSL_CA_FILE, not SSL URL parameters');
 const {Pool}=await import('pg');
 return new Pool({
  connectionString,
  ssl:await sslConfig(),
  max:positiveInteger('DATABASE_POOL_MAX',3),
  connectionTimeoutMillis:positiveInteger('DATABASE_CONNECTION_TIMEOUT_MS',5_000),
  idleTimeoutMillis:positiveInteger('DATABASE_IDLE_TIMEOUT_MS',30_000),
  query_timeout:positiveInteger('DATABASE_QUERY_TIMEOUT_MS',15_000),
  statement_timeout:positiveInteger('DATABASE_STATEMENT_TIMEOUT_MS',15_000),
  application_name:process.env.DATABASE_APPLICATION_NAME||'ah-corner'
 });
}

async function assertSchema(pool:Pool){
 try{
  const result=await pool.query<{version:string}>('SELECT version FROM schema_migrations WHERE version=$1',[latestMigration]);
  if(!result.rowCount)throw Error('Database schema is not current. Run npm run migrate before starting AH Corner.');
 }catch(error){
  if((error as {code?:string}).code==='42P01')throw Error('Database is not initialized. Run npm run migrate before starting AH Corner.');
  throw error;
 }
}

export async function runMigrations(){
 const connectionString=process.env.DATABASE_MIGRATION_URL||process.env.DATABASE_URL;
 if(!connectionString)throw Error('DATABASE_MIGRATION_URL or DATABASE_URL is required to run migrations');
 const pool=await poolFor(connectionString);
 try{
  const client=await pool.connect();
  try{
   await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
   await client.query(`SELECT pg_advisory_lock(${migrationLock})`);
    try{
    const applied=await client.query<{version:string}>('SELECT version FROM schema_migrations');
    const versions=new Set(applied.rows.map(row=>row.version));
    for(const migration of migrations){
     if(versions.has(migration.version))continue;
     const sql=await readFile(migration.file,'utf8');
     await client.query('BEGIN');
     try{
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(version) VALUES($1)',[migration.version]);
      await client.query('COMMIT');
     }catch(error){
      await client.query('ROLLBACK');
      throw error;
     }
    }
   }finally{
    await client.query(`SELECT pg_advisory_unlock(${migrationLock})`);
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
   async load(){return (await pool.query('SELECT data FROM state WHERE market=$1',[market])).rows[0]?.data||empty();},
   async save(s){await pool.query('INSERT INTO state(market,data) VALUES($1,$2) ON CONFLICT(market) DO UPDATE SET data=excluded.data',[market,JSON.stringify(s)]);},
   async snapshots(){return (await pool.query('SELECT data FROM snapshots WHERE market=$1 ORDER BY at DESC LIMIT 25',[market])).rows.map(row=>row.data).reverse();},
   async put(s){const result=await pool.query('INSERT INTO snapshots(market,key,at,data) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[market,s.key,s.at,JSON.stringify(s)]);await pool.query('DELETE FROM snapshots WHERE market=$1 AND key IN (SELECT key FROM snapshots WHERE market=$1 ORDER BY at DESC OFFSET 25)',[market]);return result.rowCount===1;},
   async health(){await pool.query('SELECT 1');},
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
  async save(s){await atomic(state,s);},
  async snapshots(){const files=(await readdir(dir)).filter(file=>file.startsWith('snap-')&&file.endsWith('.json')).sort();return Promise.all(files.slice(-25).map(async file=>JSON.parse(await readFile(join(dir,file),'utf8'))));},
  async put(s){const key=s.key.replace(/[^a-zA-Z0-9-]/g,'_');const files=(await readdir(dir)).filter(file=>file.startsWith('snap-')&&file.endsWith('.json'));if(files.some(file=>file.endsWith(`-${key}.json`)))return false;await atomic(join(dir,`snap-${s.at}-${key}.json`),s);const sorted=(await readdir(dir)).filter(file=>file.startsWith('snap-')&&file.endsWith('.json')).sort();for(const file of sorted.slice(0,Math.max(0,sorted.length-25)))await unlink(join(dir,file));return true;},
  async health(){},
  async close(){}
 };
}
