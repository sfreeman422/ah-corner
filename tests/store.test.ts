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

test('database URLs must target MySQL or MariaDB',async()=>{
 const url=process.env.DATABASE_URL;
 const required=process.env.REQUIRE_DATABASE;
 try{
  process.env.DATABASE_URL='postgresql://user:pass@example.test/ahcorner';
  delete process.env.REQUIRE_DATABASE;
  await assert.rejects(()=>openStore('test-market'),/mysql|mariadb/i);
 }finally{
  restore('DATABASE_URL',url);
  restore('REQUIRE_DATABASE',required);
 }
});

test('database TLS is configured outside the MySQL connection URL',async()=>{
 const url=process.env.DATABASE_URL;
 const required=process.env.REQUIRE_DATABASE;
 try{
  process.env.DATABASE_URL='mysql://user:pass@example.test/ahcorner?ssl-mode=REQUIRED';
  delete process.env.REQUIRE_DATABASE;
  await assert.rejects(()=>openStore('test-market'),/DATABASE_SSL/);
 }finally{
  restore('DATABASE_URL',url);
  restore('REQUIRE_DATABASE',required);
 }
});

test('required database TLS cannot be disabled',async()=>{
 const url=process.env.DATABASE_URL;
 const required=process.env.REQUIRE_DATABASE;
 const ssl=process.env.DATABASE_SSL;
 const requireSsl=process.env.REQUIRE_DATABASE_SSL;
 try{
  process.env.DATABASE_URL='mysql://user:pass@example.test/ahcorner';
  delete process.env.REQUIRE_DATABASE;
  process.env.DATABASE_SSL='disable';
  process.env.REQUIRE_DATABASE_SSL='true';
  await assert.rejects(()=>openStore('test-market'),/DATABASE_SSL=verify-full/);
 }finally{
  restore('DATABASE_URL',url);
  restore('REQUIRE_DATABASE',required);
  restore('DATABASE_SSL',ssl);
  restore('REQUIRE_DATABASE_SSL',requireSsl);
 }
});
