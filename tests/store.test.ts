import assert from 'node:assert/strict';
import test from 'node:test';
import {openStore,runMigrations} from '../src/store.ts';

function restore(name:string,value:string|undefined){
 if(value===undefined)delete process.env[name];
 else process.env[name]=value;
}

test('production-style deployments fail closed without a database URL',async()=>{
 const url=process.env.DATABASE_URL;
 const required=process.env.REQUIRE_DATABASE;
 try{
  delete process.env.DATABASE_URL;
  process.env.REQUIRE_DATABASE='true';
  await assert.rejects(()=>openStore('test-market'),/DATABASE_URL is required/);
 }finally{
  restore('DATABASE_URL',url);
  restore('REQUIRE_DATABASE',required);
 }
});

test('migration command requires a database URL',async()=>{
 const url=process.env.DATABASE_URL;
 const migrationUrl=process.env.DATABASE_MIGRATION_URL;
 try{
  delete process.env.DATABASE_URL;
  delete process.env.DATABASE_MIGRATION_URL;
  await assert.rejects(()=>runMigrations(),/DATABASE_MIGRATION_URL or DATABASE_URL is required/);
 }finally{
  restore('DATABASE_URL',url);
  restore('DATABASE_MIGRATION_URL',migrationUrl);
 }
});

test('database TLS is configured outside the connection URL',async()=>{
 const url=process.env.DATABASE_URL;
 const required=process.env.REQUIRE_DATABASE;
 try{
  process.env.DATABASE_URL='postgresql://user:pass@example.test/ahcorner?sslmode=require';
  delete process.env.REQUIRE_DATABASE;
  await assert.rejects(()=>openStore('test-market'),/DATABASE_SSL and DATABASE_SSL_CA_FILE/);
 }finally{
  restore('DATABASE_URL',url);
  restore('REQUIRE_DATABASE',required);
 }
});
